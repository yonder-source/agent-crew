import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../effects/effect-model.js';
import type { CandidateStore, CandidateSubmissionRecord } from './candidates.js';
import type { EffectStore } from '../effects/effects.js';
import { publicationInspectionFromEffectResult } from './publication.js';
import { assertText, StateError, type StateContext } from '../state/state-common.js';

export type PublicationCheckObservation = {
  checkName: string;
  producer: string;
  workflowIdentity: string | null;
  targetSha: string;
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'pending';
  runId: string;
  syntheticMergeParents: string[] | null;
  observedAt: string;
};

export type PublicationReviewObservation = {
  reviewId: string;
  reviewerIdentity: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  commitSha: string;
  submittedAt: string;
  body?: string;
  feedback?: Array<{ commentId: string; path: string | null; line: number | null; body: string }>;
};

export type PublicationEvidenceSnapshot = {
  snapshotId: string;
  candidateId: string;
  pullRequestOperationId: string;
  repositoryId: string;
  issueId: string;
  baseBranch: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  policyVersion: string;
  observedAt: string;
  sourceIdentity: string;
  sourceCursor: string | null;
  complete: boolean;
  prState: 'open' | 'closed' | 'merged';
  mergeCommitSha: string | null;
  mergeParentShas: string[] | null;
  checks: PublicationCheckObservation[];
  reviews: PublicationReviewObservation[];
};

export interface PublicationEvidenceReader {
  /** Perform an uncached read of PR head/base/state, checks and reviews for this decision. */
  readFresh(input: {
    snapshotId: string;
    purpose: 'repair' | 'delivery';
    candidate: CandidateSubmissionRecord;
    pullRequestNumber: number;
    baseBranch: string;
  }): Promise<PublicationEvidenceSnapshot>;
}

export type PublicationDecisionEvidence = { snapshot: PublicationEvidenceSnapshot; jobVersion: number };

type RawSnapshot = {
  snapshot_id: string;
  job_id: string;
  candidate_id: string;
  pull_request_operation_id: string;
  repository_id: string;
  issue_id: string;
  base_branch: string;
  pull_request_number: number;
  head_sha: string;
  base_sha: string;
  policy_version: string;
  observed_at: string;
  source_identity: string;
  source_cursor: string | null;
  complete: number;
  pr_state: 'open' | 'closed' | 'merged';
  merge_commit_sha: string | null;
  merge_parent_shas_json: string;
  checks_json: string;
  reviews_json: string;
};

export type RequiredPublicationCheck = {
  checkName: string;
  producer: string;
  workflowIdentity: string | null;
  allowNeutralOrSkipped: boolean;
};

export type PublicationReadiness = {
  status: 'ready' | 'blocked' | 'repair_required';
  reasons: string[];
  actionableRepairs: string[];
  actionableFeedback: Array<
    | { kind: 'failed_check'; checkName: string; runId: string }
    | { kind: 'changes_requested'; reviewId: string; reviewerIdentity: string; body: string; comments: Array<{ commentId: string; path: string | null; line: number | null; body: string }> }
  >;
  checksExecuted: string[];
};

function validSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function sameSha(left: string | null, right: string | null): boolean {
  return left === null || right === null ? left === right : left.toLowerCase() === right.toLowerCase();
}

function validReviewFeedback(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 500 && value.every((comment: unknown) => {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return false;
    const item = comment as { commentId?: unknown; body?: unknown; path?: unknown; line?: unknown };
    return typeof item.commentId === 'string' && item.commentId.length > 0 &&
      typeof item.body === 'string' && item.body.length <= 20_000 &&
      (item.path === null || typeof item.path === 'string') &&
      (item.line === null || (Number.isSafeInteger(item.line) && typeof item.line === 'number' && item.line >= 1));
  });
}

