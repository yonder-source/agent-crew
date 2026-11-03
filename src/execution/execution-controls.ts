import { z } from 'zod';
import { canonicalJson } from '../effects/effect-model.js';
import type { ExecutionAccounting, RunBinding } from './execution-accounting.js';
import type { ExecutionLaunchCoordinator } from './execution-launch.js';
import type { RuntimeSupervisor, RuntimeTaskReference } from './runtime-supervisor.js';
import { StateError, type StateContext } from '../state/state-common.js';

export type RuntimeDeadlineRequest = {
  commandId: string; run: RunBinding; policyRevisionId: string;
  remainingActiveMs: number; jobRemainingActiveMs: number; maximumExtensionMs: number;
  activeCeilingMs: number; jobActiveCeilingMs: number;
  expectedRevision: number; extensionGrantId: string | null;
};
export type RuntimeDeadlineReceipt = {
  commandId: string; runId: string; taskId: string; requestFingerprint: string;
  revision: number; remainingActiveMs: number; independentlyEnforced: true;
};
/** Concrete adapters must enforce deadlines and stop inference without model cooperation. */
export interface ExecutionControlSupervisor extends RuntimeSupervisor {
  terminateInference(run: RunBinding, commandId: string): Promise<void>;
  inspectInference(run: RunBinding): Promise<'running' | 'stopped' | 'unknown'>;
  configureDeadline(request: RuntimeDeadlineRequest): Promise<RuntimeDeadlineReceipt>;
  inspectDeadline(commandId: string, run: RunBinding): Promise<RuntimeDeadlineReceipt | null>;
}
export type ExecutionCommand = {
  commandId: string; runId: string; kind: 'stop' | 'deadline' | 'checkpoint';
  requestJson: string; started: boolean; receiptJson: string | null; createdGeneration: number;
};
type RawCommand = {
  command_id: string; run_id: string; kind: ExecutionCommand['kind']; request_json: string;
  started: number; receipt_json: string | null; created_generation: number;
};

/** Small durable effect ledger for safety commands, usable while ordinary effects are revoked. */
export class ExecutionCommands {
  constructor(readonly state: StateContext, private readonly accounting: ExecutionAccounting) {}

  get(commandId: string): ExecutionCommand | undefined {
    const row = this.state.database.prepare('SELECT * FROM execution_commands WHERE command_id = ?').get(commandId) as RawCommand | undefined;
    return row && { commandId: row.command_id, runId: row.run_id, kind: row.kind, requestJson: row.request_json,
      started: row.started === 1, receiptJson: row.receipt_json, createdGeneration: row.created_generation };
  }

  forRun(runId: string, kind: ExecutionCommand['kind']): ExecutionCommand[] {
    return (this.state.database.prepare('SELECT command_id FROM execution_commands WHERE run_id = ? AND kind = ? ORDER BY rowid')
      .all(runId, kind) as { command_id: string }[]).map(row => {
        const command = this.get(row.command_id);
        if (!command) throw new StateError('COMMAND_NOT_FOUND', 'Command disappeared');
        return command;
      });
  }

