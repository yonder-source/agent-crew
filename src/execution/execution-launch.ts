import { createHash } from "node:crypto";
import type { EffectResultStore } from "../effects/effect-results.js";
import type { EffectStore } from "../effects/effects.js";
import { canonicalJson } from "../effects/effect-model.js";
import type { ExecutionStore } from "./executions.js";
import type { JobStore } from "../jobs/jobs.js";
import {
	assertText,
	StateError,
	type ExecutionRecord,
	type StateContext,
} from "../state/state-common.js";
import type {
	RuntimeLaunchProfile,
	RuntimeSupervisor,
	RuntimeTaskInspection,
	RuntimeTaskReference,
	RuntimeTaskStartRequest,
	RuntimeTaskStartResult,
} from "./runtime-supervisor.js";

const OPERATION_KIND = "runtime_launch";
const STEP_KEY = "launch";
const CALLER_IDENTITY = "controller:runtime-launcher";

export type LaunchExecutionInput = {
	operationId: string;
	stepId: string;
	executionId: string;
	expectedJobVersion: number;
	expectedExecutionVersion: number;
	expectedIssueHeadVersion: number;
	expectedReadinessHeadVersion: number;
	policyVersion: string;
	profile: RuntimeLaunchProfile;
	writerGeneration: number;
};

export type ExecutionLaunchResult = {
	status: "active" | "pending" | "failed" | "blocked";
	execution: ExecutionRecord;
	taskId: string | null;
	reasonCode: string | null;
};

export class ExecutionLaunchCoordinator {
	constructor(
		private readonly state: StateContext,
		private readonly jobs: JobStore,
		private readonly executions: ExecutionStore,
		private readonly effects: EffectStore,
		private readonly effectResults: EffectResultStore,
		private readonly supervisor: RuntimeSupervisor,
	) {}

	/** Read only the identity already persisted and checked by the launcher. */
	runtimeBinding(operationId: string): {
		request: RuntimeTaskStartRequest;
		taskId: string;
		confirmed: boolean;
		startedAt: string;
	} {
		const view = this.effects.get(operationId);
		const step = view?.steps.find((item) => item.stepKey === STEP_KEY);
		if (!view || !step) throw new StateError("RUNTIME_LAUNCH_NOT_FOUND", "Launch binding is unavailable");
		const request = parseRequest(step.targetJson);
		this.assertLaunchRecord(view, request, "INVALID_RUNTIME_LAUNCH_RECORD");
		const taskId = readTaskId(step.resultJson);
		if (!taskId || !step.startedAt) throw new StateError("RUNTIME_TASK_UNKNOWN", "Launch has no attributable dispatched task");
		return { request, taskId, confirmed: step.status === "confirmed_success", startedAt: step.startedAt };
	}

