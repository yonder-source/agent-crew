import assert from "node:assert/strict";
import test from "node:test";
import { IssueScopeStore } from "../issues/issue-scopes.js";
import {
	ReadinessEvidenceStore,
	type ReadinessEvidenceInput,
} from "./readiness.js";
import { createStateFixture } from "../../tests/fixtures/state-fixture.js";

const baseEvidence: ReadinessEvidenceInput = {
	evidenceId: "readiness-1",
	repositoryId: "repo-1",
	issueId: "issue-1",
	scopeRevisionId: "scope-1",
	source: "github_label_event",
	approverIdentity: "github-user:42",
	authorityEvidence: {
		role: "maintainer",
		checkedAt: "2026-11-02T00:00:00.000Z",
	},
	githubLabelEventId: "event-1",
	labelPresent: true,
	observedAt: "2026-11-02T00:00:01.000Z",
	writerGeneration: 1,
};

function createRevision(fixture: ReturnType<typeof createStateFixture>) {
	return new IssueScopeStore(fixture.state).recordCompleteRead({
		observationId: "read-1",
		scopeRevisionId: "scope-1",
		repositoryId: "repo-1",
		issueId: "issue-1",
		sourceRevisionId: "github-revision-1",
		title: "Task",
		body: "Scope",
		dependencyIssueIds: [],
		templateVersion: "1",
		policyVersion: "policy-1",
		observedAt: "2026-11-02T00:00:00.000Z",
		expectedHeadVersion: 0,
		writerGeneration: 1,
	});
}

test("records GitHub label evidence against its exact saved scope revision", () => {
	const fixture = createStateFixture();
	try {
		createRevision(fixture);
		const evidence = new ReadinessEvidenceStore(fixture.state).record(
			baseEvidence,
		);
		assert.equal(evidence.source, "github_label_event");
		assert.equal(evidence.scopeRevisionId, "scope-1");
		assert.deepEqual(evidence.authorityEvidence, {
			role: "maintainer",
			checkedAt: "2026-11-02T00:00:00.000Z",
		});
		assert.deepEqual(
			new ReadinessEvidenceStore(fixture.state).list("repo-1", "issue-1"),
			[evidence],
		);
	} finally {
		fixture.close();
	}
});

test("records Slack approval separately with its label-write receipt", () => {
	const fixture = createStateFixture();
	try {
		createRevision(fixture);
		const { githubLabelEventId: _eventId, ...githubIndependentFields } =
			baseEvidence;
		const evidence = new ReadinessEvidenceStore(fixture.state).record({
			...githubIndependentFields,
			evidenceId: "readiness-slack",
			source: "slack_approval",
			slackConversationId: "conversation-1",
			slackApprovalReceiptId: "approval-receipt-1",
			labelWriteOperationId: "operation-1",
		});
		assert.equal(evidence.source, "slack_approval");
		assert.equal(evidence.githubLabelEventId, undefined);
		assert.equal(evidence.labelWriteOperationId, "operation-1");
	} finally {
		fixture.close();
	}
});

test("rejects evidence whose issue binding does not match the saved scope revision", () => {
	const fixture = createStateFixture();
	try {
		createRevision(fixture);
		assert.throws(
			() =>
				new ReadinessEvidenceStore(fixture.state).record({
					...baseEvidence,
					issueId: "issue-other",
				}),
			{ code: "SCOPE_BINDING_MISMATCH" },
		);
	} finally {
		fixture.close();
	}
});

test("rejects evidence whose repository binding does not match the saved scope revision", () => {
	const fixture = createStateFixture();
	try {
		createRevision(fixture);
		assert.throws(
			() =>
				new ReadinessEvidenceStore(fixture.state).record({
					...baseEvidence,
					repositoryId: "repo-other",
				}),
			{ code: "SCOPE_BINDING_MISMATCH" },
		);
	} finally {
		fixture.close();
	}
});

test("rejects incomplete Slack evidence and prevents evidence mutation", () => {
	const fixture = createStateFixture();
	try {
		createRevision(fixture);
		const store = new ReadinessEvidenceStore(fixture.state);
		const { githubLabelEventId: _eventId, ...slackWithoutReceipts } =
			baseEvidence;
		assert.throws(
			() =>
				store.record({
					...slackWithoutReceipts,
					source: "slack_approval",
				}),
			{ code: "INVALID_INPUT" },
		);
		store.record(baseEvidence);
		assert.throws(
			() => fixture.database.prepare("DELETE FROM readiness_evidence").run(),
			/immutable/,
		);
	} finally {
		fixture.close();
	}
});

test("uses Controller time to reject readiness writes after a stale heartbeat", () => {
	const fixture = createStateFixture();
	try {
		createRevision(fixture);
		const oldHeartbeat = new Date(Date.now() - 60_000).toISOString();
		fixture.database
			.prepare(`
      UPDATE controller_writer SET heartbeat_at = ?, status = 'healthy' WHERE singleton_id = 1
    `)
			.run(oldHeartbeat);

		assert.throws(
			() =>
				new ReadinessEvidenceStore(fixture.state).record({
					...baseEvidence,
					evidenceId: "stale-heartbeat-approval",
					observedAt: oldHeartbeat,
				}),
			{ code: "WRITER_UNHEALTHY" },
		);
		assert.equal(
			(
				fixture.database
					.prepare(`
      SELECT operation FROM intake_rejection_events WHERE operation_id = 'stale-heartbeat-approval'
    `)
					.get() as { operation: string }
			).operation,
			"readiness_evidence",
		);
	} finally {
		fixture.close();
	}
});
