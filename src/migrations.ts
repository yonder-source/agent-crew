import type Database from 'better-sqlite3';
import type { Migration } from './database.js';

export const controllerMigrations: Migration[] = [
  { version: 1, name: 'controller-foundation', up: () => undefined },
  {
    version: 2,
    name: 'durable-workflow-state',
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE controller_writer (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          generation INTEGER NOT NULL CHECK (generation >= 0),
          status TEXT NOT NULL CHECK (status IN ('stopped', 'recovering', 'healthy', 'unhealthy')),
          heartbeat_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO controller_writer (singleton_id, generation, status, heartbeat_at, updated_at)
        VALUES (1, 0, 'stopped', NULL, '1970-01-01T00:00:00.000Z');

        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY CHECK (length(job_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          scope_revision_id TEXT NOT NULL CHECK (length(scope_revision_id) > 0),
          phase TEXT NOT NULL CHECK (length(phase) > 0),
          requested_control TEXT NOT NULL CHECK (requested_control IN ('run', 'pause', 'cancel')),
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (repository_id, issue_id)
        ) STRICT;

        CREATE TABLE executions (
          execution_id TEXT PRIMARY KEY CHECK (length(execution_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          ownership_generation INTEGER NOT NULL CHECK (ownership_generation > 0),
          lifecycle TEXT NOT NULL CHECK (lifecycle IN ('reserved', 'starting', 'active', 'stopping', 'terminal')),
          terminal_outcome TEXT,
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (lifecycle = 'terminal' AND terminal_outcome IS NOT NULL AND length(terminal_outcome) > 0)
            OR (lifecycle <> 'terminal' AND terminal_outcome IS NULL)
          )
        ) STRICT;

        CREATE UNIQUE INDEX one_live_execution_per_job
          ON executions(job_id) WHERE lifecycle <> 'terminal';

        CREATE TABLE job_events (
          event_id INTEGER PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          row_version INTEGER NOT NULL CHECK (row_version > 0),
          event_type TEXT NOT NULL CHECK (length(event_type) > 0),
          payload_json TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation >= 0),
          occurred_at TEXT NOT NULL,
          UNIQUE (job_id, sequence)
        ) STRICT;

        CREATE TRIGGER job_events_prevent_update
        BEFORE UPDATE ON job_events
        BEGIN
          SELECT RAISE(ABORT, 'job_events is append-only');
        END;

        CREATE TRIGGER job_events_prevent_delete
        BEFORE DELETE ON job_events
        BEGIN
          SELECT RAISE(ABORT, 'job_events is append-only');
        END;

        CREATE TABLE job_blockers (
          blocker_id TEXT PRIMARY KEY CHECK (length(blocker_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          code TEXT NOT NULL CHECK (length(code) > 0),
          details_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
          created_generation INTEGER NOT NULL CHECK (created_generation > 0),
          resolved_generation INTEGER,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          CHECK (
            (status = 'open' AND resolved_generation IS NULL AND resolved_at IS NULL)
            OR (status = 'resolved' AND resolved_generation IS NOT NULL AND resolved_at IS NOT NULL)
          )
        ) STRICT;

        CREATE TABLE usage_counters (
          job_id TEXT REFERENCES jobs(job_id),
          execution_id TEXT REFERENCES executions(execution_id),
          metric TEXT NOT NULL CHECK (length(metric) > 0),
          value INTEGER,
          coverage TEXT NOT NULL CHECK (coverage IN ('observed', 'partial', 'unknown')),
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          updated_at TEXT NOT NULL,
          CHECK ((job_id IS NOT NULL AND execution_id IS NULL) OR (job_id IS NULL AND execution_id IS NOT NULL)),
          CHECK (
            (coverage = 'unknown' AND value IS NULL)
            OR (coverage IN ('observed', 'partial') AND value IS NOT NULL AND value >= 0)
          )
        ) STRICT;

        CREATE UNIQUE INDEX job_usage_metric ON usage_counters(job_id, metric) WHERE job_id IS NOT NULL;
        CREATE UNIQUE INDEX execution_usage_metric ON usage_counters(execution_id, metric) WHERE execution_id IS NOT NULL;
      `);
    },
  },
];