	async launch(input: LaunchExecutionInput): Promise<ExecutionLaunchResult> {
		this.validateInput(input);
		const execution = this.executions.get(input.executionId);
		if (!execution)
			throw new StateError("EXECUTION_NOT_FOUND", "Execution does not exist");
		const job = this.jobs.get(execution.jobId);
		if (!job)
			throw new StateError("JOB_NOT_FOUND", "Execution job does not exist");
		if (execution.ownershipGeneration !== input.writerGeneration) {
			return this.result("blocked", execution, null, "stale_execution_owner");
		}
		const existing = this.effects.get(input.operationId);
		const request = this.buildRequest(
			input,
			existing
				? { ...job, scopeRevisionId: existing.operation.scopeRevisionId }
				: job,
		);
		if (existing) {
			this.assertLaunchRecord(existing, request, "OPERATION_ID_CONFLICT");
			return this.reconcile({
				operationId: input.operationId,
				writerGeneration: input.writerGeneration,
			});
		}
		if (execution.lifecycle !== "reserved") {
			throw new StateError(
				"EXECUTION_NOT_RESERVED",
				"Only a reserved execution can be launched",
			);
		}
		if (job.rowVersion !== input.expectedJobVersion) {
			throw new StateError(
				"STALE_ROW_VERSION",
				"Job changed before execution launch",
			);
		}
		if (execution.rowVersion !== input.expectedExecutionVersion) {
			throw new StateError(
				"STALE_ROW_VERSION",
				"Execution changed before launch",
			);
		}

		this.state.runWithStaleAudit(
			job.jobId,
			input.writerGeneration,
			this.state.now().toISOString(),
			"execution_launch_prepare",
			() => {
				this.state.assertWriter(
					input.writerGeneration,
					this.state.now().toISOString(),
				);
				const currentJob = this.state.getJobOrThrow(job.jobId);
				if (currentJob.row_version !== input.expectedJobVersion) {
					throw new StateError(
						"STALE_ROW_VERSION",
						"Job changed before execution launch",
					);
				}
				const currentExecution = this.state.getExecutionOrThrow(
					input.executionId,
				);
				if (currentExecution.row_version !== input.expectedExecutionVersion) {
					throw new StateError(
						"STALE_ROW_VERSION",
						"Execution changed before launch",
					);
				}
				const transitioned = this.executions.transition({
					executionId: input.executionId,
					expectedVersion: input.expectedExecutionVersion,
					writerGeneration: input.writerGeneration,
					lifecycle: "starting",
					expectedIssueHeadVersion: input.expectedIssueHeadVersion,
					expectedReadinessHeadVersion: input.expectedReadinessHeadVersion,
				});
				const transitionedJob = this.jobs.get(job.jobId);
				if (!transitionedJob)
					throw new StateError("JOB_NOT_FOUND", "Execution job does not exist");
				this.assertPolicyRevision(
					input.policyVersion,
					job.scopeRevisionId,
					job.repositoryId,
					job.issueId,
				);
				this.effects.begin({
					operationId: input.operationId,
					jobId: job.jobId,
					executionId: input.executionId,
					operationKind: OPERATION_KIND,
					arguments: request,
					target: {
						executionId: input.executionId,
						launchId: input.operationId,
					},
					expectedJobVersion: transitionedJob.rowVersion,
					expectedExecutionVersion: transitioned.rowVersion,
					scopeRevisionId: job.scopeRevisionId,
					policyVersion: input.policyVersion,
					callerIdentity: CALLER_IDENTITY,
					grant: {
						action: "runtime.launch",
						configurationRevisionId: input.profile.configurationRevisionId,
					},
					steps: [{ stepId: input.stepId, stepKey: STEP_KEY, target: request }],
					writerGeneration: input.writerGeneration,
				});
				if (
					!this.effects.claimStepStart(
						input.operationId,
						input.stepId,
						input.writerGeneration,
					)
				) {
					throw new StateError(
						"LAUNCH_INTENT_NOT_STARTABLE",
						"Runtime launch intent could not be claimed",
					);
				}
				return transitioned;
			},
		);

		let response: RuntimeTaskStartResult | undefined;
		try {
			response = await this.supervisor.startTask(request);
		} catch {
			// A transport failure does not prove that no task was created.
		}
		if (response?.kind === "rejected") {
			assertText(response.reasonCode, "supervisor rejection reasonCode");
			return this.confirmNotStarted({
				operationId: input.operationId,
				executionId: input.executionId,
				writerGeneration: input.writerGeneration,
				reasonCode: response.reasonCode,
				resultSource: "provider_receipt",
			});
		}
		if (response?.kind === "accepted") {
			assertText(response.taskId, "supervisor taskId");
			const knownTaskId = readTaskId(
				this.launchStep(input.operationId).resultJson,
			);
			const conflict = knownTaskId !== null && knownTaskId !== response.taskId;
			const pending = this.recordUnknown(
				{ ...input, resultSource: "provider_receipt" },
				conflict
					? "supervisor_task_binding_mismatch"
					: "runtime_accepted_awaiting_inspection",
				{ startResult: response },
				response.taskId,
			);
			if (conflict) return pending;
		}

		return this.inspectAndApply({
			operationId: input.operationId,
			executionId: input.executionId,
			writerGeneration: input.writerGeneration,
			request,
			resultSource:
				response === undefined ? "reconciliation" : "provider_receipt",
			fallbackReason: response === undefined ? "launch_response_unknown" : null,
		});
	}

