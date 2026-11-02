import assert from "node:assert/strict";
import test from "node:test";
import { IssueScopeStore } from "./issue-scopes.js";
import { CollaborativeIssueWriteCoordinator } from "./issue-writes.js";
import { createJob, createStateFixture } from "./state-fixture.js";

test("applies agreed issue fields and dependency changes with verified readback", async () => {
	const fixture = createStateFixture();
	try {
		const now = new Date().toISOString();
		const scopes = new IssueScopeStore(fixture.state);
		scopes.recordCompleteRead({
			observationId: "initial-read",
			scopeRevisionId: "scope-1",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "remote-1",
			title: "Task",
			body: "Original",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: now,
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});
		const job = createJob(fixture.jobs);
		const remote = {
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "remote-1",
			title: "Task",
			body: "Original",
			dependencyIssueIds: [] as string[],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: now,
		};
		let writeCalls = 0;
		const writes = new CollaborativeIssueWriteCoordinator(
			fixture.state,
			fixture.effects,
			fixture.effectResults,
			{
				readIssue: async () => ({
					...remote,
					dependencyIssueIds: [...remote.dependencyIssueIds],
				}),
				writeFields: async (_repositoryId, _issueId, fields) => {
					writeCalls += 1;
					Object.assign(remote, fields);
					remote.sourceRevisionId = "remote-2";
					return {
						status: "confirmed_success",
						receipt: { version: "remote-2" },
					};
				},
				setBlockedBy: async (
					_repositoryId,
					_issueId,
					dependencyIssueId,
					blocked,
				) => {
					writeCalls += 1;
					remote.dependencyIssueIds = blocked
						? [
								...new Set([...remote.dependencyIssueIds, dependencyIssueId]),
							].sort()
						: remote.dependencyIssueIds.filter(
								(id) => id !== dependencyIssueId,
							);
					remote.sourceRevisionId = "remote-3";
					return {
						status: "confirmed_success",
						receipt: { dependencyIssueId, blocked },
					};
				},
			},
		);

		const result = await writes.apply({
			operationId: "issue-write-1",
			jobId: job.jobId,
			expectedJobVersion: job.rowVersion,
			expectedScopeRevisionId: "scope-1",
			proposedFields: { body: "Agreed update" },
			dependencyChanges: [{ issueId: "issue-2", blocked: true }],
			callerIdentity: "github-user:42",
			authorizedHumanIdentities: ["github-user:42"],
			authorityEvidence: { approvalId: "human-approval-1" },
			policyVersion: "policy-1",
			newScopeRevisionId: "scope-2",
			readbackObservationId: "readback-1",
			writerGeneration: 1,
		});

		assert.equal(result.outcome, "verified");
		assert.equal(
			(
				await writes.apply({
					operationId: "issue-write-1",
					jobId: job.jobId,
					expectedJobVersion: job.rowVersion,
					expectedScopeRevisionId: "scope-1",
					proposedFields: { body: "Agreed update" },
					dependencyChanges: [{ issueId: "issue-2", blocked: true }],
					callerIdentity: "github-user:42",
					authorizedHumanIdentities: ["github-user:42"],
					authorityEvidence: { approvalId: "human-approval-1" },
					policyVersion: "policy-1",
					newScopeRevisionId: "scope-2",
					readbackObservationId: "readback-1",
					writerGeneration: 1,
				})
			).outcome,
			"verified",
		);
		assert.equal(writeCalls, 2);
		assert.equal(fixture.jobs.get(job.jobId)?.scopeRevisionId, "scope-2");
		assert.equal(scopes.getRevision("scope-2")?.body, "Agreed update");
		assert.deepEqual(scopes.getRevision("scope-2")?.dependencyIssueIds, [
			"issue-2",
		]);
		assert.deepEqual(
			fixture.effects
				.get("issue-write-1")
				?.steps.map((step) => [step.stepKey, step.status]),
			[
				["dependency:add:issue-2", "confirmed_success"],
				["fields", "confirmed_success"],
				["preflight", "confirmed_success"],
				["readback", "confirmed_success"],
			],
		);
	} finally {
		fixture.close();
	}
});

test("records a preflight conflict and performs no remote write", async () => {
	const fixture = createStateFixture();
	try {
		const now = new Date().toISOString();
		new IssueScopeStore(fixture.state).recordCompleteRead({
			observationId: "initial-read",
			scopeRevisionId: "scope-1",
			repositoryId: "repo-1",
			issueId: "issue-1",
			sourceRevisionId: "remote-1",
			title: "Task",
			body: "Original",
			dependencyIssueIds: [],
			templateVersion: "1",
			policyVersion: "policy-1",
			observedAt: now,
			expectedHeadVersion: 0,
			writerGeneration: 1,
		});
		const job = createJob(fixture.jobs);
		let writeCalls = 0;
		const writes = new CollaborativeIssueWriteCoordinator(
			fixture.state,
			fixture.effects,
			fixture.effectResults,
			{
				readIssue: async () => ({
					repositoryId: "repo-1",
					issueId: "issue-1",
					sourceRevisionId: "remote-2",
					title: "Concurrent edit",
					body: "Changed elsewhere",
					dependencyIssueIds: [],
					templateVersion: "1",
					policyVersion: "policy-1",
					observedAt: now,
				}),
				writeFields: async () => {
					writeCalls += 1;
					return { status: "confirmed_success", receipt: {} };
				},
				setBlockedBy: async () => {
					writeCalls += 1;
					return { status: "confirmed_success", receipt: {} };
				},
			},
		);
		const result = await writes.apply({
			operationId: "issue-write-conflict",
			jobId: job.jobId,
			expectedJobVersion: job.rowVersion,
			expectedScopeRevisionId: "scope-1",
			proposedFields: { body: "Agreed update" },
			dependencyChanges: [],
			callerIdentity: "github-user:42",
			authorizedHumanIdentities: ["github-user:42"],
			authorityEvidence: { approvalId: "human-approval-1" },
			policyVersion: "policy-1",
			newScopeRevisionId: "scope-2",
			readbackObservationId: "readback-conflict",
			writerGeneration: 1,
		});

		assert.equal(result.outcome, "conflict");
		assert.equal(writeCalls, 0);
		assert.equal(
			fixture.effects
				.get("issue-write-conflict")
				?.steps.find((step) => step.stepKey === "preflight")?.status,
			"confirmed_failure",
		);
	} finally {
		fixture.close();
	}
});
