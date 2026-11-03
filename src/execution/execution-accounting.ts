import { z } from 'zod';
import type { ExecutionLaunchCoordinator } from './execution-launch.js';
import { canonicalJson } from '../effects/effect-model.js';
import { StateError, type StateContext, type UsageCoverage } from '../state/state-common.js';

const id = z.string().min(1).refine(value => value.trim() === value);
const count = z.number().int().nonnegative().safe();
const timestamp = z.iso.datetime().transform(value => new Date(value).toISOString());
const base = { observationId: id, runId: id, taskId: id, ownershipGeneration: count.positive(), observedAt: timestamp };
const usage = z.object({
  ...base, kind: z.literal('usage'), metric: z.enum(['input_tokens', 'output_tokens', 'cache_tokens', 'total_tokens']),
  // Epochs identify provider resets, never Controller restarts.
  epoch: id, sequence: count, responseId: id.nullable(), final: z.boolean(),
  value: count.nullable(), coverage: z.enum(['observed', 'partial', 'unknown']),
}).strict().refine(v => v.coverage === 'unknown' ? v.value === null : v.value !== null);
const interval = z.object({
  ...base, kind: z.literal('interval'), state: z.enum(['active', 'waiting', 'stopped']),
  start: timestamp, end: timestamp,
}).strict().refine(v => v.start < v.end && v.end <= v.observedAt);
const signal = z.object({
  ...base, kind: z.literal('signal'), signal: z.enum(['progress', 'native_loop']), sequence: count,
}).strict();
const closed = z.object({ ...base, kind: z.literal('closed') }).strict();
const observationSchema = z.union([usage, interval, signal, closed]);
export type ExecutionObservation = z.infer<typeof observationSchema>;
export type UsageMetric = z.infer<typeof usage>['metric'];
export type AccountedValue = { value: number | null; coverage: UsageCoverage; reasons: string[] };
export type RunBinding = {
  runId: string; executionId: string; jobId: string; launchId: string;
  taskId: string; ownershipGeneration: number; boundAt: string;
};
type RawRun = {
  run_id: string; execution_id: string; job_id: string; launch_id: string;
  task_id: string; ownership_generation: number; bound_at: string;
};

/** Called by authenticated, trusted adapters, never directly by task models. */
export class ExecutionAccounting {
  constructor(private readonly state: StateContext, private readonly launcher: ExecutionLaunchCoordinator) {}

