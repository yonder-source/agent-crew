import type Database from "better-sqlite3";
import type { Migration } from "./database.js";

export const controllerMigrations: Migration[] = [
	{ version: 1, name: "controller-foundation", up: () => undefined },
	{
		version: 2,
		name: "durable-workflow-state",
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
		name: "effect-intent-and-receipts",
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
		name: "effect-operation-replacement-link",
		up: (database: Database.Database) => {
			database.exec(`
        ALTER TABLE effect_operations
        ADD COLUMN replacement_for_operation_id TEXT REFERENCES effect_operations(operation_id);
      `);
		},
	},
	{
		version: 5,
		name: "effect-step-start-claims",
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
		name: "issue-scope-and-read-observations",
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
		name: "issue-readiness-evidence",
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
	{
		version: 8,
		name: "readiness-current-state-and-admission-decisions",
		up: (database: Database.Database) => {
			database.exec(`
        CREATE TABLE readiness_observations (
          observation_id TEXT PRIMARY KEY CHECK (length(observation_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          observation_sequence INTEGER NOT NULL CHECK (observation_sequence > 0),
          based_on_version INTEGER NOT NULL CHECK (based_on_version >= 0),
          status TEXT NOT NULL CHECK (status IN ('complete', 'unavailable', 'superseded')),
          label_present INTEGER,
          approved_actor_identity TEXT,
          observed_at TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          UNIQUE (repository_id, issue_id, observation_sequence),
          CHECK (
            (status = 'complete' AND label_present IN (0, 1))
            OR (status IN ('unavailable', 'superseded') AND label_present IS NULL)
          )
        ) STRICT;

        CREATE TABLE readiness_heads (
          repository_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          head_version INTEGER NOT NULL CHECK (head_version > 0),
          observation_id TEXT NOT NULL UNIQUE REFERENCES readiness_observations(observation_id),
          PRIMARY KEY (repository_id, issue_id)
        ) STRICT;

        CREATE TRIGGER readiness_observations_prevent_update
        BEFORE UPDATE ON readiness_observations
        BEGIN
          SELECT RAISE(ABORT, 'readiness observations are append-only');
        END;

        CREATE TRIGGER readiness_observations_prevent_delete
        BEFORE DELETE ON readiness_observations
        BEGIN
          SELECT RAISE(ABORT, 'readiness observations are append-only');
        END;

        CREATE TABLE admission_decisions (
          decision_id TEXT PRIMARY KEY CHECK (length(decision_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          outcome TEXT NOT NULL CHECK (outcome IN ('blocked', 'clarification', 'stale', 'admitted', 'existing')),
          reason_code TEXT,
          request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
          details_json TEXT NOT NULL,
          job_id TEXT REFERENCES jobs(job_id),
          execution_id TEXT REFERENCES executions(execution_id),
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          decided_at TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER admission_decisions_prevent_update
        BEFORE UPDATE ON admission_decisions
        BEGIN
          SELECT RAISE(ABORT, 'admission decisions are immutable');
        END;

        CREATE TRIGGER admission_decisions_prevent_delete
        BEFORE DELETE ON admission_decisions
        BEGIN
          SELECT RAISE(ABORT, 'admission decisions are immutable');
        END;
      `);
			database.exec(`
        CREATE TEMP TABLE issue_read_heads_v7_backup AS SELECT * FROM issue_read_heads;
        DROP TABLE issue_read_heads;
        CREATE TABLE issue_read_observations_v8 (
          observation_id TEXT PRIMARY KEY CHECK (length(observation_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          observation_sequence INTEGER NOT NULL CHECK (observation_sequence > 0),
          based_on_head_version INTEGER NOT NULL CHECK (based_on_head_version >= 0),
          status TEXT NOT NULL CHECK (status IN (
            'complete', 'unattributable', 'unavailable', 'incomplete', 'binding_mismatch', 'superseded'
          )),
          scope_revision_id TEXT REFERENCES issue_scope_revisions(scope_revision_id),
          source_revision_id TEXT,
          content_fingerprint TEXT CHECK (content_fingerprint IS NULL OR length(content_fingerprint) = 64),
          observed_at TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          UNIQUE (repository_id, issue_id, observation_sequence),
          CHECK (
            (status = 'complete' AND scope_revision_id IS NOT NULL
              AND source_revision_id IS NOT NULL AND content_fingerprint IS NOT NULL)
            OR (status = 'unattributable' AND scope_revision_id IS NULL
              AND source_revision_id IS NOT NULL AND content_fingerprint IS NOT NULL)
            OR (status = 'superseded' AND (
              (source_revision_id IS NOT NULL AND content_fingerprint IS NOT NULL)
              OR (source_revision_id IS NULL AND content_fingerprint IS NULL)
            ))
            OR (status IN ('unavailable', 'incomplete', 'binding_mismatch')
              AND scope_revision_id IS NULL AND source_revision_id IS NULL AND content_fingerprint IS NULL)
          )
        ) STRICT;

        INSERT INTO issue_read_observations_v8 (
          observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
          status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
        ) SELECT observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
          status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
          FROM issue_read_observations;

        DROP TABLE issue_read_observations;
        ALTER TABLE issue_read_observations_v8 RENAME TO issue_read_observations;

        CREATE TABLE issue_read_heads (
          repository_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          head_version INTEGER NOT NULL CHECK (head_version > 0),
          observation_id TEXT NOT NULL UNIQUE REFERENCES issue_read_observations(observation_id),
          PRIMARY KEY (repository_id, issue_id)
        ) STRICT;

        INSERT INTO issue_read_heads (repository_id, issue_id, head_version, observation_id)
        SELECT repository_id, issue_id, head_version, observation_id FROM issue_read_heads_v7_backup;
        DROP TABLE issue_read_heads_v7_backup;

        CREATE TABLE unattributed_issue_snapshots (
          observation_id TEXT PRIMARY KEY REFERENCES issue_read_observations(observation_id),
          title TEXT NOT NULL CHECK (length(title) > 0),
          body TEXT NOT NULL,
          dependency_issue_ids_json TEXT NOT NULL,
          template_version TEXT NOT NULL CHECK (length(template_version) > 0),
          policy_version TEXT NOT NULL CHECK (length(policy_version) > 0)
        ) STRICT;

        CREATE TABLE issue_scope_confirmations (
          confirmation_id TEXT PRIMARY KEY CHECK (length(confirmation_id) > 0),
          observation_id TEXT NOT NULL REFERENCES issue_read_observations(observation_id),
          scope_revision_id TEXT NOT NULL REFERENCES issue_scope_revisions(scope_revision_id),
          confirmed_by TEXT NOT NULL CHECK (length(confirmed_by) > 0),
          authority_evidence_json TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          confirmed_at TEXT NOT NULL
        ) STRICT;

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
        CREATE TRIGGER unattributed_issue_snapshots_prevent_update
        BEFORE UPDATE ON unattributed_issue_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'unattributed issue snapshots are immutable');
        END;
        CREATE TRIGGER unattributed_issue_snapshots_prevent_delete
        BEFORE DELETE ON unattributed_issue_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'unattributed issue snapshots are immutable');
        END;
        CREATE TRIGGER issue_scope_confirmations_prevent_update
        BEFORE UPDATE ON issue_scope_confirmations
        BEGIN
          SELECT RAISE(ABORT, 'issue scope confirmations are immutable');
        END;
        CREATE TRIGGER issue_scope_confirmations_prevent_delete
        BEFORE DELETE ON issue_scope_confirmations
        BEGIN
          SELECT RAISE(ABORT, 'issue scope confirmations are immutable');
        END;

        CREATE TABLE intake_rejection_events (
          rejection_id INTEGER PRIMARY KEY,
          repository_id TEXT CHECK (repository_id IS NULL OR length(repository_id) > 0),
          issue_id TEXT CHECK (issue_id IS NULL OR length(issue_id) > 0),
          operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
          operation TEXT NOT NULL CHECK (length(operation) > 0),
          submitted_generation INTEGER NOT NULL CHECK (submitted_generation > 0),
          current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
          reason_code TEXT NOT NULL CHECK (reason_code IN ('STALE_GENERATION', 'STALE_ROW_VERSION', 'WRITER_UNHEALTHY')),
          rejected_at TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER intake_rejection_events_prevent_update
        BEFORE UPDATE ON intake_rejection_events
        BEGIN
          SELECT RAISE(ABORT, 'intake rejection history is append-only');
        END;

        CREATE TRIGGER intake_rejection_events_prevent_delete
        BEFORE DELETE ON intake_rejection_events
        BEGIN
          SELECT RAISE(ABORT, 'intake rejection history is append-only');
        END;
      `);
		},
	},
	{
		version: 9,
		name: "authorized-prerequisite-confirmations",
		up: (database: Database.Database) => {
			database.exec(`
        CREATE TABLE prerequisite_confirmations (
          confirmation_id TEXT PRIMARY KEY CHECK (length(confirmation_id) > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          scope_revision_id TEXT NOT NULL REFERENCES issue_scope_revisions(scope_revision_id),
          confirmed_by TEXT NOT NULL CHECK (length(confirmed_by) > 0),
          authority_evidence_json TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          confirmed_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX prerequisite_confirmations_scope_idx
        ON prerequisite_confirmations (repository_id, issue_id, scope_revision_id);

        CREATE TRIGGER prerequisite_confirmations_prevent_update
        BEFORE UPDATE ON prerequisite_confirmations
        BEGIN
          SELECT RAISE(ABORT, 'prerequisite confirmations are immutable');
        END;

        CREATE TRIGGER prerequisite_confirmations_prevent_delete
        BEFORE DELETE ON prerequisite_confirmations
        BEGIN
          SELECT RAISE(ABORT, 'prerequisite confirmations are immutable');
        END;
      `);
		},
	},
	{
    version: 10,
    name: "execution-accounting",
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE execution_runs (
          run_id TEXT PRIMARY KEY CHECK(length(run_id) > 0),
          execution_id TEXT NOT NULL REFERENCES executions(execution_id),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          launch_id TEXT NOT NULL REFERENCES effect_operations(operation_id),
          task_id TEXT NOT NULL,
          ownership_generation INTEGER NOT NULL CHECK(ownership_generation > 0),
          bound_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE execution_observations (
          observation_id TEXT PRIMARY KEY CHECK(length(observation_id) > 0),
          run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
          evidence_json TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK(disposition IN ('applied', 'history')),
          writer_generation INTEGER NOT NULL,
          received_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX execution_observations_run ON execution_observations(run_id);
        CREATE TRIGGER execution_runs_no_update BEFORE UPDATE ON execution_runs
        BEGIN SELECT RAISE(ABORT, 'runtime bindings are immutable'); END;
        CREATE TRIGGER execution_runs_no_delete BEFORE DELETE ON execution_runs
        BEGIN SELECT RAISE(ABORT, 'runtime bindings are immutable'); END;
        CREATE TRIGGER execution_observations_no_update BEFORE UPDATE ON execution_observations
        BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
        CREATE TRIGGER execution_observations_no_delete BEFORE DELETE ON execution_observations
        BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
      `);
    },
  },
  {
    version: 11,
    name: "execution-controls",
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE execution_commands (
          command_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
          kind TEXT NOT NULL CHECK(kind IN ('stop', 'deadline', 'checkpoint')),
          request_json TEXT NOT NULL,
          started INTEGER NOT NULL DEFAULT 0 CHECK(started IN (0,1)),
          receipt_json TEXT,
          created_generation INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(run_id, kind, command_id)
        ) STRICT;
        CREATE UNIQUE INDEX one_stop_per_run ON execution_commands(run_id) WHERE kind = 'stop';
        CREATE TABLE execution_command_observations (
          observation_id INTEGER PRIMARY KEY,
          command_id TEXT NOT NULL REFERENCES execution_commands(command_id),
          receipt_json TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK(disposition IN ('applied','history')),
          submitted_generation INTEGER NOT NULL,
          observed_at TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER command_observations_no_update BEFORE UPDATE ON execution_command_observations
        BEGIN SELECT RAISE(ABORT, 'command observations are immutable'); END;
        CREATE TRIGGER command_observations_no_delete BEFORE DELETE ON execution_command_observations
        BEGIN SELECT RAISE(ABORT, 'command observations are immutable'); END;
        CREATE TABLE execution_guard_decisions (
          decision_id INTEGER PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
          policy_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          writer_generation INTEGER NOT NULL,
          decided_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE execution_settlements (
          execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
          stop_command_id TEXT NOT NULL UNIQUE REFERENCES execution_commands(command_id),
          artifact_id TEXT NOT NULL REFERENCES source_artifacts(artifact_id),
          settled_generation INTEGER NOT NULL,
          settled_at TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER execution_guard_decisions_no_update BEFORE UPDATE ON execution_guard_decisions
        BEGIN SELECT RAISE(ABORT, 'guard history is immutable'); END;
        CREATE TRIGGER execution_guard_decisions_no_delete BEFORE DELETE ON execution_guard_decisions
        BEGIN SELECT RAISE(ABORT, 'guard history is immutable'); END;
      `);
    },
  },
  {
    version: 12,
    name: "verified-source-artifacts",
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE source_artifacts (
          artifact_id TEXT PRIMARY KEY,
          command_id TEXT NOT NULL UNIQUE REFERENCES execution_commands(command_id),
          run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
          storage_path TEXT NOT NULL,
          archive_sha256 TEXT NOT NULL CHECK(length(archive_sha256) = 64),
          head_sha TEXT NOT NULL,
          bytes INTEGER NOT NULL CHECK(bytes > 0),
          kind TEXT NOT NULL CHECK(kind IN ('stopped_checkpoint', 'handoff')),
          status TEXT NOT NULL CHECK(status IN ('writing', 'verified')),
          writer_generation INTEGER NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 13,
    name: "candidate-submissions",
    up: (database: Database.Database) => {
      database.exec(`
        CREATE TABLE candidate_submissions (
          candidate_id TEXT PRIMARY KEY CHECK (length(candidate_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          execution_id TEXT NOT NULL REFERENCES executions(execution_id),
          ownership_generation INTEGER NOT NULL CHECK (ownership_generation > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          scope_revision_id TEXT NOT NULL CHECK (length(scope_revision_id) > 0),
          policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
          source_bundle_id TEXT NOT NULL CHECK (length(source_bundle_id) > 0),
          base_sha TEXT NOT NULL CHECK (length(base_sha) IN (40, 64)),
          candidate_sha TEXT NOT NULL CHECK (length(candidate_sha) IN (40, 64)),
          reported_validation_json TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          UNIQUE (execution_id, candidate_sha)
        ) STRICT;

        CREATE INDEX candidate_submissions_job_idx
        ON candidate_submissions (job_id, submitted_at, candidate_id);

        CREATE TRIGGER candidate_submissions_prevent_update
        BEFORE UPDATE ON candidate_submissions
        BEGIN
          SELECT RAISE(ABORT, 'candidate submissions are immutable');
        END;
        CREATE TRIGGER candidate_submissions_prevent_delete
        BEFORE DELETE ON candidate_submissions
        BEGIN
          SELECT RAISE(ABORT, 'candidate submissions are immutable');
        END;
      `);
    },
  },

	{
		version: 14,
		name: 'publication-evidence-snapshots',
		up: (database: Database.Database) => {
			database.exec(`
        CREATE TABLE publication_evidence_snapshots (
          snapshot_id TEXT PRIMARY KEY CHECK (length(snapshot_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          candidate_id TEXT NOT NULL REFERENCES candidate_submissions(candidate_id),
          pull_request_operation_id TEXT NOT NULL REFERENCES effect_operations(operation_id),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          issue_id TEXT NOT NULL CHECK (length(issue_id) > 0),
          base_branch TEXT NOT NULL CHECK (length(base_branch) > 0),
          pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
          head_sha TEXT NOT NULL CHECK (length(head_sha) IN (40, 64)),
          base_sha TEXT NOT NULL CHECK (length(base_sha) IN (40, 64)),
          policy_version TEXT NOT NULL CHECK (length(policy_version) > 0),
          observed_at TEXT NOT NULL,
          source_identity TEXT NOT NULL CHECK (length(source_identity) > 0),
          source_cursor TEXT,
          complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
          pr_state TEXT NOT NULL CHECK (pr_state IN ('open', 'closed', 'merged')),
          merge_commit_sha TEXT CHECK (merge_commit_sha IS NULL OR length(merge_commit_sha) IN (40, 64)),
          merge_parent_shas_json TEXT NOT NULL,
          checks_json TEXT NOT NULL,
          reviews_json TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX publication_evidence_candidate_idx
        ON publication_evidence_snapshots (candidate_id, observed_at, snapshot_id);

        CREATE TRIGGER publication_evidence_snapshots_prevent_update
        BEFORE UPDATE ON publication_evidence_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'publication evidence snapshots are immutable');
        END;
        CREATE TRIGGER publication_evidence_snapshots_prevent_delete
        BEFORE DELETE ON publication_evidence_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'publication evidence snapshots are immutable');
        END;
      `);
		},
	},
	{
		version: 15,
		name: 'bounded-repair-reservations',
		up: (database: Database.Database) => {
			database.exec(`
        CREATE TABLE repair_cycles (
          job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
          allowance INTEGER NOT NULL CHECK (allowance >= 1),
          used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= allowance),
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE repair_reservations (
          reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
          candidate_id TEXT NOT NULL REFERENCES candidate_submissions(candidate_id),
          evidence_snapshot_id TEXT NOT NULL REFERENCES publication_evidence_snapshots(snapshot_id),
          execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
          trigger_evidence_json TEXT NOT NULL,
          actionable_feedback_json TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          reserved_at TEXT NOT NULL,
          UNIQUE (job_id, cycle_number)
        ) STRICT;

        CREATE INDEX repair_reservations_job_idx
        ON repair_reservations (job_id, cycle_number);

        CREATE TABLE repair_allowance_extensions (
          extension_id TEXT PRIMARY KEY CHECK (length(extension_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          added_attempts INTEGER NOT NULL CHECK (added_attempts > 0),
          approver_identity TEXT NOT NULL CHECK (length(approver_identity) > 0),
          authority_id TEXT NOT NULL CHECK (length(authority_id) > 0),
          decision_receipt TEXT NOT NULL CHECK (length(decision_receipt) > 0),
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0),
          granted_at TEXT NOT NULL
        ) STRICT;

        CREATE TRIGGER repair_allowance_extensions_prevent_update
        BEFORE UPDATE ON repair_allowance_extensions
        BEGIN
          SELECT RAISE(ABORT, 'repair allowance extensions are immutable');
        END;
        CREATE TRIGGER repair_allowance_extensions_prevent_delete
        BEFORE DELETE ON repair_allowance_extensions
        BEGIN
          SELECT RAISE(ABORT, 'repair allowance extensions are immutable');
        END;
      `);
		},
	},
	{
		version: 16,
		name: 'delivery-verifications',
		up: (database: Database.Database) => {
		database.exec(`
        CREATE TABLE delivery_verifications (
          verification_id TEXT PRIMARY KEY CHECK (length(verification_id) > 0),
          job_id TEXT NOT NULL REFERENCES jobs(job_id),
          candidate_id TEXT NOT NULL REFERENCES candidate_submissions(candidate_id),
          snapshot_id TEXT NOT NULL REFERENCES publication_evidence_snapshots(snapshot_id),
          pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
          candidate_sha TEXT NOT NULL CHECK (length(candidate_sha) IN (40, 64)),
          base_sha TEXT NOT NULL CHECK (length(base_sha) IN (40, 64)),
          merge_commit_sha TEXT CHECK (merge_commit_sha IS NULL OR length(merge_commit_sha) IN (40, 64)),
          status TEXT NOT NULL CHECK (status IN ('complete', 'blocked')),
          reasons_json TEXT NOT NULL,
          checks_executed_json TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          writer_generation INTEGER NOT NULL CHECK (writer_generation > 0)
        ) STRICT;

        CREATE INDEX delivery_verifications_job_idx
        ON delivery_verifications (job_id, verified_at, verification_id);

        CREATE TRIGGER delivery_verifications_prevent_update
        BEFORE UPDATE ON delivery_verifications
        BEGIN
          SELECT RAISE(ABORT, 'delivery verifications are immutable');
        END;
        CREATE TRIGGER delivery_verifications_prevent_delete
        BEFORE DELETE ON delivery_verifications
        BEGIN
          SELECT RAISE(ABORT, 'delivery verifications are immutable');
        END;
      `);
		},
	},
	{
		version: 17,
		name: 'job-publication-bindings',
		up: (database: Database.Database) => {
		database.exec(`
        CREATE TABLE publication_bindings (
          job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          task_branch TEXT NOT NULL CHECK (length(task_branch) > 0),
          base_branch TEXT NOT NULL CHECK (length(base_branch) > 0),
          pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
          initial_candidate_id TEXT NOT NULL REFERENCES candidate_submissions(candidate_id),
          bound_at TEXT NOT NULL,
          UNIQUE (repository_id, task_branch),
          UNIQUE (repository_id, pull_request_number)
        ) STRICT;

        CREATE TRIGGER publication_bindings_prevent_update
        BEFORE UPDATE ON publication_bindings
        BEGIN
          SELECT RAISE(ABORT, 'publication bindings are immutable');
        END;
        CREATE TRIGGER publication_bindings_prevent_delete
        BEFORE DELETE ON publication_bindings
        BEGIN
          SELECT RAISE(ABORT, 'publication bindings are immutable');
        END;
      `);
		},
	},
];