function mapSnapshot(row: RawSnapshot): PublicationEvidenceSnapshot {
  return {
    snapshotId: row.snapshot_id,
    candidateId: row.candidate_id,
    pullRequestOperationId: row.pull_request_operation_id,
    repositoryId: row.repository_id,
    issueId: row.issue_id,
    baseBranch: row.base_branch,
    pullRequestNumber: row.pull_request_number,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    policyVersion: row.policy_version,
    observedAt: row.observed_at,
    sourceIdentity: row.source_identity,
    sourceCursor: row.source_cursor,
    complete: row.complete === 1,
    prState: row.pr_state,
    mergeCommitSha: row.merge_commit_sha,
    mergeParentShas: JSON.parse(row.merge_parent_shas_json) as string[] | null,
    checks: JSON.parse(row.checks_json) as PublicationCheckObservation[],
    reviews: JSON.parse(row.reviews_json) as PublicationReviewObservation[],
  };
}

export class PublicationEvidenceStore {
  constructor(
    private readonly state: StateContext,
    private readonly candidates: CandidateStore,
    private readonly effects: EffectStore,
  ) {}

  async refreshForDecision(input: {
    candidateId: string;
    purpose: 'repair' | 'delivery';
    expectedJobVersion: number;
    writerGeneration: number;
  }, reader: PublicationEvidenceReader): Promise<PublicationDecisionEvidence> {
    const candidate = this.candidates.get(input.candidateId);
    if (!candidate) throw new StateError('CANDIDATE_NOT_FOUND', 'Decision candidate does not exist');
    const job = this.state.getJobOrThrow(candidate.jobId);
    const startedAt = this.state.now().toISOString();
    this.state.assertWriter(input.writerGeneration, startedAt);
    if (job.row_version !== input.expectedJobVersion) {
      throw new StateError('STALE_ROW_VERSION', 'Job changed before the decision read');
    }
    const binding = this.state.database.prepare(
      'SELECT pull_request_number, base_branch FROM publication_bindings WHERE job_id = ?',
    ).get(candidate.jobId) as { pull_request_number: number; base_branch: string } | undefined;
    if (!binding) throw new StateError('PUBLICATION_PR_NOT_CONFIRMED', 'Decision requires a bound published PR');
    const snapshotId = randomUUID();
    let snapshot: PublicationEvidenceSnapshot;
    try {
      snapshot = await reader.readFresh({ snapshotId, purpose: input.purpose, candidate,
        pullRequestNumber: binding.pull_request_number, baseBranch: binding.base_branch });
    } catch {
      throw new StateError('PUBLICATION_REFRESH_UNAVAILABLE', 'Fresh provider evidence is unavailable for this decision');
    }
    const completedAt = this.state.now().toISOString();
    if (snapshot.snapshotId !== snapshotId || snapshot.candidateId !== candidate.candidateId ||
      !Number.isFinite(Date.parse(snapshot.observedAt)) || Date.parse(snapshot.observedAt) < Date.parse(startedAt) ||
      Date.parse(snapshot.observedAt) > Date.parse(completedAt)) {
      throw new StateError('PUBLICATION_REFRESH_MISMATCH', 'Evidence does not belong to this decision read');
    }
    return this.state.runWithStaleAudit(candidate.jobId, input.writerGeneration, completedAt, 'publication_decision_read', () => {
      this.state.assertWriter(input.writerGeneration, completedAt);
      if (this.state.getJobOrThrow(candidate.jobId).row_version !== input.expectedJobVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Job changed while the decision read was in flight');
      }
      const saved = this.record(snapshot, input.writerGeneration);
      return { snapshot: saved, jobVersion: this.state.getJobOrThrow(candidate.jobId).row_version };
    });
  }

