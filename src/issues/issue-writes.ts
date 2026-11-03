import type { EffectOutcome } from "../effects/effect-model.js";
import { canonicalJson } from "../effects/effect-model.js";
import type { EffectStore } from "../effects/effects.js";
import type { EffectResultStore } from "../effects/effect-results.js";
import { IssueScopeStore } from "./issue-scopes.js";
import { JobStore } from "../jobs/jobs.js";
import { StateError, type StateContext } from "../state/state-common.js";

export type CollaborativeIssueSnapshot = {
	repositoryId: string;
	issueId: string;
	sourceRevisionId: string;
	title: string;
	body: string;
	dependencyIssueIds: string[];
	templateVersion: string;
	policyVersion: string;
	observedAt: string;
};

export type IssueWriteReceipt = {
	status: Exclude<EffectOutcome, "pending">;
	receipt: unknown;
};

export interface CollaborativeIssueProvider {
	readIssue(
		repositoryId: string,
		issueId: string,
	): Promise<CollaborativeIssueSnapshot>;
	writeFields(
		repositoryId: string,
		issueId: string,
		fields: { title?: string; body?: string },
	): Promise<IssueWriteReceipt>;
	setBlockedBy(
		repositoryId: string,
		issueId: string,
		dependencyIssueId: string,
		blocked: boolean,
	): Promise<IssueWriteReceipt>;
}

export type CollaborativeIssueWriteInput = {
	operationId: string;
	jobId: string;
	expectedJobVersion: number;
	expectedScopeRevisionId: string;
	proposedFields: { title?: string; body?: string };
	dependencyChanges: Array<{ issueId: string; blocked: boolean }>;
	callerIdentity: string;
	authorizedHumanIdentities: string[];
	authorityEvidence: unknown;
	policyVersion: string;
	newScopeRevisionId: string;
	readbackObservationId: string;
	writerGeneration: number;
};

export type CollaborativeIssueWriteResult = {
	operationId: string;
	outcome: "verified" | "conflict" | "failed" | "unknown" | "pending";
	scopeRevisionId: string | null;
};

type StepRun = { status: EffectOutcome; result: unknown };

export class CollaborativeIssueWriteCoordinator {
	private readonly scopes: IssueScopeStore;
	private readonly jobs: JobStore;

	constructor(
		private readonly state: StateContext,
		private readonly effects: EffectStore,
		private readonly effectResults: EffectResultStore,
		private readonly provider: CollaborativeIssueProvider,
	) {
		this.scopes = new IssueScopeStore(state);
		this.jobs = new JobStore(state);
	}

