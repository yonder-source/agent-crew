import type { EffectStore } from '../effects/effects.js';
import type { EffectOperationView } from '../effects/effect-model.js';
import type { EffectResultStore } from '../effects/effect-results.js';
import type { CandidateStore } from './candidates.js';
import { StateError, type StateContext } from '../state/state-common.js';

export type PublicationTarget = {
  taskBranch: string;
  baseBranch: string;
  verifiedBaseSha: string;
  expectedRemoteHead: string | null;
  pullRequestTitle: string;
  pullRequestBody: string;
  policyVersion: string;
};

export type PublicationInspection = {
  authoritative: boolean;
  branchHead: string | null;
  pullRequest: null | {
    number: number;
    headSha: string;
    baseBranch: string;
    state: 'open' | 'closed' | 'merged';
    jobMarker: string;
  };
};

export type CandidateExportInspection = {
  authoritative: boolean;
  available: boolean;
  repositoryId: string;
  sourceBundleId: string;
  candidateSha: string;
  baseSha: string;
  baseIsAncestor: boolean;
  artifactSha256: string | null;
};

export type PreservedRemoteBranch = {
  operationId: string;
  repositoryId: string;
  taskBranch: string;
  expectedHead: string | null;
  observedHead: string;
  checkpointId: string;
  artifactSha256: string;
  commits: Array<{ sha: string; summary: string }>;
};

/** Adapter credentials remain in the Controller process, never in a task runtime. */
export interface PublicationProvider {
  inspectCandidateExport(input: {
    repositoryId: string;
    sourceBundleId: string;
    candidateSha: string;
    baseSha: string;
  }): Promise<CandidateExportInspection>;
  inspect(input: {
    repositoryId: string;
    taskBranch: string;
    jobMarker: string;
  }): Promise<PublicationInspection>;
  pushCandidate(input: {
    repositoryId: string;
    taskBranch: string;
    expectedRemoteHead: string | null;
    sourceBundleId: string;
    sourceArtifactSha256: string;
    baseSha: string;
    candidateSha: string;
  }): Promise<void>;
  createOrUpdatePullRequest(input: {
    repositoryId: string;
    taskBranch: string;
    baseBranch: string;
    expectedPullRequestNumber: number | null;
    title: string;
    body: string;
    jobMarker: string;
  }): Promise<void>;
  preserveUnexpectedBranch(input: {
    operationId: string;
    repositoryId: string;
    taskBranch: string;
    expectedHead: string | null;
    observedHead: string;
  }): Promise<void>;
  inspectPreservedBranch(input: {
    operationId: string;
    repositoryId: string;
    taskBranch: string;
    observedHead: string;
  }): Promise<{ authoritative: boolean; receipt: PreservedRemoteBranch | null }>;
}

export type PublicationResult = {
  status: 'published' | 'pending' | 'blocked';
  pullRequestNumber: number | null;
  reason: string | null;
  preservation?: PreservedRemoteBranch;
};

export type PublicationApproval = {
  candidateSha: string;
  baseSha: string;
  policyVersion: string;
  approverIdentity: string;
  authorityId: string;
  decisionReceipt: string;
};

export interface PublicationPolicy {
  resolve(candidate: NonNullable<ReturnType<CandidateStore['get']>>): Promise<{
    target: PublicationTarget;
    classification: 'ordinary' | 'protected' | 'uncertain';
    approval?: PublicationApproval;
  }>;
}

type WriteKind = 'publication_push' | 'publication_pull_request';

function sameSha(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase();
}

export function publicationInspectionFromEffectResult(value: unknown): PublicationInspection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { observation?: unknown };
  const raw = record.observation ?? value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const inspection = raw as Partial<PublicationInspection>;
  if (typeof inspection.authoritative !== 'boolean' ||
    (inspection.branchHead !== null && typeof inspection.branchHead !== 'string') ||
    (inspection.pullRequest !== null && (!inspection.pullRequest || typeof inspection.pullRequest !== 'object'))) return undefined;
  return inspection as PublicationInspection;
}

function expectedPullRequestNumberFromOperation(operation: EffectOperationView | undefined): number | null | undefined {
  if (!operation) return undefined;
  try {
    const target = JSON.parse(operation.operation.targetJson) as { expectedPullRequestNumber?: unknown };
    return typeof target.expectedPullRequestNumber === 'number' ? target.expectedPullRequestNumber : null;
  } catch {
    return undefined;
  }
}

