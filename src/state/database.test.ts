import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { getSchemaVersion, openDatabase, runMigrations } from "./database.js";
import { controllerMigrations } from "./migrations.js";

test("initializes an empty database and safely reopens it", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-crew-db-"));
	const path = join(directory, "controller.sqlite");

	try {
		const first = openDatabase(path);
		assert.equal(getSchemaVersion(first), 13);
		assert.equal(first.pragma("journal_mode", { simple: true }), "wal");
		assert.equal(first.pragma("synchronous", { simple: true }), 2);
		assert.equal(first.pragma("busy_timeout", { simple: true }), 5_000);
		assert.equal(first.pragma("foreign_keys", { simple: true }), 1);
		assert.ok(
			first
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'issue_scope_revisions'",
				)
				.get(),
		);
		assert.ok(
			first
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'issue_read_observations'",
				)
				.get(),
		);
		first.close();

		const second = openDatabase(path);
		assert.equal(getSchemaVersion(second), 13);
		assert.ok(
			second
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unattributed_issue_snapshots'",
				)
				.get(),
		);
		second.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("verifies required SQLite durability and constraint settings on open", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-crew-db-settings-"));
	const path = join(directory, "controller.sqlite");

	try {
		const database = openDatabase(path, { timeoutMs: 750 });
		assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
		assert.equal(database.pragma("synchronous", { simple: true }), 2);
		assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
		assert.equal(database.pragma("busy_timeout", { simple: true }), 750);
		database.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("records successful migrations and rolls back a failed migration", () => {
	const database = new Database(":memory:");

	try {
		runMigrations(database, [
			{
				version: 1,
				name: "first",
				up: (connection) =>
					connection.exec("CREATE TABLE first_table (id INTEGER PRIMARY KEY)"),
			},
		]);

		assert.throws(
			() =>
				runMigrations(database, [
					{
						version: 2,
						name: "broken",
						up: (connection) => {
							connection.exec(
								"CREATE TABLE rolled_back (id INTEGER PRIMARY KEY)",
							);
							throw new Error("migration failed");
						},
					},
				]),
			/migration failed/,
		);

		assert.equal(getSchemaVersion(database), 1);
		assert.equal(
			database
				.prepare("SELECT 1 FROM sqlite_master WHERE name = 'rolled_back'")
				.get(),
			undefined,
		);
	} finally {
		database.close();
	}
});

test("schema includes unattributable snapshots and preserves issue read heads", () => {
	const database = new Database(":memory:");
	try {
		runMigrations(
			database,
			controllerMigrations.filter((migration) => migration.version <= 7),
		);
		const timestamp = "2026-11-02T00:00:00.000Z";
		const fingerprint = "a".repeat(64);
		database
			.prepare(`
      INSERT INTO issue_scope_revisions (
        scope_revision_id, repository_id, issue_id, source_revision_id, content_fingerprint,
        title, body, dependency_issue_ids_json, template_version, policy_version, observed_at, created_generation
      ) VALUES ('scope-1', 'repo-1', 'issue-1', 'source-1', ?, 'Task', 'Body', '[]', '1', 'policy-1', ?, 1)
    `)
			.run(fingerprint, timestamp);
		database
			.prepare(`
      INSERT INTO issue_read_observations (
        observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
        status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
      ) VALUES ('read-1', 'repo-1', 'issue-1', 1, 0, 'complete', 'scope-1', 'source-1', ?, ?, 1)
    `)
			.run(fingerprint, timestamp);
		database
			.prepare(`
      INSERT INTO issue_read_heads (repository_id, issue_id, head_version, observation_id)
      VALUES ('repo-1', 'issue-1', 1, 'read-1')
    `)
			.run();

		runMigrations(database, controllerMigrations);
		assert.equal(getSchemaVersion(database), 13);
		assert.equal(
			(
				database
					.prepare(
						"SELECT status FROM issue_read_observations WHERE observation_id = ?",
					)
					.get("read-1") as { status: string }
			).status,
			"complete",
		);
		assert.equal(
			(
				database
					.prepare(
						"SELECT observation_id FROM issue_read_heads WHERE repository_id = ? AND issue_id = ?",
					)
					.get("repo-1", "issue-1") as { observation_id: string }
			).observation_id,
			"read-1",
		);
		database
			.prepare(`
      INSERT INTO issue_read_observations (
        observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
        status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
      ) VALUES ('late-failure', 'repo-1', 'issue-1', 2, 0, 'superseded', NULL, NULL, NULL, ?, 1)
    `)
			.run(timestamp);
		assert.equal(
			(
				database
					.prepare(
						"SELECT status FROM issue_read_observations WHERE observation_id = ?",
					)
					.get("late-failure") as { status: string }
			).status,
			"superseded",
		);
		assert.ok(
			database
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unattributed_issue_snapshots'",
				)
				.get(),
		);
		assert.ok(
			database
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prerequisite_confirmations'",
				)
				.get(),
		);
		assert.ok(
			database
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'intake_rejection_events'",
				)
				.get(),
		);
		assert.deepEqual(database.pragma("foreign_key_check"), []);
	} finally {
		database.close();
	}
});

test("rejects unsupported future schema versions", () => {
	const database = new Database(":memory:");

	try {
		database.exec(
			"CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT",
		);
		database
			.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
			.run(2, "future", "now");

		assert.throws(
			() =>
				runMigrations(database, [
					{
						version: 1,
						name: "current",
						up: () => undefined,
					},
				]),
			/newer than this application supports/,
		);
	} finally {
		database.close();
	}
});


test("upgrades the merged WBS4 schema without losing jobs or execution records", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-crew-upgrade-"));
  const path = join(directory, "controller.sqlite");
  try {
    const previous = new Database(path);
    previous.pragma("foreign_keys = ON");
    runMigrations(previous, controllerMigrations.filter(migration => migration.version <= 9));
    previous.exec(`
      INSERT INTO jobs (job_id, repository_id, issue_id, scope_revision_id, phase, requested_control, created_at, updated_at)
      VALUES ('old-job', 'repo', 'issue', 'scope', 'queued', 'run', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
      INSERT INTO executions (execution_id, job_id, ownership_generation, lifecycle, created_at, updated_at)
      VALUES ('old-execution', 'old-job', 1, 'reserved', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    `);
    previous.close();
    const upgraded = openDatabase(path);
    try {
      assert.equal(getSchemaVersion(upgraded), 12);
      assert.deepEqual(upgraded.prepare('SELECT lifecycle, ownership_generation FROM executions WHERE execution_id = ?').get('old-execution'),
        { lifecycle: 'reserved', ownership_generation: 1 });
      for (const table of ['execution_runs', 'execution_observations', 'execution_commands', 'execution_command_observations', 'source_artifacts']) {
        assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
      }
      assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