  intent(commandId: string, runId: string, kind: ExecutionCommand['kind'], request: unknown, generation: number): ExecutionCommand {
    z.string().min(1).parse(commandId);
    const requestJson = canonicalJson(request);
    return this.mutate(runId, generation, 'execution_command_intent', () => {
      const old = this.get(commandId);
      if (old) {
        if (old.runId !== runId || old.kind !== kind || old.requestJson !== requestJson) {
          throw new StateError('COMMAND_ID_CONFLICT', 'Command identity cannot change');
        }
        return old;
      }
      this.state.database.prepare(`INSERT INTO execution_commands
        (command_id, run_id, kind, request_json, created_generation, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(commandId, runId, kind, requestJson, generation, this.state.now().toISOString());
      const saved = this.get(commandId);
      if (!saved) throw new StateError('COMMAND_NOT_FOUND', 'Command intent was not saved');
      return saved;
    });
  }

  claim(commandId: string, generation: number): boolean {
    const command = this.require(commandId);
    return this.mutate(command.runId, generation, 'execution_command_dispatched', () =>
      this.state.database.prepare('UPDATE execution_commands SET started = 1 WHERE command_id = ? AND started = 0')
        .run(commandId).changes === 1);
  }

  receipt(commandId: string, receipt: unknown, generation: number): void {
    const command = this.require(commandId);
    const encoded = canonicalJson(receipt);
    const observe = (disposition: 'applied' | 'history') => this.state.database.prepare(`INSERT INTO execution_command_observations
      (command_id, receipt_json, disposition, submitted_generation, observed_at) VALUES (?, ?, ?, ?, ?)`)
      .run(commandId,encoded,disposition,generation,this.state.now().toISOString());
    this.mutate(command.runId, generation, 'execution_command_observed', () => {
      if (!this.require(commandId).started) throw new StateError('COMMAND_NOT_STARTED', 'Receipt requires dispatched intent');
      this.state.database.prepare('UPDATE execution_commands SET receipt_json = ? WHERE command_id = ?')
        .run(encoded, commandId);
      observe('applied');
    },receipt,() => { observe('history'); });
  }

  mutate<T>(runId: string, generation: number, eventType: string, action: () => T, evidence?: unknown, recordRejection?: () => void): T {
    const run = this.accounting.getRun(runId);
    if (!run) throw new StateError('RUN_NOT_FOUND', 'Run binding is unavailable');
    const now = this.state.now().toISOString();
    return this.state.runWithStaleAudit(run.jobId, generation, now, eventType, () => {
      this.state.assertWriter(generation, now);
      const value = action();
      const job = this.state.getJobOrThrow(run.jobId);
      this.state.bumpJob(job, job.row_version + 1, job.event_sequence + 1, now);
      this.state.insertEvent({ jobId: run.jobId, sequence: job.event_sequence + 1, rowVersion: job.row_version + 1,
        eventType, payload: { runId, value, evidence }, writerGeneration: generation, occurredAt: now });
      return value;
    },recordRejection);
  }

  private require(commandId: string): ExecutionCommand {
    const command = this.get(commandId);
    if (!command) throw new StateError('COMMAND_NOT_FOUND', 'Command does not exist');
    return command;
  }
}

const stopAuthority = z.object({ actor: z.string().min(1), grantId: z.string().min(1), action: z.literal('execution.stop') }).strict();
export type StopAuthority = z.infer<typeof stopAuthority>;

export class ExecutionStopCoordinator {
  constructor(private readonly state: StateContext, private readonly accounting: ExecutionAccounting,
    private readonly launcher: ExecutionLaunchCoordinator, private readonly commands: ExecutionCommands,
    private readonly supervisor: ExecutionControlSupervisor, private readonly rpcTimeoutMs: number) {
      z.number().int().positive().safe().parse(rpcTimeoutMs);
    }

  request(input: { runId: string; reason: string; control: 'pause' | 'cancel'; authority: StopAuthority;
    expectedJobVersion: number; expectedExecutionVersion: number; writerGeneration: number }): ExecutionCommand {
    stopAuthority.parse(input.authority);
    z.string().min(1).parse(input.reason);
    if (input.control !== 'pause' && input.control !== 'cancel') throw new StateError('INVALID_INPUT', 'Stop control must pause or cancel');
    const run = this.requireRun(input.runId);
    return this.commands.mutate(run.runId, input.writerGeneration, 'execution_stop_requested', () => {
      const existing = this.commands.forRun(run.runId, 'stop')[0];
      const job = this.state.getJobOrThrow(run.jobId);
      const execution = this.state.getExecutionOrThrow(run.executionId);
      if (job.row_version !== input.expectedJobVersion || execution.row_version !== input.expectedExecutionVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Stop authorization refers to obsolete state');
      }
      if (execution.lifecycle === 'terminal') throw new StateError('EXECUTION_TERMINAL', 'Terminal execution cannot request a new stop');
      const command = existing ?? this.commands.intent(`stop:${run.runId}`, run.runId, 'stop',
        { run, reason: input.reason, authority: input.authority, control: input.control,
          baselineActiveMs: this.accounting.activeTime({ executionId: run.executionId }).value,
          baselineOutputTokens: this.accounting.usage({ executionId: run.executionId },'output_tokens').value }, input.writerGeneration);
      // Cancellation is irreversible within this control request; duplicate pause cannot undo it.
      this.state.database.prepare("UPDATE jobs SET requested_control = CASE WHEN requested_control = 'cancel' THEN 'cancel' ELSE ? END WHERE job_id = ?")
        .run(input.control, run.jobId);
      if (execution.lifecycle !== 'stopping') {
        this.state.database.prepare("UPDATE executions SET lifecycle = 'stopping', row_version = row_version + 1, updated_at = ? WHERE execution_id = ?")
          .run(this.state.now().toISOString(), run.executionId);
      }
      return command;
    });
  }

  async dispatch(commandId: string, writerGeneration: number): Promise<{ stopped: boolean; reason: string }> {
    const command = this.commands.get(commandId);
    if (command?.kind !== 'stop') throw new StateError('STOP_NOT_FOUND', 'Stop intent is unavailable');
    const run = this.requireRun(command.runId);
    if (this.commands.claim(commandId, writerGeneration)) {
      const { request, taskId } = this.launcher.runtimeBinding(run.launchId);
      // Dispatch both independently: a hanging inference transport must not prevent
      // task termination. Late responses have no state-mutating callback.
      await Promise.allSettled([
        bounded(() => this.supervisor.terminateInference(run, commandId), this.rpcTimeoutMs),
        bounded(() => this.supervisor.terminateTask({ ...request, taskId, operationId: commandId }), this.rpcTimeoutMs),
      ]);
    }
    return this.reconcile(commandId, writerGeneration);
  }

  async reconcile(commandId: string, writerGeneration: number): Promise<{ stopped: boolean; reason: string }> {
    const command = this.commands.get(commandId);
    if (command?.kind !== 'stop') throw new StateError('STOP_NOT_FOUND', 'Stop intent is unavailable');
    const run = this.requireRun(command.runId);
    this.state.assertWriter(writerGeneration, this.state.now().toISOString());
    const { request } = this.launcher.runtimeBinding(run.launchId);
    let task: RuntimeTaskReference | null = null;
    let inference: 'running' | 'stopped' | 'unknown' = 'unknown';
    try {
      const inspection = await bounded(() => this.supervisor.inspectTask(request), this.rpcTimeoutMs);
      if (inspection.kind === 'present') task = inspection.task;
    } catch { /* unknown */ }
    try { inference = await bounded(() => this.supervisor.inspectInference(run), this.rpcTimeoutMs); } catch { /* unknown */ }
    const matches = task?.taskId === run.taskId && task.launchId === run.launchId && task.jobId === run.jobId &&
      task.executionId === run.executionId && task.ownershipGeneration === run.ownershipGeneration &&
      task.requestFingerprint === request.requestFingerprint;
    const stopped = matches && task?.status === 'stopped' && inference === 'stopped';
    const result = { stopped, reason: stopped ? 'termination_verified_source_pending' : 'termination_unverified' };
    const baseline = JSON.parse(command.requestJson) as { baselineActiveMs: number | null; baselineOutputTokens: number | null };
    const active = this.accounting.activeTime({ executionId: run.executionId });
    const output = this.accounting.usage({ executionId: run.executionId },'output_tokens');
    this.commands.receipt(commandId, { ...result, task, inference, lastObserved: { active, output },
      observedOvershoot: {
        activeMs: active.value !== null && baseline.baselineActiveMs !== null ? Math.max(0,active.value-baseline.baselineActiveMs) : null,
        outputTokens: output.value !== null && baseline.baselineOutputTokens !== null ? Math.max(0,output.value-baseline.baselineOutputTokens) : null,
      }, nextAction: stopped ? 'preserve_source_and_reconcile_effects' : 'inspect_same_runtime_or_request_operator' }, writerGeneration);
    if (stopped && !this.accounting.observations(run.runId).some(observation => observation.kind === 'closed')) {
      this.accounting.record({ observationId: `closed:${commandId}`, runId: run.runId, taskId: run.taskId,
        ownershipGeneration: run.ownershipGeneration, observedAt: this.state.now().toISOString(), kind: 'closed' }, writerGeneration, true);
    }
    return result;
  }

  private requireRun(runId: string): RunBinding {
    const run = this.accounting.getRun(runId);
    if (!run) throw new StateError('RUN_NOT_FOUND', 'Run does not exist');
    return run;
  }
}

export async function bounded<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StateError('SUPERVISOR_TIMEOUT', 'Supervisor response is unknown')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