	async reconcile(input: {
		operationId: string;
		writerGeneration: number;
	}): Promise<ExecutionLaunchResult> {
		assertText(input.operationId, "operationId");
		const view = this.effects.get(input.operationId);
		if (!view || view.operation.operationKind !== OPERATION_KIND) {
			throw new StateError(
				"RUNTIME_LAUNCH_NOT_FOUND",
				"Runtime launch operation does not exist",
			);
		}
		const step = view.steps.find((item) => item.stepKey === STEP_KEY);
		if (!step)
			throw new StateError(
				"RUNTIME_LAUNCH_STEP_NOT_FOUND",
				"Runtime launch step does not exist",
			);
		const request = parseRequest(step.targetJson);
		this.assertLaunchRecord(view, request, "INVALID_RUNTIME_LAUNCH_RECORD");
		const execution = this.executions.get(view.operation.executionId ?? "");
		if (!execution)
			throw new StateError("EXECUTION_NOT_FOUND", "Execution does not exist");
		if (execution.ownershipGeneration !== input.writerGeneration) {
			return this.result("blocked", execution, null, "stale_execution_owner");
		}
		if (
			execution.lifecycle === "active" &&
			step.status === "confirmed_success"
		) {
			return this.result(
				"active",
				execution,
				readTaskId(step.resultJson),
				null,
			);
		}
		if (
			step.status === "confirmed_failure" &&
			(execution.lifecycle === "starting" ||
				(execution.lifecycle === "terminal" &&
					execution.terminalOutcome === "launch_failed"))
		) {
			return this.finishFailedLaunch(
				input.operationId,
				execution,
				input.writerGeneration,
				readReasonCode(step.resultJson) ?? "launch_failure_already_confirmed",
				readTaskId(step.resultJson),
			);
		}
		if (execution.lifecycle !== "starting") {
			return this.result("blocked", execution, null, "execution_not_starting");
		}
		return this.inspectAndApply({
			operationId: input.operationId,
			executionId: execution.executionId,
			writerGeneration: input.writerGeneration,
			request,
			resultSource: "reconciliation",
			fallbackReason: null,
		});
	}

