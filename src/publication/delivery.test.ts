import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateStore } from './candidates.js';
import { DeliveryStore } from './delivery.js';
import { PublicationEvidenceStore, type PublicationEvidenceSnapshot } from './publication-evidence.js';
import { recordConfirmedPublication } from '../../tests/fixtures/publication-test-support.js';
import { createJob, createStateFixture } from '../../tests/fixtures/state-fixture.js';

function setup() {
  const fixture = createStateFixture();
  const job = createJob(fixture.jobs);
  const execution = fixture.executions.reserve({
    executionId: 'execution-delivery-1', jobId: job.jobId,
    expectedJobVersion: job.rowVersion, writerGeneration: 1,
  });
  fixture.executions.transition({ executionId: execution.executionId, expectedVersion: execution.rowVersion,
    writerGeneration: 1, lifecycle: 'terminal', terminalOutcome: 'candidate_submitted' });
  fixture.database.prepare(`
    INSERT INTO candidate_submissions (
      candidate_id, job_id, execution_id, ownership_generation, repository_id, issue_id,
      scope_revision_id, policy_version, source_bundle_id, base_sha, candidate_sha,
      reported_validation_json, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('candidate-delivery-1', job.jobId, execution.executionId, 1, job.repositoryId, job.issueId,
    job.scopeRevisionId, 'policy-1', 'bundle-1', 'a'.repeat(40), 'c'.repeat(40), '[]', fixture.state.now().toISOString());
  const candidates = new CandidateStore(fixture.state);
  const candidate = candidates.get('candidate-delivery-1');
  assert.ok(candidate);
  recordConfirmedPublication(fixture, candidate, 23);
  const evidence = new PublicationEvidenceStore(fixture.state, candidates, fixture.effects);
  const store = new DeliveryStore(fixture.state, candidates, evidence);
  return { fixture, candidate, evidence, store };
}

function evidence(candidate: NonNullable<ReturnType<CandidateStore['get']>>, snapshotId: string,
  overrides: Partial<PublicationEvidenceSnapshot> = {}): PublicationEvidenceSnapshot {
  const observedAt = new Date().toISOString();
  return {
    snapshotId, candidateId: candidate.candidateId, pullRequestOperationId: 'published-pr-candidate-delivery-1',
    repositoryId: candidate.repositoryId, issueId: candidate.issueId, baseBranch: 'main',
    pullRequestNumber: 23, headSha: candidate.candidateSha, baseSha: 'b'.repeat(40),
    policyVersion: candidate.policyVersion, observedAt, sourceIdentity: 'github-api:installation-1',
    sourceCursor: snapshotId, complete: true, prState: 'merged', mergeCommitSha: 'd'.repeat(40),
    mergeParentShas: [candidate.candidateSha, 'b'.repeat(40)],
    checks: [{ checkName: 'ci', producer: 'github-actions', workflowIdentity: '.github/workflows/ci.yml',
      targetSha: candidate.candidateSha, conclusion: 'success', runId: 'run-1',
      syntheticMergeParents: null, observedAt }],
    reviews: [{ reviewId: 'review-1', reviewerIdentity: 'human:reviewer-1', state: 'approved',
      commitSha: candidate.candidateSha, submittedAt: observedAt }],
    ...overrides,
  };
}

function verifyInput(state: ReturnType<typeof setup>, snapshotId: string, verificationId: string) {
  const job = state.fixture.jobs.get('job-1');
  assert.ok(job);
  return {
    verificationId, candidateId: state.candidate.candidateId, snapshotId,
    expectedJobVersion: job.rowVersion, currentBaseSha: 'b'.repeat(40), policyVersion: 'policy-1',
    requiredChecks: [{ checkName: 'ci', producer: 'github-actions',
      workflowIdentity: '.github/workflows/ci.yml', allowNeutralOrSkipped: false }],
    authorizedReviewers: ['human:reviewer-1'], observedNow: new Date().toISOString(),
    maximumEvidenceAgeMs: 60_000, writerGeneration: 1,
  };
}

test('completes delivery only after a fresh merged snapshot verifies exact candidate, base and merge parents', () => {
  const state = setup();
  try {
    const saved = state.evidence.record(evidence(state.candidate, 'delivery-snapshot-1'), 1);
    const result = state.store.verify(verifyInput(state, saved.snapshotId, 'delivery-verification-1'));
    assert.equal(result.status, 'complete');
    assert.equal(result.mergeCommitSha, 'd'.repeat(40));
    assert.deepEqual(result.checksExecuted, ['ci']);
    assert.equal(state.store.latest('job-1')?.verificationId, 'delivery-verification-1');
    assert.throws(
      () => state.fixture.database.prepare('UPDATE delivery_verifications SET status = ? WHERE verification_id = ?')
        .run('blocked', result.verificationId),
      /delivery verifications are immutable/,
    );
  } finally {
    state.fixture.close();
  }
});

test('records bypassed merges as blocked and rejects stale snapshots', () => {
  const state = setup();
  try {
    const bypassed = state.evidence.record(evidence(state.candidate, 'delivery-snapshot-1', {
      mergeParentShas: [state.candidate.candidateSha, 'e'.repeat(40)],
    }), 1);
    const blocked = state.store.verify(verifyInput(state, bypassed.snapshotId, 'delivery-verification-1'));
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.reasons.includes('merge_head_or_parents_mismatch'));

    const next = state.evidence.record(evidence(state.candidate, 'delivery-snapshot-2'), 1);
    const stale = state.store.verify(verifyInput(state, bypassed.snapshotId, 'delivery-verification-2'));
    assert.equal(stale.status, 'blocked');
    assert.ok(stale.reasons.includes('provider_snapshot_not_latest'));
    assert.equal(state.evidence.latest(next.candidateId)?.snapshotId, next.snapshotId);
  } finally {
    state.fixture.close();
  }
});
