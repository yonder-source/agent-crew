import { canonicalJson } from '../effects/effect-model.js';
import type { CandidateStore } from './candidates.js';
import {
  evaluatePublicationReadiness,
  type RequiredPublicationCheck,
} from './publication-evidence.js';
import type { PublicationDecisionEvidence, PublicationEvidenceReader, PublicationEvidenceStore } from './publication-evidence.js';
import { assertText, StateError, type StateContext } from '../state/state-common.js';

export type DeliveryVerification = {
  verificationId: string;
  jobId: string;
  candidateId: string;
  snapshotId: string;
  pullRequestNumber: number;
  candidateSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  status: 'complete' | 'blocked';
  reasons: string[];
  checksExecuted: string[];
  verifiedAt: string;
};

type RawVerification = {
  verification_id: string;
  job_id: string;
  candidate_id: string;
  snapshot_id: string;
  pull_request_number: number;
  candidate_sha: string;
  base_sha: string;
  merge_commit_sha: string | null;
  status: 'complete' | 'blocked';
  reasons_json: string;
  checks_executed_json: string;
  verified_at: string;
};

function mapVerification(row: RawVerification): DeliveryVerification {
  return {
    verificationId: row.verification_id,
    jobId: row.job_id,
    candidateId: row.candidate_id,
    snapshotId: row.snapshot_id,
    pullRequestNumber: row.pull_request_number,
    candidateSha: row.candidate_sha,
    baseSha: row.base_sha,
    mergeCommitSha: row.merge_commit_sha,
    status: row.status,
    reasons: JSON.parse(row.reasons_json) as string[],
    checksExecuted: JSON.parse(row.checks_executed_json) as string[],
    verifiedAt: row.verified_at,
  };
}

export class DeliveryStore {
  constructor(
    private readonly state: StateContext,
    private readonly candidates: CandidateStore,
    private readonly evidence: PublicationEvidenceStore,
    private readonly reader: PublicationEvidenceReader,
  ) {}

  async verify(input: {
    verificationId: string;
    candidateId: string;
    expectedJobVersion: number;
    currentBaseSha: string;
    policyVersion: string;
    requiredChecks: RequiredPublicationCheck[];
    authorizedReviewers: string[];
    maximumEvidenceAgeMs: number;
    writerGeneration: number;
  }): Promise<DeliveryVerification> {
    for (const [name, value] of Object.entries({
      verificationId: input.verificationId,
      candidateId: input.candidateId,
      currentBaseSha: input.currentBaseSha,
      policyVersion: input.policyVersion,
    })) assertText(value, name);
    if (!Number.isSafeInteger(input.expectedJobVersion) || input.expectedJobVersion < 1 ||
      !Number.isSafeInteger(input.writerGeneration) || input.writerGeneration < 1 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.currentBaseSha)) {
      throw new StateError('INVALID_DELIVERY_VERIFICATION', 'Delivery verification input is malformed');
    }
    const candidate = this.candidates.get(input.candidateId);
    if (!candidate) throw new StateError('CANDIDATE_NOT_FOUND', 'Delivery candidate does not exist');
    const job = this.state.getJobOrThrow(candidate.jobId);
    const previous = this.matchingVerification(input);
    if (previous) return previous;
    let fresh: PublicationDecisionEvidence;
    try {
      fresh = await this.evidence.refreshForDecision({ candidateId: candidate.candidateId, purpose: 'delivery',
        expectedJobVersion: input.expectedJobVersion, writerGeneration: input.writerGeneration }, this.reader);
    } catch (error) {
      const concurrent = this.matchingVerification(input);
      if (concurrent) return concurrent;
      throw error;
    }
    const snapshot = fresh.snapshot;
    const occurredAt = this.state.now().toISOString();