	private async inspectAndApply(input: {
		operationId: string;
		executionId: string;
		writerGeneration: number;
		request: RuntimeTaskStartRequest;
		resultSource: "provider_receipt" | "reconciliation";
		fallbackReason: string | null;
	}): Promise<ExecutionLaunchResult> {
		let inspection: RuntimeTaskInspection;
		try {
			inspection = await this.supervisor.inspectTask({
				launchId: input.request.launchId,
				jobId: input.request.jobId,
				executionId: input.request.executionId,
				ownershipGeneration: input.request.ownershipGeneration,
				requestFingerprint: input.request.requestFingerprint,
			});
		} catch {
			inspection = { kind: "unknown" };
		}

		if (inspection.kind === "unknown") {
			return this.recordUnknown(
				input,
				input.fallbackReason ?? "supervisor_status_unknown",
				{ inspection },
			);
		}
		const expectedTaskId = readTaskId(
			this.launchStep(input.operationId).resultJson,
		);
		if (inspection.kind === "not_created") {
			if (expectedTaskId !== null) {
				return this.recordUnknown(input, "launch_outcome_conflict", {
					inspection,
				});
			}
			return this.confirmNotStarted({
				operationId: input.operationId,
				executionId: input.executionId,
				writerGeneration: input.writerGeneration,
				reasonCode: input.fallbackReason ?? "runtime_not_created",
				resultSource: input.resultSource,
			});
		}

		const task = inspection.task;
		if (
			!task.taskId.trim() ||
			!matchesTask(task, input.request) ||
			(expectedTaskId !== null && task.taskId !== expectedTaskId)
		) {
			return this.recordUnknown(input, "supervisor_task_binding_mismatch", {
				inspection,
			});
		}
		if (task.status === "starting" || task.status === "stopping") {
			return this.recordUnknown(
				input,
				`runtime_${task.status}`,
				{ inspection },
				task.taskId,
			);
		}
		if (task.status === "stopped") {
			return this.confirmNotStarted({
				operationId: input.operationId,
				executionId: input.executionId,
				writerGeneration: input.writerGeneration,
				reasonCode: "runtime_stopped_before_activation",
				resultSource: input.resultSource,
				taskId: task.taskId,
			});
		}

		const recorded = this.recordResult({
			operationId: input.operationId,
			writerGeneration: input.writerGeneration,
			status: "confirmed_success",
			resultSource: input.resultSource,
			result: { task, requestFingerprint: input.request.requestFingerprint },
		});
		if (recorded.historyOnly) {
			const currentStep = this.effects
				.get(input.operationId)
				?.steps.find((item) => item.stepKey === STEP_KEY);
			if (currentStep?.status !== "confirmed_success") {
				const execution = this.executions.get(input.executionId);
				if (!execution)
					throw new StateError(
						"EXECUTION_NOT_FOUND",
						"Execution does not exist",
					);
				return this.result(
					"pending",
					execution,
					task.taskId,
					"launch_result_superseded",
				);
			}
		}
		try {
			return this.state.runWithStaleAudit(
				input.request.jobId,
				input.writerGeneration,
				this.state.now().toISOString(),
				"execution_launch_activate",
				() => {
					this.state.assertWriter(
						input.writerGeneration,
						this.state.now().toISOString(),
					);
					const current = this.state.getExecutionOrThrow(input.executionId);
					if (current.lifecycle === "active") {
						const execution = this.executions.get(input.executionId);
						if (!execution)
							throw new StateError(
								"EXECUTION_NOT_FOUND",
								"Execution does not exist",
							);
						this.resolveLaunchBlockers(
							input.operationId,
							execution,
							input.writerGeneration,
						);
						return this.result("active", execution, task.taskId, null);
					}
					this.assertCurrentLaunchScope(input.request);
					const active = this.executions.transition({
						executionId: input.executionId,
						expectedVersion: current.row_version,
						writerGeneration: input.writerGeneration,
						lifecycle: "active",
						eventPayload: {
							taskId: task.taskId,
							launchOperationId: input.operationId,
						},
					});
					this.resolveLaunchBlockers(
						input.operationId,
						active,
						input.writerGeneration,
					);
					return this.result("active", active, task.taskId, null);
				},
			);
		} catch (error) {
			const reasonCodes: Record<string, string> = {
				JOB_CONTROL_BLOCKS_EXECUTION: "control_requested_during_launch",
				START_SCOPE_STALE: "launch_scope_changed",
				STALE_POLICY_REVISION: "launch_scope_changed",
				READINESS_REMOVED: "readiness_removed_during_launch",
			};
			const reasonCode =
				error instanceof StateError ? reasonCodes[error.code] : undefined;
			if (reasonCode !== undefined) {
				const execution = this.executions.get(input.executionId);
				if (!execution)
					throw new StateError(
						"EXECUTION_NOT_FOUND",
						"Execution does not exist",
					);
				this.ensureLaunchBlocker(
					input.operationId,
					execution,
					input.writerGeneration,
				);
				return this.result("blocked", execution, task.taskId, reasonCode);
			}
			throw error;
		}
	}

