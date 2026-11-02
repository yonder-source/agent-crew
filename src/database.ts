import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { controllerMigrations } from './migrations.js';

export type Migration = {
  version: number;
  name: string;
  up: (database: Database.Database) => void;
};

export type DatabaseOptions = {
  timeoutMs?: number;
};

export function openDatabase(path: string, options: DatabaseOptions = {}): Database.Database {
  const databasePath = path === ':memory:' ? path : resolve(path);

  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath, {
    timeout: options.timeoutMs ?? 5_000,
  });

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.pragma(`busy_timeout = ${options.timeoutMs ?? 5_000}`);
    verifyDatabaseSettings(database, databasePath, options.timeoutMs ?? 5_000);
    runMigrations(database, controllerMigrations);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function verifyDatabaseSettings(
  database: Database.Database,
  databasePath: string,
  timeoutMs: number,
): void {
  const journalMode = database.pragma('journal_mode', { simple: true });
  const synchronous = database.pragma('synchronous', { simple: true });
  const foreignKeys = database.pragma('foreign_keys', { simple: true });
  const busyTimeout = database.pragma('busy_timeout', { simple: true });
  const expectedJournalMode = databasePath === ':memory:' ? 'memory' : 'wal';

  if (journalMode !== expectedJournalMode || synchronous !== 2 || foreignKeys !== 1 || busyTimeout !== timeoutMs) {
    throw new Error('SQLite connection settings do not match the durable state contract');
  }
}

export function runMigrations(database: Database.Database, migrations: Migration[]): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const seen = new Set<number>();

  for (const migration of ordered) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 || seen.has(migration.version)) {
      throw new Error('Migration versions must be unique positive integers');
    }
    seen.add(migration.version);
  }

  const currentVersion = getSchemaVersion(database);
  const latestVersion = ordered.at(-1)?.version ?? 0;

  if (currentVersion > latestVersion) {
    throw new Error('Database schema is newer than this application supports');
  }

  const insertMigration = database.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of ordered) {
    if (migration.version <= currentVersion) {
      continue;
    }

    if (migration.version !== getSchemaVersion(database) + 1) {
      throw new Error('Migration versions must be applied without gaps');
    }

    database.transaction(() => {
      migration.up(database);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

export function getSchemaVersion(database: Database.Database): number {
  const table = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { found: number } | undefined;

  if (!table) {
    return 0;
  }

  const result = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };

  return result.version ?? 0;
}
