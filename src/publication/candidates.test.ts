import assert from "node:assert/strict";
import test from "node:test";
import { CandidateStore } from "./candidates.js";
import { StateError } from "../state/state-common.js";
import {
	createJob,
	createStateFixture,
	prepareExecutionStartEvidence,
} from "../../tests/fixtures/state-fixture.js";

function prepareActiveExecution() {
	const fixture = createStateFixture();
	const job = createJob(fixture.jobs);
	const execution = fixture.executions.reserve({
		executionId: "execution-1",
		jobId: job.jobId,
		expectedJobVersion: job.rowVersion,
		writerGeneration: 1,
	});
	const startEvidence = prepareExecutionStartEvidence(
		fixture,
		job.repositoryId,
		job.issueId,
		job.scopeRevisionId,
	);
	const starting = fixture.executions.transition({
		executionId: execution.executionId,
		expectedVersion: execution.rowVersion,
		writerGeneration: 1,
		lifecycle: "starting",
		expectedIssueHeadVersion: startEvidence.issueHeadVersion,
		expectedReadinessHeadVersion: startEvidence.readinessHeadVersion,
	});
	fixture.executions.transition({
		executionId: starting.executionId,
		expectedVersion: starting.rowVersion,
		writerGeneration: 1,
		lifecycle: "active",
	});

	const launchRequest = {
		launchId: "launch-1",
		jobId: job.jobId,
		repositoryId: job.repositoryId,
		issueId: job.issueId,
		executionId: execution.executionId,
		ownershipGeneration: 1,
		scopeRevisionId: job.scopeRevisionId,
		policyVersion: "policy-1",
		configurationRevisionId: "config-1",
		runtimeImage: "runtime@sha256:abc",
		sourceBundleId: "bundle-1",
		sourceCommitSha: "a".repeat(40),
		workspaceGrantId: "workspace-1",
		toolGrantId: "tools-1",
		networkGrantId: "network-1",
		budgetProfileRevisionId: "budget-1",
		validationCommands: ["npm run check", "npm test"],
		requestFingerprint: "b".repeat(64),
	};
	const currentJob = fixture.jobs.get(job.jobId);
	const currentExecution = fixture.executions.get(execution.executionId);
	assert.ok(currentJob);
	assert.ok(currentExecution);
	fixture.effects.begin({
		operationId: "launch-1",
		jobId: job.jobId,
		executionId: execution.executionId,
		operationKind: "runtime_launch",
		arguments: launchRequest,
		target: { executionId: execution.executionId },
		expectedJobVersion: currentJob.rowVersion,
		expectedExecutionVersion: currentExecution.rowVersion,
		scopeRevisionId: job.scopeRevisionId,
		policyVersion: "policy-1",
		callerIdentity: "controller:runtime-launcher",
		grant: { action: "runtime.launch" },
		steps: [
			{
				stepId: "launch-step-1",
				stepKey: "launch",
				target: launchRequest,
			},
		],
		writerGeneration: 1,
	});
	assert.equal(
		fixture.effects.claimStepStart("launch-1", "launch-step-1", 1),
		true,
	);
	const launchStep = fixture.effects.get("launch-1")?.steps[0];
	assert.ok(launchStep);
	fixture.effectResults.recordResult({
		operationId: "launch-1",
		stepId: launchStep.stepId,
		expectedStepVersion: launchStep.rowVersion,
		status: "confirmed_success",
		result: { taskId: "task-1" },
		resultGeneration: 1,
		resultSource: "provider_receipt",
		writerGeneration: 1,
	});
	return { fixture, job, execution, launchRequest };
}

