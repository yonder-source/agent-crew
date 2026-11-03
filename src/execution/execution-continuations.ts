import { z } from 'zod';
import type { ExecutionAccounting } from './execution-accounting.js';
import type { ExecutionLaunchCoordinator } from './execution-launch.js';
import type { ExecutionCommands, ExecutionControlSupervisor, ExecutionStopCoordinator } from './execution-controls.js';
import type { ExecutionSources, SourceArtifact } from './execution-sources.js';
import { assertExecutionSettled } from './execution-settlement.js';
import type { ExecutionStore } from './executions.js';
import { ExecutionGuards, parseGuardPolicy, type ExecutionGuardPolicy } from './execution-guards.js';
import { bounded } from './execution-controls.js';
import { StateError, type StateContext, type ExecutionRecord } from '../state/state-common.js';

const authoritySchema = z.object({
  actor: z.string().min(1), grantId: z.string().min(1), action: z.literal('execution.continue'),
  scopeRevisionId: z.string().min(1), policyVersion: z.string().min(1), capacity: z.number().int().positive().safe(),
}).strict();
export type ContinuationAuthority = z.infer<typeof authoritySchema>;
export type ValidationClaim = { command: string; outcome: 'passed' | 'failed' | 'not_run'; candidateSha: string; source: 'agent_claim' };
export type ExecutionSourceHandoff = {
  jobId: string; repositoryId: string; issueId: string; executionId: string; ownershipGeneration: number;
  scopeRevisionId: string; policyVersion: string; launchInput: { sourceBundleId: string; baseCommitSha: string };
  output: SourceArtifact; candidateSha: string; validationClaims: ValidationClaim[];
};

export class ExecutionContinuations {
  constructor(private readonly state: StateContext, private readonly accounting: ExecutionAccounting,
    private readonly launcher: ExecutionLaunchCoordinator, private readonly commands: ExecutionCommands,
    private readonly sources: ExecutionSources, private readonly stops: ExecutionStopCoordinator,
    private readonly supervisor: ExecutionControlSupervisor, private readonly executions: ExecutionStore,
    private readonly rpcTimeoutMs: number) { z.number().int().positive().safe().parse(rpcTimeoutMs); }

  handoff(input: { runId: string; artifactId: string; validationClaims: ValidationClaim[]; writerGeneration: number }): ExecutionSourceHandoff {
    const run = this.requireRun(input.runId);
    const artifact = this.sources.get(input.artifactId);
    if (!artifact || artifact.runId !== run.runId || artifact.status !== 'verified') throw new StateError('SOURCE_UNVERIFIED','Handoff requires this run verified output');
    this.sources.verify(artifact.artifactId);
    const claims = z.array(z.object({ command: z.string().min(1), outcome: z.enum(['passed','failed','not_run']),
      candidateSha: z.literal(artifact.headSha), source: z.literal('agent_claim') }).strict()).parse(input.validationClaims);
    return this.commands.mutate(run.runId,input.writerGeneration,'execution_source_handoff',() => {
      const { request } = this.launcher.runtimeBinding(run.launchId);
      this.assertCurrent(run.executionId,request.scopeRevisionId,request.policyVersion,input.writerGeneration);
      const job = this.state.getJobOrThrow(run.jobId);
      const execution = this.state.getExecutionOrThrow(run.executionId);
      if (execution.lifecycle !== 'active' || job.requested_control !== 'run') throw new StateError('HANDOFF_OWNER_INACTIVE','Candidate must be submitted by its current active owner');
      return { jobId: run.jobId, repositoryId: job.repository_id, issueId: job.issue_id,
        executionId: run.executionId, ownershipGeneration: execution.ownership_generation,
        scopeRevisionId: request.scopeRevisionId, policyVersion: request.policyVersion,
        launchInput: { sourceBundleId: request.sourceBundleId, baseCommitSha: request.sourceCommitSha },
        output: artifact, candidateSha: artifact.headSha, validationClaims: claims };
    });
  }