	private assertCurrentLaunchScope(request: RuntimeTaskStartRequest): void {
		const job = this.state.getJobOrThrow(request.jobId);
		if (
			job.scope_revision_id !== request.scopeRevisionId ||
			job.repository_id !== request.repositoryId ||
			job.issue_id !== request.issueId
		) {
			throw new StateError(
				"START_SCOPE_STALE",
				"Job scope changed during runtime launch",
			);
		}
		this.assertPolicyRevision(
			request.policyVersion,
			request.scopeRevisionId,
			request.repositoryId,
			request.issueId,
		);
		const issue = this.state.database
			.prepare(`
			SELECT o.status, o.scope_revision_id FROM issue_read_heads h
			JOIN issue_read_observations o USING (observation_id)
			WHERE h.repository_id = ? AND h.issue_id = ?
		`)
			.get(request.repositoryId, request.issueId) as
			| { status: string; scope_revision_id: string | null }
			| undefined;
		if (
			issue?.status !== "complete" ||
			issue.scope_revision_id !== request.scopeRevisionId
		) {
			throw new StateError(
				"START_SCOPE_STALE",
				"Current issue no longer matches the launch scope",
			);
		}
		const readiness = this.state.database
			.prepare(`
			SELECT o.status, o.label_present FROM readiness_heads h
			JOIN readiness_observations o USING (observation_id)
			WHERE h.repository_id = ? AND h.issue_id = ?
		`)
			.get(request.repositoryId, request.issueId) as
			| { status: string; label_present: number | null }
			| undefined;
		if (readiness?.status !== "complete" || readiness.label_present !== 1) {
			throw new StateError(
				"READINESS_REMOVED",
				"Readiness no longer permits execution activation",
			);
		}
	}

	private recordUnknown(
		input: {
			operationId: string;
			executionId: string;
			writerGeneration: number;
			resultSource: "provider_receipt" | "reconciliation";
		},
		reasonCode: string,
		evidence: {
			inspection?: RuntimeTaskInspection;
			startResult?: RuntimeTaskStartResult;
		} = {},
		observedTaskId?: string,
	): ExecutionLaunchResult {
		const execution = this.executions.get(input.executionId);
		if (!execution)
			throw new StateError("EXECUTION_NOT_FOUND", "Execution does not exist");
		return this.state.runWithStaleAudit(
			execution.jobId,
			input.writerGeneration,
			this.state.now().toISOString(),
			"execution_launch_pending",
			() => {
				const taskId =
					readTaskId(this.launchStep(input.operationId).resultJson) ??
					observedTaskId ??
					null;
				const recorded = this.recordResult({
					operationId: input.operationId,
					writerGeneration: input.writerGeneration,
					status: "unknown",
					resultSource: input.resultSource,
					result: { reasonCode, taskId, ...evidence },
				});
				this.ensureLaunchBlocker(
					input.operationId,
					execution,
					input.writerGeneration,
				);
				return this.result(
					"pending",
					execution,
					readTaskId(recorded.step.resultJson),
					reasonCode,
				);
			},
		);
	}

	private launchStep(operationId: string) {
		const step = this.effects
			.get(operationId)
			?.steps.find((item) => item.stepKey === STEP_KEY);
		if (!step)
			throw new StateError(
				"RUNTIME_LAUNCH_STEP_NOT_FOUND",
				"Runtime launch step does not exist",
			);
		return step;
	}

	private launchBlockerDetails(
		operationId: string,
		execution: ExecutionRecord,
	) {
		return {
			operationId,
			executionId: execution.executionId,
			nextAction: "reconcile_or_request_operator",
		};
	}

	private openLaunchBlockers(operationId: string, execution: ExecutionRecord) {
		const detailsJson = JSON.stringify(
			this.launchBlockerDetails(operationId, execution),
		);
		return this.jobs
			.listBlockers(execution.jobId)
			.filter(
				(blocker) =>
					blocker.status === "open" &&
					blocker.code === "runtime_launch_unresolved" &&
					blocker.detailsJson === detailsJson,
			);
	}

