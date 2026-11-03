import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createSourceFixture } from '../../tests/fixtures/execution-source-fixture.js';

test('terminal and replacement remain blocked until stop, checkpoint and effects are settled', async () => {
  const f = await createSourceFixture();
  try {
    const execution = f.executions.get('execution-1'); assert.ok(execution);
    assert.throws(() => f.executions.transition({ executionId: execution.executionId, expectedVersion: execution.rowVersion,
      writerGeneration: 1, lifecycle: 'terminal', terminalOutcome: 'shortcut' }),{ code: 'EXECUTION_UNSETTLED' });
    await f.stop();
    const artifact = f.sources.capture({ commandId: 'capture-1', runId: f.run.runId, writerGeneration: 1 });
    assert.equal(artifact.kind,'stopped_checkpoint');
    assert.equal(artifact.status,'verified');
    assert.equal(f.sources.capture({ commandId: 'capture-1', runId: f.run.runId, writerGeneration: 1 }).artifactId,artifact.artifactId);
    await f.sources.settle(f.run.runId,artifact.artifactId,f.stops,1);
    const stopped = f.executions.get('execution-1'); assert.ok(stopped);
    f.executions.transition({ executionId: stopped.executionId, expectedVersion: stopped.rowVersion, writerGeneration: 1,
      lifecycle: 'terminal', terminalOutcome: 'paused_preserved' });
    assert.equal(f.executions.get('execution-1')?.lifecycle,'terminal');
    rmSync(f.workspace,{ recursive: true });
    const restored = f.sources.restore({ commandId: 'restore-1', artifactId: artifact.artifactId,
      destination: join(f.directory,'restored'), writerGeneration: 1 });
    assert.equal(restored.head,artifact.headSha);
    assert.equal(f.sources.restore({ commandId: 'restore-1', artifactId: artifact.artifactId,
      destination: join(f.directory,'restored'), writerGeneration: 1 }).head,artifact.headSha);
  } finally { f.close(); }
});

test('an active handoff archive cannot satisfy the stopped-source replacement barrier', async () => {
  const f = await createSourceFixture();
  try {
    const artifact = f.sources.capture({ commandId: 'active-capture', runId: f.run.runId, writerGeneration: 1 });
    assert.equal(artifact.kind,'handoff');
    assert.equal(f.executions.get('execution-1')?.lifecycle,'active');
    await f.stop();
    await assert.rejects(f.sources.settle(f.run.runId,artifact.artifactId,f.stops,1),{ code: 'CHECKPOINT_REQUIRED' });
  } finally { f.close(); }
});

test('reconciles an archive written before its receipt and a restore completed before its receipt',async () => {
  const f = await createSourceFixture();
  try {
    await f.stop();
    f.database.exec(`CREATE TRIGGER interrupt_capture BEFORE UPDATE ON source_artifacts
      BEGIN SELECT RAISE(ABORT, 'interrupted receipt'); END;`);
    assert.throws(() => f.sources.capture({ commandId: 'lost-capture', runId: f.run.runId, writerGeneration: 1 }));
    f.database.exec('DROP TRIGGER interrupt_capture');
    const artifact = f.sources.reconcile('lost-capture',1);
    assert.equal(artifact.status,'verified');
    const request = { commandId: 'lost-restore', artifactId: artifact.artifactId,
      destination: join(f.directory,'restored-after-loss'), writerGeneration: 1 };
    f.database.exec(`CREATE TRIGGER interrupt_restore BEFORE INSERT ON execution_command_observations
      WHEN NEW.command_id = 'lost-restore' BEGIN SELECT RAISE(ABORT, 'interrupted receipt'); END;`);
    assert.throws(() => f.sources.restore(request));
    f.database.exec('DROP TRIGGER interrupt_restore');
    assert.equal(f.sources.restore(request).head,artifact.headSha);
  } finally { f.close(); }
});

for (const scenario of ['never_created', 'removed'] as const) {
  test(`missing restore destination remains a modeled reconciliation state: ${scenario}`, async () => {
    const f = await createSourceFixture();
    try {
      await f.stop();
      const artifact = f.sources.capture({ commandId: 'capture-missing-destination', runId: f.run.runId, writerGeneration: 1 });
      const request = { commandId: 'restore-missing-destination', artifactId: artifact.artifactId,
        destination: join(f.directory, 'missing-destination'), writerGeneration: 1 };
      if (scenario === 'never_created') {
        f.commands.intent(request.commandId, artifact.runId, 'checkpoint',
          { action: 'restore', artifactId: artifact.artifactId, destination: request.destination }, 1);
        assert.equal(f.commands.claim(request.commandId, 1), true);
      } else {
        f.sources.restore(request);
        rmSync(request.destination, { recursive: true });
      }
      const before = f.commands.get(request.commandId);
      assert.throws(() => f.sources.restore(request), {
        name: 'StateError', code: 'RESTORE_RECONCILIATION_REQUIRED',
      });
      assert.equal(existsSync(request.destination), false);
      const after = f.commands.get(request.commandId);
      assert.equal(after?.started, true);
      assert.equal(after?.requestJson, before?.requestJson);
      assert.equal(after?.receiptJson, before?.receiptJson);
      assert.equal(f.sources.verify(artifact.artifactId).head, artifact.headSha);
      assert.equal(f.executions.get('execution-1')?.lifecycle, 'stopping');
    } finally { f.close(); }
  });
}

test('a missing source artifact remains a modeled integrity failure with its reference retained', async () => {
  const f = await createSourceFixture();
  try {
    const artifact = f.sources.capture({ commandId: 'missing-artifact', runId: f.run.runId, writerGeneration: 1 });
    const row = f.database.prepare('SELECT storage_path FROM source_artifacts WHERE artifact_id = ?')
      .get(artifact.artifactId) as { storage_path: string };
    rmSync(row.storage_path);
    assert.throws(() => f.sources.verify(artifact.artifactId), { name: 'StateError', code: 'SOURCE_ARTIFACT_INVALID' });
    assert.equal(f.sources.get(artifact.artifactId)?.archiveSha256, artifact.archiveSha256);
  } finally { f.close(); }
});
