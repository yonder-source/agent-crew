import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateStore } from './candidates.js';
import { PublicationEvidenceStore, type PublicationEvidenceReader, type PublicationEvidenceSnapshot } from './publication-evidence.js';
import { RepairStore } from './repairs.js';
import { recordConfirmedPublication } from '../../tests/fixtures/publication-test-support.js';
import { StateError } from '../state/state-common.js';
import { createJob, createStateFixture } from '../../tests/fixtures/state-fixture.js';

function setup(authorized = true) {
  const fixture = createStateFixture();
  const job = createJob(fixture.jobs);
  const original = fixture.executions.reserve({
    executionId: 'execution-original', jobId: job.jobId, expectedJobVersion: job.rowVersion, writerGeneration: 1,
  });
  fixture.executions.transition({
    executionId: original.executionId, expectedVersion: original.rowVersion,
    writerGeneration: 1, lifecycle: 'terminal', terminalOutcome: 'candidate_submitted',
  });
  fixture.database.prepare(`
    INSERT INTO candidate_submissions (
      candidate_id, job_id, execution_id, ownership_generation, repository_id, issue_id,
      scope_revision_id, policy_version, source_bundle_id, base_sha, candidate_sha,
      reported_validation_json, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('candidate-repair-1', job.jobId, original.executionId, 1, job.repositoryId, job.issueId,
    job.scopeRevisionId, 'policy-1', 'bundle-1', 'a'.repeat(40), 'c'.repeat(40), '[]', fixture.state.now().toISOString());
  const candidates = new CandidateStore(fixture.state);
  const candidate = candidates.get('candidate-repair-1');
  assert.ok(candidate);
  const pullRequestOperationId = recordConfirmedPublication(fixture, candidate);
  const evidence = new PublicationEvidenceStore(fixture.state, candidates, fixture.effects);
  const observedAt = fixture.state.now().toISOString();
  const snapshot: PublicationEvidenceSnapshot = {
    snapshotId: 'repair-snapshot-1', candidateId: candidate.candidateId, pullRequestOperationId,
    repositoryId: candidate.repositoryId, issueId: candidate.issueId, baseBranch: 'main',
    pullRequestNumber: 17, headSha: candidate.candidateSha, baseSha: 'b'.repeat(40),
    policyVersion: candidate.policyVersion, observedAt, sourceIdentity: 'github-api:1',
    sourceCursor: 'cursor-1', complete: true, prState: 'open', mergeCommitSha: null, mergeParentShas: null,
    checks: [{ checkName: 'ci', producer: 'github-actions', workflowIdentity: null,
      targetSha: candidate.candidateSha, conclusion: 'failure', runId: 'run-1',
      syntheticMergeParents: null, observedAt }],
    reviews: [{
      reviewId: 'review-1', reviewerIdentity: 'human:reviewer-1', state: 'changes_requested',
      commitSha: candidate.candidateSha, submittedAt: observedAt, body: 'Please handle the reported failure.',
      feedback: [{ commentId: 'comment-1', path: 'src/example.ts', line: 12, body: 'This branch needs a guard.' }],
    }],
  };
  evidence.record(snapshot, 1);
  let reads = 0;
  const reader: PublicationEvidenceReader = { readFresh: async (request) => {
    assert.equal(fixture.database.inTransaction, false);
    assert.equal(request.purpose, 'repair');
    reads += 1;
    return { ...snapshot, snapshotId: request.snapshotId, observedAt: fixture.state.now().toISOString() };
  } };
  const store = new RepairStore(fixture.state, candidates, evidence, fixture.executions, {
    isAuthorized: () => authorized,
  }, reader);
  return { fixture, candidate, evidence, store, reader, snapshot, reads: () => reads };
}

function input(state: ReturnType<typeof setup>, overrides: Partial<Parameters<RepairStore['reserve']>[0]> = {}) {
  const job = state.fixture.jobs.get('job-1');
  assert.ok(job);
  return {
    reservationId: 'repair-reservation-1', candidateId: state.candidate.candidateId,
    executionId: 'execution-repair-1',
    expectedJobVersion: job.rowVersion, currentBaseSha: 'b'.repeat(40), policyVersion: 'policy-1',
    requiredChecks: [{ checkName: 'ci', producer: 'github-actions', workflowIdentity: null, allowNeutralOrSkipped: false }],
    authorizedReviewers: [], maximumEvidenceAgeMs: 120_000,
    writerGeneration: 1, ...overrides,
  };
}

test('atomically reserves one repair execution and deduplicates retries across the same reservation', async () => {
  const state = setup();
  try {
    const request = input(state, { authorizedReviewers: ['human:reviewer-1'] });
    const reserved = await state.store.reserve(request);
    assert.equal(reserved.cycleNumber, 1);
    assert.equal(reserved.executionId, 'execution-repair-1');
    assert.deepEqual(reserved.actionableFeedback, [
      { kind: 'failed_check', checkName: 'ci', runId: 'run-1' },
      {
        kind: 'changes_requested', reviewId: 'review-1', reviewerIdentity: 'human:reviewer-1',
        body: 'Please handle the reported failure.',
        comments: [{ commentId: 'comment-1', path: 'src/example.ts', line: 12, body: 'This branch needs a guard.' }],
      },
    ]);
    assert.deepEqual(await state.store.reserve(request), reserved);
    assert.equal(state.reads(), 1);
    assert.notEqual(reserved.evidenceSnapshotId, 'repair-snapshot-1');
    assert.deepEqual(state.store.getAllowance('job-1'), { allowance: 1, usedCount: 1, rowVersion: 2 });
  } finally {
    state.fixture.close();
  }
});

test('blocks non-actionable or exhausted repairs and requires an authorized allowance extension', async () => {
  const state = setup();
  try {
    const first = await state.store.reserve(input(state));
    const execution = state.fixture.executions.get(first.executionId);
    assert.ok(execution);
    state.fixture.executions.transition({
      executionId: execution.executionId, expectedVersion: execution.rowVersion,
      writerGeneration: 1, lifecycle: 'terminal', terminalOutcome: 'repair_finished',
    });
    const afterRepair = state.fixture.jobs.get('job-1');
    assert.ok(afterRepair);
    await assert.rejects(
      () => state.store.reserve(input(state, {
        reservationId: 'repair-reservation-2', executionId: 'execution-repair-2',
        expectedJobVersion: afterRepair.rowVersion,
      })),
      (error: unknown) => error instanceof StateError && error.code === 'REPAIR_ALLOWANCE_EXHAUSTED',
    );
    assert.equal(state.fixture.executions.get('execution-repair-2'), undefined);
    const allowance = state.store.extendAllowance({
      extensionId: 'extension-1', jobId: 'job-1', addedAttempts: 1,
      approverIdentity: 'human:reviewer-1', authorityId: 'repair-admin', decisionReceipt: 'decision-1',
      expectedJobVersion: afterRepair.rowVersion, writerGeneration: 1,
    });
    assert.equal(allowance, 2);
    assert.throws(
      () => state.fixture.database.prepare('UPDATE repair_allowance_extensions SET added_attempts = 9 WHERE extension_id = ?').run('extension-1'),
      /repair allowance extensions are immutable/,
    );
    const currentJob = state.fixture.jobs.get('job-1');
    assert.ok(currentJob);
    const second = await state.store.reserve(input(state, {
      reservationId: 'repair-reservation-2', executionId: 'execution-repair-2',
      expectedJobVersion: currentJob.rowVersion,
    }));
    assert.equal(second.cycleNumber, 2);
    assert.deepEqual(state.store.getAllowance('job-1'), { allowance: 2, usedCount: 2, rowVersion: 4 });
  } finally {
    state.fixture.close();
  }
});

test('rejects unavailable fresh evidence and unauthorized extension as repair authority', async () => {
  const state = setup(false);
  try {
    const currentJob = state.fixture.jobs.get('job-1');
    assert.ok(currentJob);
    state.reader.readFresh = async () => { throw new Error('GitHub unavailable'); };
    await assert.rejects(
      () => state.store.reserve(input(state, {
        expectedJobVersion: currentJob.rowVersion,
      })),
      (error: unknown) => error instanceof StateError && error.code === 'PUBLICATION_REFRESH_UNAVAILABLE',
    );
    assert.throws(
      () => state.store.extendAllowance({
        extensionId: 'extension-unauthorized', jobId: 'job-1', addedAttempts: 2,
        approverIdentity: 'human:guest', authorityId: 'untrusted', decisionReceipt: 'nope',
        expectedJobVersion: currentJob.rowVersion, writerGeneration: 1,
      }),
      (error: unknown) => error instanceof StateError && error.code === 'REPAIR_EXTENSION_UNAUTHORIZED',
    );
  } finally {
    state.fixture.close();
  }
});

for (const changed of ['merged', 'checks_passed', 'checks_pending'] as const) {
  test(`fresh ${changed} state prevents repair despite a cached failed check`, async () => {
    const state = setup();
    if (changed === 'merged') state.snapshot.prState = 'merged';
    else {
      const check = state.snapshot.checks[0];
      assert.ok(check);
      check.conclusion = changed === 'checks_passed' ? 'success' : 'pending';
    }
    try {
      await assert.rejects(() => state.store.reserve(input(state)),
        (error: unknown) => error instanceof StateError && error.code === 'REPAIR_TRIGGER_NOT_ACTIONABLE');
      assert.equal(state.reads(), 1);
      assert.equal(state.fixture.executions.get('execution-repair-1'), undefined);
      assert.equal(state.store.getAllowance('job-1'), undefined);
    } finally { state.fixture.close(); }
  });
}

test('repair admission rejects a cached observation returned for a new decision read', async () => {
  const state = setup();
  state.reader.readFresh = async () => state.snapshot;
  try {
    await assert.rejects(() => state.store.reserve(input(state)),
      (error: unknown) => error instanceof StateError && error.code === 'PUBLICATION_REFRESH_MISMATCH');
    assert.equal(state.fixture.executions.get('execution-repair-1'), undefined);
    assert.equal(state.store.getAllowance('job-1'), undefined);
  } finally { state.fixture.close(); }
});

test('concurrent retries share one repair execution and allowance reservation', async () => {
  const state = setup();
  try {
    const request = input(state);
    const [first, duplicate] = await Promise.all([state.store.reserve(request), state.store.reserve(request)]);
    assert.deepEqual(first, duplicate);
    assert.equal(state.store.getAllowance('job-1')?.usedCount, 1);
    const saved = state.fixture.database.prepare('SELECT COUNT(*) AS count FROM repair_reservations').get() as { count: number };
    assert.equal(saved.count, 1);
  } finally { state.fixture.close(); }
});
