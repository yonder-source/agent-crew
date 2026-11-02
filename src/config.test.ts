import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';

test('loads safe defaults without external credentials', () => {
  const result = loadConfig({});

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.config, {
      host: '127.0.0.1',
      port: 3000,
      databasePath: './state/agent-crew.sqlite',
      lockPath: './state/controller.lock',
      logLevel: 'info',
    });
  }
});

test('rejects invalid ports without echoing their values', () => {
  const result = loadConfig({ PORT: 'not-a-port', API_TOKEN: 'sensitive-token' });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.issues.map((issue) => issue.message).join(' '), /number|expected/i);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-token|not-a-port/);
  }
});
