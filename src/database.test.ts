import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { getSchemaVersion, openDatabase, runMigrations } from './database.js';

test('initializes an empty database and safely reopens it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-crew-db-'));
  const path = join(directory, 'controller.sqlite');

  try {
    const first = openDatabase(path);
    assert.equal(getSchemaVersion(first), 5);
    assert.equal(first.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(first.pragma('synchronous', { simple: true }), 2);
    assert.equal(first.pragma('busy_timeout', { simple: true }), 5_000);
    assert.equal(first.pragma('foreign_keys', { simple: true }), 1);
    first.close();

    const second = openDatabase(path);
    assert.equal(getSchemaVersion(second), 5);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verifies required SQLite durability and constraint settings on open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-crew-db-settings-'));
  const path = join(directory, 'controller.sqlite');

  try {
    const database = openDatabase(path, { timeoutMs: 750 });
    assert.equal(database.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(database.pragma('synchronous', { simple: true }), 2);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(database.pragma('busy_timeout', { simple: true }), 750);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('records successful migrations and rolls back a failed migration', () => {
  const database = new Database(':memory:');

  try {
    runMigrations(database, [{
      version: 1,
      name: 'first',
      up: (connection) => connection.exec('CREATE TABLE first_table (id INTEGER PRIMARY KEY)'),
    }]);

    assert.throws(() => runMigrations(database, [{
      version: 2,
      name: 'broken',
      up: (connection) => {
        connection.exec('CREATE TABLE rolled_back (id INTEGER PRIMARY KEY)');
        throw new Error('migration failed');
      },
    }]), /migration failed/);

    assert.equal(getSchemaVersion(database), 1);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'rolled_back'").get(), undefined);
  } finally {
    database.close();
  }
});

test('rejects unsupported future schema versions', () => {
  const database = new Database(':memory:');

  try {
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    database.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(2, 'future', 'now');

    assert.throws(() => runMigrations(database, [{
      version: 1,
      name: 'current',
      up: () => undefined,
    }]), /newer than this application supports/);
  } finally {
    database.close();
  }
});
