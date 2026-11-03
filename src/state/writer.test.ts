import assert from 'node:assert/strict';
import test from 'node:test';
import { createStateFixture } from '../../tests/fixtures/state-fixture.js';
import { WriterCoordinator } from './writer.js';

test('increments generation and remains recovering until recovery completes', async () => {
  const fixture = createStateFixture();
  fixture.database.prepare(`
    UPDATE controller_writer SET generation = 0, status = 'stopped', heartbeat_at = NULL
    WHERE singleton_id = 1
  `).run();
  let finishRecovery: (() => void) | undefined;
  const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
  const starting = WriterCoordinator.start(fixture.database, () => recovery, () => new Date(), 60_000);
  try {
    const recovering = fixture.database.prepare(
      'SELECT generation, status FROM controller_writer WHERE singleton_id = 1',
    ).get() as { generation: number; status: string };
    assert.deepEqual(recovering, { generation: 1, status: 'recovering' });

    finishRecovery?.();
    const writer = await starting;
    assert.deepEqual(writer.status(), {
      generation: 1,
      status: 'healthy',
      heartbeatAt: writer.status().heartbeatAt,
    });
    writer.stop();
    assert.equal(writer.status().status, 'stopped');
  } finally {
    fixture.close();
  }
});

test('marks a missed-heartbeat writer unhealthy without changing generation', async () => {
  const fixture = createStateFixture();
  let currentTime = new Date();
  const writer = await WriterCoordinator.start(
    fixture.database,
    () => undefined,
    () => currentTime,
    5,
  );
  try {
    currentTime = new Date(currentTime.getTime() + 15_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(writer.status().generation, 2);
    assert.equal(writer.status().status, 'unhealthy');
    writer.stop();
    assert.equal(writer.status().status, 'stopped');
  } finally {
    fixture.close();
  }
});

test('keeps a failed recovery unavailable and releases its generation cleanly', async () => {
  const fixture = createStateFixture();
  try {
    await assert.rejects(WriterCoordinator.start(
      fixture.database,
      () => { throw new Error('recovery failed'); },
    ), /recovery failed/);
    const writer = fixture.database.prepare(
      'SELECT generation, status FROM controller_writer WHERE singleton_id = 1',
    ).get() as { generation: number; status: string };
    assert.deepEqual(writer, { generation: 2, status: 'stopped' });
  } finally {
    fixture.close();
  }
});
