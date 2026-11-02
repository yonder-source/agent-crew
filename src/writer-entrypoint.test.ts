import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

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
    assert.equal(firstHealth.writerGeneration, 1);

    const competing = start();
    assert.equal(await waitForExit(competing), 75);
    assert.equal((await waitForHealth(address)).writerGeneration, 1);

    const firstExit = waitForExit(first);
    first.kill('SIGTERM');
    assert.equal(await firstExit, 0);
    first = undefined;

    replacement = start();
    const replacementHealth = await waitForHealth(address);
    assert.equal(replacementHealth.writerGeneration, 2);
    assert.equal(replacementHealth.writerStatus, 'healthy');
  } finally {
    for (const child of [first, replacement]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all([first, replacement].filter((child): child is ChildProcess => child !== undefined)
      .map((child) => waitForExit(child).catch(() => 1)));
    rmSync(directory, { recursive: true, force: true });
  }
});
