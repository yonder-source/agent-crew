import assert from 'node:assert/strict';
import test from 'node:test';
import { StateError } from './state-common.js';
import { createJob, createStateFixture } from './state-fixture.js';

test('reserves one live execution and enforces its lifecycle and generation', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const execution = fixture.executions.reserve({
      executionId: 'execution-1',
      jobId: job.jobId,
      expectedJobVersion: job.rowVersion,
      writerGeneration: 1,
    });
    assert.equal(execution.lifecycle, 'reserved');
    assert.equal(execution.ownershipGeneration, 1);

    assert.throws(() => fixture.executions.reserve({
      executionId: 'execution-2',
      jobId: job.jobId,
      expectedJobVersion: 2,
      writerGeneration: 1,
    }), (error: unknown) => error instanceof StateError && error.code === 'LIVE_EXECUTION_EXISTS');

    const starting = fixture.executions.transition({
      executionId: execution.executionId,
      expectedVersion: execution.rowVersion,
      writerGeneration: 1,
      lifecycle: 'starting',
      eventPayload: { lifecycle: 'terminal', executionId: 'forged' },
    });
    const startingEvent = fixture.jobs.listEvents(job.jobId).at(-1);
    assert.deepEqual(JSON.parse(startingEvent?.payloadJson ?? '{}'), {
      executionId: execution.executionId,
      lifecycle: 'starting',
    });
    const active = fixture.executions.transition({
      executionId: execution.executionId,
      expectedVersion: starting.rowVersion,
      writerGeneration: 1,
      lifecycle: 'active',
    });
    const terminal = fixture.executions.transition({
      executionId: execution.executionId,
      expectedVersion: active.rowVersion,
      writerGeneration: 1,
      lifecycle: 'terminal',
      terminalOutcome: 'succeeded',
    });
    assert.equal(terminal.terminalOutcome, 'succeeded');
  } finally {
    fixture.close();
  }
});

test('stores cumulative usage by job and execution with unknown coverage preserved', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const execution = fixture.executions.reserve({
      executionId: 'execution-1',
      jobId: job.jobId,
      expectedJobVersion: job.rowVersion,
      writerGeneration: 1,
    });
    const usage = fixture.executions.recordUsage({
      executionId: execution.executionId,
      metric: 'output_tokens',
      value: 42,
      coverage: 'observed',
      writerGeneration: 1,
    });
    assert.throws(() => fixture.executions.recordUsage({
      executionId: execution.executionId,
      metric: 'output_tokens',
      value: 43,
      coverage: 'observed',
      writerGeneration: 1,
    }), (error: unknown) => error instanceof StateError && error.code === 'STALE_ROW_VERSION');
    fixture.executions.recordUsage({
      executionId: execution.executionId,
      metric: 'output_tokens',
      value: 43,
      coverage: 'observed',
      expectedVersion: usage.rowVersion,
      writerGeneration: 1,
    });
    fixture.executions.recordUsage({
      jobId: job.jobId,
      metric: 'input_tokens',
      value: null,
      coverage: 'unknown',
      writerGeneration: 1,
    });

    const counters = fixture.database.prepare(`
      SELECT metric, value, coverage FROM usage_counters
      WHERE job_id = ? OR execution_id = ? ORDER BY metric
    `).all(job.jobId, execution.executionId) as Array<{ metric: string; value: number | null; coverage: string }>;
    assert.deepEqual(counters, [
      { metric: 'input_tokens', value: null, coverage: 'unknown' },
      { metric: 'output_tokens', value: 43, coverage: 'observed' },
    ]);
  } finally {
    fixture.close();
  }
});