export class PublicationCoordinator {
  constructor(
    private readonly state: StateContext,
    private readonly candidates: CandidateStore,
    private readonly effects: EffectStore,
    private readonly effectResults: EffectResultStore,
    private readonly provider: PublicationProvider,
    private readonly policy: PublicationPolicy,
  ) {}

  async publish(input: {
    candidateId: string;
    preservationOperationId: string;
    pushOperationId: string;
    pullRequestOperationId: string;
    writerGeneration: number;
  }): Promise<PublicationResult> {
    const candidate = this.candidates.get(input.candidateId);
    if (!candidate) throw new StateError('CANDIDATE_NOT_FOUND', 'Candidate does not exist');
    if (this.candidates.latestForJob(candidate.jobId)?.candidateId !== candidate.candidateId) {
      return this.blocked('candidate_not_current');
    }
    if (candidate.reportedValidationResults.some((result) => result.exitCode !== 0)) {
      return this.blocked('local_validation_failed');
    }
    if (candidate.ownershipGeneration !== input.writerGeneration) {
      return this.blocked('stale_candidate_owner');
    }
    const candidateBlock = this.currentnessBlock(candidate);
    if (candidateBlock) return this.blocked(candidateBlock);
    const policy = await this.policy.resolve(candidate);
    const afterPolicyBlock = this.currentnessBlock(candidate);
    if (afterPolicyBlock) return this.blocked(afterPolicyBlock);
    const target = policy.target;
    this.validateTarget(target);
    if (this.hasConflictingWrite(candidate.repositoryId, target.taskBranch,
      [input.pushOperationId, input.pullRequestOperationId])) {
      return this.pending('publication_write_unresolved');
    }
    const existingBinding = this.state.database.prepare(
      'SELECT repository_id, task_branch, base_branch, pull_request_number FROM publication_bindings WHERE job_id = ?',
    ).get(candidate.jobId) as {
      repository_id: string; task_branch: string; base_branch: string; pull_request_number: number;
    } | undefined;
    if (existingBinding && (existingBinding.repository_id !== candidate.repositoryId ||
      existingBinding.task_branch !== target.taskBranch || existingBinding.base_branch !== target.baseBranch)) {
      return this.blocked('publication_target_binding_conflict');
    }
    if (target.policyVersion !== candidate.policyVersion) return this.blocked('stale_publication_policy');
    if (!sameSha(target.verifiedBaseSha, candidate.baseSha)) {
      return this.blocked('stale_publication_base');
    }
    if (policy.classification !== 'ordinary' && policy.classification !== 'protected' && policy.classification !== 'uncertain') {
      return this.blocked('protected_change_classification_unknown');
    }
    if (policy.classification !== 'ordinary') {
      const approval = policy.approval;
      if (!approval || approval.candidateSha !== candidate.candidateSha || approval.baseSha !== candidate.baseSha ||
        approval.policyVersion !== candidate.policyVersion ||
        [approval.approverIdentity, approval.authorityId, approval.decisionReceipt].some((value) =>
          typeof value !== 'string' || value.trim() !== value || value.length === 0)) {
        return this.blocked('protected_change_approval_required');
      }
    }

    let sourceExport: CandidateExportInspection;
    try {
      sourceExport = await this.provider.inspectCandidateExport({
        repositoryId: candidate.repositoryId,
        sourceBundleId: candidate.sourceBundleId,
        candidateSha: candidate.candidateSha,
        baseSha: candidate.baseSha,
      });
    } catch {
      return this.pending('source_export_read_incomplete');
    }
    if (!sourceExport.authoritative) return this.pending('source_export_read_incomplete');
    if (!sourceExport.available || sourceExport.repositoryId !== candidate.repositoryId ||
      sourceExport.sourceBundleId !== candidate.sourceBundleId || !sameSha(sourceExport.candidateSha, candidate.candidateSha) ||
      !sameSha(sourceExport.baseSha, candidate.baseSha) || !sourceExport.baseIsAncestor ||
      !sourceExport.artifactSha256 || !/^[a-f0-9]{64}$/i.test(sourceExport.artifactSha256)) {
      return this.blocked('candidate_source_export_invalid');
    }
    const sourceArtifactSha256 = sourceExport.artifactSha256;
    const afterExportBlock = this.currentnessBlock(candidate);
    if (afterExportBlock) return this.blocked(afterExportBlock);

    const previousPullRequestOperation = this.effects.get(input.pullRequestOperationId);
    const inspection = await this.inspect(candidate.repositoryId, target, candidate.jobId);
    if (!inspection.authoritative) return this.pending('provider_read_incomplete');
    const afterInspectionBlock = this.currentnessBlock(candidate);
    if (afterInspectionBlock) return this.blocked(afterInspectionBlock);
    if (inspection.pullRequest && (
      (existingBinding ? inspection.pullRequest.number !== existingBinding.pull_request_number
        : !this.canReconcilePullRequest(previousPullRequestOperation, candidate, target, inspection.pullRequest)) ||
      inspection.pullRequest.jobMarker !== candidate.jobId ||
      inspection.pullRequest.baseBranch !== target.baseBranch || inspection.pullRequest.state !== 'open')) {
      return this.blocked('unattributed_pull_request');
    }
    if (existingBinding && !inspection.pullRequest) return this.blocked('bound_pull_request_missing');
    if (!sameSha(inspection.branchHead, candidate.candidateSha) &&
      !sameSha(inspection.branchHead, target.expectedRemoteHead)) {
      if (!inspection.branchHead) return this.blocked('expected_remote_branch_missing');
      const preservation = await this.preserveUnexpectedBranch({
        operationId: input.preservationOperationId,
        candidate,
        target,
        observedHead: inspection.branchHead,
        writerGeneration: input.writerGeneration,
      });
      if (!preservation) {
        const preservationStep = this.effects.get(input.preservationOperationId)?.steps
          .find((step) => step.stepKey === 'preserve');
        return preservationStep?.status === 'confirmed_failure'
          ? this.blocked('unexpected_branch_preservation_failed')
          : this.pending('unexpected_branch_preservation_unconfirmed');
      }
      return { ...this.blocked('unexpected_remote_branch_head'), preservation };
    }
    const pushIntent = this.effects.get(input.pushOperationId);
    if (sameSha(inspection.branchHead, candidate.candidateSha) && !pushIntent) {
      return this.blocked('unattributed_remote_branch_head');
    }
    const pushed = await this.runWrite({
        operationId: input.pushOperationId,
        kind: 'publication_push',
        candidate,
        target,
        generation: input.writerGeneration,
        classification: policy.classification,
        isCurrent: () => this.publicationCurrent(candidate),
        ...(policy.approval ? { approval: policy.approval } : {}),
        arguments: {
          repositoryId: candidate.repositoryId,
          taskBranch: target.taskBranch,
          expectedRemoteHead: target.expectedRemoteHead,
          sourceBundleId: candidate.sourceBundleId,
          sourceArtifactSha256,
          baseSha: candidate.baseSha,
          candidateSha: candidate.candidateSha,
        },
        write: () => this.provider.pushCandidate({
          repositoryId: candidate.repositoryId,
          taskBranch: target.taskBranch,
          expectedRemoteHead: target.expectedRemoteHead,
          sourceBundleId: candidate.sourceBundleId,
          sourceArtifactSha256,
          baseSha: candidate.baseSha,
          candidateSha: candidate.candidateSha,
        }),
        verify: (read) => sameSha(read.branchHead, candidate.candidateSha),
        absent: (read) => sameSha(read.branchHead, target.expectedRemoteHead),
      });
    if (pushed !== 'confirmed_success') return this.resultFor(pushed, 'push_not_confirmed');

    const afterPush = await this.inspect(candidate.repositoryId, target, candidate.jobId);
    if (!afterPush.authoritative || !sameSha(afterPush.branchHead, candidate.candidateSha)) {
      return this.pending('candidate_head_readback_unconfirmed');
    }
    const pr = afterPush.pullRequest;
    if (existingBinding && !pr) return this.blocked('bound_pull_request_missing');
    if (pr?.number && ((existingBinding ? pr.number !== existingBinding.pull_request_number
      : !this.canReconcilePullRequest(previousPullRequestOperation, candidate, target, pr)) ||
      pr.jobMarker !== candidate.jobId || pr.baseBranch !== target.baseBranch)) {
      return this.blocked('unattributed_pull_request');
    }
    if (pr && pr.jobMarker !== candidate.jobId) return this.blocked('pull_request_binding_conflict');
    if (pr && pr.state !== 'open') return this.blocked('pull_request_not_open');
    const beforePrBlock = this.currentnessBlock(candidate);
    if (beforePrBlock) return this.blocked(beforePrBlock);

    const savedPullRequestNumber = expectedPullRequestNumberFromOperation(previousPullRequestOperation);
    const expectedPullRequestNumber = savedPullRequestNumber === undefined
      ? existingBinding?.pull_request_number ?? null
      : savedPullRequestNumber;
    const pullRequestResult = await this.runWrite({
      operationId: input.pullRequestOperationId,
      kind: 'publication_pull_request',
      candidate,
      target,
      generation: input.writerGeneration,
      classification: policy.classification,
      isCurrent: () => this.publicationCurrent(candidate),
      ...(policy.approval ? { approval: policy.approval } : {}),
      arguments: {
        repositoryId: candidate.repositoryId,
        taskBranch: target.taskBranch,
        baseBranch: target.baseBranch,
        expectedPullRequestNumber,
        title: target.pullRequestTitle,
        body: target.pullRequestBody,
        jobMarker: candidate.jobId,
        candidateSha: candidate.candidateSha,
      },
      write: () => this.provider.createOrUpdatePullRequest({
        repositoryId: candidate.repositoryId,
        taskBranch: target.taskBranch,
        baseBranch: target.baseBranch,
        expectedPullRequestNumber,
        title: target.pullRequestTitle,
        body: target.pullRequestBody,
        jobMarker: candidate.jobId,
      }),
      verify: (read) => read.pullRequest?.jobMarker === candidate.jobId &&
        sameSha(read.pullRequest.headSha, candidate.candidateSha) &&
        read.pullRequest.baseBranch === target.baseBranch &&
        read.pullRequest.state === 'open' &&
        (expectedPullRequestNumber === null || read.pullRequest.number === expectedPullRequestNumber),
      absent: (read) => read.pullRequest === null,
      effectTarget: { expectedPullRequestNumber },
    });
    if (pullRequestResult !== 'confirmed_success') {
      return this.resultFor(pullRequestResult, 'pull_request_not_confirmed');
    }
    const finalRead = await this.inspect(candidate.repositoryId, target, candidate.jobId);
    if (
      !finalRead.authoritative || !sameSha(finalRead.branchHead, candidate.candidateSha) ||
      finalRead.pullRequest?.jobMarker !== candidate.jobId ||
      !sameSha(finalRead.pullRequest.headSha, candidate.candidateSha) ||
      finalRead.pullRequest.baseBranch !== target.baseBranch ||
      finalRead.pullRequest.state !== 'open'
    ) return this.pending('pull_request_readback_unconfirmed');
    const beforeBindBlock = this.currentnessBlock(candidate);
    if (beforeBindBlock) return this.blocked(beforeBindBlock);
    const confirmedPrStep = this.effects.get(input.pullRequestOperationId)?.steps.find((step) => step.stepKey === 'write');
    let confirmedPrInspection: PublicationInspection | undefined;
    try {
      confirmedPrInspection = confirmedPrStep?.resultJson
        ? publicationInspectionFromEffectResult(JSON.parse(confirmedPrStep.resultJson))
        : undefined;
    } catch {
      confirmedPrInspection = undefined;
    }
    if (confirmedPrStep?.status !== 'confirmed_success' ||
      confirmedPrInspection?.pullRequest?.number !== finalRead.pullRequest.number ||
      confirmedPrInspection.pullRequest?.jobMarker !== candidate.jobId ||
      !sameSha(confirmedPrInspection.pullRequest.headSha, candidate.candidateSha)) {
      return this.blocked('pull_request_receipt_conflict');
    }
    if (!this.bindPullRequest(candidate, target, finalRead.pullRequest.number, input.writerGeneration)) {
      return this.blocked('publication_binding_conflict');
    }
    return { status: 'published', pullRequestNumber: finalRead.pullRequest.number, reason: null };
  }

