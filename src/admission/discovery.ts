import {
	AdmissionStore,
	type AdmissionInput,
	type AdmissionResult,
} from "./admission.js";
import type { ReadinessEvidenceInput } from "./readiness.js";
import { ReadinessEvidenceStore } from "./readiness.js";
import { IssueScopeStore } from "../issues/issue-scopes.js";
import { PrerequisiteConfirmationStore } from "./prerequisite-confirmations.js";
import { StateError, type StateContext } from "../state/state-common.js";

export type DiscoveryIssueSnapshot = {
	repositoryId: string;
	issueId: string;
	sourceRevisionId: string;
	title: string;
	body: string;
	templateVersion: string;
	policyVersion: string;
	isOpen: boolean;
	observedAt: string;
};

type ApprovalBase = {
	evidenceId: string;
	approvedSourceRevisionId: string;
	approverIdentity: string;
	authorityEvidence: unknown;
	labelPresent: boolean;
	observedAt: string;
};

export type DiscoveryApproval =
	| (ApprovalBase & {
			source: "github_label_event";
			githubLabelEventId: string;
	  })
	| (ApprovalBase & {
			source: "slack_approval";
			slackConversationId: string;
			slackApprovalReceiptId: string;
			labelWriteOperationId: string;
	  });

export type DiscoveryReadiness = {
	complete: boolean;
	labelPresent: boolean | null;
	approvedActorIdentity?: string;
	observedAt: string;
	approvals: DiscoveryApproval[];
};

export type DiscoveryDependencySnapshot = {
	source: string;
	issueIds: string[];
	graph: Record<string, string[]>;
	completionEvidence: Record<
		string,
		| {
				status: "complete";
				evidenceId: string;
				evidenceKind: "merged_pr";
				sourceRevisionId: string;
		  }
		| { status: "missing" | "incomplete" }
	>;
};

export interface AdmissionDiscoveryProvider {
	listIssues(repositoryId: string): Promise<Array<{ issueId: string }>>;
	readIssue(
		repositoryId: string,
		issueId: string,
	): Promise<DiscoveryIssueSnapshot>;
	readReadiness(
		repositoryId: string,
		issueId: string,
	): Promise<DiscoveryReadiness>;
	readBlockedBy(
		repositoryId: string,
		issueId: string,
	): Promise<DiscoveryDependencySnapshot>;
}

export type AdmissionDiscoveryPolicy = {
	repositoryId: string;
	authorizedApproverIdentities: string[];
	authorizedPrerequisiteConfirmerIdentities: string[];
	currentPolicyVersion: string;
	maxLiveExecutions: number;
	dependencyKinds: Record<string, "coding" | "non_coding">;
	writerGeneration: number;
	nextId: (
		kind: "issue-read" | "readiness-read" | "decision" | "job" | "execution",
		issueId: string,
	) => string;
};

export type DiscoveredIssueResult = {
	issueId: string;
	admission: AdmissionResult;
};

export class AdmissionDiscovery {
	private readonly admission: AdmissionStore;
	private readonly issueScopes: IssueScopeStore;
	private readonly readinessEvidence: ReadinessEvidenceStore;
	private readonly confirmations: PrerequisiteConfirmationStore;

	constructor(
		private readonly state: StateContext,
		private readonly provider: AdmissionDiscoveryProvider,
		private readonly policy: AdmissionDiscoveryPolicy,
	) {
		this.admission = new AdmissionStore(state);
		this.issueScopes = new IssueScopeStore(state);
		this.readinessEvidence = new ReadinessEvidenceStore(state);
		this.confirmations = new PrerequisiteConfirmationStore(state);
	}

	async scan(scanId: string): Promise<{ issues: DiscoveredIssueResult[] }> {
		if (!scanId.trim())
			throw new StateError("INVALID_INPUT", "Scan id is required");
		const discovered = await this.provider.listIssues(this.policy.repositoryId);
		const issueIds = [...new Set(discovered.map(({ issueId }) => issueId))];
		const issues: DiscoveredIssueResult[] = [];
		for (const issueId of issueIds) {
			issues.push(await this.scanIssue(scanId, issueId));
		}
		return { issues };
	}

