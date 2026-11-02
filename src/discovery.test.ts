import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionDiscovery } from "./discovery.js";
import { createStateFixture } from "./state-fixture.js";

test("periodic discovery persists provider evidence and reserves each ready issue once", async () => {
	const fixture = createStateFixture();
	try {
		let sequence = 0;
		const discovery = new AdmissionDiscovery(
			fixture.state,
			{
				listIssues: async () => [{ issueId: "issue-1" }],
				readIssue: async () => ({
					repositoryId: "repo-1",
					issueId: "issue-1",
					sourceRevisionId: "gh-rev-1",
					title: "Task",
					body: "Approved work",
					templateVersion: "1",
					policyVersion: "policy-1",
					isOpen: true,
					observedAt: "2026-11-02T00:00:00.000Z",
				}),
				readReadiness: async () => ({
					complete: true,
					labelPresent: true,
					approvedActorIdentity: "github-user:42",
					observedAt: "2026-11-02T00:00:00.000Z",
					approvals: [
						{
							evidenceId: "label-event-1",
							source: "github_label_event",
							approvedSourceRevisionId: "gh-rev-1",
							approverIdentity: "github-user:42",
							authorityEvidence: { role: "maintainer" },
							githubLabelEventId: "event-1",
							labelPresent: true,
							observedAt: "2026-11-02T00:00:00.000Z",
						},
					],
				}),
				readBlockedBy: async () => ({
					source: "github_blocked_by",
					issueIds: [],
					graph: { "issue-1": [] },
					completionEvidence: {},
				}),
			},
			{
				repositoryId: "repo-1",
				authorizedApproverIdentities: ["github-user:42"],
				authorizedPrerequisiteConfirmerIdentities: ["github-user:42"],
				currentPolicyVersion: "policy-1",
				maxLiveExecutions: 1,
				dependencyKinds: {},
				writerGeneration: 1,
				nextId: (kind, issueId) => `${kind}-${issueId}-${++sequence}`,
			},
		);

		const result = await discovery.scan("scan-1");
		assert.equal(result.issues.length, 1);
		assert.equal(result.issues[0]?.admission.outcome, "admitted");
		const repeated = await discovery.scan("scan-2");
		assert.equal(repeated.issues[0]?.admission.outcome, "existing");
		assert.equal(
			(
				fixture.database
					.prepare("SELECT count(*) AS count FROM jobs")
					.get() as { count: number }
			).count,
			1,
		);
	} finally {
		fixture.close();
	}
});

test("discovery rejects dependency data that does not come from GitHub blocked_by", async () => {
	const fixture = createStateFixture();
	try {
		let sequence = 0;
		const discovery = new AdmissionDiscovery(
			fixture.state,
			{
				listIssues: async () => [{ issueId: "issue-1" }],
				readIssue: async () => ({
					repositoryId: "repo-1",
					issueId: "issue-1",
					sourceRevisionId: "gh-rev-1",
					title: "Task",
					body: "Approved work",
					templateVersion: "1",
					policyVersion: "policy-1",
					isOpen: true,
					observedAt: "2026-11-02T00:00:00.000Z",
				}),
				readReadiness: async () => ({
					complete: true,
					labelPresent: false,
					observedAt: "2026-11-02T00:00:00.000Z",
					approvals: [],
				}),
				readBlockedBy: async () => ({
					source: "issue_body_references" as "github_blocked_by",
					issueIds: ["issue-2"],
					graph: { "issue-1": ["issue-2"] },
					completionEvidence: {},
				}),
			},
			{
				repositoryId: "repo-1",
				authorizedApproverIdentities: [],
				authorizedPrerequisiteConfirmerIdentities: [],
				currentPolicyVersion: "policy-1",
				maxLiveExecutions: 1,
				dependencyKinds: {},
				writerGeneration: 1,
				nextId: (kind, issueId) => `${kind}-${issueId}-${++sequence}`,
			},
		);

		await assert.rejects(discovery.scan("scan-1"), {
			code: "DEPENDENCY_SOURCE_UNTRUSTED",
		});
	} finally {
		fixture.close();
	}
});