  private async preserveUnexpectedBranch(input: {
    operationId: string;
    candidate: NonNullable<ReturnType<CandidateStore['get']>>;
    target: PublicationTarget;
    observedHead: string | null;
    writerGeneration: number;
  }): Promise<PreservedRemoteBranch | null> {
    if (!input.observedHead || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.observedHead)) return null;
    const job = this.state.getJobOrThrow(input.candidate.jobId);
    const target = {
      repositoryId: input.candidate.repositoryId,
      taskBranch: input.target.taskBranch,
      expectedHead: input.target.expectedRemoteHead,
      observedHead: input.observedHead.toLowerCase(),
    };
    const operation = this.effects.begin({
      operationId: input.operationId,
      jobId: job.job_id,
      operationKind: 'publication_branch_preservation',
      arguments: target,
      target,
      expectedJobVersion: this.effects.get(input.operationId)?.operation.expectedJobVersion ?? job.row_version,
      scopeRevisionId: input.candidate.scopeRevisionId,
      policyVersion: input.candidate.policyVersion,
      callerIdentity: 'controller:publication',
      grant: { action: 'publication.preserve_unexpected_branch', candidateId: input.candidate.candidateId },
      steps: [{ stepId: `${input.operationId}:preserve`, stepKey: 'preserve', target }],
      writerGeneration: input.writerGeneration,
    }).view;
    const step = operation.steps[0];
    if (!step) return null;
    if (step.status === 'confirmed_success' && step.resultJson) {
      try {
        const stored = JSON.parse(step.resultJson) as { receipt?: PreservedRemoteBranch };
        return this.validatePreservation(stored.receipt, input.operationId, target)
          ? stored.receipt as PreservedRemoteBranch : null;
      } catch { return null; }
    }
    if (step.status === 'confirmed_failure') return null;

