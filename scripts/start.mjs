import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const lockPath = process.env.LOCK_PATH?.trim() || './state/controller.lock';
const controllerArguments = process.argv.slice(2);
mkdirSync(dirname(resolve(lockPath)), { recursive: true });

const controller = spawn(
  'flock',
  [
    '--no-fork',
    '--nonblock',
    '--conflict-exit-code',
    '75',
    lockPath,
    process.execPath,
    ...(controllerArguments.length > 0 ? controllerArguments : ['dist/main.js']),
  ],
  { stdio: 'inherit', env: process.env },
);

let settled = false;
const forwardSignal = (signal) => controller.kill(signal);
process.on('SIGINT', forwardSignal);
process.on('SIGTERM', forwardSignal);

controller.once('error', (error) => {
  if (settled) return;
  settled = true;
  console.error(JSON.stringify({
    level: 'fatal',
    message: 'Unable to start Controller; flock is required for single-writer protection',
    errorName: error.name,
  }));
  process.exitCode = 1;
});

controller.once('exit', (code) => {
  if (settled) return;
  settled = true;
  if (code === 75) {
    console.error(JSON.stringify({
      level: 'fatal',
      message: 'Another Controller process holds the installation writer lock',
    }));
  }
  process.exitCode = code ?? 1;
});