	async apply(
		input: CollaborativeIssueWriteInput,
	): Promise<CollaborativeIssueWriteResult> {
		if (!input.authorizedHumanIdentities.includes(input.callerIdentity))
			throw new StateError(
				"CALLER_UNAUTHORIZED",
				"Issue writes require an authorized human",
			);
		const job = this.jobs.get(input.jobId);
		if (!job)
			throw new StateError("JOB_NOT_FOUND", "Issue write job does not exist");
		const existingOperation = this.effects.get(input.operationId);
		if (
			!existingOperation &&
			(job.rowVersion !== input.expectedJobVersion ||
				job.scopeRevisionId !== input.expectedScopeRevisionId)
		) {
			throw new StateError(
				"STALE_SCOPE_REVISION",
				"Issue write authorization is stale",
			);
		}
		const revision = this.scopes.getRevision(input.expectedScopeRevisionId);
		const head = this.scopes.getHead(job.repositoryId, job.issueId);
		if (
			!revision ||
			revision.repositoryId !== job.repositoryId ||
			revision.issueId !== job.issueId ||
			(!existingOperation && revision.scopeRevisionId !== head?.scopeRevisionId)
		) {
			throw new StateError(
				"STALE_SCOPE_REVISION",
				"Issue write requires the current job scope",
			);
		}
		if (revision.policyVersion !== input.policyVersion)
			throw new StateError(
				"STALE_POLICY",
				"Issue write policy does not match the approved scope",
			);
		this.validateProposal(input);

		const changes = [...input.dependencyChanges].sort((left, right) =>
			left.issueId.localeCompare(right.issueId),
		);
		const stepKeys = ["preflight"];
		if (Object.keys(input.proposedFields).length > 0) stepKeys.push("fields");
		for (const change of changes)
			stepKeys.push(
				`dependency:${change.blocked ? "add" : "remove"}:${change.issueId}`,
			);
		if (stepKeys.length === 1)
			throw new StateError(
				"EMPTY_ISSUE_WRITE",
				"Issue write contains no proposed changes",
			);
		const writeStepKeys = stepKeys.slice(1);
		const steps = [
			{
				stepId: `${input.operationId}:preflight`,
				stepKey: "preflight",
				target: { scopeRevisionId: revision.scopeRevisionId },
			},
			...(Object.keys(input.proposedFields).length > 0
				? [
						{
							stepId: `${input.operationId}:fields`,
							stepKey: "fields",
							target: { fields: input.proposedFields },
							dependsOn: ["preflight"],
						},
					]
				: []),
			...changes.map((change) => ({
				stepId: `${input.operationId}:${change.blocked ? "add" : "remove"}:${change.issueId}`,
				stepKey: `dependency:${change.blocked ? "add" : "remove"}:${change.issueId}`,
				target: { dependencyIssueId: change.issueId, blocked: change.blocked },
				dependsOn: ["preflight"],
			})),
			{
				stepId: `${input.operationId}:readback`,
				stepKey: "readback",
				target: { expectedScopeRevisionId: revision.scopeRevisionId },
				dependsOn: writeStepKeys,
			},
		];
		this.effects.begin({
			operationId: input.operationId,
			jobId: input.jobId,
			operationKind: "github_issue_update",
			arguments: {
				expectedScopeRevisionId: revision.scopeRevisionId,
				proposedFields: input.proposedFields,
				dependencyChanges: changes,
				authorityEvidence: input.authorityEvidence,
			},
			target: { repositoryId: job.repositoryId, issueId: job.issueId },
			expectedJobVersion: input.expectedJobVersion,
			scopeRevisionId: revision.scopeRevisionId,
			policyVersion: input.policyVersion,
			callerIdentity: input.callerIdentity,
			grant: {
				action: "issue.write",
				scopeRevisionId: revision.scopeRevisionId,
			},
			steps,
			writerGeneration: input.writerGeneration,
		});
		const preflight = await this.runStep(input, "preflight", async () => {
			const snapshot = await this.provider.readIssue(
				job.repositoryId,
				job.issueId,
			);
			const matches = this.matchesRevision(snapshot, revision);
			return {
				status: matches ? "confirmed_success" : "confirmed_failure",
				result: { snapshot, matchesExpectedRevision: matches },
			};
		});
		if (preflight.status === "unknown") return this.result(input, "unknown");
		if (preflight.status === "pending") return this.result(input, "pending");
		if (preflight.status === "confirmed_failure")
			return this.result(input, "conflict");

		if (Object.keys(input.proposedFields).length > 0) {
			const fields = await this.runStep(input, "fields", async () => {
				const receipt = await this.provider.writeFields(
					job.repositoryId,
					job.issueId,
					input.proposedFields,
				);
				return { status: receipt.status, result: receipt.receipt };
			});
			const result = this.outcomeForWriteStep(input, fields);
			if (result) return result;
		}
		for (const change of changes) {
			const stepKey = `dependency:${change.blocked ? "add" : "remove"}:${change.issueId}`;
			const dependency = await this.runStep(input, stepKey, async () => {
				const receipt = await this.provider.setBlockedBy(
					job.repositoryId,
					job.issueId,
					change.issueId,
					change.blocked,
				);
				return { status: receipt.status, result: receipt.receipt };
			});
			const result = this.outcomeForWriteStep(input, dependency);
			if (result) return result;
		}

		const readback = await this.runStep(input, "readback", async () => {
			const snapshot = await this.provider.readIssue(
				job.repositoryId,
				job.issueId,
			);
			const expected = this.expectedAfterWrite(revision, input, changes);
			const matches = this.matchesExpected(snapshot, expected);
			return {
				status: matches ? "confirmed_success" : "unknown",
				result: { snapshot, matchesProposedState: matches },
			};
		});
		if (readback.status !== "confirmed_success") {
			return this.result(
				input,
				readback.status === "pending" ? "pending" : "unknown",
			);
		}
		const snapshot = (
			readback.result as { snapshot: CollaborativeIssueSnapshot }
		).snapshot;
		const currentHead = this.scopes.getHead(job.repositoryId, job.issueId);
		const alreadyObserved =
			currentHead?.observationId === input.readbackObservationId;
		const observationExists = this.state.database
			.prepare(
				"SELECT 1 AS found FROM issue_read_observations WHERE observation_id = ?",
			)
			.get(input.readbackObservationId);
		if (observationExists && !alreadyObserved)
			return this.result(input, "unknown");
		const updated = alreadyObserved
			? {
					accepted: true,
					revision: this.scopes.getRevision(currentHead.scopeRevisionId ?? ""),
				}
			: this.scopes.recordCompleteRead({
					observationId: input.readbackObservationId,
					scopeRevisionId: input.newScopeRevisionId,
					repositoryId: job.repositoryId,
					issueId: job.issueId,
					sourceRevisionId: snapshot.sourceRevisionId,
					title: snapshot.title,
					body: snapshot.body,
					dependencyIssueIds: snapshot.dependencyIssueIds,
					templateVersion: snapshot.templateVersion,
					policyVersion: snapshot.policyVersion,
					observedAt: snapshot.observedAt,
					expectedHeadVersion: currentHead?.headVersion ?? 0,
					writerGeneration: input.writerGeneration,
				});
		if (!updated.accepted || !updated.revision)
			return this.result(input, "unknown");
		const currentJob = this.jobs.get(input.jobId);
		if (!currentJob) return this.result(input, "unknown");
		if (currentJob.scopeRevisionId !== updated.revision.scopeRevisionId)
			this.jobs.transition({
				jobId: input.jobId,
				expectedVersion: currentJob.rowVersion,
				writerGeneration: input.writerGeneration,
				eventType: "issue_write_readback_verified",
				eventPayload: {
					operationId: input.operationId,
					previousScopeRevisionId: revision.scopeRevisionId,
					scopeRevisionId: updated.revision.scopeRevisionId,
				},
				scopeRevisionId: updated.revision.scopeRevisionId,
			});
		return {
			operationId: input.operationId,
			outcome: "verified",
			scopeRevisionId: updated.revision.scopeRevisionId,
		};
	}