  async reuse(input: { runId: string; authority: ContinuationAuthority; policy: ExecutionGuardPolicy; writerGeneration: number;
    inspectWorkspace: () => Promise<{ taskId: string; usable: boolean }> }): Promise<ExecutionRecord> {
    const run = this.requireRun(input.runId);
    const authority = authoritySchema.parse(input.authority);
    parseGuardPolicy(input.policy);
    const guard = new ExecutionGuards(this.state,this.accounting,this.commands,this.stops).evaluate(run.runId,input.policy,input.writerGeneration);
    if (guard.action === 'stop') throw new StateError('CONTINUATION_BUDGET_BLOCKED','Guard requires stopped work');
    this.state.assertWriter(input.writerGeneration,this.state.now().toISOString());
    const { request } = this.launcher.runtimeBinding(run.launchId);
    const task = await bounded(() => this.supervisor.inspectTask(request),this.rpcTimeoutMs);
    const inference = await bounded(() => this.supervisor.inspectInference(run),this.rpcTimeoutMs);
    const workspace = await bounded(input.inspectWorkspace,this.rpcTimeoutMs);
    return this.commands.mutate(run.runId,input.writerGeneration,'execution_continuation_reused',() => {
      this.assertCurrent(run.executionId,authority.scopeRevisionId,authority.policyVersion,input.writerGeneration);
      const execution = this.state.getExecutionOrThrow(run.executionId);
      const job = this.state.getJobOrThrow(run.jobId);
      if (execution.lifecycle !== 'active' || job.requested_control !== 'run' ||
        task.kind !== 'present' || task.task.status !== 'running' || task.task.taskId !== run.taskId ||
        task.task.launchId !== run.launchId || task.task.executionId !== run.executionId ||
        task.task.jobId !== run.jobId || task.task.ownershipGeneration !== run.ownershipGeneration ||
        task.task.requestFingerprint !== request.requestFingerprint || workspace.taskId !== run.taskId || !workspace.usable ||
        inference === 'unknown' || this.commands.forRun(run.runId,'stop').length ||
        this.commands.forRun(run.runId,'deadline').some(command => command.receiptJson === null)) throw new StateError('CONTINUATION_UNVERIFIED','Existing runtime/workspace cannot be reused');
      this.assertCapacity(authority.capacity,run.executionId);
      this.assertBudget(run.jobId,run.executionId,input.policy);
      const record = this.executions.get(run.executionId);
      if (!record) throw new StateError('EXECUTION_NOT_FOUND','Execution unavailable');
      return record;
    },authority);
  }

  async replace(input: { runId: string; artifactId: string; restoreCommandId: string; destination: string;
    newExecutionId: string; authority: ContinuationAuthority; policy: ExecutionGuardPolicy; writerGeneration: number }): Promise<ExecutionRecord> {
    const run = this.requireRun(input.runId);
    const authority = authoritySchema.parse(input.authority);
    parseGuardPolicy(input.policy);
    this.assertCurrent(run.executionId,authority.scopeRevisionId,authority.policyVersion,input.writerGeneration,true);
    this.assertCapacity(authority.capacity,run.executionId);
    this.assertBudget(run.jobId,run.executionId,input.policy);
    this.commands.mutate(run.runId,input.writerGeneration,'execution_replacement_authorized',() =>
      ({ artifactId: input.artifactId, newExecutionId: input.newExecutionId, destination: input.destination }),authority);
    await this.sources.settle(run.runId,input.artifactId,this.stops,input.writerGeneration);
    this.sources.restore({ commandId: input.restoreCommandId, artifactId: input.artifactId,
      destination: input.destination, writerGeneration: input.writerGeneration });
    return this.commands.mutate(run.runId,input.writerGeneration,'execution_replacement_reserved',() => {
      // An old writer's work may be stopped/preserved, but only the current writer
      // can authorize a new execution after checking today's scope and readiness.
      this.assertCurrent(run.executionId,authority.scopeRevisionId,authority.policyVersion,input.writerGeneration,true);
      this.assertCapacity(authority.capacity,run.executionId);
      this.assertBudget(run.jobId,run.executionId,input.policy);
      assertExecutionSettled(this.state,run.executionId);
      const old = this.state.getExecutionOrThrow(run.executionId);
      const job = this.state.getJobOrThrow(run.jobId);
      if (job.requested_control === 'cancel') throw new StateError('JOB_CANCELLED','Cancelled work cannot continue');
      if (old.lifecycle !== 'stopping' && old.lifecycle !== 'terminal') throw new StateError('EXECUTION_NOT_STOPPED','Replacement requires a stopped execution');
      this.state.database.prepare("UPDATE executions SET lifecycle = 'terminal', terminal_outcome = 'replaced_preserved', row_version = row_version + 1, updated_at = ? WHERE execution_id = ?")
        .run(this.state.now().toISOString(),run.executionId);
      this.state.database.prepare("UPDATE jobs SET requested_control = 'run' WHERE job_id = ?").run(run.jobId);
      return this.executions.reserve({ executionId: input.newExecutionId, jobId: run.jobId,
        expectedJobVersion: this.state.getJobOrThrow(run.jobId).row_version, writerGeneration: input.writerGeneration });
    },authority);
  }

