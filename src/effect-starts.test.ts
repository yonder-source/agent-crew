import assert from 'node:assert/strict';
import test from 'node:test';
import { createEffectInput, createJob, createStateFixture } from './state-fixture.js';
import { StateError } from './state-common.js';
import { WriterCoordinator } from './writer.js';

for (const requestedControl of ['pause', 'cancel'] as const) {
  test(`blocks accepted effect starts after ${requestedControl}`, () => {
    const fixture = createStateFixture();
    try {
      const job = createJob(fixture.jobs);
      fixture.effects.begin(createEffectInput(fixture, 'operation-1'));
      const current = fixture.jobs.get(job.jobId);
      assert.ok(current);
      const stopped = fixture.jobs.transition({
        jobId: job.jobId,
        expectedVersion: current.rowVersion,
        writerGeneration: 1,
        requestedControl,
        eventType: 'control_changed',
      });
      assert.equal(fixture.effects.claimStepStart('operation-1', 'operation-1-write', 1), false);
      assert.equal(fixture.effects.get('operation-1')?.steps[0]?.attemptCount, 0);
      assert.equal(fixture.effects.listAudit('operation-1').at(-1)?.eventType, 'effect_step_start_rejected_job_control');
      if (requestedControl === 'pause') {
        fixture.jobs.transition({
          jobId: job.jobId,
          expectedVersion: stopped.rowVersion,
          writerGeneration: 1,
          requestedControl: 'run',
          eventType: 'resumed',
        });
        assert.equal(fixture.effects.claimStepStart('operation-1', 'operation-1-write', 1), true);
      }
    } finally {
      fixture.close();
    }
  });
}

for (const lifecycle of ['starting', 'stopping', 'terminal'] as const) {
  test(`rejects execution effects whose authorized execution changed to ${lifecycle}`, () => {
    const fixture = createStateFixture();
    try {
      const job = createJob(fixture.jobs);
      const execution = fixture.executions.reserve({
        executionId: 'execution-1', jobId: job.jobId, expectedJobVersion: job.rowVersion, writerGeneration: 1,
      });
      fixture.effects.begin(createEffectInput(fixture, 'operation-1', {
        executionId: execution.executionId, expectedExecutionVersion: execution.rowVersion,
      }));
      const changed = fixture.executions.transition({
        executionId: execution.executionId, expectedVersion: execution.rowVersion, writerGeneration: 1,
        lifecycle, ...(lifecycle === 'terminal' ? { terminalOutcome: 'cancelled' } : {}),
      });
      assert.equal(fixture.effects.claimStepStart('operation-1', 'operation-1-write', 1), false);
      assert.equal(fixture.effects.get('operation-1')?.steps[0]?.attemptCount, 0);
      if (lifecycle !== 'starting') {
        assert.throws(() => fixture.effects.begin(createEffectInput(fixture, 'operation-2', {
          executionId: changed.executionId, expectedExecutionVersion: changed.rowVersion,
        })), (error: unknown) => error instanceof StateError && error.code === 'EXECUTION_NOT_ELIGIBLE');
      } else {
        fixture.effects.begin(createEffectInput(fixture, 'operation-2', {
          executionId: changed.executionId, expectedExecutionVersion: changed.rowVersion,
        }));
        assert.equal(fixture.effects.claimStepStart('operation-2', 'operation-2-write', 1), true);
      }
    } finally {
      fixture.close();
    }
  });
}

test('replacement cannot start effects belonging to a previous execution owner', async () => {
  const fixture = createStateFixture();
  let writer: WriterCoordinator | undefined;
  try {
    const job = createJob(fixture.jobs);
    const execution = fixture.executions.reserve({
      executionId: 'execution-1', jobId: job.jobId, expectedJobVersion: job.rowVersion, writerGeneration: 1,
    });
    fixture.effects.begin(createEffectInput(fixture, 'operation-1', {
      executionId: execution.executionId, expectedExecutionVersion: execution.rowVersion,
    }));
    writer = await WriterCoordinator.start(fixture.database, (generation) => {
      fixture.effectResults.recoverPendingSteps(generation);
    });
    assert.equal(fixture.effects.get('operation-1')?.operation.writerGeneration, writer.generation);
    assert.equal(fixture.executions.get(execution.executionId)?.ownershipGeneration, 1);
    assert.equal(fixture.effects.claimStepStart('operation-1', 'operation-1-write', writer.generation), false);
    assert.equal(fixture.effects.get('operation-1')?.steps[0]?.attemptCount, 0);
    assert.equal(fixture.effects.listAudit('operation-1').at(-1)?.eventType, 'effect_step_start_rejected_execution');
  } finally {
    writer?.stop();
    fixture.close();
  }
});