	private ensureLaunchBlocker(
		operationId: string,
		execution: ExecutionRecord,
		writerGeneration: number,
	): void {
		if (this.openLaunchBlockers(operationId, execution).length > 0) return;
		const job = this.state.getJobOrThrow(execution.jobId);
		this.jobs.addBlocker({
			blockerId: `runtime-launch:${operationId}:${job.event_sequence + 1}`,
			jobId: execution.jobId,
			code: "runtime_launch_unresolved",
			details: this.launchBlockerDetails(operationId, execution),
			writerGeneration,
		});
	}

	private resolveLaunchBlockers(
		operationId: string,
		execution: ExecutionRecord,
		writerGeneration: number,
	): void {
		for (const blocker of this.openLaunchBlockers(operationId, execution)) {
			this.jobs.resolveBlocker({
				blockerId: blocker.blockerId,
				expectedJobVersion: this.state.getJobOrThrow(execution.jobId)
					.row_version,
				writerGeneration,
			});
		}
	}

	private confirmNotStarted(input: {
		operationId: string;
		executionId: string;
		writerGeneration: number;
		reasonCode: string;
		resultSource: "provider_receipt" | "reconciliation";
		taskId?: string;
	}): ExecutionLaunchResult {
		const recorded = this.recordResult({
			operationId: input.operationId,
			writerGeneration: input.writerGeneration,
			status: "confirmed_failure",
			resultSource: input.resultSource,
			result: { reasonCode: input.reasonCode, taskId: input.taskId ?? null },
		});
		const execution = this.executions.get(input.executionId);
		if (!execution)
			throw new StateError("EXECUTION_NOT_FOUND", "Execution does not exist");
		if (recorded.historyOnly && recorded.step.status === "confirmed_success") {
			this.ensureLaunchBlocker(
				input.operationId,
				execution,
				input.writerGeneration,
			);
			return this.result(
				"pending",
				execution,
				readTaskId(recorded.step.resultJson),
				"launch_outcome_conflict",
			);
		}
		if (execution.lifecycle === "starting") {
			return this.finishFailedLaunch(
				input.operationId,
				execution,
				input.writerGeneration,
				input.reasonCode,
				input.taskId ?? null,
			);
		}
		return this.result(
			"failed",
			execution,
			input.taskId ?? null,
			input.reasonCode,
		);
	}

	private finishFailedLaunch(
		operationId: string,
		execution: ExecutionRecord,
		writerGeneration: number,
		reasonCode: string,
		taskId: string | null = null,
	): ExecutionLaunchResult {
		return this.state.runWithStaleAudit(
			execution.jobId,
			writerGeneration,
			this.state.now().toISOString(),
			"execution_launch_failed",
			() => {
				this.state.assertWriter(
					writerGeneration,
					this.state.now().toISOString(),
				);
				const terminal =
					execution.lifecycle === "terminal"
						? execution
						: this.executions.transition({
								executionId: execution.executionId,
								expectedVersion: execution.rowVersion,
								writerGeneration,
								lifecycle: "terminal",
								terminalOutcome: "launch_failed",
								eventPayload: { reasonCode, taskId },
							});
				this.resolveLaunchBlockers(operationId, terminal, writerGeneration);
				return this.result("failed", terminal, taskId, reasonCode);
			},
		);
	}

	private recordResult(input: {
		operationId: string;
		writerGeneration: number;
		status: "confirmed_success" | "confirmed_failure" | "unknown";
		resultSource: "provider_receipt" | "reconciliation";
		result: unknown;
	}) {
		const step = this.launchStep(input.operationId);
		return this.effectResults.recordResult({
			operationId: input.operationId,
			stepId: step.stepId,
			expectedStepVersion: step.rowVersion,
			status: input.status,
			result: input.result,
			resultGeneration: input.writerGeneration,
			resultSource: input.resultSource,
			writerGeneration: input.writerGeneration,
		});
	}

