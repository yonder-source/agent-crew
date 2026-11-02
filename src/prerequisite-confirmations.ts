import type { StateContext } from "./state-common.js";
import { assertText, StateError } from "./state-common.js";
import { canonicalJson } from "./effect-model.js";

export type PrerequisiteConfirmationInput = {
	confirmationId: string;
	repositoryId: string;
	issueId: string;
	scopeRevisionId: string;
	confirmedBy: string;
	authorizedHumanIdentities: string[];
	authorityEvidence: unknown;
	writerGeneration: number;
};

export type PrerequisiteConfirmation = Omit<
	PrerequisiteConfirmationInput,
	"authorizedHumanIdentities"
> & { confirmedAt: string };

export class PrerequisiteConfirmationStore {
	constructor(private readonly state: StateContext) {}

	confirm(input: PrerequisiteConfirmationInput): PrerequisiteConfirmation {
		for (const [value, label] of [
			[input.confirmationId, "confirmation id"],
			[input.repositoryId, "repository id"],
			[input.issueId, "issue id"],
			[input.scopeRevisionId, "scope revision id"],
			[input.confirmedBy, "confirmer identity"],
		] as const)
			assertText(value, label);
		if (!input.authorizedHumanIdentities.includes(input.confirmedBy)) {
			throw new StateError(
				"CONFIRMER_UNAUTHORIZED",
				"Only an authorized human can confirm a non-coding prerequisite",
			);
		}
		if (
			!Number.isSafeInteger(input.writerGeneration) ||
			input.writerGeneration < 1
		) {
			throw new StateError(
				"INVALID_INPUT",
				"Writer generation must be positive",
			);
		}

		return this.state.runWithIntakeRejectionAudit({
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			operationId: input.confirmationId,
			operation: "prerequisite_confirmation",
			generation: input.writerGeneration,
			action: () => {
				const confirmedAt = this.state.now().toISOString();
				this.state.assertWriter(input.writerGeneration, confirmedAt);
				const existing = this.get(input.confirmationId);
				if (existing) {
					if (
						existing.repositoryId !== input.repositoryId ||
						existing.issueId !== input.issueId ||
						existing.scopeRevisionId !== input.scopeRevisionId ||
						existing.confirmedBy !== input.confirmedBy ||
						canonicalJson(existing.authorityEvidence) !==
							canonicalJson(input.authorityEvidence)
					) {
						throw new StateError(
							"CONFIRMATION_ID_CONFLICT",
							"Confirmation identity was reused with changed evidence",
						);
					}
					return existing;
				}
				const current = this.state.database
					.prepare(`
						SELECT observation.scope_revision_id
						FROM issue_read_heads head
						JOIN issue_read_observations observation USING (observation_id)
						WHERE head.repository_id = ? AND head.issue_id = ?
						  AND observation.status = 'complete'
					`)
					.get(input.repositoryId, input.issueId) as
					| { scope_revision_id: string | null }
					| undefined;
				if (current?.scope_revision_id !== input.scopeRevisionId) {
					throw new StateError(
						"PREREQUISITE_REVISION_STALE",
						"Confirmation must bind to the current complete prerequisite revision",
					);
				}
				const inserted = this.state.database
					.prepare(`
						INSERT INTO prerequisite_confirmations (
						  confirmation_id, repository_id, issue_id, scope_revision_id,
						  confirmed_by, authority_evidence_json, writer_generation, confirmed_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (confirmation_id) DO NOTHING
					`)
					.run(
						input.confirmationId,
						input.repositoryId,
						input.issueId,
						input.scopeRevisionId,
						input.confirmedBy,
						canonicalJson(input.authorityEvidence),
						input.writerGeneration,
						confirmedAt,
					);
				if (inserted.changes === 0) {
					const existing = this.get(input.confirmationId);
					if (
						existing?.repositoryId !== input.repositoryId ||
						existing.issueId !== input.issueId ||
						existing.scopeRevisionId !== input.scopeRevisionId ||
						existing.confirmedBy !== input.confirmedBy ||
						canonicalJson(existing.authorityEvidence) !==
							canonicalJson(input.authorityEvidence)
					) {
						throw new StateError(
							"CONFIRMATION_ID_CONFLICT",
							"Confirmation identity was reused with changed evidence",
						);
					}
				}
				return this.get(input.confirmationId) as PrerequisiteConfirmation;
			},
		});
	}

	get(confirmationId: string): PrerequisiteConfirmation | null {
		const row = this.state.database
			.prepare(
				"SELECT * FROM prerequisite_confirmations WHERE confirmation_id = ?",
			)
			.get(confirmationId) as
			| {
					confirmation_id: string;
					repository_id: string;
					issue_id: string;
					scope_revision_id: string;
					confirmed_by: string;
					authority_evidence_json: string;
					writer_generation: number;
					confirmed_at: string;
			  }
			| undefined;
		if (!row) return null;
		return {
			confirmationId: row.confirmation_id,
			repositoryId: row.repository_id,
			issueId: row.issue_id,
			scopeRevisionId: row.scope_revision_id,
			confirmedBy: row.confirmed_by,
			authorityEvidence: JSON.parse(row.authority_evidence_json) as unknown,
			writerGeneration: row.writer_generation,
			confirmedAt: row.confirmed_at,
		};
	}

	getCurrentForIssue(
		repositoryId: string,
		issueId: string,
	): { confirmationId: string; sourceRevisionId: string } | null {
		const row = this.state.database
			.prepare(`
				SELECT confirmation.confirmation_id, revision.source_revision_id
				FROM prerequisite_confirmations confirmation
				JOIN issue_scope_revisions revision
				  ON revision.scope_revision_id = confirmation.scope_revision_id
				JOIN issue_read_heads head
				  ON head.repository_id = confirmation.repository_id
				 AND head.issue_id = confirmation.issue_id
			JOIN issue_read_observations observation
			  ON observation.observation_id = head.observation_id
			 AND observation.scope_revision_id = confirmation.scope_revision_id
			 AND observation.status = 'complete'
			WHERE confirmation.repository_id = ? AND confirmation.issue_id = ?
			ORDER BY confirmation.rowid DESC LIMIT 1
			`)
			.get(repositoryId, issueId) as
			| { confirmation_id: string; source_revision_id: string }
			| undefined;
		return row
			? {
					confirmationId: row.confirmation_id,
					sourceRevisionId: row.source_revision_id,
				}
			: null;
	}
}
