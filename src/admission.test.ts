import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionStore, type AdmissionInput } from "./admission.js";
import { IssueScopeStore } from "./issue-scopes.js";
import { ReadinessEvidenceStore } from "./readiness.js";
import { PrerequisiteConfirmationStore } from "./prerequisite-confirmations.js";
import { createStateFixture } from "./state-fixture.js";

const time = "2026-11-02T00:00:00.000Z";

function prepareAdmission(
	fixture: ReturnType<typeof createStateFixture>,
	dependencies: string[] = [],
) {
	new IssueScopeStore(fixture.state).recordCompleteRead({
		observationId: "issue-read-1",
		scopeRevisionId: "scope-1",
		repositoryId: "repo-1",
		issueId: "issue-1",
		sourceRevisionId: "github-rev-1",
		title: "Task",
		body: "Scope",
		dependencyIssueIds: dependencies,
		templateVersion: "1",
		policyVersion: "policy-1",
		observedAt: time,
		expectedHeadVersion: 0,
		writerGeneration: 1,
	});
	new ReadinessEvidenceStore(fixture.state).record({
		evidenceId: "approval-1",
		repositoryId: "repo-1",
		issueId: "issue-1",
		scopeRevisionId: "scope-1",
		source: "github_label_event",
		approverIdentity: "github-user:42",
		authorityEvidence: { role: "maintainer" },
		githubLabelEventId: "label-event-1",
		labelPresent: true,
		observedAt: time,
		writerGeneration: 1,
	});
	const admission = new AdmissionStore(fixture.state);
	admission.recordReadinessObservation({
		observationId: "ready-read-1",
		repositoryId: "repo-1",
		issueId: "issue-1",
		labelPresent: true,
		approvedActorIdentity: "github-user:42",
		complete: true,
		observedAt: time,
		expectedHeadVersion: 0,
		writerGeneration: 1,
	});
	return admission;
}

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
	return {
		decisionId: "decision-1",
		jobId: "job-1",
		executionId: "execution-1",
		repositoryId: "repo-1",
		issueId: "issue-1",
		scopeRevisionId: "scope-1",
		expectedIssueHeadVersion: 1,
		expectedReadinessHeadVersion: 1,
		issueIsOpen: true,
		repositoryBindingValid: true,
		authorizedApproverIdentities: ["github-user:42"],
		authorizedPrerequisiteConfirmerIdentities: ["github-user:42"],
		currentPolicyVersion: "policy-1",
		nativeDependencyIssueIds: [],
		prerequisiteStates: {},
		dependencyKinds: {},
		dependencyGraph: {},
		maxLiveExecutions: 1,
		writerGeneration: 1,
		...overrides,
	};
}

test("atomically admits one job and reserved execution and replays the same decision", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		const first = admission.admit(input());
		const replay = admission.admit(input());
		assert.deepEqual(first, {
			outcome: "admitted",
			reasonCode: null,
			jobId: "job-1",
			executionId: "execution-1",
		});
		assert.deepEqual(replay, first);
		assert.throws(() => admission.admit(input({ maxLiveExecutions: 2 })), {
			code: "DECISION_ARGUMENT_MISMATCH",
		});
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM jobs")
					.get() as { count: number }
			).count,
			1,
		);
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM executions")
					.get() as { count: number }
			).count,
			1,
		);
	} finally {
		fixture.close();
	}
});

test("blocks changed readiness and stale issue snapshots without creating work", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		admission.recordReadinessObservation({
			observationId: "ready-read-2",
			repositoryId: "repo-1",
			issueId: "issue-1",
			labelPresent: false,
			complete: true,
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		const removed = admission.admit(
			input({
				decisionId: "decision-removed",
				expectedReadinessHeadVersion: 2,
			}),
		);
		const stale = admission.admit(
			input({
				decisionId: "decision-stale",
				expectedReadinessHeadVersion: 1,
				expectedIssueHeadVersion: 0,
			}),
		);
		assert.equal(removed.reasonCode, "not_ready");
		assert.equal(stale.reasonCode, "issue_snapshot_changed");
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM jobs")
					.get() as { count: number }
			).count,
			0,
		);
	} finally {
		fixture.close();
	}
});

