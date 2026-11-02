import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateStore, type CandidateSubmissionRecord } from './candidates.js';
import { AdmissionStore } from '../admission/admission.js';
import { IssueScopeStore } from '../issues/issue-scopes.js';
import {
  PublicationCoordinator,
  type CandidateExportInspection,
  publicationInspectionFromEffectResult,
  type PublicationApproval,
  type PublicationInspection,
  type PublicationPolicy,
  type PublicationProvider,
  type PreservedRemoteBranch,
  type PublicationTarget,
} from './publication.js';
import { createJob, createStateFixture, prepareExecutionStartEvidence } from '../../tests/fixtures/state-fixture.js';

const candidate: CandidateSubmissionRecord = {
  candidateId: 'candidate-1',
  jobId: 'job-1',
  executionId: 'execution-1',
  ownershipGeneration: 1,
  repositoryId: 'repo-1',
  issueId: 'issue-1',
  scopeRevisionId: 'scope-1',
  policyVersion: 'policy-1',
  sourceBundleId: 'bundle-1',
  baseSha: 'a'.repeat(40),
  candidateSha: 'c'.repeat(40),
  reportedValidationResults: [],
  submittedAt: '2026-11-03T00:00:00.000Z',
};

const target: PublicationTarget = {
  taskBranch: 'agent/job-1',
  baseBranch: 'main',
  verifiedBaseSha: candidate.baseSha,
  expectedRemoteHead: candidate.baseSha,
  pullRequestTitle: 'Issue #1: task',
  pullRequestBody: 'Implements the approved scope.',
  policyVersion: 'policy-1',
};

