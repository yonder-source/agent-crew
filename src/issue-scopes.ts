import { createHash } from "node:crypto";
import type { StateContext } from "./state-common.js";
import { assertText, StateError } from "./state-common.js";
import { canonicalJson } from "./effect-model.js";

export type CompleteIssueRead = {
	observationId: string;
	scopeRevisionId: string;
	repositoryId: string;
	issueId: string;
	sourceRevisionId: string;
	title: string;
	body: string;
	dependencyIssueIds: string[];
	templateVersion: string;
	policyVersion: string;
	observedAt: string;
	expectedHeadVersion: number;
	writerGeneration: number;
};

export type UnusableIssueRead = {
	observationId: string;
	repositoryId: string;
	issueId: string;
	status: "unavailable" | "incomplete" | "binding_mismatch";
	observedAt: string;
	expectedHeadVersion: number;
	writerGeneration: number;
};

export type UnattributableIssueRead = Omit<
	CompleteIssueRead,
	"scopeRevisionId"
>;

export type UnattributedIssueSnapshot = Omit<
	IssueScopeRevision,
	"scopeRevisionId"
> & {
	observationId: string;
};

export type IssueScopeRevision = {
	scopeRevisionId: string;
	repositoryId: string;
	issueId: string;
	sourceRevisionId: string;
	contentFingerprint: string;
	title: string;
	body: string;
	dependencyIssueIds: string[];
	templateVersion: string;
	policyVersion: string;
	observedAt: string;
};

export type IssueReadHead = {
	repositoryId: string;
	issueId: string;
	headVersion: number;
	observationId: string;
	status:
		| "complete"
		| "unattributable"
		| "unavailable"
		| "incomplete"
		| "binding_mismatch";
	scopeRevisionId: string | null;
	sourceRevisionId: string | null;
	contentFingerprint: string | null;
	observedAt: string;
};

type RawRevision = {
	scope_revision_id: string;
	repository_id: string;
	issue_id: string;
	source_revision_id: string;
	content_fingerprint: string;
	title: string;
	body: string;
	dependency_issue_ids_json: string;
	template_version: string;
	policy_version: string;
	observed_at: string;
};

type RawHead = {
	repository_id: string;
	issue_id: string;
	head_version: number;
	observation_id: string;
	status: IssueReadHead["status"] | "superseded";
	scope_revision_id: string | null;
	source_revision_id: string | null;
	content_fingerprint: string | null;
	observed_at: string;
};

function mapRevision(row: RawRevision): IssueScopeRevision {
	return {
		scopeRevisionId: row.scope_revision_id,
		repositoryId: row.repository_id,
		issueId: row.issue_id,
		sourceRevisionId: row.source_revision_id,
		contentFingerprint: row.content_fingerprint,
		title: row.title,
		body: row.body,
		dependencyIssueIds: JSON.parse(row.dependency_issue_ids_json) as string[],
		templateVersion: row.template_version,
		policyVersion: row.policy_version,
		observedAt: row.observed_at,
	};
}

function mapHead(row: RawHead): IssueReadHead {
	if (row.status === "superseded")
		throw new StateError(
			"INVALID_HEAD",
			"A superseded observation cannot be current",
		);
	return {
		repositoryId: row.repository_id,
		issueId: row.issue_id,
		headVersion: row.head_version,
		observationId: row.observation_id,
		status: row.status,
		scopeRevisionId: row.scope_revision_id,
		sourceRevisionId: row.source_revision_id,
		contentFingerprint: row.content_fingerprint,
		observedAt: row.observed_at,
	};
}

function fingerprint(
	input: Pick<
		CompleteIssueRead,
		"title" | "body" | "templateVersion" | "policyVersion"
	> & {
		dependencyIssueIds: string[];
	},
): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				title: input.title,
				body: input.body,
				dependencyIssueIds: input.dependencyIssueIds,
				templateVersion: input.templateVersion,
				policyVersion: input.policyVersion,
			}),
		)
		.digest("hex");
}

export class IssueScopeStore {
	constructor(private readonly state: StateContext) {}

