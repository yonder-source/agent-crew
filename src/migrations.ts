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
  {
    version: 3,
    name: 'effect-intent-and-receipts',
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE effect_operations (
          operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          execution_id TEXT REFERENCES executions(execution_id),
          operation_kind TEXT NOT NULL CHECK (length(operation_kind) > 0),
          argument_fingerprint TEXT NOT NULL CHECK (length(argument_fingerprint) = 64),
          target_json TEXT NOT NULL,
          expected_job_version INTEGER NOT NULL CHECK (expected_job_version > 0),
          expected_execution_version INTEGER,
          scope_revision_id TEXT NOT NULL CHECK (length(scope_revision_id) > 0),
          policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'confirmed_success', 'confirmed_failure', 'unknown'
          )),
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (execution_id IS NULL AND expected_execution_version IS NULL)
            OR (execution_id IS NOT NULL AND expected_execution_version > 0)
          )
        ) STRICT;

        CREATE TABLE effect_authorization_evidence (
          operation_id TEXT PRIMARY KEY REFERENCES effect_operations(operation_id),
          caller_identity TEXT NOT NULL CHECK (length(caller_identity) > 0),
          grant_json TEXT NOT NULL,
          target_json TEXT NOT NULL,
          expected_job_version INTEGER NOT NULL CHECK (expected_job_version > 0),
          expected_execution_version INTEGER,
          scope_revision_id TEXT NOT NULL CHECK (length(scope_revision_id) > 0),
          policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          authorized_at TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER effect_authorization_prevent_update
        BEFORE UPDATE ON effect_authorization_evidence
        BEGIN
          SELECT RAISE(ABORT, 'effect authorization evidence is immutable');
        END;

        CREATE TRIGGER effect_authorization_prevent_delete
        BEFORE DELETE ON effect_authorization_evidence
        BEGIN
          SELECT RAISE(ABORT, 'effect authorization evidence is immutable');
        END;

        CREATE TABLE effect_steps (
          step_id TEXT PRIMARY KEY CHECK (length(step_id) > 0),
          operation_id TEXT NOT NULL REFERENCES effect_operations(operation_id),
          step_key TEXT NOT NULL CHECK (length(step_key) > 0),
          target_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'confirmed_success', 'confirmed_failure', 'unknown'
          )),
          result_json TEXT,
          result_generation INTEGER,
          result_source TEXT CHECK (result_source IN ('provider_receipt', 'reconciliation', 'recovery')),
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (operation_id, step_key),
          CHECK (
            (status = 'pending' AND result_json IS NULL AND result_generation IS NULL AND result_source IS NULL)
            OR (status = 'unknown' AND result_json IS NOT NULL AND result_generation IS NOT NULL AND result_source IS NOT NULL)
            OR (status IN ('confirmed_success', 'confirmed_failure') AND result_json IS NOT NULL AND result_generation > 0 AND result_source IS NOT NULL)
          )
        ) STRICT;

        CREATE TABLE effect_step_dependencies (
          step_id TEXT NOT NULL REFERENCES effect_steps(step_id),
          depends_on_step_id TEXT NOT NULL REFERENCES effect_steps(step_id),
          PRIMARY KEY (step_id, depends_on_step_id),
          CHECK (step_id <> depends_on_step_id)
        ) STRICT;

        CREATE TABLE effect_audit_events (
          event_id INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL REFERENCES effect_operations(operation_id),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          event_type TEXT NOT NULL CHECK (length(event_type) > 0),
          payload_json TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          occurred_at TEXT NOT NULL,
          UNIQUE (operation_id, sequence)
        ) STRICT;

        CREATE TRIGGER effect_audit_prevent_update
        BEFORE UPDATE ON effect_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'effect audit history is append-only');
        END;

        CREATE TRIGGER effect_audit_prevent_delete
        BEFORE DELETE ON effect_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'effect audit history is append-only');
        END;
      `);
    },
  },
  {
    version: 4,
    name: 'effect-operation-replacement-link',
    up: (database: Database.Database) => {
      database.exec(`
        ALTER TABLE effect_operations
        ADD COLUMN replacement_for_operation_id TEXT REFERENCES effect_operations(operation_id);
      `);
    },
  },
  {
    version: 5,
    name: 'effect-step-start-claims',
    up: (database: Database.Database) => {
      database.exec(`
        ALTER TABLE effect_steps
        ADD COLUMN started_generation INTEGER CHECK (started_generation IS NULL OR started_generation > 0);
        ALTER TABLE effect_steps ADD COLUMN started_at TEXT;
        ALTER TABLE effect_steps
        ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
      `);
    },
  },
  {
    version: 6,
    name: 'issue-scope-and-read-observations',
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE issue_scope_revisions (
          scope_revision_id TEXT PRIMARY KEY CHECK (length(scope_revision_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          source_revision_id TEXT NOT NULL CHECK (length(source_revision_id) > 0),
          content_fingerprint TEXT NOT NULL CHECK (length(content_fingerprint) = 64),
          title TEXT NOT NULL CHECK (length(title) > 0),
          body TEXT NOT NULL,
          dependency_issue_ids_json TEXT NOT NULL,
          template_version TEXT NOT NULL CHECK (length(template_version) > 0),
          policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
          observed_at TEXT NOT NULL,
          created_generation INTEGER NOT NULL CHECK (created_generation > 0),
          UNIQUE (repository_id, issue_id, content_fingerprint)
        ) STRICT;

        CREATE TABLE issue_read_observations (
          observation_id TEXT PRIMARY KEY CHECK (length(observation_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          observation_sequence INTEGER NOT NULL CHECK (observation_sequence > 0),
          based_on_head_version INTEGER NOT NULL CHECK (based_on_head_version >= 0),
          status TEXT NOT NULL CHECK (status IN (
            'complete', 'unavailable', 'incomplete', 'binding_mismatch', 'superseded'
          )),
          scope_revision_id TEXT REFERENCES issue_scope_revisions(scope_revision_id),
          source_revision_id TEXT,
          content_fingerprint TEXT CHECK (content_fingerprint IS NULL OR length(content_fingerprint) = 64),
          observed_at TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          UNIQUE (repository_id, issue_id, observation_sequence),
          CHECK (
            (status IN ('complete', 'superseded') AND scope_revision_id IS NOT NULL
              AND source_revision_id IS NOT NULL AND content_fingerprint IS NOT NULL)
            OR (status IN ('unavailable', 'incomplete', 'binding_mismatch')
              AND scope_revision_id IS NULL AND source_revision_id IS NULL AND content_fingerprint IS NULL)
          )
        ) STRICT;

        CREATE TABLE issue_read_heads (
          repository_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          head_version INTEGER NOT NULL CHECK (head_version > 0),
          observation_id TEXT NOT NULL UNIQUE REFERENCES issue_read_observations(observation_id),
          PRIMARY KEY (repository_id, issue_id)
        ) STRICT;

        CREATE TRIGGER issue_scope_revisions_prevent_update
        BEFORE UPDATE ON issue_scope_revisions
        BEGIN
          SELECT RAISE(ABORT, 'issue scope revisions are immutable');
        END;

        CREATE TRIGGER issue_scope_revisions_prevent_delete
        BEFORE DELETE ON issue_scope_revisions
        BEGIN
          SELECT RAISE(ABORT, 'issue scope revisions are immutable');
        END;

        CREATE TRIGGER issue_read_observations_prevent_update
        BEFORE UPDATE ON issue_read_observations
        BEGIN
          SELECT RAISE(ABORT, 'issue read observations are append-only');
        END;

        CREATE TRIGGER issue_read_observations_prevent_delete
        BEFORE DELETE ON issue_read_observations
        BEGIN
          SELECT RAISE(ABORT, 'issue read observations are append-only');
        END;
      `);
    },
  },
  {
    version: 7,
    name: 'issue-readiness-evidence',
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE readiness_evidence (
          evidence_id TEXT PRIMARY KEY CHECK (length(evidence_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          scope_revision_id TEXT NOT NULL REFERENCES issue_scope_revisions(scope_revision_id),
          source TEXT NOT NULL CHECK (source IN ('github_label_event', 'slack_approval')),
          approver_identity TEXT NOT NULL CHECK (length(approver_identity) > 0),
          authority_evidence_json TEXT NOT NULL,
          github_label_event_id TEXT,
          slack_conversation_id TEXT,
          slack_approval_receipt_id TEXT,
          label_write_operation_id TEXT,
          label_present INTEGER NOT NULL CHECK (label_present IN (0, 1)),
          observed_at TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          CHECK (
            (source = 'github_label_event' AND github_label_event_id IS NOT NULL
              AND slack_conversation_id IS NULL AND slack_approval_receipt_id IS NULL
              AND label_write_operation_id IS NULL)
            OR (source = 'slack_approval' AND github_label_event_id IS NULL
              AND slack_conversation_id IS NOT NULL AND slack_approval_receipt_id IS NOT NULL
              AND label_write_operation_id IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX readiness_evidence_issue_idx
        ON readiness_evidence (repository_id, issue_id, observed_at);

        CREATE TRIGGER readiness_evidence_prevent_update
        BEFORE UPDATE ON readiness_evidence
        BEGIN
          SELECT RAISE(ABORT, 'readiness evidence is immutable');
        END;

        CREATE TRIGGER readiness_evidence_prevent_delete
        BEFORE DELETE ON readiness_evidence
        BEGIN
          SELECT RAISE(ABORT, 'readiness evidence is immutable');
        END;
      `);
    },
  },
];