test("routes a complete unattributable snapshot to human clarification with exact content", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		new IssueScopeStore(fixture.state).recordUnattributableRead({
			observationId: "unknown-current-read",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "provider-revision-unknown",
			title: "Unattributed current title",
			body: "Show this exact snapshot to the authorized human.",
			dependencyIssueIds: ["issue-7"],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		const result = admission.admit(
			input({ decisionId: "decision-clarify", expectedIssueHeadVersion: 2 }),
		);
		assert.equal(result.outcome, "clarification");
		assert.equal(result.reasonCode, "current_revision_unlinked");
		assert.equal(result.clarificationSnapshot?.contentFingerprint.length, 64);
		assert.deepEqual(result.clarificationSnapshot, {
			observationId: "unknown-current-read",
			sourceRevisionId: "provider-revision-unknown",
			contentFingerprint: result.clarificationSnapshot?.contentFingerprint,
			title: "Unattributed current title",
			body: "Show this exact snapshot to the authorized human.",
			dependencyIssueIds: ["issue-7"],
			templateVersion: "1",
			policyVersion: "policy-1",
		});
		assert.deepEqual(
			admission.admit(
				input({ decisionId: "decision-clarify", expectedIssueHeadVersion: 2 }),
			),
			result,
		);
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

test("classifies a known current revision change as stale approval, not clarification", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		new IssueScopeStore(fixture.state).recordCompleteRead({
			observationId: "known-drift-read",
			scopeRevisionId: "scope-2",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "provider-revision-2",
			title: "Updated title",
			body: "Scope",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		const result = admission.admit(
			input({
				decisionId: "decision-known-drift",
				expectedIssueHeadVersion: 2,
			}),
		);
		assert.equal(result.outcome, "stale");
		assert.equal(result.reasonCode, "approval_revision_stale");
		assert.equal(result.clarificationSnapshot, undefined);
	} finally {
		fixture.close();
	}
});

test("blocks admission when the current readiness observation names a different actor", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		admission.recordReadinessObservation({
			observationId: "ready-read-2",
			repositoryId: "repo-1",
			issueId: "issue-1",
			labelPresent: true,
			approvedActorIdentity: "github-user:99",
			complete: true,
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		const result = admission.admit(
			input({
				decisionId: "decision-actor-mismatch",
				expectedReadinessHeadVersion: 2,
			}),
		);

		assert.equal(result.outcome, "blocked");
		assert.equal(result.reasonCode, "readiness_evidence_conflict");
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM jobs")
					.get() as { count: number }
			).count,
			0,
		);
	} finally {
		fixture.close();
	}
});

test("orders revision-bound approvals by durable insertion order, not provider timestamps", () => {
	const fixture = createStateFixture();
	try {
		const scopes = new IssueScopeStore(fixture.state);
		scopes.recordCompleteRead({
			observationId: "old-scope-read",
			scopeRevisionId: "scope-old",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "github-rev-old",
			title: "Old task",
			body: "Old scope",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: time,
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});
		const evidence = new ReadinessEvidenceStore(fixture.state);
		evidence.record({
			evidenceId: "older-approval",
			repositoryId: "repo-1",
			issueId: "issue-1",
			scopeRevisionId: "scope-old",
			source: "github_label_event",
			approverIdentity: "github-user:42",
			authorityEvidence: { role: "maintainer" },
			githubLabelEventId: "older-event",
			labelPresent: true,
			observedAt: "2026-11-02T00:00:02.000Z",
			writerGeneration: 1,
		});
		scopes.recordCompleteRead({
			observationId: "current-scope-read",
			scopeRevisionId: "scope-current",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "github-rev-current",
			title: "Current task",
			body: "Current scope",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		evidence.record({
			evidenceId: "current-approval",
			repositoryId: "repo-1",
			issueId: "issue-1",
			scopeRevisionId: "scope-current",
			source: "github_label_event",
			approverIdentity: "github-user:99",
			authorityEvidence: { role: "maintainer" },
			githubLabelEventId: "current-event",
			labelPresent: true,
			observedAt: "2026-11-01T23:59:59.000Z",
			writerGeneration: 1,
		});
		const admission = new AdmissionStore(fixture.state);
		admission.recordReadinessObservation({
			observationId: "current-ready-read",
			repositoryId: "repo-1",
			issueId: "issue-1",
			labelPresent: true,
			approvedActorIdentity: "github-user:99",
			complete: true,
			observedAt: "2026-11-02T00:01:01.000Z",
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});

		const result = admission.admit(
			input({
				decisionId: "decision-current-approval",
				jobId: "job-current",
				executionId: "execution-current",
				scopeRevisionId: "scope-current",
				expectedIssueHeadVersion: 2,
				expectedReadinessHeadVersion: 1,
				authorizedApproverIdentities: ["github-user:42", "github-user:99"],
			}),
		);

		assert.equal(result.outcome, "admitted");
		assert.equal(result.jobId, "job-current");
	} finally {
		fixture.close();
	}
});

test("readiness removal after reservation blocks the unstarted execution boundary", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		const result = admission.admit(input());
		assert.equal(result.outcome, "admitted");
		admission.recordReadinessObservation({
			observationId: "ready-read-removed",
			repositoryId: "repo-1",
			issueId: "issue-1",
			labelPresent: false,
			complete: true,
			observedAt: "2026-11-02T00:01:00.000Z",
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		assert.throws(
			() =>
				fixture.executions.transition({
					executionId: "execution-1",
					expectedVersion: 1,
					writerGeneration: 1,
					lifecycle: "starting",
					expectedIssueHeadVersion: 1,
					expectedReadinessHeadVersion: 2,
				}),
			{ code: "READINESS_REMOVED" },
		);
		assert.equal(fixture.executions.get("execution-1")?.lifecycle, "reserved");
	} finally {
		fixture.close();
	}
});

test("requires native dependency completion evidence and rejects dependency cycles", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture, ["issue-2"]);
		const blocked = admission.admit(
			input({
				nativeDependencyIssueIds: ["issue-2"],
				dependencyKinds: { "issue-2": "coding" },
				dependencyGraph: { "issue-1": ["issue-2"] },
			}),
		);
		assert.equal(blocked.reasonCode, "dependency_incomplete");
		const cycle = admission.admit(
			input({
				decisionId: "decision-cycle",
				nativeDependencyIssueIds: ["issue-2"],
				dependencyKinds: { "issue-2": "coding" },
				prerequisiteStates: {
					"issue-2": {
						status: "complete",
						evidenceId: "merge-1",
						evidenceKind: "merged_pr",
						sourceRevisionId: "pr-commit",
					},
				},
				dependencyGraph: { "issue-1": ["issue-2"], "issue-2": ["issue-1"] },
			}),
		);
		assert.equal(cycle.reasonCode, "dependency_cycle");
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM jobs")
					.get() as { count: number }
			).count,
			0,
		);
	} finally {
		fixture.close();
	}
});