	recordCompleteRead(input: CompleteIssueRead): {
		revision: IssueScopeRevision;
		head: IssueReadHead;
		accepted: boolean;
	} {
		this.validateCommon(input);
		for (const [value, label] of [
			[input.sourceRevisionId, "source revision id"],
			[input.title, "title"],
			[input.templateVersion, "template version"],
			[input.policyVersion, "policy version"],
		] as const)
			assertText(value, label);
		if (
			!Number.isSafeInteger(input.expectedHeadVersion) ||
			input.expectedHeadVersion < 0
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Expected head version must be a non-negative integer",
			);
		}
		if (
			!Array.isArray(input.dependencyIssueIds) ||
			input.dependencyIssueIds.some(
				(id) => typeof id !== "string" || id.length === 0,
			)
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Dependency issue ids must be non-empty strings",
			);
		}

		const dependencies = [...new Set(input.dependencyIssueIds)].sort();
		const contentFingerprint = fingerprint({
			...input,
			dependencyIssueIds: dependencies,
		});

		return this.state.runWithIntakeRejectionAudit({
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			operationId: input.observationId,
			operation: "issue_read_complete",
			generation: input.writerGeneration,
			action: () => {
				this.state.assertWriter(
					input.writerGeneration,
					this.state.now().toISOString(),
				);
				const current = this.getRawHead(input.repositoryId, input.issueId);
				const sequence = this.nextSequence(input.repositoryId, input.issueId);
				const accepted =
					(current?.head_version ?? 0) === input.expectedHeadVersion;
				const revision = this.ensureRevision({
					...input,
					dependencyIssueIds: dependencies,
					contentFingerprint,
				});
				const observationId = accepted
					? input.observationId
					: `${input.observationId}:superseded`;
				this.state.database
					.prepare(`
        INSERT INTO issue_read_observations (
          observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
          status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
					.run(
						observationId,
						input.repositoryId,
						input.issueId,
						sequence,
						input.expectedHeadVersion,
						accepted ? "complete" : "superseded",
						revision.scopeRevisionId,
						input.sourceRevisionId,
						contentFingerprint,
						input.observedAt,
						input.writerGeneration,
					);
				if (accepted)
					this.writeHead(
						input.repositoryId,
						input.issueId,
						(current?.head_version ?? 0) + 1,
						observationId,
					);
				const head = this.getHeadOrThrow(input.repositoryId, input.issueId);
				return { revision, head, accepted };
			},
		});
	}

	recordUnattributableRead(input: UnattributableIssueRead): {
		snapshot: UnattributedIssueSnapshot;
		head: IssueReadHead;
		accepted: boolean;
	} {
		this.validateCompleteFields(input);
		if (
			!Number.isSafeInteger(input.expectedHeadVersion) ||
			input.expectedHeadVersion < 0
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Expected head version must be a non-negative integer",
			);
		}
		const dependencies = [...new Set(input.dependencyIssueIds)].sort();
		const contentFingerprint = fingerprint({
			...input,
			dependencyIssueIds: dependencies,
		});

		return this.state.runWithIntakeRejectionAudit({
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			operationId: input.observationId,
			operation: "issue_read_unattributable",
			generation: input.writerGeneration,
			action: () => {
				this.state.assertWriter(
					input.writerGeneration,
					this.state.now().toISOString(),
				);
				const current = this.getRawHead(input.repositoryId, input.issueId);
				const accepted =
					(current?.head_version ?? 0) === input.expectedHeadVersion;
				const sequence = this.nextSequence(input.repositoryId, input.issueId);
				const observationId = accepted
					? input.observationId
					: `${input.observationId}:superseded`;
				this.state.database
					.prepare(`
        INSERT INTO issue_read_observations (
          observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
          status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `)
					.run(
						observationId,
						input.repositoryId,
						input.issueId,
						sequence,
						input.expectedHeadVersion,
						accepted ? "unattributable" : "superseded",
						input.sourceRevisionId,
						contentFingerprint,
						input.observedAt,
						input.writerGeneration,
					);
				this.state.database
					.prepare(`
        INSERT INTO unattributed_issue_snapshots (
          observation_id, title, body, dependency_issue_ids_json, template_version, policy_version
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
					.run(
						observationId,
						input.title,
						input.body,
						JSON.stringify(dependencies),
						input.templateVersion,
						input.policyVersion,
					);
				if (accepted)
					this.writeHead(
						input.repositoryId,
						input.issueId,
						(current?.head_version ?? 0) + 1,
						observationId,
					);
				const head = this.getHeadOrThrow(input.repositoryId, input.issueId);
				return {
					snapshot: {
						observationId,
						repositoryId: input.repositoryId,
						issueId: input.issueId,
						sourceRevisionId: input.sourceRevisionId,
						contentFingerprint,
						title: input.title,
						body: input.body,
						dependencyIssueIds: dependencies,
						templateVersion: input.templateVersion,
						policyVersion: input.policyVersion,
						observedAt: input.observedAt,
					},
					head,
					accepted,
				};
			},
		});
	}

	confirmUnattributableSnapshot(input: {
		confirmationId: string;
		observationId: string;
		scopeRevisionId: string;
		confirmedBy: string;
		authorityEvidence: unknown;
		expectedHeadVersion: number;
		observedAt: string;
		writerGeneration: number;
	}): { revision: IssueScopeRevision; head: IssueReadHead } {
		for (const [value, label] of [
			[input.confirmationId, "confirmation id"],
			[input.observationId, "observation id"],
			[input.scopeRevisionId, "scope revision id"],
			[input.confirmedBy, "confirmer identity"],
		] as const)
			assertText(value, label);
		if (
			!Number.isSafeInteger(input.expectedHeadVersion) ||
			input.expectedHeadVersion < 1
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Expected head version must be positive",
			);
		}
		if (
			!Number.isSafeInteger(input.writerGeneration) ||
			input.writerGeneration < 1
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Writer generation must be a positive integer",
			);
		}
		if (!Number.isFinite(Date.parse(input.observedAt)))
			throw new StateError("INVALID_INPUT", "Observation time must be valid");
		const binding = this.state.database
			.prepare(`
      SELECT repository_id, issue_id FROM issue_read_observations WHERE observation_id = ?
    `)
			.get(input.observationId) as
			| { repository_id: string; issue_id: string }
			| undefined;

		return this.state.runWithIntakeRejectionAudit({
			repositoryId: binding?.repository_id ?? null,
			issueId: binding?.issue_id ?? null,
			operationId: input.confirmationId,
			operation: "issue_scope_confirmation",
			generation: input.writerGeneration,
			action: () => {
				this.state.assertWriter(
					input.writerGeneration,
					this.state.now().toISOString(),
				);
				const current = this.state.database
					.prepare(`
        SELECT h.repository_id, h.issue_id, h.head_version, o.observation_id, o.status,
          o.scope_revision_id, o.source_revision_id, o.content_fingerprint, o.observed_at,
          s.title, s.body, s.dependency_issue_ids_json, s.template_version, s.policy_version
        FROM issue_read_heads h JOIN issue_read_observations o USING (observation_id)
        JOIN unattributed_issue_snapshots s USING (observation_id)
        WHERE h.observation_id = ?
      `)
					.get(input.observationId) as
					| (RawHead & {
							title: string;
							body: string;
							dependency_issue_ids_json: string;
							template_version: string;
							policy_version: string;
					  })
					| undefined;
				if (current?.status !== "unattributable") {
					throw new StateError(
						"UNATTRIBUTABLE_SNAPSHOT_NOT_CURRENT",
						"Snapshot is not the current unattributable issue read",
					);
				}
				if (current.head_version !== input.expectedHeadVersion) {
					throw new StateError(
						"STALE_ROW_VERSION",
						"Issue read head changed before snapshot confirmation",
					);
				}
				const dependencies = JSON.parse(
					current.dependency_issue_ids_json,
				) as string[];
				const scopeInput: CompleteIssueRead = {
					observationId: `confirmed:${input.confirmationId}`,
					scopeRevisionId: input.scopeRevisionId,
					repositoryId: current.repository_id,
					issueId: current.issue_id,
					sourceRevisionId: current.source_revision_id as string,
					title: current.title,
					body: current.body,
					dependencyIssueIds: dependencies,
					templateVersion: current.template_version,
					policyVersion: current.policy_version,
					observedAt: input.observedAt,
					expectedHeadVersion: input.expectedHeadVersion,
					writerGeneration: input.writerGeneration,
				};
				const contentFingerprint = current.content_fingerprint as string;
				const revision = this.ensureRevision({
					...scopeInput,
					dependencyIssueIds: dependencies,
					contentFingerprint,
				});
				this.state.database
					.prepare(`
        INSERT INTO issue_scope_confirmations (
          confirmation_id, observation_id, scope_revision_id, confirmed_by,
          authority_evidence_json, writer_generation, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
					.run(
						input.confirmationId,
						input.observationId,
						revision.scopeRevisionId,
						input.confirmedBy,
						canonicalJson(input.authorityEvidence),
						input.writerGeneration,
						input.observedAt,
					);
				const sequence = this.nextSequence(
					current.repository_id,
					current.issue_id,
				);
				this.state.database
					.prepare(`
        INSERT INTO issue_read_observations (
          observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
          status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
        ) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?)
      `)
					.run(
						scopeInput.observationId,
						current.repository_id,
						current.issue_id,
						sequence,
						input.expectedHeadVersion,
						revision.scopeRevisionId,
						current.source_revision_id,
						contentFingerprint,
						input.observedAt,
						input.writerGeneration,
					);
				this.writeHead(
					current.repository_id,
					current.issue_id,
					input.expectedHeadVersion + 1,
					scopeInput.observationId,
				);
				return {
					revision,
					head: this.getHeadOrThrow(current.repository_id, current.issue_id),
				};
			},
		});
	}

	getUnattributedSnapshot(
		observationId: string,
	): UnattributedIssueSnapshot | null {
		const row = this.state.database
			.prepare(`
      SELECT o.repository_id, o.issue_id, o.source_revision_id, o.content_fingerprint, o.observed_at,
        s.title, s.body, s.dependency_issue_ids_json, s.template_version, s.policy_version
      FROM issue_read_observations o JOIN unattributed_issue_snapshots s USING (observation_id)
      WHERE o.observation_id = ? AND o.status = 'unattributable'
    `)
			.get(observationId) as
			| {
					repository_id: string;
					issue_id: string;
					source_revision_id: string;
					content_fingerprint: string;
					observed_at: string;
					title: string;
					body: string;
					dependency_issue_ids_json: string;
					template_version: string;
					policy_version: string;
			  }
			| undefined;
		return row
			? {
					observationId,
					repositoryId: row.repository_id,
					issueId: row.issue_id,
					sourceRevisionId: row.source_revision_id,
					contentFingerprint: row.content_fingerprint,
					title: row.title,
					body: row.body,
					dependencyIssueIds: JSON.parse(
						row.dependency_issue_ids_json,
					) as string[],
					templateVersion: row.template_version,
					policyVersion: row.policy_version,
					observedAt: row.observed_at,
				}
			: null;
	}

	recordUnusableRead(input: UnusableIssueRead): {
		head: IssueReadHead | null;
		accepted: boolean;
	} {
		this.validateCommon(input);
		if (
			!Number.isSafeInteger(input.expectedHeadVersion) ||
			input.expectedHeadVersion < 0
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Expected head version must be a non-negative integer",
			);
		}
		return this.state.runWithIntakeRejectionAudit({
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			operationId: input.observationId,
			operation: "issue_read_unusable",
			generation: input.writerGeneration,
			action: () => {
				this.state.assertWriter(
					input.writerGeneration,
					this.state.now().toISOString(),
				);
				const current = this.getRawHead(input.repositoryId, input.issueId);
				const sequence = this.nextSequence(input.repositoryId, input.issueId);
				const accepted =
					(current?.head_version ?? 0) === input.expectedHeadVersion;
				const observationId = accepted
					? input.observationId
					: `${input.observationId}:superseded`;
				this.state.database
					.prepare(`
        INSERT INTO issue_read_observations (
          observation_id, repository_id, issue_id, observation_sequence, based_on_head_version,
          status, scope_revision_id, source_revision_id, content_fingerprint, observed_at, writer_generation
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      `)
					.run(
						observationId,
						input.repositoryId,
						input.issueId,
						sequence,
						input.expectedHeadVersion,
						accepted ? input.status : "superseded",
						input.observedAt,
						input.writerGeneration,
					);
				if (accepted)
					this.writeHead(
						input.repositoryId,
						input.issueId,
						(current?.head_version ?? 0) + 1,
						observationId,
					);
				return {
					head: accepted
						? this.getHeadOrThrow(input.repositoryId, input.issueId)
						: current
							? mapHead(current)
							: null,
					accepted,
				};
			},
		});
	}

	getHead(repositoryId: string, issueId: string): IssueReadHead | null {
		const row = this.getRawHead(repositoryId, issueId);
		return row ? mapHead(row) : null;
	}

	getRevision(scopeRevisionId: string): IssueScopeRevision | null {
		const row = this.state.database
			.prepare(
				"SELECT * FROM issue_scope_revisions WHERE scope_revision_id = ?",
			)
			.get(scopeRevisionId) as RawRevision | undefined;
		return row ? mapRevision(row) : null;
	}

	private ensureRevision(
		input: CompleteIssueRead & {
			dependencyIssueIds: string[];
			contentFingerprint: string;
		},
	): IssueScopeRevision {
		const existing = this.state.database
			.prepare(`
      SELECT * FROM issue_scope_revisions WHERE repository_id = ? AND issue_id = ? AND content_fingerprint = ?
    `)
			.get(input.repositoryId, input.issueId, input.contentFingerprint) as
			| RawRevision
			| undefined;
		if (existing) return mapRevision(existing);
		this.state.database
			.prepare(`
      INSERT INTO issue_scope_revisions (
        scope_revision_id, repository_id, issue_id, source_revision_id, content_fingerprint,
        title, body, dependency_issue_ids_json, template_version, policy_version, observed_at, created_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				input.scopeRevisionId,
				input.repositoryId,
				input.issueId,
				input.sourceRevisionId,
				input.contentFingerprint,
				input.title,
				input.body,
				JSON.stringify(input.dependencyIssueIds),
				input.templateVersion,
				input.policyVersion,
				input.observedAt,
				input.writerGeneration,
			);
		return this.getRevision(input.scopeRevisionId) as IssueScopeRevision;
	}

	private validateCompleteFields(input: UnattributableIssueRead): void {
		this.validateCommon(input);
		for (const [value, label] of [
			[input.sourceRevisionId, "source revision id"],
			[input.title, "title"],
			[input.templateVersion, "template version"],
			[input.policyVersion, "policy version"],
		] as const)
			assertText(value, label);
		if (
			!Number.isSafeInteger(input.expectedHeadVersion) ||
			input.expectedHeadVersion < 0
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Expected head version must be a non-negative integer",
			);
		}
		if (
			!Array.isArray(input.dependencyIssueIds) ||
			input.dependencyIssueIds.some(
				(id) => typeof id !== "string" || id.length === 0,
			)
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Dependency issue ids must be non-empty strings",
			);
		}
	}

	private validateCommon(input: {
		observationId: string;
		repositoryId: string;
		issueId: string;
		observedAt: string;
		writerGeneration: number;
	}): void {
		for (const [value, label] of [
			[input.observationId, "observation id"],
			[input.repositoryId, "repository id"],
			[input.issueId, "issue id"],
		] as const)
			assertText(value, label);
		if (
			!Number.isSafeInteger(input.writerGeneration) ||
			input.writerGeneration < 1
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Writer generation must be a positive integer",
			);
		}
		if (!Number.isFinite(Date.parse(input.observedAt)))
			throw new StateError("INVALID_INPUT", "Observation time must be valid");
	}

	private getRawHead(
		repositoryId: string,
		issueId: string,
	): RawHead | undefined {
		return this.state.database
			.prepare(`
      SELECT h.repository_id, h.issue_id, h.head_version, o.observation_id, o.status,
        o.scope_revision_id, o.source_revision_id, o.content_fingerprint, o.observed_at
      FROM issue_read_heads h JOIN issue_read_observations o USING (observation_id)
      WHERE h.repository_id = ? AND h.issue_id = ?
    `)
			.get(repositoryId, issueId) as RawHead | undefined;
	}

	private getHeadOrThrow(repositoryId: string, issueId: string): IssueReadHead {
		const head = this.getHead(repositoryId, issueId);
		if (!head)
			throw new StateError(
				"READ_HEAD_MISSING",
				"Issue read head was not recorded",
			);
		return head;
	}

	private nextSequence(repositoryId: string, issueId: string): number {
		const row = this.state.database
			.prepare(`
      SELECT coalesce(max(observation_sequence), 0) + 1 AS sequence
      FROM issue_read_observations WHERE repository_id = ? AND issue_id = ?
    `)
			.get(repositoryId, issueId) as { sequence: number };
		return row.sequence;
	}

	private writeHead(
		repositoryId: string,
		issueId: string,
		headVersion: number,
		observationId: string,
	): void {
		this.state.database
			.prepare(`
      INSERT INTO issue_read_heads (repository_id, issue_id, head_version, observation_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (repository_id, issue_id) DO UPDATE SET
        head_version = excluded.head_version, observation_id = excluded.observation_id
    `)
			.run(repositoryId, issueId, headVersion, observationId);
	}
}
