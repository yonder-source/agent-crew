import type { StateContext } from './state-common.js';
import { assertText, StateError } from './state-common.js';
import { canonicalJson } from './effect-model.js';

export type ReadinessEvidenceInput = {
  evidenceId: string;
  repositoryId: string;
  issueId: string;
  scopeRevisionId: string;
  source: 'github_label_event' | 'slack_approval';
  approverIdentity: string;
  authorityEvidence: unknown;
  githubLabelEventId?: string;
  slackConversationId?: string;
  slackApprovalReceiptId?: string;
  labelWriteOperationId?: string;
  labelPresent: boolean;
  observedAt: string;
  writerGeneration: number;
};

export type ReadinessEvidence = ReadinessEvidenceInput;

type RawReadinessEvidence = {
  evidence_id: string;
  repository_id: string;
  issue_id: string;
  scope_revision_id: string;
  source: ReadinessEvidence['source'];
  approver_identity: string;
  authority_evidence_json: string;
  github_label_event_id: string | null;
  slack_conversation_id: string | null;
  slack_approval_receipt_id: string | null;
  label_write_operation_id: string | null;
  label_present: number;
  observed_at: string;
  writer_generation: number;
};

function mapEvidence(row: RawReadinessEvidence): ReadinessEvidence {
  const result: ReadinessEvidence = {
    evidenceId: row.evidence_id,
    repositoryId: row.repository_id,
    issueId: row.issue_id,
    scopeRevisionId: row.scope_revision_id,
    source: row.source,
    approverIdentity: row.approver_identity,
    authorityEvidence: JSON.parse(row.authority_evidence_json) as unknown,
    labelPresent: row.label_present === 1,
    observedAt: row.observed_at,
    writerGeneration: row.writer_generation,
  };
  if (row.github_label_event_id !== null) result.githubLabelEventId = row.github_label_event_id;
  if (row.slack_conversation_id !== null) result.slackConversationId = row.slack_conversation_id;
  if (row.slack_approval_receipt_id !== null) result.slackApprovalReceiptId = row.slack_approval_receipt_id;
  if (row.label_write_operation_id !== null) result.labelWriteOperationId = row.label_write_operation_id;
  return result;
}

export class ReadinessEvidenceStore {
  constructor(private readonly state: StateContext) {}

  record(input: ReadinessEvidenceInput): ReadinessEvidence {
    for (const [value, label] of [
      [input.evidenceId, 'evidence id'], [input.repositoryId, 'repository id'],
      [input.issueId, 'issue id'], [input.scopeRevisionId, 'scope revision id'],
      [input.approverIdentity, 'approver identity'],
    ] as const) assertText(value, label);
    if (!Number.isSafeInteger(input.writerGeneration) || input.writerGeneration < 1) {
      throw new StateError('INVALID_INPUT', 'Writer generation must be a positive integer');
    }
    if (!Number.isFinite(Date.parse(input.observedAt))) throw new StateError('INVALID_INPUT', 'Observation time must be valid');
    if (input.source === 'github_label_event') {
      if (!input.githubLabelEventId || input.slackConversationId || input.slackApprovalReceiptId || input.labelWriteOperationId) {
        throw new StateError('INVALID_INPUT', 'GitHub readiness evidence requires only a label event identity');
      }
    } else if (input.source === 'slack_approval') {
      if (input.githubLabelEventId || !input.slackConversationId || !input.slackApprovalReceiptId || !input.labelWriteOperationId) {
        throw new StateError('INVALID_INPUT', 'Slack readiness evidence requires approval and label-write receipts');
      }
    } else {
      throw new StateError('INVALID_INPUT', 'Unsupported readiness evidence source');
    }

    return this.state.database.transaction(() => {
      this.state.assertWriter(input.writerGeneration, input.observedAt);
      const revision = this.state.database.prepare(`
        SELECT repository_id, issue_id FROM issue_scope_revisions WHERE scope_revision_id = ?
      `).get(input.scopeRevisionId) as { repository_id: string; issue_id: string } | undefined;
      if (!revision || revision.repository_id !== input.repositoryId || revision.issue_id !== input.issueId) {
        throw new StateError('SCOPE_BINDING_MISMATCH', 'Readiness evidence must match its saved repository and issue scope');
      }
      this.state.database.prepare(`
        INSERT INTO readiness_evidence (
          evidence_id, repository_id, issue_id, scope_revision_id, source, approver_identity,
          authority_evidence_json, github_label_event_id, slack_conversation_id,
          slack_approval_receipt_id, label_write_operation_id, label_present, observed_at,
          writer_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.evidenceId, input.repositoryId, input.issueId, input.scopeRevisionId, input.source,
        input.approverIdentity, canonicalJson(input.authorityEvidence), input.githubLabelEventId ?? null,
        input.slackConversationId ?? null, input.slackApprovalReceiptId ?? null,
        input.labelWriteOperationId ?? null, input.labelPresent ? 1 : 0, input.observedAt,
        input.writerGeneration,
      );
      return this.get(input.evidenceId) as ReadinessEvidence;
    }).immediate();
  }

  list(repositoryId: string, issueId: string): ReadinessEvidence[] {
    const rows = this.state.database.prepare(`
      SELECT * FROM readiness_evidence WHERE repository_id = ? AND issue_id = ?
      ORDER BY observed_at, evidence_id
    `).all(repositoryId, issueId) as RawReadinessEvidence[];
    return rows.map(mapEvidence);
  }

  get(evidenceId: string): ReadinessEvidence | null {
    const row = this.state.database.prepare('SELECT * FROM readiness_evidence WHERE evidence_id = ?')
      .get(evidenceId) as RawReadinessEvidence | undefined;
    return row ? mapEvidence(row) : null;
  }
}
