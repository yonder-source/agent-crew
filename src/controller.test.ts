import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLogger, startController } from './controller.js';

test('serves health and closes its database connection cleanly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-crew-controller-'));
  const controller = await startController({
    host: '127.0.0.1',
    port: 0,
    databasePath: join(directory, 'controller.sqlite'),
    lockPath: join(directory, 'controller.lock'),
    logLevel: 'silent',
  }, createLogger('silent'));

  try {
    const response = await fetch(`${controller.address}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      schemaVersion: 3,
      writerGeneration: 1,
      writerStatus: 'healthy',
    });

    const missing = await fetch(`${controller.address}/`);
    assert.equal(missing.status, 404);
  } finally {
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
