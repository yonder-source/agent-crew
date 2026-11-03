import { canonicalJson } from '../effects/effect-model.js';
import type { CandidateStore } from './candidates.js';
import type { ExecutionStore } from '../execution/executions.js';
import {
  evaluatePublicationReadiness,
  type PublicationEvidenceSnapshot,
  type PublicationReadiness,
  type RequiredPublicationCheck,
} from './publication-evidence.js';
import type { PublicationDecisionEvidence, PublicationEvidenceReader, PublicationEvidenceStore } from './publication-evidence.js';
import { assertText, StateError, type StateContext } from '../state/state-common.js';

export type RepairReservation = {
  reservationId: string;
  jobId: string;
  cycleNumber: number;
  candidateId: string;
  evidenceSnapshotId: string;
  executionId: string;
  triggerEvidence: string[];
  actionableFeedback: PublicationReadiness['actionableFeedback'];
  writerGeneration: number;
  reservedAt: string;
};

export type RepairAuthorization = {
  extensionId: string;
  jobId: string;
  addedAttempts: number;
  approverIdentity: string;
  authorityId: string;
  decisionReceipt: string;
};

export interface RepairAuthorizationVerifier {
  isAuthorized(input: RepairAuthorization): boolean;
}

type RawReservation = {
  reservation_id: string;
  job_id: string;
  cycle_number: number;
  candidate_id: string;
  evidence_snapshot_id: string;
  execution_id: string;
  trigger_evidence_json: string;
  actionable_feedback_json: string;
  writer_generation: number;
  reserved_at: string;
};

type RawCycle = { allowance: number; used_count: number; row_version: number };
type RawExtension = {
  job_id: string;
  added_attempts: number;
  approver_identity: string;
  authority_id: string;
  decision_receipt: string;
};

function mapReservation(row: RawReservation): RepairReservation {
  return {
    reservationId: row.reservation_id,
    jobId: row.job_id,
    cycleNumber: row.cycle_number,
    candidateId: row.candidate_id,
    evidenceSnapshotId: row.evidence_snapshot_id,
    executionId: row.execution_id,
    triggerEvidence: JSON.parse(row.trigger_evidence_json) as string[],
    actionableFeedback: JSON.parse(row.actionable_feedback_json) as PublicationReadiness['actionableFeedback'],
    writerGeneration: row.writer_generation,
    reservedAt: row.reserved_at,
  };
}

export class RepairStore {
  constructor(
    private readonly state: StateContext,
    private readonly candidates: CandidateStore,
    private readonly evidence: PublicationEvidenceStore,
    private readonly executions: ExecutionStore,
    private readonly authorization: RepairAuthorizationVerifier,
    private readonly reader: PublicationEvidenceReader,
  ) {}