    let observation: { authoritative: boolean; receipt: PreservedRemoteBranch | null };
    try {
      observation = await this.provider.inspectPreservedBranch({
        operationId: input.operationId,
        repositoryId: target.repositoryId,
        taskBranch: target.taskBranch,
        observedHead: target.observedHead,
      });
    } catch {
      observation = { authoritative: false, receipt: null };
    }
    if (observation.authoritative && this.validatePreservation(observation.receipt, input.operationId, target)) {
      if (step.startedAt === null && !this.effects.claimStepStart(input.operationId, step.stepId, input.writerGeneration)) return null;
      const currentStep = this.effects.get(input.operationId)?.steps[0];
      if (!currentStep) return null;
      this.record(input.operationId, step.stepId, currentStep.rowVersion, 'confirmed_success', observation,
        input.writerGeneration, 'reconciliation');
      return observation.receipt;
    }
    if (step.startedAt !== null || step.status === 'unknown') {
      if (observation.authoritative) {
        this.record(input.operationId, step.stepId, step.rowVersion, 'confirmed_failure', observation, input.writerGeneration, 'reconciliation');
      }
      return null;
    }
    if (!observation.authoritative || !this.effects.claimStepStart(input.operationId, step.stepId, input.writerGeneration)) return null;
    const started = this.effects.get(input.operationId)?.steps[0];
    if (!started) return null;
    let writeThrew = false;
    try {
      await this.provider.preserveUnexpectedBranch({ operationId: input.operationId, ...target });
    } catch {
      writeThrew = true;
      try {
        observation = await this.provider.inspectPreservedBranch({
          operationId: input.operationId,
          repositoryId: target.repositoryId,
          taskBranch: target.taskBranch,
          observedHead: target.observedHead,
        });
      } catch {
        observation = { authoritative: false, receipt: null };
      }
    }
    if (!writeThrew) {
      try {
        observation = await this.provider.inspectPreservedBranch({
          operationId: input.operationId,
          repositoryId: target.repositoryId,
          taskBranch: target.taskBranch,
          observedHead: target.observedHead,
        });
      } catch {
        observation = { authoritative: false, receipt: null };
      }
    }
    const valid = observation.authoritative && this.validatePreservation(observation.receipt, input.operationId, target);
    const status = valid ? 'confirmed_success' : observation.authoritative ? 'confirmed_failure' : 'unknown';
    this.record(input.operationId, started.stepId, started.rowVersion, status, observation, input.writerGeneration, 'provider_receipt');
    return valid ? observation.receipt : null;
  }

  private validatePreservation(
    receipt: PreservedRemoteBranch | null | undefined,
    operationId: string,
    target: { repositoryId: string; taskBranch: string; expectedHead: string | null; observedHead: string },
  ): receipt is PreservedRemoteBranch {
    if (!receipt || receipt.operationId !== operationId || receipt.repositoryId !== target.repositoryId ||
      receipt.taskBranch !== target.taskBranch || !sameSha(receipt.expectedHead, target.expectedHead) ||
      !sameSha(receipt.observedHead, target.observedHead) ||
      typeof receipt.checkpointId !== 'string' || receipt.checkpointId.trim() !== receipt.checkpointId || !receipt.checkpointId ||
      !/^[a-f0-9]{64}$/i.test(receipt.artifactSha256) ||
      !Array.isArray(receipt.commits) || receipt.commits.length === 0) return false;
    return receipt.commits.every((commit) => commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit.sha) &&
      typeof commit.summary === 'string' && commit.summary.trim() === commit.summary) &&
      receipt.commits.some((commit) => sameSha(commit.sha, target.observedHead));
  }

  private bindPullRequest(
    candidate: NonNullable<ReturnType<CandidateStore['get']>>,
    target: PublicationTarget,
    pullRequestNumber: number,
    writerGeneration: number,
  ): boolean {
    const occurredAt = this.state.now().toISOString();
    return this.state.runWithStaleAudit(candidate.jobId, writerGeneration, occurredAt, 'publication_binding', () => {
      this.state.assertWriter(writerGeneration, occurredAt);
      const job = this.state.getJobOrThrow(candidate.jobId);
      if (this.currentnessBlock(candidate) !== null) return false;
      const existing = this.state.database.prepare(
        'SELECT * FROM publication_bindings WHERE job_id = ?',
      ).get(candidate.jobId) as {
        repository_id: string; task_branch: string; base_branch: string;
        pull_request_number: number; initial_candidate_id: string;
      } | undefined;
      if (existing) {
        return existing.repository_id === candidate.repositoryId && existing.task_branch === target.taskBranch &&
          existing.base_branch === target.baseBranch && existing.pull_request_number === pullRequestNumber;
      }
      this.state.database.prepare(`
        INSERT INTO publication_bindings (
          job_id, repository_id, task_branch, base_branch, pull_request_number,
          initial_candidate_id, bound_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(candidate.jobId, candidate.repositoryId, target.taskBranch, target.baseBranch,
        pullRequestNumber, candidate.candidateId, occurredAt);
      const nextVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.bumpJob(job, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: candidate.jobId,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'publication_bound',
        payload: {
          repositoryId: candidate.repositoryId,
          taskBranch: target.taskBranch,
          baseBranch: target.baseBranch,
          pullRequestNumber,
          candidateId: candidate.candidateId,
        },
        writerGeneration,
        occurredAt,
      });
      return true;
    });
  }

  private async runWrite(input: {
    operationId: string;
    kind: WriteKind;
    candidate: NonNullable<ReturnType<CandidateStore['get']>>;
    target: PublicationTarget;
    generation: number;
    classification: 'ordinary' | 'protected' | 'uncertain';
    isCurrent: () => boolean;
    arguments: unknown;
    effectTarget?: Record<string, unknown>;
    approval?: PublicationApproval;
    write: () => Promise<void>;
    verify: (read: PublicationInspection) => boolean;
    absent: (read: PublicationInspection) => boolean;
  }): Promise<'confirmed_success' | 'confirmed_failure' | 'unknown'> {
    const job = this.state.getJobOrThrow(input.candidate.jobId);
    const target = {
      repositoryId: input.candidate.repositoryId,
      taskBranch: input.target.taskBranch,
      candidateSha: input.candidate.candidateSha,
      ...input.effectTarget,
    };
    const operation = this.effects.begin({
        operationId: input.operationId,
        jobId: job.job_id,
        operationKind: input.kind,
        arguments: input.arguments,
        target,
        expectedJobVersion: this.effects.get(input.operationId)?.operation.expectedJobVersion ?? job.row_version,
        scopeRevisionId: input.candidate.scopeRevisionId,
        policyVersion: input.candidate.policyVersion,
        callerIdentity: 'controller:publication',
        grant: { action: input.kind, candidateId: input.candidate.candidateId, approval: input.approval ?? null,
          protectedChangeClassification: input.classification },
        steps: [{ stepId: `${input.operationId}:write`, stepKey: 'write', target }],
        writerGeneration: input.generation,
      }).view;
    const step = operation.steps[0];
    if (!step) throw new StateError('PUBLICATION_STEP_MISSING', 'Publication effect has no write step');
    if (step.status === 'confirmed_success') return 'confirmed_success';
    if (step.status === 'confirmed_failure') return 'confirmed_failure';

    const before = await this.inspect(input.candidate.repositoryId, input.target, input.candidate.jobId);
    if (before.authoritative && input.verify(before)) {
      this.record(operation.operation.operationId, step.stepId, step.rowVersion, 'confirmed_success', before, input.generation, 'reconciliation');
      return 'confirmed_success';
    }
    if (!before.authoritative || step.startedAt !== null || step.status === 'unknown') {
      if (step.startedAt === null) return 'unknown';
      const status = before.authoritative && input.absent(before) ? 'confirmed_failure' : 'unknown';
      this.record(operation.operation.operationId, step.stepId, step.rowVersion, status, before, input.generation, 'reconciliation');
      return status;
    }
    if (!input.isCurrent()) return 'unknown';
    if (this.hasConflictingWrite(input.candidate.repositoryId, input.target.taskBranch, [input.operationId])) return 'unknown';
    if (!this.effects.claimStepStart(input.operationId, step.stepId, input.generation)) return 'unknown';
    const started = this.effects.get(input.operationId)?.steps[0];
    if (!started) return 'unknown';
    try {
      await input.write();
    } catch {
      const read = await this.inspect(input.candidate.repositoryId, input.target, input.candidate.jobId);
      const status = read.authoritative && input.verify(read)
        ? 'confirmed_success'
        : read.authoritative && input.absent(read) ? 'confirmed_failure' : 'unknown';
      this.record(input.operationId, started.stepId, started.rowVersion, status, {
        observation: read,
        adapterError: 'write_outcome_requires_reconciliation',
      }, input.generation, 'provider_receipt');
      return status;
    }
    const read = await this.inspect(input.candidate.repositoryId, input.target, input.candidate.jobId);
    const status = !read.authoritative ? 'unknown'
      : input.verify(read) ? 'confirmed_success'
      : input.absent(read) ? 'confirmed_failure' : 'unknown';
    this.record(input.operationId, started.stepId, started.rowVersion, status, read, input.generation, 'provider_receipt');
    return status;
  }

  private record(
    operationId: string,
    stepId: string,
    expectedStepVersion: number,
    status: 'confirmed_success' | 'confirmed_failure' | 'unknown',
    result: unknown,
    generation: number,
    resultSource: 'provider_receipt' | 'reconciliation',
  ): void {
    this.effectResults.recordResult({
      operationId,
      stepId,
      expectedStepVersion,
      status,
      result,
      resultGeneration: generation,
      resultSource,
      writerGeneration: generation,
    });
  }

  private async inspect(repositoryId: string, target: PublicationTarget, jobMarker: string): Promise<PublicationInspection> {
    try {
      return await this.provider.inspect({ repositoryId, taskBranch: target.taskBranch, jobMarker });
    } catch {
      return { authoritative: false, branchHead: null, pullRequest: null };
    }
  }

  private validateTarget(target: PublicationTarget): void {
    for (const [name, value] of Object.entries(target)) {
      if (name === 'expectedRemoteHead' && value === null) continue;
      if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
        throw new StateError('INVALID_PUBLICATION_TARGET', `${name} must be a non-empty trimmed string`);
      }
    }
    if (target.expectedRemoteHead !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(target.expectedRemoteHead)) {
      throw new StateError('INVALID_PUBLICATION_TARGET', 'expectedRemoteHead must be a full Git commit SHA');
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(target.verifiedBaseSha)) {
      throw new StateError('INVALID_PUBLICATION_TARGET', 'verifiedBaseSha must be a full Git commit SHA');
    }
    if (target.taskBranch === target.baseBranch) throw new StateError('INVALID_PUBLICATION_TARGET', 'Task branch must differ from the base branch');
  }

  private blocked(reason: string): PublicationResult { return { status: 'blocked', pullRequestNumber: null, reason }; }
  private pending(reason: string): PublicationResult { return { status: 'pending', pullRequestNumber: null, reason }; }
  private resultFor(status: 'confirmed_success' | 'confirmed_failure' | 'unknown', reason: string): PublicationResult {
    return status === 'confirmed_success' ? { status: 'published', pullRequestNumber: null, reason: null }
      : status === 'unknown' ? this.pending(reason) : this.blocked(reason);
  }

  private publicationCurrent(candidate: NonNullable<ReturnType<CandidateStore['get']>>): boolean {
    return this.currentnessBlock(candidate) === null;
  }

  private hasConflictingWrite(repositoryId: string, taskBranch: string, excludedOperationIds: string[]): boolean {
    const writes = this.state.database.prepare(`
      SELECT operation.operation_id FROM effect_operations operation
      WHERE operation.operation_kind IN ('publication_push', 'publication_pull_request')
        AND json_extract(operation.target_json, '$.repositoryId') = ?
        AND json_extract(operation.target_json, '$.taskBranch') = ?
        AND (operation.status = 'unknown' OR EXISTS (
          SELECT 1 FROM effect_steps step WHERE step.operation_id = operation.operation_id
            AND step.started_at IS NOT NULL AND step.status IN ('pending', 'unknown')
        ))
    `).all(repositoryId, taskBranch) as Array<{ operation_id: string }>;
    return writes.some((write) => !excludedOperationIds.includes(write.operation_id));
  }

  private canReconcilePullRequest(
    operation: EffectOperationView | undefined,
    candidate: NonNullable<ReturnType<CandidateStore['get']>>,
    target: PublicationTarget,
    pullRequest: NonNullable<PublicationInspection['pullRequest']>,
  ): boolean {
    if (!operation || operation.operation.jobId !== candidate.jobId ||
      operation.operation.operationKind !== 'publication_pull_request' ||
      operation.operation.scopeRevisionId !== candidate.scopeRevisionId ||
      operation.operation.policyVersion !== candidate.policyVersion) return false;
    const step = operation.steps.find((item) => item.stepKey === 'write');
    if (!step?.startedAt || step.status === 'confirmed_failure') return false;
    try {
      const savedTarget = JSON.parse(operation.operation.targetJson) as {
        repositoryId?: unknown; taskBranch?: unknown; candidateSha?: unknown; expectedPullRequestNumber?: unknown;
      };
      const grant = JSON.parse(operation.authorization.grantJson) as { candidateId?: unknown };
      if (savedTarget.repositoryId !== candidate.repositoryId || savedTarget.taskBranch !== target.taskBranch ||
        savedTarget.candidateSha !== candidate.candidateSha || grant.candidateId !== candidate.candidateId ||
        !sameSha(pullRequest.headSha, candidate.candidateSha) ||
        (savedTarget.expectedPullRequestNumber !== null && savedTarget.expectedPullRequestNumber !== pullRequest.number)) return false;
      if (step.status === 'confirmed_success') {
        const receipt = publicationInspectionFromEffectResult(JSON.parse(step.resultJson ?? 'null'));
        return receipt?.pullRequest?.number === pullRequest.number;
      }
      return true;
    } catch { return false; }
  }

  private currentnessBlock(candidate: NonNullable<ReturnType<CandidateStore['get']>>): string | null {
    const job = this.state.getJobOrThrow(candidate.jobId);
    if (job.requested_control !== 'run') return 'job_control_blocks_publication';
    if (job.repository_id !== candidate.repositoryId || job.issue_id !== candidate.issueId ||
      job.scope_revision_id !== candidate.scopeRevisionId) return 'stale_candidate_binding';
    const latestExecution = this.state.database.prepare(`
      SELECT execution_id, ownership_generation, lifecycle
      FROM executions WHERE job_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(candidate.jobId) as { execution_id: string; ownership_generation: number; lifecycle: string } | undefined;
    if (!latestExecution || latestExecution.execution_id !== candidate.executionId ||
      latestExecution.ownership_generation !== candidate.ownershipGeneration ||
      (latestExecution.lifecycle !== 'active' && latestExecution.lifecycle !== 'terminal')) {
      return 'candidate_execution_not_current';
    }
    const issueRead = this.state.database.prepare(`
      SELECT observation.status, observation.scope_revision_id
      FROM issue_read_heads head JOIN issue_read_observations observation USING (observation_id)
      WHERE head.repository_id = ? AND head.issue_id = ?
    `).get(candidate.repositoryId, candidate.issueId) as { status: string; scope_revision_id: string | null } | undefined;
    if (issueRead?.status !== 'complete' || issueRead.scope_revision_id !== candidate.scopeRevisionId) {
      return 'issue_scope_not_current';
    }
    const readiness = this.state.database.prepare(`
      SELECT observation.status, observation.label_present
      FROM readiness_heads head JOIN readiness_observations observation USING (observation_id)
      WHERE head.repository_id = ? AND head.issue_id = ?
    `).get(candidate.repositoryId, candidate.issueId) as { status: string; label_present: number | null } | undefined;
    if (readiness?.status !== 'complete' || readiness.label_present !== 1) return 'readiness_not_current';
    if (this.candidates.latestForJob(candidate.jobId)?.candidateId !== candidate.candidateId) return 'candidate_not_current';
    return null;
  }
}