  private assertCurrent(executionId: string, scopeRevisionId: string, policyVersion: string, writerGeneration: number, recovery = false): void {
    this.state.assertWriter(writerGeneration,this.state.now().toISOString());
    const execution = this.state.getExecutionOrThrow(executionId);
    const job = this.state.getJobOrThrow(execution.job_id);
    const head = this.state.database.prepare(`SELECT o.status, o.scope_revision_id FROM issue_read_heads h
      JOIN issue_read_observations o USING(observation_id) WHERE h.repository_id = ? AND h.issue_id = ?`)
      .get(job.repository_id,job.issue_id) as { status: string; scope_revision_id: string | null } | undefined;
    const readiness = this.state.database.prepare(`SELECT o.status, o.label_present FROM readiness_heads h
      JOIN readiness_observations o USING(observation_id) WHERE h.repository_id = ? AND h.issue_id = ?`)
      .get(job.repository_id,job.issue_id) as { status: string; label_present: number | null } | undefined;
    const scope = this.state.database.prepare('SELECT policy_version FROM issue_scope_revisions WHERE scope_revision_id = ?')
      .get(scopeRevisionId) as { policy_version: string } | undefined;
    if ((!recovery && execution.ownership_generation !== writerGeneration) || job.scope_revision_id !== scopeRevisionId ||
      head?.status !== 'complete' || head.scope_revision_id !== scopeRevisionId || scope?.policy_version !== policyVersion ||
      readiness?.status !== 'complete' || readiness.label_present !== 1) throw new StateError('CONTINUATION_AUTHORITY_STALE','Current scope, readiness or ownership no longer permits continuation');
  }

  private assertBudget(jobId: string, executionId: string, policy: ExecutionGuardPolicy): void {
    const active = this.accounting.activeTime({ executionId });
    const jobActive = this.accounting.activeTime({ jobId });
    if (active.coverage !== 'observed' || jobActive.coverage !== 'observed' || active.value === null || jobActive.value === null ||
      active.value >= policy.activeLimitMs || jobActive.value >= policy.jobActiveLimitMs) throw new StateError('CONTINUATION_BUDGET_BLOCKED','Active allowance is exhausted or unknown');
    for (const limit of policy.usageLimits) {
      const execution = this.accounting.usage({ executionId },limit.metric);
      const job = this.accounting.usage({ jobId },limit.metric);
      if (execution.value === null || job.value === null || execution.value >= limit.executionLimit || job.value >= limit.jobLimit) {
        throw new StateError('CONTINUATION_BUDGET_BLOCKED','Usage allowance is exhausted or unknown');
      }
    }
  }

  private assertCapacity(capacity: number, priorExecutionId: string): void {
    const row = this.state.database.prepare("SELECT count(*) AS count FROM executions WHERE lifecycle <> 'terminal' AND execution_id <> ?")
      .get(priorExecutionId) as { count: number };
    if (row.count >= capacity) throw new StateError('CAPACITY_EXHAUSTED','Configured execution capacity is exhausted');
  }

  private requireRun(runId: string) {
    const run = this.accounting.getRun(runId);
    if (!run) throw new StateError('RUN_NOT_FOUND','Run unavailable');
    return run;
  }
}
