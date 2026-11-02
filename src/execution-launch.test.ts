import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionLaunchCoordinator } from "./execution-launch.js";
import { AdmissionStore } from "./admission.js";
import { IssueScopeStore } from "./issue-scopes.js";
import { WriterCoordinator } from "./writer.js";
import type {
	RuntimeSupervisor,
	RuntimeTaskInspection,
	RuntimeTaskStartRequest,
} from "./runtime-supervisor.js";
import {
	createJob,
	createStateFixture,
	prepareExecutionStartEvidence,
} from "./state-fixture.js";

const profile = {
	configurationRevisionId: "config-1",
	runtimeImage: `registry.example/coding@sha256:${"a".repeat(64)}`,
	sourceBundleId: "bundle-1",
	sourceCommitSha: "b".repeat(40),
	workspaceGrantId: "workspace-profile-1",
	toolGrantId: "tool-profile-1",
	networkGrantId: "network-profile-1",
	budgetProfileRevisionId: "budget-1",
	validationCommands: ["npm run check"],
};

function taskFor(
	request: RuntimeTaskStartRequest,
	status: "starting" | "running" | "stopping" | "stopped" = "running",
) {
	return {
		launchId: request.launchId,
		taskId: "task-1",
		jobId: request.jobId,
		executionId: request.executionId,
		ownershipGeneration: request.ownershipGeneration,
		requestFingerprint: request.requestFingerprint,
		runtimeImage: request.runtimeImage,
		sourceCommitSha: request.sourceCommitSha,
		status,
	} as const;
}

function prepareLaunch(
	fixture: ReturnType<typeof createStateFixture>,
	supervisor: RuntimeSupervisor,
) {
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
	return {
		coordinator: new ExecutionLaunchCoordinator(
			fixture.state,
			fixture.jobs,
			fixture.executions,
			fixture.effects,
			fixture.effectResults,
			supervisor,
		),
		input: {
			operationId: "launch-1",
			stepId: "launch-1-step",
			executionId: execution.executionId,
			expectedJobVersion: fixture.jobs.get(job.jobId)?.rowVersion ?? 0,
			expectedExecutionVersion: execution.rowVersion,
			expectedIssueHeadVersion: startEvidence.issueHeadVersion,
			expectedReadinessHeadVersion: startEvidence.readinessHeadVersion,
			policyVersion: "policy-1",
			profile,
			writerGeneration: 1,
		},
	};
}

test("activates a reserved execution only after inspecting its exact running task", async () => {
	const fixture = createStateFixture();
	try {
		let request: RuntimeTaskStartRequest | undefined;
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				const intent = fixture.effects.get(value.launchId);
				assert.equal(intent?.operation.executionId, value.executionId);
				assert.equal(intent?.steps[0]?.startedGeneration, 1);
				request = value;
				return { kind: "accepted", taskId: "task-1" };
			},
			async inspectTask() {
				assert.ok(request);
				return { kind: "present", task: taskFor(request) };
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);

		const result = await coordinator.launch(input);

		assert.equal(result.status, "active");
		assert.equal(result.execution.lifecycle, "active");
		assert.equal(result.taskId, "task-1");
		assert.equal(
			fixture.effects.get("launch-1")?.steps[0]?.status,
			"confirmed_success",
		);
	} finally {
		fixture.close();
	}
});

test("reconciles a lost launch response before considering another start", async () => {
	const fixture = createStateFixture();
	try {
		let startCount = 0;
		let request: RuntimeTaskStartRequest | undefined;
		let inspection: RuntimeTaskInspection = { kind: "unknown" };
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				startCount += 1;
				request = value;
				throw new Error("response lost");
			},
			async inspectTask() {
				return inspection;
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);

		const uncertain = await coordinator.launch(input);
		assert.equal(uncertain.status, "pending");
		assert.equal(fixture.effects.get("launch-1")?.steps[0]?.status, "unknown");

		assert.ok(request);
		inspection = { kind: "present", task: taskFor(request) };
		const reconciled = await coordinator.reconcile({
			operationId: "launch-1",
			writerGeneration: 1,
		});

		assert.equal(reconciled.status, "active");
		assert.equal(startCount, 1);
		assert.equal(reconciled.execution.lifecycle, "active");
	} finally {
		fixture.close();
	}
});

test("keeps a mismatched supervisor task unknown and does not activate it", async () => {
	const fixture = createStateFixture();
	try {
		let request: RuntimeTaskStartRequest | undefined;
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				request = value;
				return { kind: "accepted", taskId: "task-1" };
			},
			async inspectTask() {
				assert.ok(request);
				return {
					kind: "present",
					task: { ...taskFor(request), executionId: "other-execution" },
				};
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);

		const result = await coordinator.launch(input);

		assert.equal(result.status, "pending");
		assert.equal(result.execution.lifecycle, "starting");
		assert.equal(fixture.effects.get("launch-1")?.steps[0]?.status, "unknown");
	} finally {
		fixture.close();
	}
});