  bindRun(input: { runId: string; launchId: string; writerGeneration: number; startedAt?: string }): RunBinding {
    id.parse(input.runId);
    const { request, taskId, confirmed, startedAt } = this.launcher.runtimeBinding(input.launchId);
    const boundAt = input.startedAt === undefined ? this.state.now().toISOString() : timestamp.parse(input.startedAt);
    if (boundAt < startedAt || Date.parse(boundAt) > this.state.now().getTime()) throw new StateError('RUN_TIME_INVALID','Run start must match the supervisor launch window');
    return this.mutate(request.jobId, input.writerGeneration, 'execution_run_bound', () => {
      const execution = this.state.getExecutionOrThrow(request.executionId);
      const job = this.state.getJobOrThrow(request.jobId);
      if (!confirmed || execution.lifecycle !== 'active' || job.requested_control !== 'run' ||
          job.scope_revision_id !== request.scopeRevisionId ||
          execution.ownership_generation !== input.writerGeneration || request.ownershipGeneration !== input.writerGeneration) {
        throw new StateError('RUN_NOT_AUTHORIZED', 'Run requires a confirmed active runtime and current scope/ownership');
      }
      const existing = this.getRun(input.runId);
      if (existing) {
        if (existing.launchId !== input.launchId || (input.startedAt !== undefined && existing.boundAt !== boundAt)) throw new StateError('RUN_ID_CONFLICT', 'Run already has another launch or start time');
        return existing;
      }
      this.state.database.prepare(`INSERT INTO execution_runs
        (run_id, execution_id, job_id, launch_id, task_id, ownership_generation, bound_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.runId, request.executionId, request.jobId, input.launchId, taskId,
          request.ownershipGeneration, boundAt);
      return this.requireRun(input.runId);
    });
  }

  getRun(runId: string): RunBinding | undefined {
    const row = this.state.database.prepare('SELECT * FROM execution_runs WHERE run_id = ?').get(runId) as RawRun | undefined;
    return row && { runId: row.run_id, executionId: row.execution_id, jobId: row.job_id,
      launchId: row.launch_id, taskId: row.task_id, ownershipGeneration: row.ownership_generation, boundAt: row.bound_at };
  }

  /** Recovery binding grants only attribution; it never activates a runtime. */
  bindRecoveryRun(launchId: string, writerGeneration: number): RunBinding {
    const { request, taskId, startedAt } = this.launcher.runtimeBinding(launchId);
    const runId = `recovery:${launchId}`;
    return this.mutate(request.jobId, writerGeneration, 'execution_recovery_bound', () => {
      const existing = this.getRun(runId);
      if (existing) return existing;
      const prior = this.runs({ executionId: request.executionId }).find(run => run.launchId === launchId);
      if (prior) return prior;
      this.state.database.prepare(`INSERT INTO execution_runs
        (run_id, execution_id, job_id, launch_id, task_id, ownership_generation, bound_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, request.executionId, request.jobId, launchId, taskId,
          request.ownershipGeneration, startedAt);
      return this.requireRun(runId);
    });
  }

  record(evidence: ExecutionObservation, writerGeneration: number, reconcile = false): { historyOnly: boolean } {
    const parsed = observationSchema.parse(evidence);
    const run = this.requireRun(parsed.runId);
    return this.mutate(run.jobId, writerGeneration, 'execution_observation_recorded', () => {
      if (parsed.taskId !== run.taskId || parsed.ownershipGeneration !== run.ownershipGeneration ||
          parsed.observedAt < run.boundAt || Date.parse(parsed.observedAt) > this.state.now().getTime() ||
          (parsed.kind === 'interval' && parsed.start < run.boundAt)) {
        throw new StateError('OBSERVATION_BINDING_MISMATCH', 'Observation does not match runtime or observation window');
      }
      const encoded = canonicalJson(parsed);
      if (parsed.kind === 'closed') {
        const stop = this.state.database.prepare(`SELECT 1 FROM execution_commands
          WHERE run_id = ? AND kind = 'stop' AND json_extract(receipt_json, '$.stopped') = 1`).get(run.runId);
        if (!stop) throw new StateError('TERMINATION_UNVERIFIED', 'Run closure requires verified task and inference termination');
      }
      const existing = this.state.database.prepare('SELECT evidence_json, disposition FROM execution_observations WHERE observation_id = ?')
        .get(parsed.observationId) as { evidence_json: string; disposition: string } | undefined;
      if (existing && existing.evidence_json !== encoded) throw new StateError('OBSERVATION_ID_CONFLICT', 'Observation identity has different evidence');
      if (existing) return { historyOnly: existing.disposition === 'history' };
      const execution = this.state.getExecutionOrThrow(run.executionId);
      const historyOnly = !reconcile && (run.ownershipGeneration !== writerGeneration ||
        execution.lifecycle === 'terminal' || execution.lifecycle === 'stopping');
      this.state.database.prepare(`INSERT INTO execution_observations
        (observation_id, run_id, evidence_json, disposition, writer_generation, received_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(parsed.observationId, run.runId, encoded, historyOnly ? 'history' : 'applied', writerGeneration, this.state.now().toISOString());
      return { historyOnly };
    });
  }

  observations(runId: string, includeHistory = false): ExecutionObservation[] {
    return (this.state.database.prepare(`SELECT evidence_json FROM execution_observations
      WHERE run_id = ? ${includeHistory ? '' : "AND disposition = 'applied'"} ORDER BY rowid`)
      .all(runId) as { evidence_json: string }[]).map(row => observationSchema.parse(JSON.parse(row.evidence_json)));
  }

  usage(owner: { executionId: string } | { jobId: string }, metric: UsageMetric): AccountedValue {
    const runs = this.runs(owner);
    if (!runs.length) return { value: null, coverage: 'unknown', reasons: ['no_run_evidence'] };
    const values = runs.map(run => this.runUsage(run.runId, metric));
    const known = values.filter(v => v.value !== null);
    const total = known.reduce((sum, v) => sum + (v.value ?? 0), 0);
    if (!Number.isSafeInteger(total)) throw new StateError('USAGE_OVERFLOW', 'Usage exceeds safe integer range');
    return {
      value: known.length ? total : null,
      coverage: values.every(v => v.coverage === 'observed') ? 'observed' : known.length ? 'partial' : 'unknown',
      reasons: [...new Set(values.flatMap(v => v.reasons))],
    };
  }

  activeTime(owner: { executionId: string } | { jobId: string }, through = this.state.now()): AccountedValue {
    const runs = this.runs(owner);
    const active: [number, number][] = [];
    let complete = runs.length > 0;
    let hasEvidence = false;
    for (const run of runs) {
      const segments = this.observations(run.runId).filter(v => v.kind === 'interval');
      const closedAt = this.observations(run.runId).filter(v => v.kind === 'closed').map(v => Date.parse(v.observedAt));
      const end = Math.min(through.getTime(), ...closedAt);
      if (!Number.isFinite(end) || end < Date.parse(run.boundAt) || through.getTime() > this.state.now().getTime()) throw new StateError('INVALID_INPUT', 'Invalid accounting boundary');
      const covered: [number, number][] = [];
      const waits: [number, number][] = [];
      const runActive: [number, number][] = [];
      for (const segment of segments) {
        const start = Date.parse(segment.start);
        const finish = Math.min(Date.parse(segment.end), end);
        if (start >= finish) continue;
        hasEvidence = true;
        covered.push([start, finish]);
        if (segment.state === 'active') { active.push([start, finish]); runActive.push([start, finish]); }
        else waits.push([start, finish]);
      }
      const conflict = runActive.some(([a,b]) => waits.some(([c,d]) => a < d && c < b));
      if (conflict || unionLength(covered) < end - Date.parse(run.boundAt)) complete = false;
    }
    return { value: hasEvidence ? unionLength(active) : null,
      coverage: complete ? 'observed' : hasEvidence ? 'partial' : 'unknown',
      reasons: complete ? [] : ['uncovered_or_conflicting_runtime_intervals'] };
  }

  runs(owner: { executionId: string } | { jobId: string }): RunBinding[] {
    const rows = this.state.database.prepare(`SELECT run_id FROM execution_runs WHERE ${'jobId' in owner ? 'job_id' : 'execution_id'} = ?`)
      .all('jobId' in owner ? owner.jobId : owner.executionId) as { run_id: string }[];
    return rows.map(row => this.requireRun(row.run_id));
  }

  private runUsage(runId: string, metric: UsageMetric): AccountedValue {
    const reports = this.observations(runId).filter(v => v.kind === 'usage').filter(v => v.metric === metric);
    const epochs = new Map<string, number>();
    const responses = new Map<string, number>();
    const summaries = new Map<string, number>();
    let conflict = false;
    for (const report of reports) {
      if (report.value === null) continue;
      if (report.responseId !== null) {
        const prior = responses.get(report.responseId);
        responses.set(report.responseId, Math.max(prior ?? 0, report.value));
      } else {
        epochs.set(report.epoch, Math.max(epochs.get(report.epoch) ?? 0, report.value));
        // final + no response identity is an authoritative cumulative epoch receipt.
        if (report.final && report.coverage === 'observed') {
          const prior = summaries.get(report.epoch);
          if (prior !== undefined && prior !== report.value) conflict = true;
          summaries.set(report.epoch, Math.max(prior ?? 0, report.value));
        }
      }
    }
    const known = epochs.size + responses.size > 0;
    const live = [...epochs.values()].reduce((a,b) => a+b, 0);
    const finals = [...responses.values()].reduce((a,b) => a+b, 0);
    const value = known ? Math.max(live, finals) : null;
    const complete = epochs.size > 0 && [...epochs].every(([epoch, total]) => summaries.get(epoch) === total)
      && live >= finals && !conflict && reports.every(v => v.value !== null);
    return { value, coverage: complete ? 'observed' : known ? 'partial' : 'unknown',
      reasons: complete ? [] : [conflict ? 'conflicting_epoch_receipts' : 'incomplete_run_usage'] };
  }

  private requireRun(runId: string): RunBinding {
    const run = this.getRun(runId);
    if (!run) throw new StateError('RUN_NOT_FOUND', 'Runtime run binding does not exist');
    return run;
  }

  private mutate<T>(jobId: string, generation: number, eventType: string, action: () => T): T {
    const now = this.state.now().toISOString();
    return this.state.runWithStaleAudit(jobId, generation, now, eventType, () => {
      this.state.assertWriter(generation, now);
      const result = action();
      const job = this.state.getJobOrThrow(jobId);
      this.state.bumpJob(job, job.row_version + 1, job.event_sequence + 1, now);
      this.state.insertEvent({ jobId, sequence: job.event_sequence + 1, rowVersion: job.row_version + 1,
        eventType, payload: {}, writerGeneration: generation, occurredAt: now });
      return result;
    });
  }
}

function unionLength(intervals: [number, number][]): number {
  let total = 0;
  let lastEnd = -Infinity;
  for (const [start,end] of intervals.sort((a,b) => a[0]-b[0])) {
    if (end > Math.max(start,lastEnd)) total += end - Math.max(start,lastEnd);
    lastEnd = Math.max(lastEnd,end);
  }
  return total;
}