test("requires durable authorized human confirmation for a non-coding prerequisite", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture, ["issue-2"]);
		const candidate = input({
			nativeDependencyIssueIds: ["issue-2"],
			dependencyKinds: { "issue-2": "non_coding" },
			dependencyGraph: { "issue-1": ["issue-2"] },
			prerequisiteStates: {
				"issue-2": {
					status: "complete",
					evidenceId: "confirmation-2",
					evidenceKind: "authorized_human_confirmation",
					sourceRevisionId: "github-rev-2",
				},
			},
		});
		assert.equal(
			admission.admit(candidate).reasonCode,
			"dependency_incomplete",
		);

		new IssueScopeStore(fixture.state).recordCompleteRead({
			observationId: "issue-read-2",
			scopeRevisionId: "scope-2",
			repositoryId: "repo-1",
			issueId: "issue-2",
			sourceRevisionId: "github-rev-2",
			title: "Non-coding prerequisite",
			body: "Confirmed manually",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: time,
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});
		new PrerequisiteConfirmationStore(fixture.state).confirm({
			confirmationId: "confirmation-2",
			repositoryId: "repo-1",
			issueId: "issue-2",
			scopeRevisionId: "scope-2",
			confirmedBy: "github-user:42",
			authorizedHumanIdentities: ["github-user:42"],
			authorityEvidence: { role: "maintainer" },
			writerGeneration: 1,
		});
		assert.throws(
			() =>
				new PrerequisiteConfirmationStore(fixture.state).confirm({
					confirmationId: "unauthorized-confirmation",
					repositoryId: "repo-1",
					issueId: "issue-2",
					scopeRevisionId: "scope-2",
					confirmedBy: "github-user:99",
					authorizedHumanIdentities: ["github-user:42"],
					authorityEvidence: {},
					writerGeneration: 1,
				}),
			{ code: "CONFIRMER_UNAUTHORIZED" },
		);

		assert.equal(
			admission.admit({ ...candidate, decisionId: "decision-confirmed" })
				.outcome,
			"admitted",
		);
		assert.equal(
			admission.admit({
				...candidate,
				decisionId: "decision-confirmation-revoked",
				authorizedPrerequisiteConfirmerIdentities: [],
			}).reasonCode,
			"dependency_incomplete",
		);
		new IssueScopeStore(fixture.state).recordCompleteRead({
			observationId: "issue-read-2-changed",
			scopeRevisionId: "scope-3",
			repositoryId: "repo-1",
			issueId: "issue-2",
			sourceRevisionId: "github-rev-3",
			title: "Non-coding prerequisite changed",
			body: "Changed after confirmation",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: time,
			expectedHeadVersion: 1,
			writerGeneration: 1,
		});
		assert.equal(
			admission.admit({
				...candidate,
				decisionId: "decision-confirmation-stale",
			}).reasonCode,
			"dependency_incomplete",
		);
	} finally {
		fixture.close();
	}
});

