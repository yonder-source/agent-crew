import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateStore } from './candidates.js';
import { DeliveryStore } from './delivery.js';
import { PublicationEvidenceStore, type PublicationEvidenceReader, type PublicationEvidenceSnapshot } from './publication-evidence.js';
import { recordConfirmedPublication } from '../../tests/fixtures/publication-test-support.js';
import { StateError } from '../state/state-common.js';
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
  let remote = providerSnapshot(candidate, 'initial-remote');
  let reads = 0;
  const reader: PublicationEvidenceReader = { readFresh: async (request) => {
    assert.equal(fixture.database.inTransaction, false);
    assert.equal(request.purpose, 'delivery');
    reads += 1;
    return { ...remote, snapshotId: request.snapshotId, observedAt: fixture.state.now().toISOString() };
  } };
  const store = new DeliveryStore(fixture.state, candidates, evidence, reader);
  return { fixture, candidate, evidence, store, reader, reads: () => reads,
    setRemote: (snapshot: PublicationEvidenceSnapshot) => { remote = snapshot; } };
}

function providerSnapshot(candidate: NonNullable<ReturnType<CandidateStore['get']>>, snapshotId: string,
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

function verifyInput(state: ReturnType<typeof setup>, verificationId: string) {
  const job = state.fixture.jobs.get('job-1');
  assert.ok(job);
  return {
    verificationId, candidateId: state.candidate.candidateId,
    expectedJobVersion: job.rowVersion, currentBaseSha: 'b'.repeat(40), policyVersion: 'policy-1',
    requiredChecks: [{ checkName: 'ci', producer: 'github-actions',
      workflowIdentity: '.github/workflows/ci.yml', allowNeutralOrSkipped: false }],
    authorizedReviewers: ['human:reviewer-1'],
    maximumEvidenceAgeMs: 60_000, writerGeneration: 1,
  };
}

test('completes delivery only after a fresh merged snapshot verifies exact candidate, base and merge parents', async () => {
  const state = setup();
  try {
    const cached = state.evidence.record(providerSnapshot(state.candidate, 'delivery-snapshot-1'), 1);
    const request = verifyInput(state, 'delivery-verification-1');
    const result = await state.store.verify(request);
    assert.equal(result.status, 'complete');
    assert.equal(result.mergeCommitSha, 'd'.repeat(40));
    assert.deepEqual(result.checksExecuted, ['ci']);
    assert.notEqual(result.snapshotId, cached.snapshotId);
    assert.deepEqual(await state.store.verify(request), result);
    assert.equal(state.reads(), 1);
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

test('records bypassed merges as blocked and reads again for each new delivery decision', async () => {
  const state = setup();
  try {
    state.setRemote(providerSnapshot(state.candidate, 'remote-bypassed', {
      mergeParentShas: [state.candidate.candidateSha, 'e'.repeat(40)],
    }));
    const blocked = await state.store.verify(verifyInput(state, 'delivery-verification-1'));
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.reasons.includes('merge_head_or_parents_mismatch'));

    state.setRemote(providerSnapshot(state.candidate, 'remote-valid'));
    const next = await state.store.verify(verifyInput(state, 'delivery-verification-2'));
    assert.equal(next.status, 'complete');
    assert.notEqual(next.snapshotId, blocked.snapshotId);
    assert.equal(state.reads(), 2);
    assert.equal(state.evidence.latest(state.candidate.candidateId)?.snapshotId, next.snapshotId);
  } finally {
    state.fixture.close();
  }
});

test('an approval cannot override another authorized reviewer\'s unresolved change request after merge', async () => {
  const state = setup();
  try {
    const snapshot = providerSnapshot(state.candidate, 'merged-with-changes-requested');
    snapshot.reviews.push({ reviewId: 'review-2', reviewerIdentity: 'human:reviewer-2',
      state: 'changes_requested', commitSha: state.candidate.candidateSha, submittedAt: snapshot.observedAt });
    state.setRemote(snapshot);
    const request = verifyInput(state, 'blocked-review-verification');
    request.authorizedReviewers.push('human:reviewer-2');
    const result = await state.store.verify(request);
    assert.equal(result.status, 'blocked');
    assert.ok(result.reasons.includes('authorized_changes_requested:human:reviewer-2'));
  } finally { state.fixture.close(); }
});

for (const changed of ['dismissed', 'pending', 'head_changed'] as const) {
  test(`fresh ${changed} evidence blocks delivery despite a successful cached snapshot`, async () => {
    const state = setup();
    state.evidence.record(providerSnapshot(state.candidate, 'cached-success'), 1);
    const remote = providerSnapshot(state.candidate, 'changed-remote');
    if (changed === 'dismissed') {
      const review = remote.reviews[0];
      assert.ok(review);
      review.state = 'dismissed';
    } else if (changed === 'pending') {
      const check = remote.checks[0];
      assert.ok(check);
      check.conclusion = 'pending';
    } else remote.headSha = 'f'.repeat(40);
    state.setRemote(remote);
    try {
      const result = await state.store.verify(verifyInput(state, 'freshly-blocked'));
      assert.equal(result.status, 'blocked');
      assert.notEqual(result.snapshotId, 'cached-success');
    } finally { state.fixture.close(); }
  });
}

test('delivery rejects unavailable or cached provider reads without falling back to saved success', async () => {
  const state = setup();
  const cached = state.evidence.record(providerSnapshot(state.candidate, 'cached-success'), 1);
  try {
    state.reader.readFresh = async () => { throw new Error('provider unavailable'); };
    await assert.rejects(() => state.store.verify(verifyInput(state, 'unavailable-read')),
      (error: unknown) => error instanceof StateError && error.code === 'PUBLICATION_REFRESH_UNAVAILABLE');
    state.reader.readFresh = async () => cached;
    await assert.rejects(() => state.store.verify(verifyInput(state, 'cached-read')),
      (error: unknown) => error instanceof StateError && error.code === 'PUBLICATION_REFRESH_MISMATCH');
    state.reader.readFresh = async (request) => ({ ...cached, snapshotId: request.snapshotId,
      observedAt: new Date(Date.now() - 60_000).toISOString() });
    await assert.rejects(() => state.store.verify(verifyInput(state, 'stale-read')),
      (error: unknown) => error instanceof StateError && error.code === 'PUBLICATION_REFRESH_MISMATCH');
    assert.equal(state.store.latest(state.candidate.jobId), undefined);
  } finally { state.fixture.close(); }
});

test('concurrent retries retain one delivery verification', async () => {
  const state = setup();
  try {
    const request = verifyInput(state, 'same-decision');
    const [first, duplicate] = await Promise.all([state.store.verify(request), state.store.verify(request)]);
    assert.deepEqual(first, duplicate);
    const saved = state.fixture.database.prepare('SELECT COUNT(*) AS count FROM delivery_verifications').get() as { count: number };
    assert.equal(saved.count, 1);
  } finally { state.fixture.close(); }
});