    const reasons = new Set<string>();
    if (this.candidates.latestForJob(candidate.jobId)?.candidateId !== input.candidateId) {
      reasons.add('candidate_not_current');
    }
    if (this.evidence.latest(input.candidateId)?.snapshotId !== snapshot.snapshotId) reasons.add('provider_snapshot_not_latest');
    const readiness = evaluatePublicationReadiness({
      candidate,
      snapshot,
      currentBaseSha: input.currentBaseSha,
      policyVersion: input.policyVersion,
      requiredChecks: input.requiredChecks,
      authorizedReviewers: input.authorizedReviewers,
      observedNow: occurredAt,
      maximumAgeMs: input.maximumEvidenceAgeMs,
      allowMerged: true,
    });
    for (const reason of readiness.reasons) reasons.add(reason);
    if (snapshot.prState !== 'merged') reasons.add('pull_request_not_merged');
    const result = {
      jobId: candidate.jobId,
      candidateId: candidate.candidateId,
      snapshotId: snapshot.snapshotId,
      pullRequestNumber: snapshot.pullRequestNumber,
      candidateSha: candidate.candidateSha,
      baseSha: snapshot.baseSha,
      mergeCommitSha: snapshot.mergeCommitSha,
      status: reasons.size === 0 ? 'complete' as const : 'blocked' as const,
      reasons: [...reasons],
      checksExecuted: readiness.checksExecuted,
    };
    return this.state.runWithStaleAudit(job.job_id, input.writerGeneration, occurredAt, 'delivery_verification', () => {
      this.state.assertWriter(input.writerGeneration, occurredAt);
      const currentJob = this.state.getJobOrThrow(job.job_id);
      if (currentJob.row_version !== fresh.jobVersion || currentJob.scope_revision_id !== candidate.scopeRevisionId) {
        throw new StateError('STALE_DELIVERY_JOB', 'Job changed before delivery verification was saved');
      }
      if (this.evidence.latest(input.candidateId)?.snapshotId !== snapshot.snapshotId) {
        result.status = 'blocked';
        result.reasons = [...new Set([...result.reasons, 'provider_snapshot_changed'])];
      }
      if (this.candidates.latestForJob(candidate.jobId)?.candidateId !== input.candidateId) {
        result.status = 'blocked';
        result.reasons = [...new Set([...result.reasons, 'candidate_not_current'])];
      }
      this.state.database.prepare(`
        INSERT INTO delivery_verifications (
          verification_id, job_id, candidate_id, snapshot_id, pull_request_number,
          candidate_sha, base_sha, merge_commit_sha, status, reasons_json,
          checks_executed_json, verified_at, writer_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.verificationId, result.jobId, result.candidateId, result.snapshotId,
        result.pullRequestNumber, result.candidateSha, result.baseSha, result.mergeCommitSha,
        result.status, canonicalJson(result.reasons), canonicalJson(result.checksExecuted),
        occurredAt, input.writerGeneration,
      );
      const nextVersion = currentJob.row_version + 1;
      const nextSequence = currentJob.event_sequence + 1;
      this.state.bumpJob(currentJob, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: currentJob.job_id,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: result.status === 'complete' ? 'delivery_verified' : 'delivery_blocked',
        payload: {
          verificationId: input.verificationId,
          candidateId: input.candidateId,
          snapshotId: snapshot.snapshotId,
          status: result.status,
          reasons: result.reasons,
        },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return this.get(input.verificationId) as DeliveryVerification;
    });
  }

  get(verificationId: string): DeliveryVerification | undefined {
    const row = this.state.database.prepare(
      'SELECT * FROM delivery_verifications WHERE verification_id = ?',
    ).get(verificationId) as RawVerification | undefined;
    return row ? mapVerification(row) : undefined;
  }

  private matchingVerification(input: { verificationId: string; candidateId: string }): DeliveryVerification | undefined {
    const previous = this.get(input.verificationId);
    if (previous && previous.candidateId !== input.candidateId) {
      throw new StateError('DELIVERY_VERIFICATION_ID_CONFLICT', 'Verification identity was reused with changed evidence');
    }
    return previous;
  }

  latest(jobId: string): DeliveryVerification | undefined {
    const row = this.state.database.prepare(`
      SELECT * FROM delivery_verifications WHERE job_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(jobId) as RawVerification | undefined;
    return row ? mapVerification(row) : undefined;
  }
}
