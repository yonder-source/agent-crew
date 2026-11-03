import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateStore } from './candidates.js';
import {
  evaluatePublicationReadiness,
  PublicationEvidenceStore,
  type PublicationCheckObservation,
  type PublicationEvidenceSnapshot,
} from './publication-evidence.js';
import { recordConfirmedPublication } from '../../tests/fixtures/publication-test-support.js';
import { StateError } from '../state/state-common.js';
import { createJob, createStateFixture } from '../../tests/fixtures/state-fixture.js';

function setup() {
  const fixture = createStateFixture();
  const job = createJob(fixture.jobs);
  const execution = fixture.executions.reserve({
    executionId: 'execution-evidence-1',
    jobId: job.jobId,
    expectedJobVersion: job.rowVersion,
    writerGeneration: 1,
  });
  fixture.database.prepare(`
    INSERT INTO candidate_submissions (
      candidate_id, job_id, execution_id, ownership_generation, repository_id, issue_id,
      scope_revision_id, policy_version, source_bundle_id, base_sha, candidate_sha,
      reported_validation_json, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'candidate-evidence-1', job.jobId, execution.executionId, 1, job.repositoryId, job.issueId,
    job.scopeRevisionId, 'policy-1', 'bundle-1', 'a'.repeat(40), 'c'.repeat(40), '[]',
    '2026-11-03T00:00:00.000Z',
  );
  const candidates = new CandidateStore(fixture.state);
  const candidate = candidates.get('candidate-evidence-1');
  assert.ok(candidate);
  const pullRequestOperationId = recordConfirmedPublication(fixture, candidate);
  const store = new PublicationEvidenceStore(fixture.state, candidates, fixture.effects);
  return { fixture, candidate, store, pullRequestOperationId };
}

function check(overrides: Partial<PublicationCheckObservation> = {}): PublicationCheckObservation {
  return {
    checkName: 'ci',
    producer: 'github-actions',
    workflowIdentity: '.github/workflows/ci.yml',
    targetSha: 'c'.repeat(40),
    conclusion: 'success',
    runId: 'run-1',
    syntheticMergeParents: null,
    observedAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<PublicationEvidenceSnapshot> = {}): PublicationEvidenceSnapshot {
  return {
    snapshotId: 'snapshot-1',
    candidateId: 'candidate-evidence-1',
    pullRequestOperationId: 'published-pr-candidate-evidence-1',
    repositoryId: 'repo-1',
    issueId: 'issue-1',
    baseBranch: 'main',
    pullRequestNumber: 17,
    headSha: 'c'.repeat(40),
    baseSha: 'b'.repeat(40),
    policyVersion: 'policy-1',
    observedAt: '2026-11-03T00:01:00.000Z',
    sourceIdentity: 'github-api:installation-1',
    sourceCursor: 'response-1',
    complete: true,
    prState: 'open',
    mergeCommitSha: null,
    mergeParentShas: null,
    checks: [check()],
    reviews: [{
      reviewId: 'review-1',
      reviewerIdentity: 'human:reviewer-1',
      state: 'approved',
      commitSha: 'c'.repeat(40),
      submittedAt: '2026-11-03T00:00:00.000Z',
    }],
    ...overrides,
  };
}

function evaluate(candidate: NonNullable<ReturnType<CandidateStore['get']>>, evidence: PublicationEvidenceSnapshot) {
  return evaluatePublicationReadiness({
    candidate,
    snapshot: evidence,
    currentBaseSha: 'b'.repeat(40),
    policyVersion: 'policy-1',
    requiredChecks: [{
      checkName: 'ci',
      producer: 'github-actions',
      workflowIdentity: '.github/workflows/ci.yml',
      allowNeutralOrSkipped: false,
    }],
    authorizedReviewers: ['human:reviewer-1'],
    observedNow: '2026-11-03T00:02:00.000Z',
    maximumAgeMs: 120_000,
  });
}

test('stores immutable provider snapshots and evaluates exact current check and review evidence', () => {
  const state = setup();
  try {
    const saved = state.store.record(snapshot(), 1);
    assert.equal(state.store.latest(saved.candidateId)?.snapshotId, 'snapshot-1');
    assert.deepEqual(state.store.record(snapshot(), 1), saved);
    assert.equal(evaluate(state.candidate, saved).status, 'ready');
    assert.deepEqual(evaluate(state.candidate, saved).checksExecuted, ['ci']);
    assert.throws(
      () => state.fixture.database.prepare('DELETE FROM publication_evidence_snapshots WHERE snapshot_id = ?').run(saved.snapshotId),
      /publication evidence snapshots are immutable/,
    );
    assert.throws(
      () => state.store.record(snapshot({ headSha: 'd'.repeat(40) }), 1),
      /Snapshot identity was reused with changed evidence/,
    );
  } finally {
    state.fixture.close();
  }
});

test('rejects wrong producers, stale evidence, and revoked candidate approval', () => {
  const state = setup();
  try {
    assert.ok(evaluate(state.candidate, snapshot({ checks: [check({ producer: 'untrusted-app' })] })).reasons
      .includes('required_check_missing_or_pending:ci'));
    assert.equal(evaluate(state.candidate, snapshot({ observedAt: '2026-11-02T00:00:00.000Z' })).reasons[0], 'evidence_stale');
    const dismissed = snapshot({ reviews: [
      { reviewId: 'review-1', reviewerIdentity: 'human:reviewer-1', state: 'approved', commitSha: 'c'.repeat(40), submittedAt: '2026-11-03T00:00:00.000Z' },
      { reviewId: 'review-2', reviewerIdentity: 'human:reviewer-1', state: 'dismissed', commitSha: 'c'.repeat(40), submittedAt: '2026-11-03T00:01:00.000Z' },
    ] });
    assert.ok(evaluate(state.candidate, dismissed).reasons.includes('authorized_candidate_approval_missing'));
  } finally {
    state.fixture.close();
  }
});

test('informational reviews preserve the reviewer\'s effective decision', () => {
  const state = setup();
  try {
    const current = snapshot();
    const approved = current.reviews[0];
    assert.ok(approved);
    current.reviews.push({ ...approved, reviewId: 'comment-2', state: 'commented', submittedAt: '2026-11-03T00:00:30.000Z' });
    assert.equal(evaluate(state.candidate, current).status, 'ready');
    approved.state = 'changes_requested';
    const decision = evaluate(state.candidate, current);
    assert.equal(decision.status, 'repair_required');
    assert.ok(decision.reasons.includes('authorized_changes_requested:human:reviewer-1'));
  } finally { state.fixture.close(); }
});

for (const changed of ['job', 'writer'] as const) {
  test(`a changed ${changed} fences a decision read before its evidence can be saved`, async () => {
    const state = setup();
    const job = state.fixture.jobs.get(state.candidate.jobId);
    assert.ok(job);
    try {
      await assert.rejects(() => state.store.refreshForDecision({ candidateId: state.candidate.candidateId,
        purpose: 'delivery', expectedJobVersion: job.rowVersion, writerGeneration: 1 }, {
        readFresh: async (request) => {
          if (changed === 'job') state.fixture.jobs.transition({ jobId: job.jobId, expectedVersion: job.rowVersion,
            writerGeneration: 1, requestedControl: 'pause', eventType: 'operator_pause' });
          else state.fixture.database.prepare('UPDATE controller_writer SET generation = 2 WHERE singleton_id = 1').run();
          return { ...snapshot(), snapshotId: request.snapshotId, observedAt: state.fixture.state.now().toISOString() };
        },
      }), (error: unknown) => error instanceof StateError && error.code === (changed === 'job' ? 'STALE_ROW_VERSION' : 'STALE_GENERATION'));
      assert.equal(state.store.latest(state.candidate.candidateId), undefined);
    } finally { state.fixture.close(); }
  });
}

test('opens bounded-repair eligibility only for current failed checks or authorized change requests', () => {
  const state = setup();
  try {
    const failed = snapshot({ checks: [check({ conclusion: 'failure' })] });
    assert.equal(evaluate(state.candidate, failed).status, 'repair_required');
    const failedAndPending = evaluatePublicationReadiness({
      candidate: state.candidate,
      snapshot: failed,
      currentBaseSha: 'b'.repeat(40),
      policyVersion: 'policy-1',
      requiredChecks: [
        { checkName: 'ci', producer: 'github-actions', workflowIdentity: '.github/workflows/ci.yml', allowNeutralOrSkipped: false },
        { checkName: 'security', producer: 'github-actions', workflowIdentity: '.github/workflows/security.yml', allowNeutralOrSkipped: false },
      ],
      authorizedReviewers: ['human:reviewer-1'],
      observedNow: '2026-11-03T00:02:00.000Z',
      maximumAgeMs: 120_000,
    });
    assert.equal(failedAndPending.status, 'blocked');
    const unauthorized = snapshot({ reviews: [{
      reviewId: 'review-2', reviewerIdentity: 'human:other', state: 'changes_requested',
      commitSha: 'c'.repeat(40), submittedAt: '2026-11-03T00:00:00.000Z',
    }] });
    assert.equal(evaluate(state.candidate, unauthorized).status, 'blocked');
    const authorized = snapshot({ reviews: [{
      reviewId: 'review-3', reviewerIdentity: 'human:reviewer-1', state: 'changes_requested',
      commitSha: 'c'.repeat(40), submittedAt: '2026-11-03T00:00:00.000Z',
    }] });
    assert.equal(evaluate(state.candidate, authorized).status, 'repair_required');
  } finally {
    state.fixture.close();
  }
});

test('accepts synthetic merge checks only when both parents bind candidate and current base', () => {
  const state = setup();
  try {
    const synthetic = check({
      targetSha: 'd'.repeat(40),
      syntheticMergeParents: ['c'.repeat(40), 'b'.repeat(40)],
    });
    assert.equal(evaluate(state.candidate, snapshot({ checks: [synthetic] })).status, 'ready');
    const wrongBase = check({
      targetSha: 'd'.repeat(40),
      syntheticMergeParents: ['c'.repeat(40), 'e'.repeat(40)],
    });
    assert.equal(evaluate(state.candidate, snapshot({ checks: [wrongBase] })).status, 'blocked');
  } finally {
    state.fixture.close();
  }
});