	private async runStep(
		input: CollaborativeIssueWriteInput,
		stepKey: string,
		action: () => Promise<{
			status: Exclude<EffectOutcome, "pending">;
			result: unknown;
		}>,
	): Promise<StepRun> {
		const step = this.effects
			.get(input.operationId)
			?.steps.find((item) => item.stepKey === stepKey);
		if (!step)
			throw new StateError(
				"STEP_NOT_FOUND",
				"Issue write effect step does not exist",
			);
		if (
			!this.effects.claimStepStart(
				input.operationId,
				step.stepId,
				input.writerGeneration,
			)
		)
			return {
				status: step.status,
				result: step.resultJson
					? (JSON.parse(step.resultJson) as unknown)
					: null,
			};
		const claimed = this.effects
			.get(input.operationId)
			?.steps.find((item) => item.stepId === step.stepId);
		if (!claimed)
			throw new StateError(
				"STEP_NOT_FOUND",
				"Claimed issue write step does not exist",
			);
		let result: { status: Exclude<EffectOutcome, "pending">; result: unknown };
		try {
			result = await action();
		} catch (error) {
			result = {
				status: "unknown",
				result: {
					classification: "provider_operation_uncertain",
					errorType: error instanceof Error ? error.name : "Error",
				},
			};
		}
		const saved = this.effectResults.recordResult({
			operationId: input.operationId,
			stepId: claimed.stepId,
			expectedStepVersion: claimed.rowVersion,
			status: result.status,
			result: result.result,
			resultGeneration: input.writerGeneration,
			resultSource: "provider_receipt",
			writerGeneration: input.writerGeneration,
		});
		return {
			status: saved.step.status,
			result: saved.step.resultJson
				? (JSON.parse(saved.step.resultJson) as unknown)
				: null,
		};
	}