test("requires merged pull request proof for coding dependencies and honors capacity", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture, ["issue-2"]);
		const invalidProof = admission.admit(
			input({
				nativeDependencyIssueIds: ["issue-2"],
				dependencyKinds: { "issue-2": "coding" },
				prerequisiteStates: {
					"issue-2": {
						status: "complete",
						evidenceId: "closed-issue",
						evidenceKind: "authorized_human_confirmation",
						sourceRevisionId: "rev",
					},
				},
			}),
		);
		assert.equal(invalidProof.reasonCode, "dependency_incomplete");
		fixture.database
			.prepare(`INSERT INTO jobs (job_id, repository_id, issue_id, scope_revision_id, phase, requested_control, row_version, event_sequence, created_at, updated_at)
      VALUES ('other-job', 'repo-1', 'other-issue', 'scope-other', 'queued', 'run', 1, 0, ?, ?)`)
			.run(time, time);
		fixture.database
			.prepare(`INSERT INTO executions (execution_id, job_id, ownership_generation, lifecycle, terminal_outcome, row_version, created_at, updated_at)
      VALUES ('other-execution', 'other-job', 1, 'reserved', NULL, 1, ?, ?)`)
			.run(time, time);
		const capacity = admission.admit(
			input({
				decisionId: "decision-capacity",
				maxLiveExecutions: 1,
				nativeDependencyIssueIds: ["issue-2"],
				dependencyKinds: { "issue-2": "coding" },
				prerequisiteStates: {
					"issue-2": {
						status: "complete",
						evidenceId: "merge-1",
						evidenceKind: "merged_pr",
						sourceRevisionId: "merge-commit",
					},
				},
			}),
		);
		assert.equal(capacity.reasonCode, "repository_capacity_exhausted");
	} finally {
		fixture.close();
	}
});

test("requires both readiness sources to agree and records the blocker", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		new ReadinessEvidenceStore(fixture.state).record({
			evidenceId: "approval-slack",
			repositoryId: "repo-1",
			issueId: "issue-1",
			scopeRevisionId: "scope-1",
			source: "slack_approval",
			approverIdentity: "slack-user:other",
			authorityEvidence: { role: "maintainer" },
			slackConversationId: "thread-1",
			slackApprovalReceiptId: "approval-receipt",
			labelWriteOperationId: "label-write",
			labelPresent: true,
			observedAt: "2026-11-02T00:00:01.000Z",
			writerGeneration: 1,
		});
		const result = admission.admit(input());
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reasonCode, "readiness_evidence_conflict");
		assert.equal(
			(
				fixture.database
					.prepare(
						"SELECT outcome FROM admission_decisions WHERE decision_id = ?",
					)
					.get("decision-1") as { outcome: string }
			).outcome,
			"blocked",
		);
	} finally {
		fixture.close();
	}
});

test("blocks GitHub and Slack readiness evidence that names different revisions", () => {
	const fixture = createStateFixture();
	try {
		const admission = prepareAdmission(fixture);
		new IssueScopeStore(fixture.state).recordCompleteRead({
			observationId: "issue-read-superseded",
			scopeRevisionId: "scope-2",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "github-rev-2",
			title: "Task changed",
			body: "Changed scope",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: time,
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});
		new ReadinessEvidenceStore(fixture.state).record({
			evidenceId: "approval-slack-revision-2",
			repositoryId: "repo-1",
			issueId: "issue-1",
			scopeRevisionId: "scope-2",
			source: "slack_approval",
			approverIdentity: "github-user:42",
			authorityEvidence: { role: "maintainer" },
			slackConversationId: "thread-1",
			slackApprovalReceiptId: "approval-receipt-2",
			labelWriteOperationId: "label-write-2",
			labelPresent: true,
			observedAt: time,
			writerGeneration: 1,
		});

		const result = admission.admit(input());
		assert.equal(result.outcome, "blocked");
		assert.equal(result.reasonCode, "readiness_evidence_conflict");
	} finally {
		fixture.close();
	}
});
