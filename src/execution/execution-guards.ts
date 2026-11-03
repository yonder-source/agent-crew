import { z } from 'zod';
import type { ExecutionAccounting, UsageMetric } from './execution-accounting.js';
import type { ExecutionCommands, ExecutionStopCoordinator } from './execution-controls.js';
import { canonicalJson } from '../effects/effect-model.js';
import { StateError, type StateContext } from '../state/state-common.js';

const positive = z.number().positive().finite();
const policySchema = z.object({
  revisionId: z.string().min(1),
  activeLimitMs: positive.int().safe(), activeWarningMs: positive.int().safe(),
  jobActiveLimitMs: positive.int().safe(),
  meteringGraceMs: positive.int().safe(), progressGraceMs: positive.int().safe(),
  burnWindowMs: positive.int().safe(), maxOutputTokensPerMs: positive,
  usageLimits: z.array(z.object({
    metric: z.enum(['input_tokens', 'output_tokens', 'cache_tokens', 'total_tokens']),
    executionLimit: positive.int().safe(), jobLimit: positive.int().safe(),
  }).strict()).min(1),
}).strict().refine(v => v.activeWarningMs < v.activeLimitMs)
  .refine(v => new Set(v.usageLimits.map(limit => limit.metric)).size === v.usageLimits.length);
export type ExecutionGuardPolicy = z.infer<typeof policySchema>;
export function parseGuardPolicy(value: unknown): ExecutionGuardPolicy { return policySchema.parse(value); }
export type ExecutionGuardDecision = {
  runId: string; action: 'continue' | 'warn' | 'stop'; reasons: string[];
  stopCommandId: string | null; remainingActiveMs: number | null;
};

/** Evaluates durable observations; the runtime adapter supplies authenticated native signals. */
export class ExecutionGuards {
  constructor(private readonly state: StateContext, private readonly accounting: ExecutionAccounting,
    private readonly commands: ExecutionCommands, private readonly stops: ExecutionStopCoordinator) {}

