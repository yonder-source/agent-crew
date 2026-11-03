import { ExecutionLaunchCoordinator } from '../../src/execution/execution-launch.js';
import { ExecutionAccounting } from '../../src/execution/execution-accounting.js';
import { createJob, createStateFixture, prepareExecutionStartEvidence } from './state-fixture.js';
import type { RuntimeSupervisor, RuntimeTaskStartRequest } from '../../src/execution/runtime-supervisor.js';

export async function createGuardFixture() {
  const fixture = createStateFixture();
  let request: RuntimeTaskStartRequest | undefined;
  let status: 'running' | 'stopping' | 'stopped' = 'running';
  const supervisor: RuntimeSupervisor = {
    async startTask(value) { request = value; return { kind: 'accepted', taskId: 'task-1' }; },
    async inspectTask() {
      if (!request) return { kind: 'not_created', authoritative: true };
      return { kind: 'present', task: { ...request, taskId: 'task-1', status } };
    },
    async terminateTask() { status = 'stopping'; return { kind: 'accepted' }; },
  };
  try {
    const job = createJob(fixture.jobs);
    const execution = fixture.executions.reserve({ executionId: 'execution-1', jobId: job.jobId,
      expectedJobVersion: job.rowVersion, writerGeneration: 1 });
    const evidence = prepareExecutionStartEvidence(fixture, job.repositoryId, job.issueId, job.scopeRevisionId);
    const launcher = new ExecutionLaunchCoordinator(fixture.state, fixture.jobs, fixture.executions,
      fixture.effects, fixture.effectResults, supervisor);
    await launcher.launch({ operationId: 'launch-1', stepId: 'launch-step-1', executionId: execution.executionId,
      expectedJobVersion: fixture.jobs.get(job.jobId)?.rowVersion ?? 0, expectedExecutionVersion: execution.rowVersion,
      expectedIssueHeadVersion: evidence.issueHeadVersion, expectedReadinessHeadVersion: evidence.readinessHeadVersion,
      policyVersion: 'policy-1', writerGeneration: 1, profile: {
        configurationRevisionId: 'config-1', runtimeImage: `registry.example/coding@sha256:${'a'.repeat(64)}`,
        sourceBundleId: 'bundle-1', sourceCommitSha: 'b'.repeat(40), workspaceGrantId: 'workspace-1',
        toolGrantId: 'tools-1', networkGrantId: 'network-1', budgetProfileRevisionId: 'budget-1', validationCommands: ['npm run check'],
      } });
    const accounting = new ExecutionAccounting(fixture.state, launcher);
    const run = accounting.bindRun({ runId: 'run-1', launchId: 'launch-1', writerGeneration: 1 });
    return { ...fixture, launcher, supervisor, accounting, run, setStatus(value: typeof status) { status = value; } };
  } catch (error) { fixture.close(); throw error; }
}
