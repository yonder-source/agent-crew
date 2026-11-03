import assert from "node:assert/strict";
import test from "node:test";
import { IssueScopeStore } from "./issue-scopes.js";
import { createStateFixture } from "../../tests/fixtures/state-fixture.js";

function read(
	overrides: Partial<Parameters<IssueScopeStore["recordCompleteRead"]>[0]> = {},
) {
	return {
		observationId: "observation-1",
		scopeRevisionId: "scope-1",
		repositoryId: "repo-1",
		issueId: "issue-1",
		sourceRevisionId: "provider-revision-1",
		title: "Task title",
		body: "Accepted scope",
		dependencyIssueIds: ["issue-3", "issue-2"],
		templateVersion: "1",
		policyVersion: "policy-1",
		observedAt: "2026-11-02T00:00:00.000Z",
		expectedHeadVersion: 0,
		writerGeneration: 1,
		...overrides,
	};
}

test("complete issue reads save immutable content snapshots and advance the current head", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		const first = scopes.recordCompleteRead(read());
		const second = scopes.recordCompleteRead(
			read({
				observationId: "observation-2",
				scopeRevisionId: "scope-duplicate",
				sourceRevisionId: "provider-revision-2",
				dependencyIssueIds: ["issue-2", "issue-3", "issue-2"],
				expectedHeadVersion: 1,
				observedAt: "2026-11-02T00:01:00.000Z",
			}),
		);

		assert.equal(first.accepted, true);
		assert.equal(second.accepted, true);
		assert.equal(
			second.revision.scopeRevisionId,
			first.revision.scopeRevisionId,
		);
		assert.deepEqual(second.revision.dependencyIssueIds, [
			"issue-2",
			"issue-3",
		]);
		assert.equal(second.head.headVersion, 2);
		assert.equal(second.head.sourceRevisionId, "provider-revision-2");
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM issue_scope_revisions")
					.get() as { count: number }
			).count,
			1,
		);
	} finally {
		fixture.close();
	}
});

test("changed issue content creates a new retained revision", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		const first = scopes.recordCompleteRead(read());
		const next = scopes.recordCompleteRead(
			read({
				observationId: "observation-2",
				scopeRevisionId: "scope-2",
				title: "Updated title",
				expectedHeadVersion: 1,
			}),
		);
		assert.notEqual(
			next.revision.scopeRevisionId,
			first.revision.scopeRevisionId,
		);
		assert.equal(
			scopes.getRevision(first.revision.scopeRevisionId)?.title,
			"Task title",
		);
		assert.equal(next.head.scopeRevisionId, next.revision.scopeRevisionId);
	} finally {
		fixture.close();
	}
});

test("stores a complete unattributable snapshot without creating a trusted scope revision", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		const result = scopes.recordUnattributableRead({
			observationId: "read-unattributed",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "provider-revision-unknown",
			title: "Current task",
			body: "Exact current content",
			dependencyIssueIds: ["issue-9"],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: "2026-11-02T00:00:00.000Z",
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});
		assert.equal(result.accepted, true);
		assert.equal(result.head.status, "unattributable");
		assert.equal(result.head.scopeRevisionId, null);
		assert.deepEqual(
			scopes.getUnattributedSnapshot(result.head.observationId),
			{
				observationId: result.head.observationId,
				repositoryId: "repo-1",
				issueId: "issue-1",
				sourceRevisionId: "provider-revision-unknown",
				contentFingerprint: result.head.contentFingerprint,
				title: "Current task",
				body: "Exact current content",
				dependencyIssueIds: ["issue-9"],
				templateVersion: "1",
				policyVersion: "policy-1",
				observedAt: "2026-11-02T00:00:00.000Z",
			},
		);
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM issue_scope_revisions")
					.get() as { count: number }
			).count,
			0,
		);
	} finally {
		fixture.close();
	}
});

test("authorized confirmation links the exact unattributable snapshot to a new scope revision", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		const unknown = scopes.recordUnattributableRead({
			observationId: "read-unattributed",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "provider-revision-unknown",
			title: "Current task",
			body: "Exact current content",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: "2026-11-02T00:00:00.000Z",
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});
		const confirmed = scopes.confirmUnattributableSnapshot({
			confirmationId: "human-confirmation-1",
			observationId: unknown.head.observationId,
			scopeRevisionId: "scope-confirmed",
			confirmedBy: "github-user:42",
			authorityEvidence: {
				role: "maintainer",
				checkedAt: "2026-11-02T00:01:00.000Z",
			},
			expectedHeadVersion: 1,
			observedAt: "2026-11-02T00:01:00.000Z",
			writerGeneration: 1,
		});
		assert.equal(confirmed.head.status, "complete");
		assert.equal(confirmed.head.scopeRevisionId, "scope-confirmed");
		assert.equal(confirmed.revision.title, "Current task");
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM issue_scope_confirmations")
					.get() as { count: number }
			).count,
			1,
		);
	} finally {
		fixture.close();
	}
});