  record(input: PublicationEvidenceSnapshot, writerGeneration: number): PublicationEvidenceSnapshot {
    this.validate(input, writerGeneration);
    const candidate = this.candidates.get(input.candidateId);
    if (!candidate) throw new StateError('CANDIDATE_NOT_FOUND', 'Evidence candidate does not exist');
    if (candidate.repositoryId !== input.repositoryId || candidate.issueId !== input.issueId) {
      throw new StateError('PUBLICATION_EVIDENCE_BINDING_MISMATCH', 'Evidence does not match candidate repository and issue');
    }
    this.assertPublishedPullRequest(candidate, input);
    const job = this.state.getJobOrThrow(candidate.jobId);
    const checksJson = canonicalJson(input.checks);
    const reviewsJson = canonicalJson(input.reviews);
    const existing = this.get(input.snapshotId);
    if (existing) {
      const same = existing.candidateId === input.candidateId && existing.baseBranch === input.baseBranch &&
        existing.pullRequestOperationId === input.pullRequestOperationId && existing.headSha === input.headSha.toLowerCase() &&
        existing.baseSha === input.baseSha.toLowerCase() && existing.policyVersion === input.policyVersion &&
        existing.observedAt === input.observedAt && existing.sourceIdentity === input.sourceIdentity &&
        existing.sourceCursor === input.sourceCursor && existing.complete === input.complete &&
        existing.prState === input.prState && existing.mergeCommitSha === input.mergeCommitSha &&
        canonicalJson(existing.mergeParentShas) === canonicalJson(input.mergeParentShas) &&
        canonicalJson(existing.checks) === checksJson &&
        canonicalJson(existing.reviews) === reviewsJson;
      if (same) return existing;
      throw new StateError('PUBLICATION_SNAPSHOT_ID_CONFLICT', 'Snapshot identity was reused with changed evidence');
    }