	private buildRequest(
		input: LaunchExecutionInput,
		job: ReturnType<JobStore["get"]> & {},
	) {
		this.assertPolicyRevision(
			input.policyVersion,
			job.scopeRevisionId,
			job.repositoryId,
			job.issueId,
		);
		const base = {
			launchId: input.operationId,
			jobId: job.jobId,
			repositoryId: job.repositoryId,
			issueId: job.issueId,
			executionId: input.executionId,
			ownershipGeneration: input.writerGeneration,
			scopeRevisionId: job.scopeRevisionId,
			policyVersion: input.policyVersion,
			configurationRevisionId: input.profile.configurationRevisionId,
			runtimeImage: input.profile.runtimeImage,
			sourceBundleId: input.profile.sourceBundleId,
			sourceCommitSha: input.profile.sourceCommitSha,
			workspaceGrantId: input.profile.workspaceGrantId,
			toolGrantId: input.profile.toolGrantId,
			networkGrantId: input.profile.networkGrantId,
			budgetProfileRevisionId: input.profile.budgetProfileRevisionId,
			validationCommands: [...input.profile.validationCommands],
		};
		return {
			...base,
			requestFingerprint: createHash("sha256")
				.update(canonicalJson(base))
				.digest("hex"),
		};
	}

	private assertLaunchRecord(
		view: NonNullable<ReturnType<EffectStore["get"]>>,
		request: RuntimeTaskStartRequest,
		code: "OPERATION_ID_CONFLICT" | "INVALID_RUNTIME_LAUNCH_RECORD",
	): void {
		if (
			view.operation.operationKind !== OPERATION_KIND ||
			view.operation.operationId !== request.launchId ||
			view.operation.writerGeneration !== request.ownershipGeneration ||
			view.operation.executionId !== request.executionId ||
			view.operation.jobId !== request.jobId ||
			view.operation.scopeRevisionId !== request.scopeRevisionId ||
			view.operation.policyVersion !== request.policyVersion ||
			view.operation.argumentFingerprint !==
				createHash("sha256").update(canonicalJson(request)).digest("hex") ||
			view.operation.targetJson !==
				canonicalJson({
					executionId: request.executionId,
					launchId: request.launchId,
				}) ||
			view.steps.find((step) => step.stepKey === STEP_KEY)?.targetJson !==
				canonicalJson(request)
		) {
			throw new StateError(
				code,
				"Runtime launch identity, arguments and stored bindings must agree",
			);
		}
	}

	private assertPolicyRevision(
		policyVersion: string,
		scopeRevisionId: string,
		repositoryId: string,
		issueId: string,
	): void {
		const row = this.state.database
			.prepare(
				"SELECT repository_id, issue_id, policy_version FROM issue_scope_revisions WHERE scope_revision_id = ?",
			)
			.get(scopeRevisionId) as
			| { repository_id: string; issue_id: string; policy_version: string }
			| undefined;
		if (
			!row ||
			row.policy_version !== policyVersion ||
			row.repository_id !== repositoryId ||
			row.issue_id !== issueId
		) {
			throw new StateError(
				"STALE_POLICY_REVISION",
				"Runtime policy does not match the reserved scope revision",
			);
		}
	}

	private validateInput(input: LaunchExecutionInput): void {
		for (const [label, value] of Object.entries({
			expectedJobVersion: input.expectedJobVersion,
			expectedExecutionVersion: input.expectedExecutionVersion,
			expectedIssueHeadVersion: input.expectedIssueHeadVersion,
			expectedReadinessHeadVersion: input.expectedReadinessHeadVersion,
			writerGeneration: input.writerGeneration,
		})) {
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new StateError(
					"INVALID_INPUT",
					`${label} must be a positive integer`,
				);
			}
		}
		for (const [label, value] of Object.entries({
			operationId: input.operationId,
			stepId: input.stepId,
			executionId: input.executionId,
			policyVersion: input.policyVersion,
		}))
			assertText(value, label);
		validateLaunchProfile(input.profile);
	}

	private result(
		status: ExecutionLaunchResult["status"],
		execution: ExecutionRecord,
		taskId: string | null,
		reasonCode: string | null,
	): ExecutionLaunchResult {
		return { status, execution, taskId, reasonCode };
	}
}