test("keeps launch unknown when accepted and inspected task identities differ", async () => {
	const fixture = createStateFixture();
	try {
		let request: RuntimeTaskStartRequest | undefined;
		let inspectedTaskId = "different-task";
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				request = value;
				return { kind: "accepted", taskId: "task-from-start" };
			},
			async inspectTask() {
				assert.ok(request);
				return {
					kind: "present",
					task: { ...taskFor(request), taskId: inspectedTaskId },
				};
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);

		const result = await coordinator.launch(input);

		assert.equal(result.status, "pending");
		assert.equal(result.reasonCode, "supervisor_task_binding_mismatch");
		assert.equal(fixture.effects.get("launch-1")?.steps[0]?.status, "unknown");
		const recovered = new ExecutionLaunchCoordinator(
			fixture.state,
			fixture.jobs,
			fixture.executions,
			fixture.effects,
			fixture.effectResults,
			supervisor,
		);
		const replayed = await recovered.reconcile({
			operationId: "launch-1",
			writerGeneration: 1,
		});
		assert.equal(replayed.status, "pending");
		assert.equal(replayed.taskId, "task-from-start");
		const blocker = fixture.jobs
			.listBlockers("job-1")
			.find((item) => item.status === "open");
		assert.equal(blocker?.code, "runtime_launch_unresolved");
		assert.ok(
			fixture.effects
				.listAudit("launch-1")
				.some(
					(event) =>
						event.payloadJson.includes("different-task") &&
						event.payloadJson.includes("task-from-start"),
				),
		);

		inspectedTaskId = "task-from-start";
		const reconciled = await recovered.reconcile({
			operationId: "launch-1",
			writerGeneration: 1,
		});
		assert.equal(reconciled.status, "active");
		assert.equal(reconciled.taskId, "task-from-start");
		assert.equal(
			fixture.jobs
				.listBlockers("job-1")
				.filter((item) => item.status === "open").length,
			0,
		);
	} finally {
		fixture.close();
	}
});

test("reuses a confirmed launch receipt when activation is retried after resume", async () => {
	const fixture = createStateFixture();
	try {
		let request: RuntimeTaskStartRequest | undefined;
		let pauseDuringInspection = true;
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				request = value;
				return { kind: "accepted", taskId: "task-1" };
			},
			async inspectTask() {
				assert.ok(request);
				if (pauseDuringInspection) {
					pauseDuringInspection = false;
					const job = fixture.jobs.get(request.jobId);
					assert.ok(job);
					fixture.jobs.transition({
						jobId: job.jobId,
						expectedVersion: job.rowVersion,
						writerGeneration: 1,
						requestedControl: "pause",
						eventType: "pause_requested",
					});
				}
				return { kind: "present", task: taskFor(request) };
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);

		const paused = await coordinator.launch(input);
		assert.equal(paused.status, "blocked");
		assert.equal(
			fixture.effects.get("launch-1")?.steps[0]?.status,
			"confirmed_success",
		);

		const job = fixture.jobs.get("job-1");
		assert.ok(job);
		fixture.jobs.transition({
			jobId: job.jobId,
			expectedVersion: job.rowVersion,
			writerGeneration: 1,
			requestedControl: "run",
			eventType: "resume_requested",
		});

		const resumed = await coordinator.reconcile({
			operationId: "launch-1",
			writerGeneration: 1,
		});
		assert.equal(resumed.status, "active");
		assert.equal(resumed.execution.lifecycle, "active");
	} finally {
		fixture.close();
	}
});

test("preserves a confirmed launch when reconciliation contradicts it with not-created", async () => {
	const fixture = createStateFixture();
	try {
		let request: RuntimeTaskStartRequest | undefined;
		let inspection: RuntimeTaskInspection = { kind: "unknown" };
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				request = value;
				return { kind: "accepted", taskId: "task-1" };
			},
			async inspectTask() {
				return inspection;
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);
		const pending = await coordinator.launch(input);
		assert.equal(pending.status, "pending");
		assert.equal(fixture.effects.get("launch-1")?.steps[0]?.status, "unknown");

		assert.ok(request);
		inspection = { kind: "present", task: taskFor(request) };
		const job = fixture.jobs.get("job-1");
		assert.ok(job);
		fixture.jobs.transition({
			jobId: job.jobId,
			expectedVersion: job.rowVersion,
			writerGeneration: 1,
			requestedControl: "pause",
			eventType: "pause_requested",
		});
		const blocked = await coordinator.reconcile({
			operationId: "launch-1",
			writerGeneration: 1,
		});
		assert.equal(blocked.status, "blocked");
		assert.equal(
			fixture.effects.get("launch-1")?.steps[0]?.status,
			"confirmed_success",
		);

		inspection = { kind: "not_created", authoritative: true };
		const contradictory = await coordinator.reconcile({
			operationId: "launch-1",
			writerGeneration: 1,
		});
		assert.equal(contradictory.status, "pending");
		assert.equal(contradictory.reasonCode, "launch_outcome_conflict");
		assert.equal(contradictory.execution.lifecycle, "starting");
		assert.equal(
			fixture.effects.get("launch-1")?.steps[0]?.status,
			"confirmed_success",
		);
	} finally {
		fixture.close();
	}
});

