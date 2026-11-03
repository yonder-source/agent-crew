import { createHash } from "node:crypto";
import { canonicalJson } from "../effects/effect-model.js";
import {
	assertText,
	mapJob,
	StateError,
	type RawExecution,
	type RawJob,
	type StateContext,
} from "../state/state-common.js";

type PrerequisiteState =
	| {
			status: "complete";
			evidenceId: string;
			evidenceKind: "merged_pr" | "authorized_human_confirmation";
			sourceRevisionId: string;
	  }
	| { status: "incomplete" | "missing" };

export type ReadinessObservationInput = {
	observationId: string;
	repositoryId: string;
	issueId: string;
	labelPresent: boolean | null;
	approvedActorIdentity?: string;
	complete: boolean;
	observedAt: string;
	expectedHeadVersion: number;
	writerGeneration: number;
};

export type AdmissionInput = {
	decisionId: string;
	jobId: string;
	executionId: string;
	repositoryId: string;
	issueId: string;
	scopeRevisionId: string;
	expectedIssueHeadVersion: number;
	expectedReadinessHeadVersion: number;
	issueIsOpen: boolean;
	repositoryBindingValid: boolean;
	authorizedApproverIdentities: string[];
	authorizedPrerequisiteConfirmerIdentities: string[];
	currentPolicyVersion: string;
	nativeDependencyIssueIds: string[];
	prerequisiteStates: Record<string, PrerequisiteState>;
	dependencyKinds: Record<string, "coding" | "non_coding">;
	dependencyGraph: Record<string, string[]>;
	maxLiveExecutions: number;
	writerGeneration: number;
};

export type AdmissionResult = {
	outcome: "blocked" | "clarification" | "stale" | "admitted" | "existing";
	reasonCode: string | null;
	jobId: string | null;
	executionId: string | null;
	clarificationSnapshot?: {
		observationId: string;
		sourceRevisionId: string;
		contentFingerprint: string;
		title: string;
		body: string;
		dependencyIssueIds: string[];
		templateVersion: string;
		policyVersion: string;
	};
};

type RawCurrentObservation = {
	repository_id: string;
	issue_id: string;
	head_version: number;
	observation_id: string;
	status: "complete" | "unavailable";
	label_present: number | null;
	approved_actor_identity: string | null;
};

function dependencyCycle(
	start: string,
	graph: Record<string, string[]>,
): boolean {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (node: string): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const dependency of graph[node] ?? [])
			if (visit(dependency)) return true;
		visiting.delete(node);
		visited.add(node);
		return false;
	};
	return visit(start);
}

export class AdmissionStore {
	constructor(private readonly state: StateContext) {}

	getReadinessHeadVersion(repositoryId: string, issueId: string): number {
		return this.getReadinessHead(repositoryId, issueId)?.head_version ?? 0;
	}

	recordReadinessObservation(input: ReadinessObservationInput): {
		headVersion: number;
		accepted: boolean;
	} {
		for (const [value, label] of [
			[input.observationId, "observation id"],
			[input.repositoryId, "repository id"],
			[input.issueId, "issue id"],
		] as const)
			assertText(value, label);
		if (
			!Number.isSafeInteger(input.expectedHeadVersion) ||
			input.expectedHeadVersion < 0
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Expected readiness head version must be non-negative",
			);
		}
		if (input.complete !== (input.labelPresent !== null)) {
			throw new StateError(
				"INVALID_INPUT",
				"Complete readiness observations require label presence",
			);
		}
		if (!Number.isFinite(Date.parse(input.observedAt)))
			throw new StateError("INVALID_INPUT", "Observation time must be valid");