function matchesTask(
	task: RuntimeTaskReference,
	request: RuntimeTaskStartRequest,
): boolean {
	return (
		task.launchId === request.launchId &&
		task.jobId === request.jobId &&
		task.executionId === request.executionId &&
		task.ownershipGeneration === request.ownershipGeneration &&
		task.requestFingerprint === request.requestFingerprint
	);
}

function parseRequest(value: string): RuntimeTaskStartRequest {
	try {
		const request = JSON.parse(value) as RuntimeTaskStartRequest;
		validateRuntimeTaskStartRequest(request);
		return request;
	} catch {
		throw new StateError(
			"INVALID_RUNTIME_LAUNCH_RECORD",
			"Stored runtime launch request is invalid",
		);
	}
}

function validateRuntimeTaskStartRequest(
	request: RuntimeTaskStartRequest,
): void {
	for (const [label, value] of Object.entries({
		launchId: request.launchId,
		jobId: request.jobId,
		repositoryId: request.repositoryId,
		issueId: request.issueId,
		executionId: request.executionId,
		scopeRevisionId: request.scopeRevisionId,
		policyVersion: request.policyVersion,
		requestFingerprint: request.requestFingerprint,
	}))
		assertText(value, label);
	if (
		!Number.isSafeInteger(request.ownershipGeneration) ||
		request.ownershipGeneration < 1
	) {
		throw new StateError(
			"INVALID_RUNTIME_LAUNCH_RECORD",
			"Stored runtime owner generation is invalid",
		);
	}
	validateLaunchProfile(request);
	const { requestFingerprint, ...base } = request;
	const expectedFingerprint = createHash("sha256")
		.update(canonicalJson(base))
		.digest("hex");
	if (requestFingerprint !== expectedFingerprint) {
		throw new StateError(
			"INVALID_RUNTIME_LAUNCH_RECORD",
			"Stored runtime launch fingerprint does not match its request",
		);
	}
}

function validateLaunchProfile(profile: RuntimeLaunchProfile): void {
	for (const [label, value] of Object.entries({
		configurationRevisionId: profile.configurationRevisionId,
		sourceBundleId: profile.sourceBundleId,
		workspaceGrantId: profile.workspaceGrantId,
		toolGrantId: profile.toolGrantId,
		networkGrantId: profile.networkGrantId,
		budgetProfileRevisionId: profile.budgetProfileRevisionId,
	}))
		assertText(value, label);
	if (
		typeof profile.runtimeImage !== "string" ||
		!/@sha256:[a-f0-9]{64}$/i.test(profile.runtimeImage)
	) {
		throw new StateError(
			"INVALID_INPUT",
			"Runtime image must use a pinned SHA-256 digest",
		);
	}
	if (
		typeof profile.sourceCommitSha !== "string" ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(profile.sourceCommitSha)
	) {
		throw new StateError(
			"INVALID_INPUT",
			"Source commit must be a full Git object ID",
		);
	}
	if (
		!Array.isArray(profile.validationCommands) ||
		profile.validationCommands.length === 0 ||
		profile.validationCommands.some(
			(command) => typeof command !== "string" || !command.trim(),
		)
	) {
		throw new StateError(
			"INVALID_INPUT",
			"At least one non-empty validation command is required",
		);
	}
}

function readTaskId(resultJson: string | null): string | null {
	if (!resultJson) return null;
	try {
		const parsed = JSON.parse(resultJson) as {
			task?: { taskId?: unknown };
			taskId?: unknown;
		};
		if (typeof parsed.task?.taskId === "string") return parsed.task.taskId;
		if (typeof parsed.taskId === "string") return parsed.taskId;
		return null;
	} catch {
		return null;
	}
}

function readReasonCode(resultJson: string | null): string | null {
	if (!resultJson) return null;
	const parsed = JSON.parse(resultJson) as { reasonCode?: unknown };
	return typeof parsed.reasonCode === "string" ? parsed.reasonCode : null;
}
