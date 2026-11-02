import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { EffectStore } from './effects.js';
import { JobStore } from './jobs.js';
import { StateContext } from './state-common.js';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to reserve an ephemeral test port');
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

async function waitForHealth(address: string): Promise<{ writerGeneration: number; writerStatus: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(address);
      if (response.ok) return await response.json() as { writerGeneration: number; writerStatus: string };
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error('Controller did not become healthy before timeout');
}

test('flock prevents a second writer and allows restart with a higher generation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-crew-lock-'));
  const port = await unusedPort();
  const address = `http://127.0.0.1:${port}/healthz`;
  const environment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_PATH: join(directory, 'controller.sqlite'),
    LOCK_PATH: join(directory, 'controller.lock'),
    LOG_LEVEL: 'silent',
  };
  const database = openDatabase(environment.DATABASE_PATH);
  const seededAt = new Date().toISOString();
  database.prepare(`
    UPDATE controller_writer SET generation = 1, status = 'healthy', heartbeat_at = ?, updated_at = ?
    WHERE singleton_id = 1
  `).run(seededAt, seededAt);
  const state = new StateContext(database);
  const job = new JobStore(state).create({
    jobId: 'job-recovery',
    repositoryId: 'repo-1',
    issueId: 'issue-1',
    scopeRevisionId: 'scope-1',
    phase: 'queued',
    writerGeneration: 1,
  });
  new EffectStore(state).begin({
    operationId: 'operation-recovery',
    jobId: job.jobId,
    operationKind: 'github_issue_update',
    arguments: { title: 'Accepted title' },
    target: { issueId: 'issue-1' },
    expectedJobVersion: job.rowVersion,
    scopeRevisionId: 'scope-1',
    policyVersion: 'policy-1',
    callerIdentity: 'human:123',
    grant: { action: 'issue.write' },
    steps: [{ stepId: 'step-recovery', stepKey: 'write', target: { title: 'Accepted title' } }],
    writerGeneration: 1,
  });
  database.prepare(`
    UPDATE controller_writer SET status = 'stopped', updated_at = ? WHERE singleton_id = 1
  `).run(seededAt);
  database.close();
  const start = (): ChildProcess => spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: resolve('.'),
    env: environment,
    stdio: 'ignore',
  });

  let first: ChildProcess | undefined;
  let replacement: ChildProcess | undefined;
  try {
    first = start();
    const firstHealth = await waitForHealth(address);
    assert.equal(firstHealth.writerGeneration, 2);
    const recovered = new Database(environment.DATABASE_PATH, { readonly: true });
    assert.equal((recovered.prepare(
      'SELECT status FROM effect_steps WHERE step_id = ?',
    ).get('step-recovery') as { status: string }).status, 'unknown');
    recovered.close();

    const competing = start();
    assert.equal(await waitForExit(competing), 75);
    assert.equal((await waitForHealth(address)).writerGeneration, 2);

    const firstExit = waitForExit(first);
    first.kill('SIGTERM');
    assert.equal(await firstExit, 0);
    first = undefined;

    replacement = start();
    const replacementHealth = await waitForHealth(address);
    assert.equal(replacementHealth.writerGeneration, 3);
    assert.equal(replacementHealth.writerStatus, 'healthy');
    const stillUnknown = new Database(environment.DATABASE_PATH, { readonly: true });
    assert.equal((stillUnknown.prepare(
      'SELECT status FROM effect_steps WHERE step_id = ?',
    ).get('step-recovery') as { status: string }).status, 'unknown');
    stillUnknown.close();
  } finally {
    for (const child of [first, replacement]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all([first, replacement].filter((child): child is ChildProcess => child !== undefined)
      .map((child) => waitForExit(child).catch(() => 1)));
    rmSync(directory, { recursive: true, force: true });
  }
});
