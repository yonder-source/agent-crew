import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSourceFixture } from '../../tests/fixtures/execution-source-fixture.js';
import { ExecutionAccounting } from './execution-accounting.js';
import { ExecutionCommands, ExecutionStopCoordinator } from './execution-controls.js';
import { ExecutionSources } from './execution-sources.js';
import { ExecutionContinuations, type ContinuationAuthority } from './execution-continuations.js';
import { ExecutionStore } from './executions.js';
import { StateContext } from '../state/state-common.js';
import type { ExecutionGuardPolicy } from './execution-guards.js';

const policy: ExecutionGuardPolicy = { revisionId: 'budget-1', activeLimitMs: 1200000, activeWarningMs: 900000,
  jobActiveLimitMs: 2400000, meteringGraceMs: 30000, progressGraceMs: 30000, burnWindowMs: 1000,
  maxOutputTokensPerMs: 100, usageLimits: [{ metric: 'output_tokens', executionLimit: 100, jobLimit: 200 }] };
const authority: ContinuationAuthority = { actor: 'human:1', grantId: 'continue-1', action: 'execution.continue',
  scopeRevisionId: 'scope-1', policyVersion: 'policy-1', capacity: 1 };

async function setup() {
  const f = await createSourceFixture();
  const now = new Date(Date.parse(f.run.boundAt) + 10000);
  f.database.prepare('UPDATE controller_writer SET heartbeat_at = ?').run(now.toISOString());
  const state = new StateContext(f.database,() => now);
  const accounting = new ExecutionAccounting(state,f.launcher);
  const commands = new ExecutionCommands(state,accounting);
  const stops = new ExecutionStopCoordinator(state,accounting,f.launcher,commands,f.supervisor,50);
  const sources = new ExecutionSources(state,accounting,commands,f.archives,join(f.directory,'artifacts'),run =>
    ({ path: f.workspace, taskId: run.taskId, readOnly: true }));
  const executions = new ExecutionStore(state);
  const continuations = new ExecutionContinuations(state,accounting,f.launcher,commands,sources,stops,f.supervisor,executions,50);
  accounting.record({ observationId: 'active', runId: f.run.runId, taskId: f.run.taskId, ownershipGeneration: 1,
    observedAt: now.toISOString(), kind: 'interval', state: 'active', start: f.run.boundAt, end: now.toISOString() },1);
  accounting.record({ observationId: 'usage', runId: f.run.runId, taskId: f.run.taskId, ownershipGeneration: 1,
    observedAt: now.toISOString(), kind: 'usage', metric: 'output_tokens', epoch: 'epoch-1', sequence: 1,
    responseId: null, final: true, value: 50, coverage: 'observed' },1);
  accounting.record({ observationId: 'progress', runId: f.run.runId, taskId: f.run.taskId, ownershipGeneration: 1,
    observedAt: now.toISOString(), kind: 'signal', signal: 'progress', sequence: 1 },1);
  return { ...f, state, accounting, commands, stops, sources, executions, continuations, now,
    async stop() {
      const job = f.jobs.get('job-1'); const execution = executions.get('execution-1'); assert.ok(job && execution);
      const command = stops.request({ runId: f.run.runId, reason: 'pause', control: 'pause',
        authority: { actor: 'human:1', grantId: 'pause-1', action: 'execution.stop' },
        expectedJobVersion: job.rowVersion, expectedExecutionVersion: execution.rowVersion, writerGeneration: 1 });
      await stops.dispatch(command.commandId,1); f.setStatus('stopped'); await stops.reconcile(command.commandId,1);
    } };
}