test("finishes a confirmed launch failure after a crash before lifecycle transition", async () => {
	const fixture = createStateFixture();
	try {
		let inspectCount = 0;
		const supervisor: RuntimeSupervisor = {
			async startTask() {
				throw new Error("response lost");
			},
			async inspectTask() {
				inspectCount += 1;
				return { kind: "unknown" };
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);
		const pending = await coordinator.launch(input);
		assert.equal(pending.status, "pending");
		const step = fixture.effects.get("launch-1")?.steps[0];
		assert.ok(step);
		fixture.effectResults.recordResult({
			operationId: "launch-1",
			stepId: step.stepId,
			expectedStepVersion: step.rowVersion,
			status: "confirmed_failure",
			result: { reasonCode: "runtime_not_created" },
			resultGeneration: 1,
			resultSource: "reconciliation",
			writerGeneration: 1,
		});

		const reconciled = await coordinator.reconcile({
			operationId: "launch-1",
			writerGeneration: 1,
		});
		assert.equal(reconciled.status, "failed");
		assert.equal(reconciled.execution.lifecycle, "terminal");
		assert.equal(reconciled.reasonCode, "runtime_not_created");
		assert.equal(
			fixture.jobs
				.listBlockers("job-1")
				.filter((item) => item.status === "open").length,
			0,
		);
		assert.equal(inspectCount, 1);
	} finally {
		fixture.close();
	}
});

test("blocks activation when the job scope changes while supervisor inspection awaits", async () => {
	const fixture = createStateFixture();
	try {
		let request: RuntimeTaskStartRequest | undefined;
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				request = value;
				return { kind: "accepted", taskId: "task-1" };
			},
			async inspectTask() {
				assert.ok(request);
				const job = fixture.jobs.get(request.jobId);
				assert.ok(job);
				fixture.jobs.transition({
					jobId: job.jobId,
					expectedVersion: job.rowVersion,
					writerGeneration: 1,
					scopeRevisionId: "scope-2",
					eventType: "scope_changed",
				});
				return { kind: "present", task: taskFor(request) };
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);
		const result = await coordinator.launch(input);
		assert.equal(result.status, "blocked");
		assert.equal(result.reasonCode, "launch_scope_changed");
		assert.equal(result.execution.lifecycle, "starting");
		assert.equal(
			fixture.jobs
				.listBlockers("job-1")
				.filter((item) => item.status === "open").length,
			1,
		);
	} finally {
		fixture.close();
	}
});

test("copies only profile fields and retains Controller-owned launch bindings", async () => {
	const fixture = createStateFixture();
	try {
		let request: RuntimeTaskStartRequest | undefined;
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				request = value;
				return { kind: "accepted", taskId: "task-1" };
			},
			async inspectTask() {
				assert.ok(request);
				return { kind: "present", task: taskFor(request) };
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);
		const widerProfile = {
			...profile,
			jobId: "other-job",
			executionId: "other-execution",
			ownershipGeneration: 99,
			repositoryId: "other-repository",
			scopeRevisionId: "other-scope",
			policyVersion: "other-policy",
			launchId: "other-launch",
			unrelatedCredential: "must-not-be-forwarded",
		};
		const result = await coordinator.launch({
			...input,
			profile: widerProfile,
		});
		assert.equal(result.status, "active");
		assert.ok(request);
		assert.equal(request.executionId, "execution-1");
		assert.equal(request.jobId, "job-1");
		assert.equal(request.repositoryId, "repo-1");
		assert.equal(request.scopeRevisionId, "scope-1");
		assert.equal(request.policyVersion, "policy-1");
		assert.equal(request.ownershipGeneration, 1);
		assert.equal(request.launchId, "launch-1");
		assert.equal("unrelatedCredential" in request, false);
	} finally {
		fixture.close();
	}
});