  async reserve(input: {
    reservationId: string;
    candidateId: string;
    executionId: string;
    expectedJobVersion: number;
    currentBaseSha: string;
    policyVersion: string;
    requiredChecks: RequiredPublicationCheck[];
    authorizedReviewers: string[];
    maximumEvidenceAgeMs: number;
    writerGeneration: number;
  }): Promise<RepairReservation> {
    for (const [name, value] of Object.entries({
      reservationId: input.reservationId,
      candidateId: input.candidateId,
      executionId: input.executionId,
    })) assertText(value, name);
    if (!Number.isSafeInteger(input.expectedJobVersion) || input.expectedJobVersion < 1 ||
      !Number.isSafeInteger(input.writerGeneration) || input.writerGeneration < 1) {
      throw new StateError('INVALID_INPUT', 'Repair versions and generation must be positive integers');
    }
    const candidate = this.candidates.get(input.candidateId);
    if (!candidate) throw new StateError('CANDIDATE_NOT_FOUND', 'Repair candidate does not exist');
    if (this.candidates.latestForJob(candidate.jobId)?.candidateId !== candidate.candidateId) {
      throw new StateError('REPAIR_CANDIDATE_NOT_CURRENT', 'Only the job\'s latest candidate may start repair');
    }
    const job = this.state.getJobOrThrow(candidate.jobId);
    const prior = this.matchingReservation(input);
    if (prior) return prior;

    const allowance = this.getAllowance(candidate.jobId);
    if (allowance && allowance.usedCount >= allowance.allowance) {
      throw new StateError('REPAIR_ALLOWANCE_EXHAUSTED', 'Automated repair allowance is exhausted');
    }
    let fresh: PublicationDecisionEvidence;
    try {
      fresh = await this.evidence.refreshForDecision({ candidateId: candidate.candidateId, purpose: 'repair',
        expectedJobVersion: input.expectedJobVersion, writerGeneration: input.writerGeneration }, this.reader);
    } catch (error) {
      const concurrent = this.matchingReservation(input);
      if (concurrent) return concurrent;
      throw error;
    }
    const occurredAt = this.state.now().toISOString();

    return this.state.runWithStaleAudit(job.job_id, input.writerGeneration, occurredAt, 'repair_reservation', () => {
      this.state.assertWriter(input.writerGeneration, occurredAt);
      const currentJob = this.state.getJobOrThrow(job.job_id);
      if (currentJob.row_version !== fresh.jobVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Job changed before repair admission');
      }
      if (currentJob.scope_revision_id !== candidate.scopeRevisionId || currentJob.requested_control !== 'run') {
        throw new StateError('REPAIR_JOB_NOT_ELIGIBLE', 'Current job scope or control does not permit repair');
      }
      if (this.candidates.latestForJob(candidate.jobId)?.candidateId !== candidate.candidateId) {
        throw new StateError('REPAIR_CANDIDATE_NOT_CURRENT', 'Candidate changed before repair admission');
      }
      const snapshot = fresh.snapshot;
      if (this.evidence.latest(input.candidateId)?.snapshotId !== snapshot.snapshotId) {
        throw new StateError('REPAIR_EVIDENCE_NOT_CURRENT', 'Repair requires the latest persisted provider snapshot');
      }
      const readiness = this.evaluate(candidate, snapshot, { ...input, observedNow: occurredAt });
      if (readiness.status !== 'repair_required') {
        throw new StateError('REPAIR_TRIGGER_NOT_ACTIONABLE', 'Current evidence does not authorize an automated repair');
      }
      let cycle = this.state.database.prepare('SELECT allowance, used_count, row_version FROM repair_cycles WHERE job_id = ?')
        .get(job.job_id) as RawCycle | undefined;
      if (!cycle) {
        this.state.database.prepare(`
          INSERT INTO repair_cycles (job_id, allowance, used_count, row_version, updated_at)
          VALUES (?, 1, 0, 1, ?)
        `).run(job.job_id, occurredAt);
        cycle = { allowance: 1, used_count: 0, row_version: 1 };
      }
      if (cycle.used_count >= cycle.allowance) {
        throw new StateError('REPAIR_ALLOWANCE_EXHAUSTED', 'Automated repair allowance is exhausted');
      }

      const execution = this.executions.reserve({
        executionId: input.executionId,
        jobId: job.job_id,
        expectedJobVersion: currentJob.row_version,
        writerGeneration: input.writerGeneration,
      });
      const cycleNumber = cycle.used_count + 1;
      this.state.database.prepare(`
        UPDATE repair_cycles SET used_count = ?, row_version = row_version + 1, updated_at = ?
        WHERE job_id = ? AND row_version = ?
      `).run(cycleNumber, occurredAt, job.job_id, cycle.row_version);
      this.state.database.prepare(`
        INSERT INTO repair_reservations (
          reservation_id, job_id, cycle_number, candidate_id, evidence_snapshot_id,
          execution_id, trigger_evidence_json, actionable_feedback_json, writer_generation, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.reservationId, job.job_id, cycleNumber, input.candidateId, snapshot.snapshotId,
        execution.executionId, canonicalJson(readiness.actionableRepairs), canonicalJson(readiness.actionableFeedback),
        input.writerGeneration, occurredAt,
      );
      const bumpedJob = this.state.getJobOrThrow(job.job_id);
      const nextVersion = bumpedJob.row_version + 1;
      const nextSequence = bumpedJob.event_sequence + 1;
      this.state.bumpJob(bumpedJob, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: job.job_id,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'repair_reserved',
        payload: {
          reservationId: input.reservationId,
          cycleNumber,
          executionId: execution.executionId,
          candidateId: input.candidateId,
          evidenceSnapshotId: snapshot.snapshotId,
        },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return this.get(input.reservationId) as RepairReservation;
    });
  }

  extendAllowance(input: RepairAuthorization & { expectedJobVersion: number; writerGeneration: number }): number {
    for (const [name, value] of Object.entries({
      extensionId: input.extensionId,
      jobId: input.jobId,
      approverIdentity: input.approverIdentity,
      authorityId: input.authorityId,
      decisionReceipt: input.decisionReceipt,
    })) assertText(value, name);
    if (!Number.isSafeInteger(input.addedAttempts) || input.addedAttempts < 1 ||
      !Number.isSafeInteger(input.expectedJobVersion) || input.expectedJobVersion < 1 ||
      !Number.isSafeInteger(input.writerGeneration) || input.writerGeneration < 1) {
      throw new StateError('REPAIR_EXTENSION_UNAUTHORIZED', 'Repair extension requires a valid authorized human decision');
    }
    const job = this.state.getJobOrThrow(input.jobId);
    const occurredAt = this.state.now().toISOString();
    return this.state.runWithStaleAudit(job.job_id, input.writerGeneration, occurredAt, 'repair_allowance_extension', () => {
      this.state.assertWriter(input.writerGeneration, occurredAt);
      const currentJob = this.state.getJobOrThrow(job.job_id);
      if (currentJob.row_version !== input.expectedJobVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Job changed before repair extension');
      }
      const prior = this.state.database.prepare(
        'SELECT job_id, added_attempts, approver_identity, authority_id, decision_receipt FROM repair_allowance_extensions WHERE extension_id = ?',
      ).get(input.extensionId) as RawExtension | undefined;
      if (prior) {
        if (prior.job_id === input.jobId && prior.added_attempts === input.addedAttempts &&
          prior.approver_identity === input.approverIdentity && prior.authority_id === input.authorityId &&
          prior.decision_receipt === input.decisionReceipt) {
          return (this.getAllowance(input.jobId)?.allowance ?? 1);
        }
        throw new StateError('REPAIR_EXTENSION_ID_CONFLICT', 'Repair extension identity was reused with changed decision data');
      }
      if (!this.authorization.isAuthorized(input)) {
        throw new StateError('REPAIR_EXTENSION_UNAUTHORIZED', 'Repair extension authority is no longer valid');
      }
      this.state.database.prepare(`
        INSERT INTO repair_allowance_extensions (
          extension_id, job_id, added_attempts, approver_identity, authority_id,
          decision_receipt, writer_generation, granted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.extensionId, input.jobId, input.addedAttempts, input.approverIdentity,
        input.authorityId, input.decisionReceipt, input.writerGeneration, occurredAt);
      this.state.database.prepare(`
        INSERT INTO repair_cycles (job_id, allowance, used_count, row_version, updated_at)
        VALUES (?, ?, 0, 1, ?)
        ON CONFLICT(job_id) DO UPDATE SET allowance = allowance + excluded.allowance - 1,
          row_version = row_version + 1, updated_at = excluded.updated_at
      `).run(input.jobId, 1 + input.addedAttempts, occurredAt);
      const cycle = this.getAllowance(input.jobId);
      const nextVersion = currentJob.row_version + 1;
      const nextSequence = currentJob.event_sequence + 1;
      this.state.bumpJob(currentJob, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: input.jobId,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'repair_allowance_extended',
        payload: { extensionId: input.extensionId, addedAttempts: input.addedAttempts, allowance: cycle?.allowance },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return cycle?.allowance ?? 1;
    });
  }

  get(reservationId: string): RepairReservation | undefined {
    const row = this.state.database.prepare(
      'SELECT * FROM repair_reservations WHERE reservation_id = ?',
    ).get(reservationId) as RawReservation | undefined;
    return row ? mapReservation(row) : undefined;
  }

  private matchingReservation(input: { reservationId: string; candidateId: string; executionId: string }): RepairReservation | undefined {
    const prior = this.get(input.reservationId);
    if (prior && (prior.candidateId !== input.candidateId || prior.executionId !== input.executionId)) {
      throw new StateError('REPAIR_RESERVATION_ID_CONFLICT', 'Repair reservation identity was reused with changed data');
    }
    return prior;
  }

  getAllowance(jobId: string): { allowance: number; usedCount: number; rowVersion: number } | undefined {
    const row = this.state.database.prepare(
      'SELECT allowance, used_count, row_version FROM repair_cycles WHERE job_id = ?',
    ).get(jobId) as RawCycle | undefined;
    return row ? { allowance: row.allowance, usedCount: row.used_count, rowVersion: row.row_version } : undefined;
  }

  private evaluate(candidate: NonNullable<ReturnType<CandidateStore['get']>>, snapshot: PublicationEvidenceSnapshot, input: {
    currentBaseSha: string;
    policyVersion: string;
    requiredChecks: RequiredPublicationCheck[];
    authorizedReviewers: string[];
    observedNow: string;
    maximumEvidenceAgeMs: number;
  }) {
    return evaluatePublicationReadiness({
      candidate,
      snapshot,
      currentBaseSha: input.currentBaseSha,
      policyVersion: input.policyVersion,
      requiredChecks: input.requiredChecks,
      authorizedReviewers: input.authorizedReviewers,
      observedNow: input.observedNow,
      maximumAgeMs: input.maximumEvidenceAgeMs,
    });
  }
}
