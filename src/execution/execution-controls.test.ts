import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardFixture } from '../../tests/fixtures/execution-guard-fixture.js';
import { ExecutionAccounting } from './execution-accounting.js';
import { ExecutionCommands, ExecutionStopCoordinator, type ExecutionControlSupervisor } from './execution-controls.js';
import { ExecutionGuards, type ExecutionGuardPolicy } from './execution-guards.js';
import { StateContext } from '../state/state-common.js';

const policy: ExecutionGuardPolicy = {
  revisionId: 'budget-1', activeLimitMs: 1200000, activeWarningMs: 900000, jobActiveLimitMs: 2400000,
  meteringGraceMs: 5000, progressGraceMs: 10000, burnWindowMs: 1000, maxOutputTokensPerMs: 100,
  usageLimits: [{ metric: 'output_tokens', executionLimit: 100, jobLimit: 200 }],
};

async function setup() {
  const f = await createGuardFixture();
  let inference: 'running' | 'stopped' | 'unknown' = 'running';
  let inferenceCalls = 0;
  let taskCalls = 0;
  const supervisor: ExecutionControlSupervisor = {
    ...f.supervisor,
    async terminateInference() { inferenceCalls++; inference = 'stopped'; },
    async terminateTask(request) { taskCalls++; return f.supervisor.terminateTask(request); },
    async inspectInference() { return inference; },
    async configureDeadline() { throw new Error('not configured'); },
    async inspectDeadline() { return null; },
  };
  const commands = new ExecutionCommands(f.state, f.accounting);
  const stops = new ExecutionStopCoordinator(f.state, f.accounting, f.launcher, commands, supervisor, 10);
  return { ...f, supervisor, commands, stops, calls: () => ({ inferenceCalls, taskCalls }),
    stop() {
      const job = f.jobs.get('job-1'); const execution = f.executions.get('execution-1');
      assert.ok(job && execution);
      return stops.request({ runId: f.run.runId, reason: 'human_pause', control: 'pause',
        authority: { actor: 'human:1', grantId: 'stop-1', action: 'execution.stop' },
        expectedJobVersion: job.rowVersion, expectedExecutionVersion: execution.rowVersion, writerGeneration: 1 });
    } };
}

test('persists one authorized stop, inspects exact inference and task, and never blindly resends', async () => {
  const f = await setup();
  try {
    const intent = f.stop();
    assert.equal(f.jobs.get('job-1')?.requestedControl, 'pause');
    assert.equal(f.executions.get('execution-1')?.lifecycle, 'stopping');
    assert.equal(f.stop().commandId, intent.commandId);
    assert.equal((await f.stops.dispatch(intent.commandId, 1)).stopped, false);
    assert.deepEqual(f.calls(), { inferenceCalls: 1, taskCalls: 1 });
    await f.stops.dispatch(intent.commandId, 1);
    assert.deepEqual(f.calls(), { inferenceCalls: 1, taskCalls: 1 });
    f.setStatus('stopped');
    assert.equal((await f.stops.reconcile(intent.commandId, 1)).stopped, true);
    assert.equal(f.executions.get('execution-1')?.lifecycle, 'stopping');
    assert.equal(f.commands.forRun(f.run.runId, 'stop').length, 1);
  } finally { f.close(); }
});

test('a hanging inference request cannot prevent task termination or prove inference stopped', async () => {
  const f = await setup();
  try {
    f.supervisor.terminateInference = () => new Promise(() => {});
    const intent = f.stop();
    assert.equal((await f.stops.dispatch(intent.commandId, 1)).stopped, false);
    assert.equal(f.calls().taskCalls, 1);
    assert.equal(f.commands.get(intent.commandId)?.started, true);
  } finally { f.close(); }
});

test('a replaced writer receipt is retained as history without changing current command evidence',async () => {
  const f = await setup();
  try {
    const intent = f.stop();
    await f.stops.dispatch(intent.commandId,1);
    const before = f.commands.get(intent.commandId)?.receiptJson;
    f.database.prepare('UPDATE controller_writer SET generation = 2').run();
    assert.throws(() => f.commands.receipt(intent.commandId,{ stopped: true, source: 'old_writer' },1),{ code: 'STALE_GENERATION' });
    assert.equal(f.commands.get(intent.commandId)?.receiptJson,before);
    const history = f.database.prepare("SELECT receipt_json FROM execution_command_observations WHERE command_id = ? AND disposition = 'history'")
      .get(intent.commandId) as { receipt_json: string };
    assert.equal(JSON.parse(history.receipt_json).source,'old_writer');
  } finally { f.close(); }
});

test('metering gaps create a durable stop and duplicate evaluations preserve its identity', async () => {
  const f = await setup();
  try {
    const now = new Date(Date.parse(f.run.boundAt) + 6000);
    f.database.prepare('UPDATE controller_writer SET heartbeat_at = ?').run(now.toISOString());
    const state = new StateContext(f.database, () => now);
    const accounting = new ExecutionAccounting(state, f.launcher);
    const commands = new ExecutionCommands(state, accounting);
    const stops = new ExecutionStopCoordinator(state, accounting, f.launcher, commands, f.supervisor, 10);
    const guards = new ExecutionGuards(state, accounting, commands, stops);
    const first = guards.evaluate(f.run.runId, policy, 1);
    assert.equal(first.action, 'stop');
    assert.ok(first.reasons.includes('output_tokens_metering_stale'));
    assert.equal(guards.evaluate(f.run.runId, policy, 1).stopCommandId, first.stopCommandId);
    assert.equal(commands.forRun(f.run.runId, 'stop').length, 1);
    assert.equal(f.executions.get('execution-1')?.lifecycle, 'stopping');
  } finally { f.close(); }
});

test('native loop signals and observed usage exhaustion use the same exact-run stop path', async () => {
  const f = await setup();
  try {
    f.accounting.record({ observationId: 'usage-limit', runId: f.run.runId, taskId: f.run.taskId, ownershipGeneration: 1,
      observedAt: new Date().toISOString(), kind: 'usage', metric: 'output_tokens', epoch: 'one', sequence: 1,
      responseId: null, final: false, value: 101, coverage: 'observed' }, 1);
    f.accounting.record({ observationId: 'loop', runId: f.run.runId, taskId: f.run.taskId, ownershipGeneration: 1,
      observedAt: new Date().toISOString(), kind: 'signal', signal: 'native_loop', sequence: 1 }, 1);
    const result = new ExecutionGuards(f.state, f.accounting, f.commands, f.stops).evaluate(f.run.runId, policy, 1);
    assert.equal(result.action, 'stop');
    assert.ok(result.reasons.includes('native_loop_detected'));
    assert.ok(result.reasons.includes('execution_output_tokens_exhausted'));
    assert.equal(result.stopCommandId, 'stop:run-1');
    assert.throws(() => f.stops.request({ runId: 'run-1', reason: 'stale', control: 'pause',
      authority: { actor: 'human:1', grantId: 'grant', action: 'execution.stop' },
      expectedJobVersion: 1, expectedExecutionVersion: 1, writerGeneration: 1 }), { code: 'STALE_ROW_VERSION' });
  } finally { f.close(); }
});