		return this.state.runWithIntakeRejectionAudit({
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			operationId: input.observationId,
			operation: "readiness_observation",
			generation: input.writerGeneration,
			action: () => {
				this.state.assertWriter(
					input.writerGeneration,
					this.state.now().toISOString(),
				);
				const head = this.getReadinessHead(input.repositoryId, input.issueId);
				const accepted =
					(head?.head_version ?? 0) === input.expectedHeadVersion;
				const sequence = (
					this.state.database
						.prepare(`
        SELECT coalesce(max(observation_sequence), 0) + 1 AS sequence FROM readiness_observations
        WHERE repository_id = ? AND issue_id = ?
      `)
						.get(input.repositoryId, input.issueId) as { sequence: number }
				).sequence;
				const observationId = accepted
					? input.observationId
					: `${input.observationId}:superseded`;
				this.state.database
					.prepare(`
        INSERT INTO readiness_observations (
          observation_id, repository_id, issue_id, observation_sequence, based_on_version,
          status, label_present, approved_actor_identity, observed_at, writer_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
					.run(
						observationId,
						input.repositoryId,
						input.issueId,
						sequence,
						input.expectedHeadVersion,
						accepted
							? input.complete
								? "complete"
								: "unavailable"
							: "superseded",
						accepted
							? input.labelPresent === null
								? null
								: Number(input.labelPresent)
							: null,
						accepted ? (input.approvedActorIdentity ?? null) : null,
						input.observedAt,
						input.writerGeneration,
					);
				const version = (head?.head_version ?? 0) + 1;
				if (accepted)
					this.state.database
						.prepare(`
        INSERT INTO readiness_heads (repository_id, issue_id, head_version, observation_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (repository_id, issue_id) DO UPDATE SET
          head_version = excluded.head_version, observation_id = excluded.observation_id
      `)
						.run(input.repositoryId, input.issueId, version, observationId);
				return {
					headVersion: accepted ? version : (head?.head_version ?? 0),
					accepted,
				};
			},
		});
	}

	admit(input: AdmissionInput): AdmissionResult {
		for (const [value, label] of [
			[input.decisionId, "decision id"],
			[input.jobId, "job id"],
			[input.executionId, "execution id"],
			[input.repositoryId, "repository id"],
			[input.issueId, "issue id"],
			[input.scopeRevisionId, "scope revision id"],
			[input.currentPolicyVersion, "policy version"],
		] as const)
			assertText(value, label);
		if (
			!Number.isSafeInteger(input.maxLiveExecutions) ||
			input.maxLiveExecutions < 1
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Maximum live executions must be positive",
			);
		}
		const decidedAt = this.state.now().toISOString();
		const {
			decisionId: _decisionId,
			writerGeneration: _writerGeneration,
			...request
		} = input;
		const requestFingerprint = createHash("sha256")
			.update(canonicalJson(request))
			.digest("hex");
		return this.state.runWithIntakeRejectionAudit({
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			operationId: input.decisionId,
			operation: "issue_admission",
			generation: input.writerGeneration,
			action: () => {
				this.state.assertWriter(input.writerGeneration, decidedAt);
				const existingDecision = this.state.database
					.prepare("SELECT * FROM admission_decisions WHERE decision_id = ?")
					.get(input.decisionId) as
					| {
							repository_id: string;
							issue_id: string;
							request_fingerprint: string;
							details_json: string;
					  }
					| undefined;
				if (existingDecision) {
					if (
						existingDecision.repository_id !== input.repositoryId ||
						existingDecision.issue_id !== input.issueId
					) {
						throw new StateError(
							"DECISION_ID_CONFLICT",
							"Admission decision identity is already used",
						);
					}
					if (existingDecision.request_fingerprint !== requestFingerprint) {
						throw new StateError(
							"DECISION_ARGUMENT_MISMATCH",
							"Admission decision identity was reused with changed arguments",
						);
					}
					const saved = JSON.parse(
						existingDecision.details_json,
					) as AdmissionResult;
					return saved;
				}

				const decide = (
					outcome: AdmissionResult["outcome"],
					reasonCode: string | null,
					jobId: string | null = null,
					executionId: string | null = null,
					clarificationSnapshot?: AdmissionResult["clarificationSnapshot"],
				): AdmissionResult => {
					const result: AdmissionResult = {
						outcome,
						reasonCode,
						jobId,
						executionId,
					};
					if (clarificationSnapshot)
						result.clarificationSnapshot = clarificationSnapshot;
					this.state.database
						.prepare(`
          INSERT INTO admission_decisions (
            decision_id, repository_id, issue_id, outcome, reason_code, details_json,
            request_fingerprint, job_id, execution_id, writer_generation, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
						.run(
							input.decisionId,
							input.repositoryId,
							input.issueId,
							outcome,
							reasonCode,
							canonicalJson(result),
							requestFingerprint,
							jobId,
							executionId,
							input.writerGeneration,
							decidedAt,
						);
					return result;
				};

				const issueHead = this.state.database
					.prepare(`
        SELECT h.head_version, o.observation_id, o.status, o.scope_revision_id, o.content_fingerprint
        FROM issue_read_heads h JOIN issue_read_observations o USING (observation_id)
        WHERE h.repository_id = ? AND h.issue_id = ?
      `)
					.get(input.repositoryId, input.issueId) as
					| {
							head_version: number;
							observation_id: string;
							status: string;
							scope_revision_id: string | null;
							content_fingerprint: string | null;
					  }
					| undefined;
				if (!issueHead) return decide("blocked", "issue_read_unavailable");
				if (issueHead.head_version !== input.expectedIssueHeadVersion)
					return decide("blocked", "issue_snapshot_changed");
				if (issueHead.status === "unattributable") {
					const snapshot = this.state.database
						.prepare(`
          SELECT o.observation_id, o.source_revision_id, o.content_fingerprint,
            s.title, s.body, s.dependency_issue_ids_json, s.template_version, s.policy_version
          FROM issue_read_observations o JOIN unattributed_issue_snapshots s USING (observation_id)
          WHERE o.observation_id = ?
        `)
						.get(issueHead.observation_id) as
						| {
								observation_id: string;
								source_revision_id: string;
								content_fingerprint: string;
								title: string;
								body: string;
								dependency_issue_ids_json: string;
								template_version: string;
								policy_version: string;
						  }
						| undefined;
					if (!snapshot) return decide("blocked", "issue_snapshot_missing");
					return decide(
						"clarification",
						"current_revision_unlinked",
						null,
						null,
						{
							observationId: snapshot.observation_id,
							sourceRevisionId: snapshot.source_revision_id,
							contentFingerprint: snapshot.content_fingerprint,
							title: snapshot.title,
							body: snapshot.body,
							dependencyIssueIds: JSON.parse(
								snapshot.dependency_issue_ids_json,
							) as string[],
							templateVersion: snapshot.template_version,
							policyVersion: snapshot.policy_version,
						},
					);
				}
				if (issueHead.status !== "complete")
					return decide("blocked", "issue_read_unavailable");
				if (!issueHead.scope_revision_id)
					return decide("clarification", "current_revision_unlinked");
				if (issueHead.scope_revision_id !== input.scopeRevisionId)
					return decide("stale", "approval_revision_stale");

				const readinessHead = this.state.database
					.prepare(`
        SELECT h.head_version, o.status, o.label_present, o.approved_actor_identity
        FROM readiness_heads h JOIN readiness_observations o USING (observation_id)
        WHERE h.repository_id = ? AND h.issue_id = ?
      `)
					.get(input.repositoryId, input.issueId) as
					| {
							head_version: number;
							status: string;
							label_present: number | null;
							approved_actor_identity: string | null;
					  }
					| undefined;
				if (readinessHead?.status !== "complete")
					return decide("blocked", "readiness_unavailable");
				if (readinessHead.head_version !== input.expectedReadinessHeadVersion)
					return decide("blocked", "readiness_changed");
				if (readinessHead.label_present !== 1)
					return decide("blocked", "not_ready");
				if (!input.repositoryBindingValid)
					return decide("blocked", "repository_binding_mismatch");
				if (!input.issueIsOpen) return decide("blocked", "issue_not_open");

				const revision = this.state.database
					.prepare(
						"SELECT * FROM issue_scope_revisions WHERE scope_revision_id = ?",
					)
					.get(input.scopeRevisionId) as
					| { repository_id: string; issue_id: string; policy_version: string }
					| undefined;
				if (
					!revision ||
					revision.repository_id !== input.repositoryId ||
					revision.issue_id !== input.issueId
				) {
					return decide("blocked", "scope_binding_mismatch");
				}
				const savedDependencies = this.state.database
					.prepare(
						"SELECT dependency_issue_ids_json FROM issue_scope_revisions WHERE scope_revision_id = ?",
					)
					.get(input.scopeRevisionId) as { dependency_issue_ids_json: string };
				const approvals = this.state.database
					.prepare(`
        SELECT * FROM readiness_evidence WHERE repository_id = ? AND issue_id = ? AND label_present = 1
        ORDER BY rowid DESC
      `)
					.all(input.repositoryId, input.issueId) as Array<{
					source: string;
					scope_revision_id: string;
					approver_identity: string;
				}>;
				const latestBySource = new Map<string, (typeof approvals)[number]>();
				for (const approval of approvals)
					if (!latestBySource.has(approval.source))
						latestBySource.set(approval.source, approval);
				if (latestBySource.size === 0)
					return decide("blocked", "approval_evidence_missing");
				const distinctApproval = [...latestBySource.values()];
				if (
					distinctApproval.some(
						(item) => item.scope_revision_id !== input.scopeRevisionId,
					)
				) {
					if (distinctApproval.length > 1)
						return decide("blocked", "readiness_evidence_conflict");
					return decide("stale", "approval_revision_stale");
				}
				if (
					new Set(distinctApproval.map((item) => item.approver_identity)).size >
					1
				) {
					return decide("blocked", "readiness_evidence_conflict");
				}
				const approver = distinctApproval[0]?.approver_identity;
				if (!approver || approver !== readinessHead.approved_actor_identity) {
					return decide("blocked", "readiness_evidence_conflict");
				}
				if (!input.authorizedApproverIdentities.includes(approver))
					return decide("blocked", "approver_unauthorized");
				if (revision.policy_version !== input.currentPolicyVersion)
					return decide("blocked", "policy_revision_changed");
				if (dependencyCycle(input.issueId, input.dependencyGraph))
					return decide("blocked", "dependency_cycle");
				const nativeDependencies = [
					...new Set(input.nativeDependencyIssueIds),
				].sort();
				if (
					canonicalJson(nativeDependencies) !==
					canonicalJson(JSON.parse(savedDependencies.dependency_issue_ids_json))
				) {
					return decide("blocked", "dependency_snapshot_mismatch");
				}
				if (
					nativeDependencies.some((dependencyId) => {
						const proof = input.prerequisiteStates[dependencyId];
						const kind = input.dependencyKinds[dependencyId];
						if (
							!kind ||
							proof?.status !== "complete" ||
							!proof.evidenceId ||
							!proof.sourceRevisionId
						)
							return true;
						return kind === "coding"
							? proof.evidenceKind !== "merged_pr"
							: proof.evidenceKind !== "authorized_human_confirmation" ||
									!this.hasCurrentPrerequisiteConfirmation(
										input.repositoryId,
										dependencyId,
										proof.evidenceId,
										proof.sourceRevisionId,
										input.authorizedPrerequisiteConfirmerIdentities,
									);
					})
				) {
					return decide("blocked", "dependency_incomplete");
				}

				const priorJob = this.state.database
					.prepare(
						"SELECT * FROM jobs WHERE repository_id = ? AND issue_id = ?",
					)
					.get(input.repositoryId, input.issueId) as RawJob | undefined;
				if (priorJob) {
					const live = this.state.database
						.prepare(
							"SELECT * FROM executions WHERE job_id = ? AND lifecycle <> 'terminal'",
						)
						.get(priorJob.job_id) as RawExecution | undefined;
					return decide(
						"existing",
						null,
						mapJob(priorJob).jobId,
						live?.execution_id ?? null,
					);
				}
				const liveCount = (
					this.state.database
						.prepare(`
        SELECT count(*) AS count FROM executions e JOIN jobs j USING (job_id)
        WHERE j.repository_id = ? AND e.lifecycle <> 'terminal'
      `)
						.get(input.repositoryId) as { count: number }
				).count;
				if (liveCount >= input.maxLiveExecutions)
					return decide("blocked", "repository_capacity_exhausted");

				this.state.database
					.prepare(`
        INSERT INTO jobs (
          job_id, repository_id, issue_id, scope_revision_id, phase, requested_control,
          row_version, event_sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 'run', 1, 1, ?, ?)
      `)
					.run(
						input.jobId,
						input.repositoryId,
						input.issueId,
						input.scopeRevisionId,
						decidedAt,
						decidedAt,
					);
				this.state.insertEvent({
					jobId: input.jobId,
					sequence: 1,
					rowVersion: 1,
					eventType: "job_created",
					payload: {
						repositoryId: input.repositoryId,
						issueId: input.issueId,
						scopeRevisionId: input.scopeRevisionId,
					},
					writerGeneration: input.writerGeneration,
					occurredAt: decidedAt,
				});
				this.state.database
					.prepare(`
        INSERT INTO executions (
          execution_id, job_id, ownership_generation, lifecycle, terminal_outcome,
          row_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'reserved', NULL, 1, ?, ?)
      `)
					.run(
						input.executionId,
						input.jobId,
						input.writerGeneration,
						decidedAt,
						decidedAt,
					);
				this.state.database
					.prepare(`
        UPDATE jobs SET row_version = 2, event_sequence = 2, updated_at = ? WHERE job_id = ?
      `)
					.run(decidedAt, input.jobId);
				this.state.insertEvent({
					jobId: input.jobId,
					sequence: 2,
					rowVersion: 2,
					eventType: "execution_reserved",
					payload: {
						executionId: input.executionId,
						admissionDecisionId: input.decisionId,
					},
					writerGeneration: input.writerGeneration,
					occurredAt: decidedAt,
				});
				return decide("admitted", null, input.jobId, input.executionId);
			},
		});
	}

	private getReadinessHead(
		repositoryId: string,
		issueId: string,
	): RawCurrentObservation | undefined {
		return this.state.database
			.prepare(`
      SELECT h.repository_id, h.issue_id, h.head_version, o.observation_id, o.status,
        o.label_present, o.approved_actor_identity
      FROM readiness_heads h JOIN readiness_observations o USING (observation_id)
      WHERE h.repository_id = ? AND h.issue_id = ?
    `)
			.get(repositoryId, issueId) as RawCurrentObservation | undefined;
	}

	private hasCurrentPrerequisiteConfirmation(
		repositoryId: string,
		issueId: string,
		confirmationId: string,
		sourceRevisionId: string,
		authorizedHumanIdentities: string[],
	): boolean {
		const confirmation = this.state.database
			.prepare(`
					SELECT confirmation.confirmed_by
					FROM prerequisite_confirmations confirmation
					JOIN issue_scope_revisions revision
					  ON revision.scope_revision_id = confirmation.scope_revision_id
					JOIN issue_read_heads head
					  ON head.repository_id = confirmation.repository_id
				 AND head.issue_id = confirmation.issue_id
			JOIN issue_read_observations observation
			  ON observation.observation_id = head.observation_id
					WHERE confirmation.confirmation_id = ?
			  AND confirmation.repository_id = ?
			  AND confirmation.issue_id = ?
			  AND revision.source_revision_id = ?
			  AND observation.status = 'complete'
			  AND observation.scope_revision_id = confirmation.scope_revision_id
			LIMIT 1
				`)
			.get(confirmationId, repositoryId, issueId, sourceRevisionId) as
			| { confirmed_by: string }
			| undefined;
		return (
			confirmation !== undefined &&
			authorizedHumanIdentities.includes(confirmation.confirmed_by)
		);
	}
}