function setup(options: {
  classification?: 'ordinary' | 'protected' | 'uncertain';
  approval?: PublicationApproval;
  initial?: PublicationInspection;
  reportedValidationResults?: CandidateSubmissionRecord['reportedValidationResults'];
  sourceExport?: CandidateExportInspection;
  readinessRemoved?: boolean;
  issueChanged?: boolean;
} = {}) {
  const fixture = createStateFixture();
  const job = createJob(fixture.jobs);
  const startEvidence = prepareExecutionStartEvidence(
    fixture, job.repositoryId, job.issueId, job.scopeRevisionId,
  );
  if (options.issueChanged) {
    new IssueScopeStore(fixture.state).recordCompleteRead({
      observationId: 'changed-issue-read', scopeRevisionId: 'scope-2',
      repositoryId: job.repositoryId, issueId: job.issueId, sourceRevisionId: 'provider-revision-2',
      title: 'Task changed', body: 'New scope', dependencyIssueIds: [], templateVersion: '1',
      policyVersion: 'policy-1', observedAt: fixture.state.now().toISOString(),
      expectedHeadVersion: startEvidence.issueHeadVersion, writerGeneration: 1,
    });
  }
  if (options.readinessRemoved) {
    new AdmissionStore(fixture.state).recordReadinessObservation({
      observationId: 'removed-ready-label', repositoryId: job.repositoryId, issueId: job.issueId,
      labelPresent: false, complete: true, observedAt: fixture.state.now().toISOString(),
      expectedHeadVersion: startEvidence.readinessHeadVersion, writerGeneration: 1,
    });
  }
  const execution = fixture.executions.reserve({
    executionId: candidate.executionId,
    jobId: job.jobId,
    expectedJobVersion: job.rowVersion,
    writerGeneration: 1,
  });
  fixture.executions.transition({
    executionId: execution.executionId,
    expectedVersion: execution.rowVersion,
    writerGeneration: 1,
    lifecycle: 'terminal',
    terminalOutcome: 'candidate_submitted',
  });
  fixture.database.prepare(`
    INSERT INTO candidate_submissions (
      candidate_id, job_id, execution_id, ownership_generation, repository_id, issue_id,
      scope_revision_id, policy_version, source_bundle_id, base_sha, candidate_sha,
      reported_validation_json, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(candidate.candidateId, job.jobId, execution.executionId, candidate.ownershipGeneration,
    candidate.repositoryId, candidate.issueId, candidate.scopeRevisionId, candidate.policyVersion,
    candidate.sourceBundleId, candidate.baseSha, candidate.candidateSha,
    JSON.stringify(options.reportedValidationResults ?? []), candidate.submittedAt);
  let current: PublicationInspection = options.initial ?? {
    authoritative: true,
    branchHead: candidate.baseSha,
    pullRequest: null,
  };
  let pushCount = 0;
  let pullRequestCount = 0;
  let preservationCount = 0;
  let preserved: PreservedRemoteBranch | null = null;
  const provider: PublicationProvider = {
    inspectCandidateExport: async (input) => options.sourceExport ?? ({
      authoritative: true,
      available: true,
      repositoryId: input.repositoryId,
      sourceBundleId: input.sourceBundleId,
      candidateSha: input.candidateSha,
      baseSha: input.baseSha,
      baseIsAncestor: true,
      artifactSha256: 'e'.repeat(64),
    }),
    inspect: async () => current,
    pushCandidate: async (input) => {
      pushCount += 1;
      assert.ok(input.expectedRemoteHead === candidate.baseSha || input.expectedRemoteHead === candidate.candidateSha);
      current = { ...current, branchHead: input.candidateSha };
    },
    createOrUpdatePullRequest: async (input) => {
      pullRequestCount += 1;
      current = {
        ...current,
        pullRequest: {
          number: 12,
          headSha: current.branchHead ?? candidate.candidateSha,
          baseBranch: input.baseBranch,
          state: 'open',
          jobMarker: input.jobMarker,
        },
      };
    },
    preserveUnexpectedBranch: async (input) => {
      preservationCount += 1;
      preserved = {
        operationId: input.operationId,
        repositoryId: input.repositoryId,
        taskBranch: input.taskBranch,
        expectedHead: input.expectedHead,
        observedHead: input.observedHead,
        checkpointId: 'checkpoint-1',
        artifactSha256: 'f'.repeat(64),
        commits: [{ sha: input.observedHead, summary: 'unexpected remote commit' }],
      };
    },
    inspectPreservedBranch: async () => ({ authoritative: true, receipt: preserved }),
  };
  let resolvedTarget = target;
  const policy: PublicationPolicy = {
    resolve: async () => ({
      target: resolvedTarget,
      classification: options.classification ?? 'ordinary',
      ...(options.approval ? { approval: options.approval } : {}),
    }),
  };
  const candidates = new CandidateStore(fixture.state);
  const coordinator = new PublicationCoordinator(
    fixture.state,
    candidates as never,
    fixture.effects,
    fixture.effectResults,
    provider,
    policy,
  );
  return {
    fixture, coordinator, provider, getCurrent: () => current,
    setTarget: (value: PublicationTarget) => { resolvedTarget = value; },
    counts: () => ({ pushCount, pullRequestCount, preservationCount }),
  };
}

function request() {
  return {
    candidateId: candidate.candidateId,
    preservationOperationId: 'preserve-branch-1',
    pushOperationId: 'publish-push-1',
    pullRequestOperationId: 'publish-pr-1',
    writerGeneration: 1,
  };
}

test('publishes one exact candidate with durable push and PR receipts', async () => {
  const state = setup();
  try {
    const result = await state.coordinator.publish(request());
    assert.deepEqual(result, { status: 'published', pullRequestNumber: 12, reason: null });
    assert.deepEqual(state.counts(), { pushCount: 1, pullRequestCount: 1, preservationCount: 0 });
    assert.equal(state.fixture.effects.get('publish-push-1')?.steps[0]?.status, 'confirmed_success');
    assert.equal(state.fixture.effects.get('publish-pr-1')?.steps[0]?.status, 'confirmed_success');
    assert.deepEqual(await state.coordinator.publish(request()), result);
    assert.deepEqual(state.counts(), { pushCount: 1, pullRequestCount: 1, preservationCount: 0 });
    const binding = state.fixture.database.prepare(
      'SELECT pull_request_number FROM publication_bindings WHERE job_id = ?',
    ).get('job-1') as { pull_request_number: number } | undefined;
    assert.equal(binding?.pull_request_number, 12);
    assert.throws(
      () => state.fixture.database.prepare('DELETE FROM publication_bindings WHERE job_id = ?').run('job-1'),
      /publication bindings are immutable/,
    );
    state.setTarget({ ...target, taskBranch: 'agent/another-branch' });
    assert.equal((await state.coordinator.publish(request())).reason, 'publication_target_binding_conflict');
    assert.deepEqual(state.counts(), { pushCount: 1, pullRequestCount: 1, preservationCount: 0 });
  } finally {
    state.fixture.close();
  }
});

test('blocks unexpected branch heads and protected changes without exact approval', async () => {
  const branchRace = setup({ initial: { authoritative: true, branchHead: 'd'.repeat(40), pullRequest: null } });
  const preserve = branchRace.provider.preserveUnexpectedBranch;
  branchRace.provider.preserveUnexpectedBranch = async (input) => {
    await preserve(input);
    throw new Error('checkpoint response lost');
  };
  try {
    const blocked = await branchRace.coordinator.publish(request());
    assert.equal(blocked.reason, 'unexpected_remote_branch_head');
    assert.equal(blocked.preservation?.checkpointId, 'checkpoint-1');
    assert.deepEqual(branchRace.counts(), { pushCount: 0, pullRequestCount: 0, preservationCount: 1 });
  } finally {
    branchRace.fixture.close();
  }

  const protectedCandidate = setup({ classification: 'protected' });
  try {
    assert.equal((await protectedCandidate.coordinator.publish(request())).reason, 'protected_change_approval_required');
    assert.deepEqual(protectedCandidate.counts(), { pushCount: 0, pullRequestCount: 0, preservationCount: 0 });
  } finally {
    protectedCandidate.fixture.close();
  }
});

test('blocks publication when unexpected branch preservation is authoritatively unsuccessful', async () => {
  const state = setup({ initial: { authoritative: true, branchHead: 'd'.repeat(40), pullRequest: null } });
  state.provider.inspectPreservedBranch = async () => ({ authoritative: true, receipt: null });
  try {
    const result = await state.coordinator.publish(request());
    assert.deepEqual(result, {
      status: 'blocked', pullRequestNumber: null, reason: 'unexpected_branch_preservation_failed',
    });
    assert.equal(state.fixture.effects.get('preserve-branch-1')?.steps[0]?.status, 'confirmed_failure');
    assert.deepEqual(state.counts(), { pushCount: 0, pullRequestCount: 0, preservationCount: 1 });
  } finally {
    state.fixture.close();
  }
});

test('blocks publication when the candidate reports a failed declared local validation', async () => {
  const state = setup({ reportedValidationResults: [{
    command: 'npm run check', exitCode: 1, observedAt: '2026-11-03T00:00:00.000Z',
  }] });
  try {
    assert.equal((await state.coordinator.publish(request())).reason, 'local_validation_failed');
    assert.deepEqual(state.counts(), { pushCount: 0, pullRequestCount: 0, preservationCount: 0 });
  } finally {
    state.fixture.close();
  }
});

test('blocks a source bundle whose exported candidate or base cannot be verified', async () => {
  const state = setup({ sourceExport: {
    authoritative: true,
    available: true,
    repositoryId: candidate.repositoryId,
    sourceBundleId: candidate.sourceBundleId,
    candidateSha: 'd'.repeat(40),
    baseSha: candidate.baseSha,
    baseIsAncestor: true,
    artifactSha256: 'e'.repeat(64),
  } });
  try {
    assert.equal((await state.coordinator.publish(request())).reason, 'candidate_source_export_invalid');
    assert.deepEqual(state.counts(), { pushCount: 0, pullRequestCount: 0, preservationCount: 0 });
  } finally {
    state.fixture.close();
  }
});

test('blocks publication after the issue scope changes or readiness is removed', async () => {
  for (const [options, reason] of [
    [{ issueChanged: true }, 'issue_scope_not_current'],
    [{ readinessRemoved: true }, 'readiness_not_current'],
  ] as const) {
    const state = setup(options);
    try {
      assert.equal((await state.coordinator.publish(request())).reason, reason);
      assert.deepEqual(state.counts(), { pushCount: 0, pullRequestCount: 0, preservationCount: 0 });
    } finally {
      state.fixture.close();
    }
  }
});

test('records exact protected-change approval in effect authorization evidence', async () => {
  const approval: PublicationApproval = {
    candidateSha: candidate.candidateSha,
    baseSha: candidate.baseSha,
    policyVersion: candidate.policyVersion,
    approverIdentity: 'human:reviewer-1',
    authorityId: 'publication-approver',
    decisionReceipt: 'decision-1',
  };
  const state = setup({ classification: 'uncertain', approval });
  try {
    assert.equal((await state.coordinator.publish(request())).status, 'published');
    const authorization = state.fixture.effects.get('publish-push-1')?.authorization;
    assert.deepEqual(JSON.parse(authorization?.grantJson ?? '{}').approval, approval);
  } finally {
    state.fixture.close();
  }
});

test('reconciles an uncertain push from authoritative readback without repeating it', async () => {
  const state = setup();
  const original = state.provider.pushCandidate;
  state.provider.pushCandidate = async (input) => {
    await original(input);
    throw new Error('response lost');
  };
  try {
    assert.equal((await state.coordinator.publish(request())).status, 'published');
    assert.deepEqual(state.counts(), { pushCount: 1, pullRequestCount: 1, preservationCount: 0 });
    assert.equal(state.fixture.effects.get('publish-push-1')?.steps[0]?.status, 'confirmed_success');
  } finally {
    state.fixture.close();
  }
});

test('reconciles a lost PR response and preserves the exact inspection in its receipt', async () => {
  const state = setup();
  const original = state.provider.createOrUpdatePullRequest;
  state.provider.createOrUpdatePullRequest = async (input) => {
    await original(input);
    throw new Error('response lost');
  };
  try {
    assert.equal((await state.coordinator.publish(request())).status, 'published');
    const step = state.fixture.effects.get('publish-pr-1')?.steps[0];
    assert.equal(step?.status, 'confirmed_success');
    const inspection = publicationInspectionFromEffectResult(JSON.parse(step?.resultJson ?? '{}'));
    assert.equal(inspection?.pullRequest?.number, 12);
    assert.deepEqual(state.counts(), { pushCount: 1, pullRequestCount: 1, preservationCount: 0 });
  } finally {
    state.fixture.close();
  }
});

test('repairs update the one bound task branch and pull request', async () => {
  const state = setup();
  try {
    assert.equal((await state.coordinator.publish(request())).status, 'published');
    const job = state.fixture.jobs.get('job-1');
    assert.ok(job);
    const execution = state.fixture.executions.reserve({
      executionId: 'execution-repair-1',
      jobId: job.jobId,
      expectedJobVersion: job.rowVersion,
      writerGeneration: 1,
    });
    state.fixture.executions.transition({
      executionId: execution.executionId,
      expectedVersion: execution.rowVersion,
      writerGeneration: 1,
      lifecycle: 'terminal',
      terminalOutcome: 'repair_candidate_submitted',
    });
    const repairCandidate = {
      ...candidate,
      candidateId: 'candidate-repair-1',
      executionId: execution.executionId,
      candidateSha: 'd'.repeat(40),
      submittedAt: '2026-11-03T00:05:00.000Z',
    };
    state.fixture.database.prepare(`
      INSERT INTO candidate_submissions (
        candidate_id, job_id, execution_id, ownership_generation, repository_id, issue_id,
        scope_revision_id, policy_version, source_bundle_id, base_sha, candidate_sha,
        reported_validation_json, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(repairCandidate.candidateId, repairCandidate.jobId, repairCandidate.executionId,
      repairCandidate.ownershipGeneration, repairCandidate.repositoryId, repairCandidate.issueId,
      repairCandidate.scopeRevisionId, repairCandidate.policyVersion, repairCandidate.sourceBundleId,
      repairCandidate.baseSha, repairCandidate.candidateSha, '[]', repairCandidate.submittedAt);
    state.setTarget({ ...target, expectedRemoteHead: candidate.candidateSha });
    const result = await state.coordinator.publish({
      candidateId: repairCandidate.candidateId,
      preservationOperationId: 'preserve-repair-branch',
      pushOperationId: 'publish-repair-push',
      pullRequestOperationId: 'publish-repair-pr',
      writerGeneration: 1,
    });
    assert.deepEqual(result, { status: 'published', pullRequestNumber: 12, reason: null });
    assert.equal(state.getCurrent().branchHead, repairCandidate.candidateSha);
    assert.equal(state.getCurrent().pullRequest?.headSha, repairCandidate.candidateSha);
    const bindings = state.fixture.database.prepare('SELECT COUNT(*) AS count FROM publication_bindings WHERE job_id = ?')
      .get('job-1') as { count: number };
    assert.equal(bindings.count, 1);
    assert.deepEqual(state.counts(), { pushCount: 2, pullRequestCount: 2, preservationCount: 0 });
  } finally {
    state.fixture.close();
  }
});