  evaluate(runId: string, policy: ExecutionGuardPolicy, writerGeneration: number): ExecutionGuardDecision {
    const parsed = policySchema.parse(policy);
    const run = this.accounting.getRun(runId);
    if (!run) throw new StateError('RUN_NOT_FOUND', 'Run does not exist');
    return this.commands.mutate(runId, writerGeneration, 'execution_guard_evaluated', () => {
      const execution = this.state.getExecutionOrThrow(run.executionId);
      const job = this.state.getJobOrThrow(run.jobId);
      if (run.ownershipGeneration !== writerGeneration || execution.ownership_generation !== writerGeneration ||
        (execution.lifecycle !== 'active' && execution.lifecycle !== 'stopping')) {
        throw new StateError('GUARD_OWNER_STALE', 'Guard does not own an active or stopping execution');
      }
      const now = this.state.now().getTime();
      const observations = this.accounting.observations(runId);
      const active = this.accounting.activeTime({ executionId: run.executionId });
      const jobActive = this.accounting.activeTime({ jobId: run.jobId });
      const stops: string[] = [];
      const warnings: string[] = [];
      const age = (times: string[]) => now - Math.max(Date.parse(run.boundAt), ...times.map(value => Date.parse(value)));
      if (active.value !== null && active.value >= parsed.activeLimitMs) stops.push('execution_active_time_exhausted');
      else if (active.value !== null && active.value >= parsed.activeWarningMs) warnings.push('execution_active_time_warning');
      if (jobActive.value !== null && jobActive.value >= parsed.jobActiveLimitMs) stops.push('job_active_time_exhausted');
      const intervalAge = age(observations.filter(v => v.kind === 'interval').map(v => v.end));
      if (active.coverage !== 'observed') warnings.push('active_time_partial');
      if (intervalAge >= parsed.meteringGraceMs) stops.push('active_time_metering_stale');
      for (const limit of parsed.usageLimits) {
        const executionUsage = this.accounting.usage({ executionId: run.executionId }, limit.metric);
        const jobUsage = this.accounting.usage({ jobId: run.jobId }, limit.metric);
        if (executionUsage.value !== null && executionUsage.value >= limit.executionLimit) stops.push(`execution_${limit.metric}_exhausted`);
        if (jobUsage.value !== null && jobUsage.value >= limit.jobLimit) stops.push(`job_${limit.metric}_exhausted`);
        const reports = observations.filter(v => v.kind === 'usage').filter(v => v.metric === limit.metric && v.value !== null);
        const epochs = new Set(reports.map(report => report.epoch));
        const latest = [...epochs].map(epoch => {
          const group = reports.filter(report => report.epoch === epoch);
          const sequence = Math.max(...group.map(report => report.sequence));
          return new Date(Math.min(...group.filter(report => report.sequence === sequence).map(report => Date.parse(report.observedAt)))).toISOString();
        });
        if (age(latest) >= parsed.meteringGraceMs) stops.push(`${limit.metric}_metering_stale`);
        if (executionUsage.coverage !== 'observed') warnings.push(`${limit.metric}_partial`);
      }
      const signals = observations.filter(v => v.kind === 'signal');
      if (signals.some(v => v.signal === 'native_loop')) stops.push('native_loop_detected');
      const progress = signals.filter(v => v.signal === 'progress');
      const sequence = Math.max(-1,...progress.map(report => report.sequence));
      const latestProgress = progress.filter(report => report.sequence === sequence);
      const progressTime = latestProgress.length ? [new Date(Math.min(...latestProgress.map(report => Date.parse(report.observedAt)))).toISOString()] : [];
      if (age(progressTime) >= parsed.progressGraceMs) stops.push('progress_stale');
      const output = this.accounting.usage({ executionId: run.executionId }, 'output_tokens');
      // Rate uses non-overlapping provider epoch/response evidence, not a sum of snapshots.
      const windowStart = Math.max(Date.parse(run.boundAt),now-parsed.burnWindowMs);
      const earlier = windowStart === Date.parse(run.boundAt) ? 0 : this.usageAt(runId, 'output_tokens',windowStart);
      if (output.value !== null && earlier !== null && now > windowStart && (output.value - earlier) / (now-windowStart) >= parsed.maxOutputTokensPerMs) {
        stops.push('output_burn_rate_exceeded');
      }
      const existing = this.commands.forRun(runId, 'stop')[0];
      if (this.commands.forRun(runId,'deadline').some(command => command.receiptJson === null)) stops.push('deadline_configuration_unknown');
      let command = existing;
      if (stops.length && !command) {
        command = this.stops.request({
          runId, reason: stops.join(','), control: 'pause',
          authority: { actor: 'controller:execution-guard', grantId: parsed.revisionId, action: 'execution.stop' },
          expectedJobVersion: job.row_version, expectedExecutionVersion: execution.row_version, writerGeneration,
        });
      }
      const decision: ExecutionGuardDecision = {
        runId, action: command ? 'stop' : warnings.length ? 'warn' : 'continue',
        reasons: [...new Set([...stops, ...warnings, ...(existing ? ['stop_already_requested'] : [])])],
        stopCommandId: command?.commandId ?? null,
        remainingActiveMs: active.coverage === 'observed' && jobActive.coverage === 'observed' && active.value !== null
          ? Math.max(0, Math.min(parsed.activeLimitMs - active.value, parsed.jobActiveLimitMs - (jobActive.value ?? 0))) : null,
      };
      this.state.database.prepare(`INSERT INTO execution_guard_decisions
        (run_id, policy_json, result_json, writer_generation, decided_at) VALUES (?, ?, ?, ?, ?)`)
        .run(runId, canonicalJson(parsed), canonicalJson(decision), writerGeneration, this.state.now().toISOString());
      return decision;
    });
  }

  private usageAt(runId: string, metric: UsageMetric, through: number): number | null {
    const reports = this.accounting.observations(runId).filter(v => v.kind === 'usage')
      .filter(v => v.metric === metric && Date.parse(v.observedAt) <= through && v.value !== null);
    if (!reports.length) return null;
    const epochs = new Map<string, number>();
    const responses = new Map<string, number>();
    for (const report of reports) {
      const map = report.responseId === null ? epochs : responses;
      const key = report.responseId ?? report.epoch;
      map.set(key, Math.max(map.get(key) ?? 0, report.value ?? 0));
    }
    return Math.max([...epochs.values()].reduce((a,b) => a+b, 0), [...responses.values()].reduce((a,b) => a+b, 0));
  }
}
