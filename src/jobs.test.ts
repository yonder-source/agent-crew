import assert from 'node:assert/strict';
import test from 'node:test';
import { StateError } from './state-common.js';
import { createJob, createStateFixture } from './state-fixture.js';

test('creates one job per repository issue and appends ordered versioned events', () => {
  const fixture = createStateFixture();
  try {
    const created = createJob(fixture.jobs);
    const duplicate = createJob(fixture.jobs);
    assert.equal(duplicate.jobId, created.jobId);
    assert.equal(duplicate.rowVersion, 1);

    const changed = fixture.jobs.transition({
      jobId: created.jobId,
      expectedVersion: created.rowVersion,
      writerGeneration: 1,
      phase: 'waiting',
      requestedControl: 'pause',
      eventType: 'job_paused',
      eventPayload: { reason: 'human_request' },
    });
    assert.equal(changed.rowVersion, 2);
    assert.equal(changed.requestedControl, 'pause');
    assert.deepEqual(fixture.jobs.listEvents(created.jobId).map((event) => event.sequence), [1, 2]);
  } finally {
    fixture.close();
  }
});

test('rejects stale job versions and preserves the rejection in history', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.jobs.transition({
      jobId: job.jobId,
      expectedVersion: job.rowVersion,
      writerGeneration: 1,
      phase: 'active',
      eventType: 'phase_changed',
    });

    assert.throws(() => fixture.jobs.transition({
      jobId: job.jobId,
      expectedVersion: job.rowVersion,
      writerGeneration: 1,
      requestedControl: 'cancel',
      eventType: 'cancel_requested',
    }), (error: unknown) => error instanceof StateError && error.code === 'STALE_ROW_VERSION');

    const current = fixture.jobs.get(job.jobId);
    assert.equal(current?.rowVersion, 2);
    assert.equal(current?.requestedControl, 'run');
    assert.equal(current?.eventSequence, 3);
    assert.equal(fixture.jobs.listEvents(job.jobId).at(-1)?.eventType, 'job_transition_rejected_stale_row_version');
  } finally {
    fixture.close();
  }
});

test('rejects writes from replaced generations without applying them', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const now = new Date().toISOString();
    fixture.database.prepare(`
      UPDATE controller_writer
      SET generation = 2, status = 'healthy', heartbeat_at = ?, updated_at = ?
      WHERE singleton_id = 1
    `).run(now, now);

    assert.throws(() => fixture.jobs.transition({
      jobId: job.jobId,
      expectedVersion: job.rowVersion,
      writerGeneration: 1,
      phase: 'corrupted',
      eventType: 'late_write',
    }), (error: unknown) => error instanceof StateError && error.code === 'STALE_GENERATION');

    const event = fixture.jobs.listEvents(job.jobId).at(-1);
    assert.equal(fixture.jobs.get(job.jobId)?.phase, 'queued');
    assert.equal(fixture.jobs.get(job.jobId)?.rowVersion, 1);
    assert.equal(event?.writerGeneration, 1);
    assert.equal(event?.eventType, 'job_transition_rejected_stale_generation');
  } finally {
    fixture.close();
  }
});

test('marks an expired writer unhealthy and records the rejected mutation', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const stale = new Date(Date.now() - 16_000).toISOString();
    fixture.database.prepare(`
      UPDATE controller_writer SET heartbeat_at = ?, updated_at = ? WHERE singleton_id = 1
    `).run(stale, stale);

    assert.throws(() => fixture.jobs.transition({
      jobId: job.jobId,
      expectedVersion: job.rowVersion,
      writerGeneration: 1,
      phase: 'corrupted',
      eventType: 'late_write',
    }), (error: unknown) => error instanceof StateError && error.code === 'WRITER_UNHEALTHY');

    const writer = fixture.database.prepare(
      'SELECT status FROM controller_writer WHERE singleton_id = 1',
    ).get() as { status: string };
    assert.equal(writer.status, 'unhealthy');
    assert.equal(fixture.jobs.get(job.jobId)?.phase, 'queued');
    assert.equal(fixture.jobs.listEvents(job.jobId).at(-1)?.eventType, 'job_transition_rejected_writer_unhealthy');
  } finally {
    fixture.close();
  }
});

test('persists blockers and rejects updates from stale job versions', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const blocked = fixture.jobs.addBlocker({
      blockerId: 'blocker-1',
      jobId: job.jobId,
      code: 'needs_human',
      details: { questionId: 'question-1' },
      writerGeneration: 1,
    });
    assert.equal(blocked.rowVersion, 2);

    assert.throws(() => fixture.jobs.resolveBlocker({
      blockerId: 'blocker-1',
      expectedJobVersion: job.rowVersion,
      writerGeneration: 1,
    }), (error: unknown) => error instanceof StateError && error.code === 'STALE_ROW_VERSION');

    const resolved = fixture.jobs.resolveBlocker({
      blockerId: 'blocker-1',
      expectedJobVersion: blocked.rowVersion,
      writerGeneration: 1,
    });
    assert.equal(resolved.rowVersion, 3);
    assert.equal(fixture.jobs.listBlockers(job.jobId)[0]?.status, 'resolved');
    assert.equal(fixture.jobs.listEvents(job.jobId).at(-1)?.eventType, 'blocker_resolved');
  } finally {
    fixture.close();
  }
});
