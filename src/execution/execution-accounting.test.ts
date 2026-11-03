import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardFixture } from '../../tests/fixtures/execution-guard-fixture.js';
import { ExecutionAccounting, type ExecutionObservation } from './execution-accounting.js';
import { StateContext } from '../state/state-common.js';

function report(run: Awaited<ReturnType<typeof createGuardFixture>>['run'], observationId: string,
  changes: Partial<Extract<ExecutionObservation, { kind: 'usage' }>> = {}): Extract<ExecutionObservation, { kind: 'usage' }> {
  return { observationId, runId: run.runId, taskId: run.taskId, ownershipGeneration: run.ownershipGeneration,
    observedAt: new Date().toISOString(), kind: 'usage', metric: 'output_tokens', epoch: 'epoch-1', sequence: 1,
    responseId: null, final: false, value: 10, coverage: 'observed', ...changes };
}

test('reconciles cumulative snapshots, resets and distinct final responses without double counting', async () => {
  const f = await createGuardFixture();
  try {
    f.accounting.record(report(f.run, 'live-1'), 1);
    f.accounting.record(report(f.run, 'live-2', { value: 20, sequence: 2 }), 1);
    f.accounting.record(report(f.run, 'stale', { value: 5 }), 1);
    const final = report(f.run, 'final', { responseId: 'response-1', final: true, value: 20 });
    f.accounting.record(final, 1);
    f.accounting.record(final, 1);
    assert.equal(f.accounting.usage({ jobId: 'job-1' }, 'output_tokens').value, 20);
    f.accounting.record(report(f.run, 'reset', { epoch: 'epoch-2', value: 7 }), 1);
    f.accounting.record(report(f.run, 'final-2', { responseId: 'response-2', final: true, value: 7 }), 1);
    assert.equal(f.accounting.usage({ executionId: 'execution-1' }, 'output_tokens').value, 27);
    assert.equal(f.accounting.usage({ jobId: 'job-1' }, 'input_tokens').coverage, 'unknown');
    assert.equal(f.accounting.usage({ jobId: 'job-1' }, 'input_tokens').value, null);
    assert.throws(() => f.accounting.record({ ...final, value: 99 }, 1), { code: 'OBSERVATION_ID_CONFLICT' });
    assert.throws(() => f.accounting.record(report(f.run, 'wrong', { taskId: 'another-task' }), 1), { code: 'OBSERVATION_BINDING_MISMATCH' });
  } finally { f.close(); }
});

test('retains late reports and allows explicit current-writer reconciliation without lifecycle changes', async () => {
  const f = await createGuardFixture();
  try {
    const execution = f.executions.get('execution-1'); assert.ok(execution);
    f.executions.transition({ executionId: execution.executionId, expectedVersion: execution.rowVersion, writerGeneration: 1, lifecycle: 'stopping' });
    const late = report(f.run, 'late', { value: 40, final: true, responseId: 'response-1' });
    assert.equal(f.accounting.record(late, 1).historyOnly, true);
    assert.equal(f.accounting.usage({ jobId: 'job-1' }, 'output_tokens').value, null);
    f.accounting.record({ ...late, observationId: 'reconciled' }, 1, true);
    assert.equal(f.accounting.usage({ jobId: 'job-1' }, 'output_tokens').value, 40);
    assert.equal(f.executions.get('execution-1')?.lifecycle, 'stopping');
    assert.equal(f.accounting.observations(f.run.runId, true).length, 2);
    assert.throws(() => f.accounting.record(report(f.run, 'old-writer'), 2), { code: 'STALE_GENERATION' });
  } finally { f.close(); }
});

test('unions replayed active intervals, excludes waiting and exposes Controller-outage gaps after restart', async () => {
  const f = await createGuardFixture();
  try {
    const base = Date.parse(f.run.boundAt);
    const now = new Date(base + 10000);
    f.database.prepare('UPDATE controller_writer SET heartbeat_at = ?').run(now.toISOString());
    const state = new StateContext(f.database, () => now);
    const accounting = new ExecutionAccounting(state, f.launcher);
    const interval = (observationId: string, start: number, end: number, activity: 'active' | 'waiting') => accounting.record({
      observationId, runId: f.run.runId, taskId: f.run.taskId, ownershipGeneration: 1,
      observedAt: now.toISOString(), kind: 'interval', state: activity,
      start: new Date(base + start).toISOString(), end: new Date(base + end).toISOString(),
    }, 1);
    interval('active-1', 0, 3000, 'active');
    interval('active-replay', 1000, 3000, 'active');
    interval('human-wait', 3000, 7000, 'waiting');
    assert.deepEqual(accounting.activeTime({ jobId: 'job-1' }), {
      value: 3000, coverage: 'partial', reasons: ['uncovered_or_conflicting_runtime_intervals'],
    });
    interval('supervisor-outage-evidence', 7000, 10000, 'active');
    const restarted = new ExecutionAccounting(state, f.launcher);
    assert.deepEqual(restarted.activeTime({ executionId: 'execution-1' }), { value: 6000, coverage: 'observed', reasons: [] });
    interval('contradictory-wait', 8000, 9000, 'waiting');
    assert.equal(restarted.activeTime({ jobId: 'job-1' }).coverage, 'partial');
  } finally { f.close(); }
});