test('source handoff separates launch input from captured output and preserves active submission authority',async () => {
  const f = await setup();
  try {
    const output = f.sources.capture({ commandId: 'candidate-source', runId: f.run.runId, writerGeneration: 1 });
    const handoff = f.continuations.handoff({ runId: f.run.runId, artifactId: output.artifactId, writerGeneration: 1,
      validationClaims: [{ command: 'npm run check', outcome: 'passed', candidateSha: output.headSha, source: 'agent_claim' }] });
    assert.equal(handoff.launchInput.sourceBundleId,'bundle-1');
    assert.equal(handoff.launchInput.baseCommitSha,'b'.repeat(40));
    assert.equal(handoff.output.artifactId,output.artifactId);
    assert.equal(handoff.candidateSha,output.headSha);
    assert.equal(handoff.validationClaims[0]?.source,'agent_claim');
    assert.equal(f.executions.get('execution-1')?.lifecycle,'active');
    assert.throws(() => f.continuations.handoff({ runId: f.run.runId, artifactId: output.artifactId, writerGeneration: 1,
      validationClaims: [{ command: 'check', outcome: 'passed', candidateSha: 'wrong', source: 'agent_claim' }] }));
  } finally { f.close(); }
});

test('verified stop, checkpoint, restore and replacement retain job usage and fence old callbacks',async () => {
  const f = await setup();
  try {
    await f.stop();
    const output = f.sources.capture({ commandId: 'stopped-source', runId: f.run.runId, writerGeneration: 1 });
    const replacement = await f.continuations.replace({ runId: f.run.runId, artifactId: output.artifactId,
      restoreCommandId: 'restore-replacement', destination: join(f.directory,'replacement'), newExecutionId: 'execution-2',
      authority, policy, writerGeneration: 1 });
    assert.equal(replacement.lifecycle,'reserved');
    assert.equal(f.executions.get('execution-1')?.terminalOutcome,'replaced_preserved');
    assert.equal(f.accounting.usage({ jobId: 'job-1' },'output_tokens').value,50);
    assert.equal(f.accounting.activeTime({ jobId: 'job-1' }).value,10000);
    f.database.prepare('UPDATE controller_writer SET generation = 2').run();
    assert.throws(() => f.accounting.record({ observationId: 'stale', runId: f.run.runId, taskId: f.run.taskId,
      ownershipGeneration: 1, observedAt: f.now.toISOString(), kind: 'signal', signal: 'progress', sequence: 2 },1),{ code: 'STALE_GENERATION' });
    assert.equal(f.executions.get('execution-2')?.lifecycle,'reserved');
  } finally { f.close(); }
});

test('reuse rechecks exact task, workspace, readiness and budget',async () => {
  const f = await setup();
  try {
    const execution = await f.continuations.reuse({ runId: f.run.runId, authority, policy, writerGeneration: 1,
      inspectWorkspace: async () => ({ taskId: f.run.taskId, usable: true }) });
    assert.equal(execution.executionId,'execution-1');
    await assert.rejects(f.continuations.reuse({ runId: f.run.runId, authority, policy, writerGeneration: 1,
      inspectWorkspace: async () => ({ taskId: 'wrong', usable: true }) }),{ code: 'CONTINUATION_UNVERIFIED' });
    f.database.prepare('UPDATE jobs SET scope_revision_id = ? WHERE job_id = ?').run('changed','job-1');
    await assert.rejects(f.continuations.reuse({ runId: f.run.runId, authority, policy, writerGeneration: 1,
      inspectWorkspace: async () => ({ taskId: f.run.taskId, usable: true }) }),{ code: 'CONTINUATION_AUTHORITY_STALE' });
  } finally { f.close(); }
});

test('corrupting a settled archive closes even the low-level terminal and replacement paths',async () => {
  const f = await setup();
  try {
    await f.stop();
    const output = f.sources.capture({ commandId: 'archive', runId: f.run.runId, writerGeneration: 1 });
    await f.sources.settle(f.run.runId,output.artifactId,f.stops,1);
    appendFileSync(join(f.directory,'artifacts',createHash('sha256').update(output.artifactId).digest('hex')+'.json.gz'),'corrupt');
    const execution = f.executions.get('execution-1'); assert.ok(execution);
    assert.throws(() => f.executions.transition({ executionId: execution.executionId, expectedVersion: execution.rowVersion,
      writerGeneration: 1, lifecycle: 'terminal', terminalOutcome: 'unsafe' }),{ code: 'EXECUTION_UNSETTLED' });
  } finally { f.close(); }
});