function candidateInput(
	fixture: ReturnType<typeof prepareActiveExecution>["fixture"],
	overrides: Partial<Parameters<CandidateStore["submit"]>[0]> = {},
) {
	const job = fixture.jobs.get("job-1");
	const execution = fixture.executions.get("execution-1");
	assert.ok(job);
	assert.ok(execution);
	return {
		candidateId: "candidate-1",
		executionId: execution.executionId,
		expectedJobVersion: job.rowVersion,
		expectedExecutionVersion: execution.rowVersion,
		candidateSha: "c".repeat(40),
		baseSha: "a".repeat(40),
		sourceBundleId: "bundle-1",
		reportedValidationResults: [
			{
				command: "npm run check",
				exitCode: 0,
				observedAt: "2026-11-03T00:00:00.000Z",
			},
			{
				command: "npm test",
				exitCode: 1,
				observedAt: "2026-11-03T00:01:00.000Z",
			},
		],
		writerGeneration: 1,
		...overrides,
	};
}

test("records an immutable candidate bound to its active execution and launch", () => {
	const { fixture } = prepareActiveExecution();
	try {
		const store = new CandidateStore(fixture.state);
		const input = candidateInput(fixture);
		const submitted = store.submit(input);
		assert.equal(submitted.jobId, "job-1");
		assert.equal(submitted.repositoryId, "repo-1");
		assert.equal(submitted.issueId, "issue-1");
		assert.equal(submitted.scopeRevisionId, "scope-1");
		assert.equal(submitted.candidateSha, "c".repeat(40));
		assert.equal(submitted.baseSha, "a".repeat(40));
		assert.deepEqual(
			submitted.reportedValidationResults,
			input.reportedValidationResults,
		);
		assert.equal(store.submit(input).submittedAt, submitted.submittedAt);
		assert.equal(store.listForJob("job-1").length, 1);
		assert.equal(
			fixture.jobs.get("job-1")?.rowVersion,
			input.expectedJobVersion + 1,
		);
		assert.throws(
			() =>
				fixture.database
					.prepare(
						"UPDATE candidate_submissions SET candidate_sha = ? WHERE candidate_id = ?",
					)
					.run("d".repeat(40), submitted.candidateId),
			/candidate submissions are immutable/,
		);
		assert.throws(
			() =>
				fixture.database
					.prepare("DELETE FROM candidate_submissions WHERE candidate_id = ?")
					.run(submitted.candidateId),
			/candidate submissions are immutable/,
		);
		assert.throws(
			() =>
				store.submit(
					candidateInput(fixture, { candidateId: "candidate-duplicate" }),
				),
			(error: unknown) =>
				error instanceof StateError &&
				error.code === "CANDIDATE_ALREADY_SUBMITTED",
		);
	} finally {
		fixture.close();
	}
});

test("rejects candidates not bound to the current launch or declared validations", () => {
	const { fixture } = prepareActiveExecution();
	try {
		const store = new CandidateStore(fixture.state);
		assert.throws(
			() => store.submit(candidateInput(fixture, { baseSha: "d".repeat(40) })),
			(error: unknown) =>
				error instanceof StateError &&
				error.code === "CANDIDATE_SOURCE_MISMATCH",
		);
		assert.throws(
			() =>
				store.submit(
					candidateInput(fixture, {
						reportedValidationResults: [
							{
								command: "npm test",
								exitCode: 0,
								observedAt: "2026-11-03T00:00:00.000Z",
							},
						],
					}),
				),
			(error: unknown) =>
				error instanceof StateError &&
				error.code === "CANDIDATE_VALIDATION_INCOMPLETE",
		);
		assert.equal(store.listForJob("job-1").length, 0);
	} finally {
		fixture.close();
	}
});

test("rejects a candidate from an inactive or replaced execution", () => {
	const { fixture, execution } = prepareActiveExecution();
	try {
		fixture.executions.transition({
			executionId: execution.executionId,
			expectedVersion:
				fixture.executions.get(execution.executionId)?.rowVersion ?? 0,
			writerGeneration: 1,
			lifecycle: "stopping",
		});
		const input = candidateInput(fixture);
		assert.throws(
			() => new CandidateStore(fixture.state).submit(input),
			(error: unknown) =>
				error instanceof StateError &&
				["STALE_ROW_VERSION", "CANDIDATE_EXECUTION_NOT_CURRENT"].includes(
					error.code,
				),
		);
	} finally {
		fixture.close();
	}
});