test("replays the recorded failure without another launch or a leftover blocker", async () => {
	const fixture = createStateFixture();
	try {
		let starts = 0;
		const supervisor: RuntimeSupervisor = {
			async startTask() {
				starts += 1;
				return { kind: "rejected", reasonCode: "capacity_refused" };
			},
			async inspectTask() {
				throw new Error("Definitive rejection needs no inspection");
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);
		const initial = await coordinator.launch(input);
		const replay = await coordinator.launch(input);
		assert.equal(initial.status, "failed");
		assert.deepEqual(replay, initial);
		assert.equal(starts, 1);
		assert.equal(
			fixture.jobs
				.listBlockers("job-1")
				.filter((item) => item.status === "open").length,
			0,
		);
	} finally {
		fixture.close();
	}
});

for (const change of ["readiness", "issue"] as const) {
	test(`blocks activation after ${change} changes during runtime startup`, async () => {
		const fixture = createStateFixture();
		try {
			let request: RuntimeTaskStartRequest | undefined;
			const supervisor: RuntimeSupervisor = {
				async startTask(value) {
					request = value;
					return { kind: "accepted", taskId: "task-1" };
				},
				async inspectTask() {
					assert.ok(request);
					const base = {
						observationId: "changed-head",
						repositoryId: request.repositoryId,
						issueId: request.issueId,
						observedAt: new Date().toISOString(),
						expectedHeadVersion: 1,
						writerGeneration: 1,
					};
					if (change === "readiness") {
						new AdmissionStore(fixture.state).recordReadinessObservation({
							...base,
							labelPresent: false,
							complete: true,
						});
					} else {
						new IssueScopeStore(fixture.state).recordCompleteRead({
							...base,
							scopeRevisionId: "scope-2",
							sourceRevisionId: "provider-2",
							title: "Changed task",
							body: "New scope",
							dependencyIssueIds: [],
							templateVersion: "1",
							policyVersion: "policy-2",
						});
					}
					return { kind: "present", task: taskFor(request) };
				},
				async terminateTask() {
					return { kind: "accepted" };
				},
			};
			const { coordinator, input } = prepareLaunch(fixture, supervisor);
			const result = await coordinator.launch(input);
			assert.equal(result.status, "blocked");
			assert.equal(
				result.reasonCode,
				change === "readiness"
					? "readiness_removed_during_launch"
					: "launch_scope_changed",
			);
			assert.equal(result.execution.lifecycle, "starting");
		} finally {
			fixture.close();
		}
	});
}

test("keeps accepted task identity when authoritative absence contradicts the receipt", async () => {
	const fixture = createStateFixture();
	try {
		const supervisor: RuntimeSupervisor = {
			async startTask() {
				return { kind: "accepted", taskId: "accepted-task" };
			},
			async inspectTask() {
				return { kind: "not_created", authoritative: true };
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);
		for (const result of [
			await coordinator.launch(input),
			await coordinator.reconcile({
				operationId: "launch-1",
				writerGeneration: 1,
			}),
		]) {
			assert.equal(result.status, "pending");
			assert.equal(result.reasonCode, "launch_outcome_conflict");
			assert.equal(result.taskId, "accepted-task");
			assert.equal(result.execution.lifecycle, "starting");
		}
		assert.equal(
			fixture.jobs
				.listBlockers("job-1")
				.filter((item) => item.status === "open").length,
			1,
		);
	} finally {
		fixture.close();
	}
});

test("rejects an old writer completion after generation replacement during inspection", async () => {
	const fixture = createStateFixture();
	let writer: WriterCoordinator | undefined;
	try {
		let request: RuntimeTaskStartRequest | undefined;
		const supervisor: RuntimeSupervisor = {
			async startTask(value) {
				request = value;
				return { kind: "accepted", taskId: "task-1" };
			},
			async inspectTask() {
				assert.ok(request);
				writer = await WriterCoordinator.start(
					fixture.database,
					(generation) => {
						fixture.effectResults.recoverPendingSteps(generation);
					},
				);
				return { kind: "present", task: taskFor(request) };
			},
			async terminateTask() {
				return { kind: "accepted" };
			},
		};
		const { coordinator, input } = prepareLaunch(fixture, supervisor);
		await assert.rejects(coordinator.launch(input), {
			code: "STALE_GENERATION",
		});
		assert.equal(fixture.executions.get("execution-1")?.lifecycle, "starting");
		assert.equal(fixture.effects.get("launch-1")?.steps[0]?.status, "unknown");
		assert.ok(
			fixture.effects
				.listAudit("launch-1")
				.some((event) => event.eventType.includes("stale_generation")),
		);
	} finally {
		writer?.stop();
		fixture.close();
	}
});
