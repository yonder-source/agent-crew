import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionAccounting } from './execution-accounting.js';
import { bounded, type ExecutionControlSupervisor, type RuntimeDeadlineRequest, type RuntimeDeadlineReceipt, type ExecutionCommands } from './execution-controls.js';
import { canonicalJson } from '../effects/effect-model.js';
import { StateError, type StateContext } from '../state/state-common.js';

const receiptSchema = z.object({
  commandId: z.string(), runId: z.string(), taskId: z.string(), requestFingerprint: z.string(),
  revision: z.number().int().positive(), remainingActiveMs: z.number().int().nonnegative(),
  independentlyEnforced: z.literal(true),
}).strict();

/** Changing a deadline is an effect. Uncertain registration blocks new revisions. */
export class ExecutionDeadlines {
  constructor(private readonly state: StateContext, private readonly accounting: ExecutionAccounting,
    private readonly commands: ExecutionCommands, private readonly supervisor: ExecutionControlSupervisor,
    private readonly rpcTimeoutMs: number) { z.number().int().positive().safe().parse(rpcTimeoutMs); }

  async register(request: RuntimeDeadlineRequest, writerGeneration: number): Promise<RuntimeDeadlineReceipt | null> {
    const run = this.accounting.getRun(request.run.runId);
    if (!run || canonicalJson(run) !== canonicalJson(request.run)) throw new StateError('DEADLINE_BINDING_MISMATCH', 'Deadline run binding is invalid');
    const integer = z.number().int().nonnegative().safe();
    for (const value of [request.remainingActiveMs, request.jobRemainingActiveMs, request.maximumExtensionMs,
      request.activeCeilingMs, request.jobActiveCeilingMs, request.expectedRevision]) integer.parse(value);
    z.string().min(1).parse(request.commandId); z.string().min(1).parse(request.policyRevisionId);
    if (request.remainingActiveMs > request.jobRemainingActiveMs || request.remainingActiveMs > request.activeCeilingMs ||
        request.jobRemainingActiveMs > request.jobActiveCeilingMs) throw new StateError('DEADLINE_EXCEEDS_JOB', 'Remaining allowance exceeds its cumulative ceiling');
    this.commands.mutate(run.runId, writerGeneration, 'execution_deadline_authorized', () => {
      const execution = this.state.getExecutionOrThrow(run.executionId);
      const job = this.state.getJobOrThrow(run.jobId);
      if (execution.lifecycle !== 'active' || execution.ownership_generation !== writerGeneration ||
          run.ownershipGeneration !== writerGeneration || job.requested_control !== 'run') {
        throw new StateError('DEADLINE_NOT_AUTHORIZED', 'Only the current active owner can register a deadline');
      }
      const existing = this.commands.get(request.commandId);
      const deadlines = this.commands.forRun(run.runId, 'deadline');
      const prior = deadlines.filter(command => command.commandId !== request.commandId);
      if (prior.some(command => command.receiptJson === null)) throw new StateError('DEADLINE_UNKNOWN', 'Reconcile previous deadline before changing it');
      const previous = prior.at(-1);
      const previousReceipt = previous?.receiptJson ? receiptSchema.parse(JSON.parse(previous.receiptJson)) : null;
      if (!existing && request.expectedRevision !== (previousReceipt?.revision ?? 0)) throw new StateError('DEADLINE_REVISION_STALE', 'Deadline revision changed');
      if (request.expectedRevision === 0 && request.extensionGrantId !== null) throw new StateError('INVALID_EXTENSION', 'Initial deadline cannot consume an extension');
      const previousRequest = previous ? JSON.parse(previous.requestJson) as RuntimeDeadlineRequest : null;
      const extension = previousRequest ? Math.max(request.activeCeilingMs - previousRequest.activeCeilingMs,
        request.jobActiveCeilingMs - previousRequest.jobActiveCeilingMs,
        request.remainingActiveMs - previousRequest.remainingActiveMs) : 0;
      if (extension > 0) {
        if (!request.extensionGrantId || request.maximumExtensionMs <= 0 ||
            extension > request.maximumExtensionMs) {
          throw new StateError('EXTENSION_NOT_AUTHORIZED', 'Increasing an allowance requires a bounded human grant');
        }
        // The same human grant cannot be replayed under a new command identity.
        if (prior.some(command => JSON.parse(command.requestJson).extensionGrantId === request.extensionGrantId)) {
          throw new StateError('EXTENSION_ALREADY_USED', 'Extension grant has already been consumed');
        }
      }
      this.commands.intent(request.commandId,run.runId,'deadline',request,writerGeneration);
    });
    const command = this.commands.get(request.commandId);
    if (command?.receiptJson) return receiptSchema.parse(JSON.parse(command.receiptJson));
    if (!this.commands.claim(request.commandId,writerGeneration)) return this.reconcile(request.commandId,writerGeneration);
    let receipt: RuntimeDeadlineReceipt | null = null;
    try { receipt = await bounded(() => this.supervisor.configureDeadline(request),this.rpcTimeoutMs); } catch { /* reconcile exact command */ }
    if (receipt && this.matches(request,receipt)) {
      this.commands.receipt(request.commandId,receipt,writerGeneration);
      return receipt;
    }
    return this.reconcile(request.commandId,writerGeneration);
  }

  async reconcile(commandId: string, writerGeneration: number): Promise<RuntimeDeadlineReceipt | null> {
    const command = this.commands.get(commandId);
    if (command?.kind !== 'deadline' || !command.started) throw new StateError('DEADLINE_NOT_FOUND', 'Dispatched deadline is unavailable');
    this.state.assertWriter(writerGeneration,this.state.now().toISOString());
    const request = JSON.parse(command.requestJson) as RuntimeDeadlineRequest;
    let receipt: RuntimeDeadlineReceipt | null = null;
    try { receipt = await bounded(() => this.supervisor.inspectDeadline(commandId,request.run),this.rpcTimeoutMs); } catch { /* unknown */ }
    if (!receipt || !this.matches(request,receipt)) return null;
    this.commands.receipt(commandId,receipt,writerGeneration);
    return receipt;
  }

  private matches(request: RuntimeDeadlineRequest, receipt: RuntimeDeadlineReceipt): boolean {
    return receiptSchema.safeParse(receipt).success && receipt.commandId === request.commandId &&
      receipt.runId === request.run.runId && receipt.taskId === request.run.taskId &&
      receipt.revision === request.expectedRevision + 1 && receipt.remainingActiveMs === request.remainingActiveMs &&
      receipt.requestFingerprint === deadlineFingerprint(request);
  }
}

export function deadlineFingerprint(request: RuntimeDeadlineRequest): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}