    const occurredAt = this.state.now().toISOString();
    return this.state.runWithStaleAudit(job.job_id, writerGeneration, occurredAt, 'publication_evidence', () => {
      this.state.assertWriter(writerGeneration, occurredAt);
      const currentJob = this.state.getJobOrThrow(job.job_id);
      if (currentJob.repository_id !== input.repositoryId || currentJob.issue_id !== input.issueId ||
        currentJob.scope_revision_id !== candidate.scopeRevisionId) {
        throw new StateError('STALE_CANDIDATE_BINDING', 'Evidence candidate is no longer bound to the current job scope');
      }
      this.state.database.prepare(`
        INSERT INTO publication_evidence_snapshots (
          snapshot_id, job_id, candidate_id, pull_request_operation_id, repository_id, issue_id, base_branch, pull_request_number,
          head_sha, base_sha, policy_version, observed_at, source_identity, source_cursor,
          complete, pr_state, merge_commit_sha, merge_parent_shas_json, checks_json,
          reviews_json, writer_generation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.snapshotId, job.job_id, input.candidateId, input.pullRequestOperationId, input.repositoryId, input.issueId, input.baseBranch,
        input.pullRequestNumber, input.headSha.toLowerCase(), input.baseSha.toLowerCase(),
        input.policyVersion, input.observedAt, input.sourceIdentity, input.sourceCursor,
        input.complete ? 1 : 0, input.prState, input.mergeCommitSha,
        canonicalJson(input.mergeParentShas), checksJson, reviewsJson, writerGeneration, occurredAt,
      );
      const nextVersion = currentJob.row_version + 1;
      const nextSequence = currentJob.event_sequence + 1;
      this.state.bumpJob(currentJob, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: currentJob.job_id,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'publication_evidence_recorded',
        payload: { snapshotId: input.snapshotId, candidateId: input.candidateId },
        writerGeneration,
        occurredAt,
      });
      return this.get(input.snapshotId) as PublicationEvidenceSnapshot;
    });
  }

  get(snapshotId: string): PublicationEvidenceSnapshot | undefined {
    const row = this.state.database.prepare(
      'SELECT * FROM publication_evidence_snapshots WHERE snapshot_id = ?',
    ).get(snapshotId) as RawSnapshot | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  latest(candidateId: string): PublicationEvidenceSnapshot | undefined {
    const row = this.state.database.prepare(`
      SELECT * FROM publication_evidence_snapshots
      WHERE candidate_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(candidateId) as RawSnapshot | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  private validate(input: PublicationEvidenceSnapshot, writerGeneration: number): void {
    for (const [name, value] of Object.entries({
      snapshotId: input.snapshotId,
      candidateId: input.candidateId,
      pullRequestOperationId: input.pullRequestOperationId,
      repositoryId: input.repositoryId,
      issueId: input.issueId,
      baseBranch: input.baseBranch,
      policyVersion: input.policyVersion,
      sourceIdentity: input.sourceIdentity,
    })) assertText(value, name);
    if (!Number.isSafeInteger(writerGeneration) || writerGeneration < 1 ||
      !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1 ||
      !Number.isFinite(Date.parse(input.observedAt)) || !validSha(input.headSha) || !validSha(input.baseSha) ||
      !Array.isArray(input.checks) || !Array.isArray(input.reviews)) {
      throw new StateError('INVALID_PUBLICATION_EVIDENCE', 'Publication evidence snapshot is malformed');
    }
    if (typeof input.complete !== 'boolean' || !['open', 'closed', 'merged'].includes(input.prState) ||
      (input.sourceCursor !== null && typeof input.sourceCursor !== 'string') ||
      (input.mergeCommitSha !== null && !validSha(input.mergeCommitSha)) ||
      (input.mergeParentShas !== null && (!Array.isArray(input.mergeParentShas) || input.mergeParentShas.some((sha) => !validSha(sha))))) {
      throw new StateError('INVALID_PUBLICATION_EVIDENCE', 'Snapshot completeness or pull request state is invalid');
    }
    for (const check of input.checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check) ||
        typeof check.checkName !== 'string' || check.checkName.trim() !== check.checkName || check.checkName.length === 0 ||
        typeof check.producer !== 'string' || check.producer.trim() !== check.producer || check.producer.length === 0 ||
        (check.workflowIdentity !== null && typeof check.workflowIdentity !== 'string') ||
        !validSha(check.targetSha) || typeof check.runId !== 'string' ||
        !['success', 'failure', 'neutral', 'skipped', 'pending'].includes(check.conclusion) ||
        !Number.isFinite(Date.parse(check.observedAt)) ||
        (check.syntheticMergeParents !== null && (!Array.isArray(check.syntheticMergeParents) || check.syntheticMergeParents.some((sha) => !validSha(sha))))) {
        throw new StateError('INVALID_PUBLICATION_EVIDENCE', 'Check evidence entry is malformed');
      }
    }
    for (const review of input.reviews) {
      if (!review || typeof review !== 'object' || Array.isArray(review) ||
        typeof review.reviewId !== 'string' || !review.reviewId || typeof review.reviewerIdentity !== 'string' ||
        !review.reviewerIdentity || !['approved', 'changes_requested', 'commented', 'dismissed'].includes(review.state) ||
        !validSha(review.commitSha) || !Number.isFinite(Date.parse(review.submittedAt)) ||
        (review.body !== undefined && (typeof review.body !== 'string' || review.body.length > 20_000)) ||
        (review.feedback !== undefined && !validReviewFeedback(review.feedback))) {
        throw new StateError('INVALID_PUBLICATION_EVIDENCE', 'Review evidence entry is malformed');
      }
    }
  }

  private assertPublishedPullRequest(
    candidate: CandidateSubmissionRecord,
    input: PublicationEvidenceSnapshot,
  ): void {
    const operation = this.effects.get(input.pullRequestOperationId);
    const step = operation?.steps.find((item) => item.stepKey === 'write');
    if (!operation || operation.operation.jobId !== candidate.jobId ||
      operation.operation.operationKind !== 'publication_pull_request' ||
      operation.operation.status !== 'confirmed_success' || step?.status !== 'confirmed_success' || !step.resultJson) {
      throw new StateError('PUBLICATION_PR_NOT_CONFIRMED', 'Evidence must be tied to a confirmed Controller PR publication');
    }
    let target: unknown;
    let result: unknown;
    try {
      target = JSON.parse(operation.operation.targetJson) as unknown;
      result = JSON.parse(step.resultJson) as unknown;
    } catch {
      throw new StateError('PUBLICATION_PR_RECEIPT_INVALID', 'Confirmed PR publication receipt is malformed');
    }
    const targetRecord = target as { repositoryId?: unknown; taskBranch?: unknown; candidateSha?: unknown };
    const observation = publicationInspectionFromEffectResult(result);
    const pullRequest = observation?.pullRequest;
    const binding = this.state.database.prepare(
      'SELECT repository_id, task_branch, base_branch, pull_request_number FROM publication_bindings WHERE job_id = ?',
    ).get(candidate.jobId) as {
      repository_id: string; task_branch: string; base_branch: string; pull_request_number: number;
    } | undefined;
    if (targetRecord.repositoryId !== candidate.repositoryId || targetRecord.candidateSha !== candidate.candidateSha ||
      typeof targetRecord.taskBranch !== 'string' || !targetRecord.taskBranch || !pullRequest ||
      !sameSha(observation?.branchHead ?? null, candidate.candidateSha) || !binding ||
      binding.repository_id !== candidate.repositoryId || binding.task_branch !== targetRecord.taskBranch ||
      binding.base_branch !== input.baseBranch || binding.pull_request_number !== input.pullRequestNumber ||
      pullRequest.number !== input.pullRequestNumber || String(pullRequest.headSha).toLowerCase() !== candidate.candidateSha ||
      pullRequest.baseBranch !== input.baseBranch || pullRequest.state !== 'open' || pullRequest.jobMarker !== candidate.jobId) {
      throw new StateError('PUBLICATION_PR_BINDING_MISMATCH', 'Provider snapshot does not match the bound published PR receipt');
    }
  }
}

export function evaluatePublicationReadiness(input: {
  candidate: CandidateSubmissionRecord;
  snapshot: PublicationEvidenceSnapshot;
  currentBaseSha: string;
  policyVersion: string;
  requiredChecks: RequiredPublicationCheck[];
  authorizedReviewers: string[];
  observedNow: string;
  maximumAgeMs: number;
  allowMerged?: boolean;
}): PublicationReadiness {
  const { candidate, snapshot } = input;
  const reasons: string[] = [];
  const actionableRepairs = new Set<string>();
  const actionableFeedback: PublicationReadiness['actionableFeedback'] = [];
  const checksExecuted = new Set<string>();
  const currentTime = Date.parse(input.observedNow);
  const snapshotTime = Date.parse(snapshot.observedAt);
  const fresh = Number.isFinite(currentTime) && Number.isFinite(snapshotTime) &&
    Number.isSafeInteger(input.maximumAgeMs) && input.maximumAgeMs >= 0 &&
    snapshotTime <= currentTime && currentTime - snapshotTime <= input.maximumAgeMs;

  if (!fresh) reasons.push('evidence_stale');
  if (!snapshot.complete) reasons.push('provider_read_incomplete');
  if (snapshot.candidateId !== candidate.candidateId || snapshot.repositoryId !== candidate.repositoryId ||
    snapshot.issueId !== candidate.issueId || snapshot.headSha.toLowerCase() !== candidate.candidateSha ||
    snapshot.baseSha.toLowerCase() !== input.currentBaseSha.toLowerCase() ||
    snapshot.policyVersion !== input.policyVersion || candidate.policyVersion !== input.policyVersion) {
    reasons.push('candidate_base_or_policy_mismatch');
  }
  if (snapshot.prState === 'closed') reasons.push('pull_request_not_open');
  if (snapshot.prState === 'merged' && !input.allowMerged) reasons.push('pull_request_already_merged');
  if (snapshot.prState === 'merged' && input.allowMerged) {
    const parents = snapshot.mergeParentShas;
    if (!snapshot.mergeCommitSha || !parents || parents.length !== 2 ||
      !parents.some((sha) => sha.toLowerCase() === candidate.candidateSha) ||
      !parents.some((sha) => sha.toLowerCase() === snapshot.baseSha.toLowerCase())) {
      reasons.push('merge_head_or_parents_mismatch');
    }
  }

  for (const required of input.requiredChecks) {
    const matching = snapshot.checks.filter((check) => check.checkName === required.checkName &&
      check.producer === required.producer && check.workflowIdentity === required.workflowIdentity &&
      (check.targetSha.toLowerCase() === candidate.candidateSha ||
        (check.syntheticMergeParents !== null && check.targetSha.toLowerCase() !== candidate.candidateSha &&
          check.syntheticMergeParents.length === 2 &&
          check.syntheticMergeParents.some((sha) => sha.toLowerCase() === candidate.candidateSha) &&
          check.syntheticMergeParents.some((sha) => sha.toLowerCase() === input.currentBaseSha.toLowerCase()))));
    const latest = matching.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
    if (!latest || latest.conclusion === 'pending') {
      reasons.push(`required_check_missing_or_pending:${required.checkName}`);
    } else if (latest.conclusion === 'failure') {
      reasons.push(`required_check_failed:${required.checkName}`);
      actionableRepairs.add(`failed_check:${required.checkName}`);
      actionableFeedback.push({ kind: 'failed_check', checkName: required.checkName, runId: latest.runId });
    } else if ((latest.conclusion === 'neutral' || latest.conclusion === 'skipped') && !required.allowNeutralOrSkipped) {
      reasons.push(`required_check_not_success:${required.checkName}`);
    } else if (latest.conclusion === 'success') {
      checksExecuted.add(required.checkName);
    }
  }

  const reviewsByIdentity = new Map<string, PublicationReviewObservation>();
  for (const review of snapshot.reviews) {
    if (review.state === 'commented' || review.commitSha.toLowerCase() !== candidate.candidateSha ||
      !input.authorizedReviewers.includes(review.reviewerIdentity)) continue;
    const previous = reviewsByIdentity.get(review.reviewerIdentity);
    if (!previous || Date.parse(review.submittedAt) > Date.parse(previous.submittedAt)) {
      reviewsByIdentity.set(review.reviewerIdentity, review);
    }
  }
  if (![...reviewsByIdentity.values()].some((review) => review.state === 'approved')) {
    reasons.push('authorized_candidate_approval_missing');
  }
  for (const review of reviewsByIdentity.values()) {
    if (review.state === 'changes_requested') {
      reasons.push(`authorized_changes_requested:${review.reviewerIdentity}`);
      actionableRepairs.add(`changes_requested:${review.reviewerIdentity}`);
      actionableFeedback.push({
        kind: 'changes_requested',
        reviewId: review.reviewId,
        reviewerIdentity: review.reviewerIdentity,
        body: review.body ?? '',
        comments: review.feedback ?? [],
      });
    }
  }

  const currentCandidate = snapshot.candidateId === candidate.candidateId && snapshot.repositoryId === candidate.repositoryId &&
    snapshot.issueId === candidate.issueId && snapshot.headSha.toLowerCase() === candidate.candidateSha &&
    snapshot.baseSha.toLowerCase() === input.currentBaseSha.toLowerCase() &&
    snapshot.policyVersion === input.policyVersion && candidate.policyVersion === input.policyVersion;
  const blockedCheck = reasons.some((reason) =>
    reason.startsWith('required_check_missing_or_pending:') || reason.startsWith('required_check_not_success:'));
  if (actionableRepairs.size > 0 && !blockedCheck && snapshot.prState === 'open' && fresh && snapshot.complete && currentCandidate) {
    return { status: 'repair_required', reasons, actionableRepairs: [...actionableRepairs], actionableFeedback, checksExecuted: [...checksExecuted] };
  }
  return {
    status: reasons.length === 0 ? 'ready' : 'blocked',
    reasons,
    actionableRepairs: [...actionableRepairs],
    actionableFeedback,
    checksExecuted: [...checksExecuted],
  };
}