test("unusable reads make currentness unavailable while retaining prior scope revisions", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		const first = scopes.recordCompleteRead(read());
		const unavailable = scopes.recordUnusableRead({
			observationId: "observation-2",
			repositoryId: "repo-1",
			issueId: "issue-1",
			status: "incomplete",
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		assert.equal(unavailable.accepted, true);
		assert.equal(unavailable.head?.status, "incomplete");
		assert.equal(unavailable.head?.scopeRevisionId, null);
		assert.ok(scopes.getRevision(first.revision.scopeRevisionId));
	} finally {
		fixture.close();
	}
});

test("retains delayed failed reads as superseded observations without scope metadata", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		scopes.recordCompleteRead(read());
		const delayed = scopes.recordUnusableRead({
			observationId: "delayed-failed-read",
			repositoryId: "repo-1",
			issueId: "issue-1",
			status: "unavailable",
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});

		assert.equal(delayed.accepted, false);
		assert.equal(delayed.head?.headVersion, 1);
		assert.deepEqual(
			fixture.database
				.prepare(`
      SELECT status, scope_revision_id, source_revision_id, content_fingerprint
      FROM issue_read_observations WHERE observation_id = 'delayed-failed-read:superseded'
    `)
				.get(),
			{
				status: "superseded",
				scope_revision_id: null,
				source_revision_id: null,
				content_fingerprint: null,
			},
		);
	} finally {
		fixture.close();
	}
});

test("uses Controller time for heartbeat checks and audits stale intake generations", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		const oldHeartbeat = new Date(Date.now() - 60_000).toISOString();
		fixture.database
			.prepare(`
      UPDATE controller_writer SET heartbeat_at = ?, status = 'healthy' WHERE singleton_id = 1
    `)
			.run(oldHeartbeat);
		assert.throws(
			() =>
				scopes.recordUnattributableRead({
					observationId: "stale-heartbeat-read",
					repositoryId: "repo-1",
					issueId: "issue-1",
					sourceRevisionId: "provider-revision",
					title: "Task",
					body: "Body",
					dependencyIssueIds: [],
					templateVersion: "1",
					policyVersion: "policy-1",
					observedAt: oldHeartbeat,
					expectedHeadVersion: 0,
					writerGeneration: 1,
				}),
			{ code: "WRITER_UNHEALTHY" },
		);
		assert.equal(
			(
				fixture.database
					.prepare(
						"SELECT status FROM controller_writer WHERE singleton_id = 1",
					)
					.get() as { status: string }
			).status,
			"unhealthy",
		);
		assert.equal(
			(
				fixture.database
					.prepare("SELECT reason_code FROM intake_rejection_events")
					.get() as { reason_code: string }
			).reason_code,
			"WRITER_UNHEALTHY",
		);

		const healthyAt = new Date().toISOString();
		fixture.database
			.prepare(`
      UPDATE controller_writer SET generation = 2, status = 'healthy', heartbeat_at = ? WHERE singleton_id = 1
    `)
			.run(healthyAt);
		assert.throws(
			() =>
				scopes.recordUnusableRead({
					observationId: "old-generation-read",
					repositoryId: "repo-1",
					issueId: "issue-1",
					status: "unavailable",
					observedAt: healthyAt,
					expectedHeadVersion: 0,
					writerGeneration: 1,
				}),
			{ code: "STALE_GENERATION" },
		);
		assert.deepEqual(
			fixture.database
				.prepare(`
      SELECT operation_id, submitted_generation, current_generation, reason_code
      FROM intake_rejection_events ORDER BY rejection_id DESC LIMIT 1
    `)
				.get(),
			{
				operation_id: "old-generation-read",
				submitted_generation: 1,
				current_generation: 2,
				reason_code: "STALE_GENERATION",
			},
		);
	} finally {
		fixture.close();
	}
});

test("late reads with an obsolete head version are retained but cannot replace the current head", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		scopes.recordCompleteRead(read());
		const current = scopes.recordCompleteRead(
			read({
				observationId: "observation-current",
				scopeRevisionId: "scope-current",
				sourceRevisionId: "provider-current",
				title: "Current title",
				expectedHeadVersion: 1,
			}),
		);
		const delayed = scopes.recordCompleteRead(
			read({
				observationId: "observation-delayed",
				scopeRevisionId: "scope-delayed",
				sourceRevisionId: "provider-delayed",
				title: "Delayed title",
				expectedHeadVersion: 1,
			}),
		);

		assert.equal(delayed.accepted, false);
		assert.equal(delayed.head.observationId, current.head.observationId);
		assert.equal(
			scopes.getHead("repo-1", "issue-1")?.contentFingerprint,
			current.head.contentFingerprint,
		);
		assert.equal(
			(
				fixture.database
					.prepare(
						"SELECT status FROM issue_read_observations WHERE observation_id = 'observation-delayed:superseded'",
					)
					.get() as { status: string }
			).status,
			"superseded",
		);
	} finally {
		fixture.close();
	}
});

test("issue scope revisions and read observations reject mutation", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		const result = scopes.recordCompleteRead(read());
		assert.throws(
			() =>
				fixture.database
					.prepare("UPDATE issue_scope_revisions SET title = ?")
					.run("mutated"),
			/immutable/,
		);
		assert.throws(
			() =>
				fixture.database.prepare("DELETE FROM issue_read_observations").run(),
			/append-only/,
		);
		assert.ok(scopes.getRevision(result.revision.scopeRevisionId));
	} finally {
		fixture.close();
	}
});