	private outcomeForWriteStep(
		input: CollaborativeIssueWriteInput,
		step: StepRun,
	): CollaborativeIssueWriteResult | null {
		if (step.status === "confirmed_success") return null;
		if (step.status === "confirmed_failure")
			return this.result(input, "failed");
		return this.result(
			input,
			step.status === "pending" ? "pending" : "unknown",
		);
	}

	private result(
		input: CollaborativeIssueWriteInput,
		outcome: CollaborativeIssueWriteResult["outcome"],
	): CollaborativeIssueWriteResult {
		return { operationId: input.operationId, outcome, scopeRevisionId: null };
	}

	private matchesRevision(
		snapshot: CollaborativeIssueSnapshot,
		revision: NonNullable<ReturnType<IssueScopeStore["getRevision"]>>,
	): boolean {
		return Boolean(
			snapshot.repositoryId === revision.repositoryId &&
				snapshot.issueId === revision.issueId &&
				snapshot.title === revision.title &&
				snapshot.body === revision.body &&
				canonicalJson([...snapshot.dependencyIssueIds].sort()) ===
					canonicalJson([...revision.dependencyIssueIds].sort()),
		);
	}

	private expectedAfterWrite(
		revision: NonNullable<ReturnType<IssueScopeStore["getRevision"]>>,
		input: CollaborativeIssueWriteInput,
		changes: Array<{ issueId: string; blocked: boolean }>,
	): CollaborativeIssueSnapshot {
		const dependencies = new Set(revision.dependencyIssueIds);
		for (const change of changes) {
			if (change.blocked) dependencies.add(change.issueId);
			else dependencies.delete(change.issueId);
		}
		return {
			repositoryId: revision.repositoryId,
			issueId: revision.issueId,
			sourceRevisionId: "",
			title: input.proposedFields.title ?? revision.title,
			body: input.proposedFields.body ?? revision.body,
			dependencyIssueIds: [...dependencies].sort(),
			templateVersion: revision.templateVersion,
			policyVersion: revision.policyVersion,
			observedAt: "",
		};
	}

	private matchesExpected(
		snapshot: CollaborativeIssueSnapshot,
		expected: CollaborativeIssueSnapshot,
	): boolean {
		return (
			snapshot.repositoryId === expected.repositoryId &&
			snapshot.issueId === expected.issueId &&
			snapshot.title === expected.title &&
			snapshot.body === expected.body &&
			snapshot.templateVersion === expected.templateVersion &&
			snapshot.policyVersion === expected.policyVersion &&
			canonicalJson([...snapshot.dependencyIssueIds].sort()) ===
				canonicalJson(expected.dependencyIssueIds)
		);
	}

	private validateProposal(input: CollaborativeIssueWriteInput): void {
		if (
			Object.keys(input.proposedFields).some(
				(field) => !["title", "body"].includes(field),
			)
		)
			throw new StateError(
				"INVALID_INPUT",
				"Issue writes may change title and body only",
			);
		if (
			input.proposedFields.title !== undefined &&
			!input.proposedFields.title.trim()
		)
			throw new StateError("INVALID_INPUT", "Issue title cannot be empty");
		const ids = new Set<string>();
		for (const change of input.dependencyChanges) {
			if (!change.issueId.trim() || ids.has(change.issueId))
				throw new StateError(
					"INVALID_INPUT",
					"Dependency changes must have unique issue IDs",
				);
			ids.add(change.issueId);
		}
		if (
			Object.keys(input.proposedFields).length === 0 &&
			input.dependencyChanges.length === 0
		)
			throw new StateError(
				"EMPTY_ISSUE_WRITE",
				"Issue write contains no proposed changes",
			);
	}
}