	private async scanIssue(
		scanId: string,
		issueId: string,
	): Promise<DiscoveredIssueResult> {
		const now = this.state.now().toISOString();
		let issue: DiscoveryIssueSnapshot;
		let readiness: DiscoveryReadiness;
		let dependencies: DiscoveryDependencySnapshot;
		try {
			[issue, readiness, dependencies] = await Promise.all([
				this.provider.readIssue(this.policy.repositoryId, issueId),
				this.provider.readReadiness(this.policy.repositoryId, issueId),
				this.provider.readBlockedBy(this.policy.repositoryId, issueId),
			]);
		} catch {
			const currentIssueHead = this.issueScopes.getHead(
				this.policy.repositoryId,
				issueId,
			);
			this.issueScopes.recordUnusableRead({
				observationId: this.policy.nextId("issue-read", issueId),
				repositoryId: this.policy.repositoryId,
				issueId,
				status: "unavailable",
				observedAt: now,
				expectedHeadVersion: currentIssueHead?.headVersion ?? 0,
				writerGeneration: this.policy.writerGeneration,
			});
			this.admission.recordReadinessObservation({
				observationId: this.policy.nextId("readiness-read", issueId),
				repositoryId: this.policy.repositoryId,
				issueId,
				labelPresent: null,
				complete: false,
				observedAt: now,
				expectedHeadVersion: this.admission.getReadinessHeadVersion(
					this.policy.repositoryId,
					issueId,
				),
				writerGeneration: this.policy.writerGeneration,
			});
			return this.blocked(issueId, "provider_read_unavailable");
		}
		if (dependencies.source !== "github_blocked_by") {
			throw new StateError(
				"DEPENDENCY_SOURCE_UNTRUSTED",
				"Admission dependencies must come from GitHub blocked_by relationships",
			);
		}
		if (
			issue.repositoryId !== this.policy.repositoryId ||
			issue.issueId !== issueId
		) {
			this.issueScopes.recordUnusableRead({
				observationId: this.policy.nextId("issue-read", issueId),
				repositoryId: this.policy.repositoryId,
				issueId,
				status: "binding_mismatch",
				observedAt: now,
				expectedHeadVersion:
					this.issueScopes.getHead(this.policy.repositoryId, issueId)
						?.headVersion ?? 0,
				writerGeneration: this.policy.writerGeneration,
			});
			return this.blocked(issueId, "repository_binding_mismatch");
		}
		const currentIssueHead = this.issueScopes.getHead(
			this.policy.repositoryId,
			issueId,
		);
		const issueRead = this.issueScopes.recordCompleteRead({
			observationId: this.policy.nextId("issue-read", issueId),
			scopeRevisionId: this.policy.nextId("issue-read", issueId),
			repositoryId: this.policy.repositoryId,
			issueId,
			sourceRevisionId: issue.sourceRevisionId,
			title: issue.title,
			body: issue.body,
			dependencyIssueIds: dependencies.issueIds,
			templateVersion: issue.templateVersion,
			policyVersion: issue.policyVersion,
			observedAt: issue.observedAt,
			expectedHeadVersion: currentIssueHead?.headVersion ?? 0,
			writerGeneration: this.policy.writerGeneration,
		});
		if (!issueRead.accepted)
			return this.blocked(issueId, "issue_snapshot_changed");

		const currentReadinessVersion = this.admission.getReadinessHeadVersion(
			this.policy.repositoryId,
			issueId,
		);
		const readinessObservation = this.admission.recordReadinessObservation({
			observationId: this.policy.nextId("readiness-read", issueId),
			repositoryId: this.policy.repositoryId,
			issueId,
			labelPresent: readiness.complete ? readiness.labelPresent : null,
			...(readiness.complete && readiness.approvedActorIdentity
				? { approvedActorIdentity: readiness.approvedActorIdentity }
				: {}),
			complete: readiness.complete,
			observedAt: readiness.observedAt,
			expectedHeadVersion: currentReadinessVersion,
			writerGeneration: this.policy.writerGeneration,
		});
		if (!readinessObservation.accepted)
			return this.blocked(issueId, "readiness_changed");

		for (const approval of readiness.approvals) {
			const approvedRevision = this.issueScopes.getRevisionBySourceId(
				this.policy.repositoryId,
				issueId,
				approval.approvedSourceRevisionId,
			);
			if (!approvedRevision) continue;
			const input: ReadinessEvidenceInput = {
				evidenceId: approval.evidenceId,
				repositoryId: this.policy.repositoryId,
				issueId,
				scopeRevisionId: approvedRevision.scopeRevisionId,
				source: approval.source,
				approverIdentity: approval.approverIdentity,
				authorityEvidence: approval.authorityEvidence,
				labelPresent: approval.labelPresent,
				observedAt: approval.observedAt,
				writerGeneration: this.policy.writerGeneration,
			};
			if (approval.source === "github_label_event")
				input.githubLabelEventId = approval.githubLabelEventId;
			else {
				input.slackConversationId = approval.slackConversationId;
				input.slackApprovalReceiptId = approval.slackApprovalReceiptId;
				input.labelWriteOperationId = approval.labelWriteOperationId;
			}
			this.readinessEvidence.record(input);
		}

		const prerequisiteStates = {
			...dependencies.completionEvidence,
		} as AdmissionInput["prerequisiteStates"];
		for (const dependencyId of dependencies.issueIds) {
			if (this.policy.dependencyKinds[dependencyId] !== "non_coding") continue;
			const confirmation = this.confirmations.getCurrentForIssue(
				this.policy.repositoryId,
				dependencyId,
			);
			if (confirmation) {
				prerequisiteStates[dependencyId] = {
					status: "complete",
					evidenceId: confirmation.confirmationId,
					evidenceKind: "authorized_human_confirmation",
					sourceRevisionId: confirmation.sourceRevisionId,
				};
			}
		}

		return {
			issueId,
			admission: this.admission.admit({
				decisionId: `${scanId}:${this.policy.nextId("decision", issueId)}`,
				jobId: this.policy.nextId("job", issueId),
				executionId: this.policy.nextId("execution", issueId),
				repositoryId: this.policy.repositoryId,
				issueId,
				scopeRevisionId: issueRead.revision.scopeRevisionId,
				expectedIssueHeadVersion: issueRead.head.headVersion,
				expectedReadinessHeadVersion: readinessObservation.headVersion,
				issueIsOpen: issue.isOpen,
				repositoryBindingValid: true,
				authorizedApproverIdentities: this.policy.authorizedApproverIdentities,
				authorizedPrerequisiteConfirmerIdentities:
					this.policy.authorizedPrerequisiteConfirmerIdentities,
				currentPolicyVersion: this.policy.currentPolicyVersion,
				nativeDependencyIssueIds: dependencies.issueIds,
				prerequisiteStates,
				dependencyKinds: this.policy.dependencyKinds,
				dependencyGraph: dependencies.graph,
				maxLiveExecutions: this.policy.maxLiveExecutions,
				writerGeneration: this.policy.writerGeneration,
			}),
		};
	}

	private blocked(issueId: string, reasonCode: string): DiscoveredIssueResult {
		return {
			issueId,
			admission: {
				outcome: "blocked",
				reasonCode,
				jobId: null,
				executionId: null,
			},
		};
	}
}
