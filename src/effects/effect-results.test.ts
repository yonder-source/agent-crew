import assert from 'node:assert/strict';
import test from 'node:test';
import { createJob, createStateFixture } from '../../tests/fixtures/state-fixture.js';

function beginInput(jobId: string) {
  return {
    operationId: 'operation-1',
    jobId,
    operationKind: 'github_issue_update',
    arguments: { body: 'accepted text', title: 'Accepted title' },
    target: { issueId: 'issue-1', repositoryId: 'repo-1' },
    expectedJobVersion: 1,
    scopeRevisionId: 'scope-1',
    policyVersion: 'policy-7',
    callerIdentity: 'human:123',
    grant: { action: 'issue.write', repositoryId: 'repo-1', issueId: 'issue-1' },
    steps: [
      { stepId: 'step-write', stepKey: 'write', target: { fields: ['title', 'body'] } },
      { stepId: 'step-readback', stepKey: 'readback', target: { fields: ['title', 'body'] }, dependsOn: ['write'] },
      { stepId: 'step-audit', stepKey: 'audit', target: { action: 'record_receipt' } },
    ],
    writerGeneration: 1,
  };
}

test('blocks dependent steps until success and records effect results separately', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-write', 1), true);
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-write', 1), false);
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-readback', 1), false);

    const result = fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 2,
      status: 'confirmed_success',
      result: { providerReceiptId: 'receipt-1' },
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      writerGeneration: 1,
    });
    assert.equal(result.historyOnly, false);
    assert.equal(result.step.status, 'confirmed_success');
    assert.equal(fixture.effects.listAudit('operation-1').at(-1)?.eventType, 'effect_result_recorded');
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-readback', 1), true);
    assert.equal(fixture.effects.get('operation-1')?.operation.status, 'pending');
  } finally {
    fixture.close();
  }
});

test('requeues confirmed safe failures with the same step identity and preserved history', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-write', 1), true);
    fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 2,
      status: 'confirmed_failure',
      result: { providerCode: 'temporary_unavailable', applied: false },
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      writerGeneration: 1,
    });

    const queued = fixture.effectResults.retryStep({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 3,
      safetyClassification: 'confirmed_not_applied',
      writerGeneration: 1,
    });
    assert.equal(queued.status, 'pending');
    assert.equal(queued.attemptCount, 1);
    assert.equal(queued.resultJson, null);
    assert.equal(fixture.effects.get('operation-1')?.operation.status, 'pending');
    const retryEvent = fixture.effects.listAudit('operation-1').at(-1);
    assert.equal(retryEvent?.eventType, 'effect_retry_queued');
    assert.equal(JSON.parse(retryEvent?.payloadJson ?? '{}').previousResult.providerCode, 'temporary_unavailable');

    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-write', 1), true);
    const claimedAgain = fixture.effects.get('operation-1')?.steps.find((step) => step.stepId === 'step-write');
    assert.equal(claimedAgain?.attemptCount, 2);
  } finally {
    fixture.close();
  }
});

test('retains every receipt when reconciliation replaces an unknown observation', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    fixture.effects.claimStepStart('operation-1', 'step-write', 1);
    const unknown = fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 2,
      status: 'unknown',
      result: { providerRequestId: 'request-1', delivery: 'response_lost' },
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      writerGeneration: 1,
    });
    const reconciled = fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: unknown.step.rowVersion,
      status: 'confirmed_success',
      result: { readbackId: 'verification-1', applied: true },
      resultGeneration: 1,
      resultSource: 'reconciliation',
      writerGeneration: 1,
    });
    assert.equal(reconciled.historyOnly, false);
    const observations = fixture.effects.listAudit('operation-1')
      .filter((event) => event.eventType === 'effect_result_recorded')
      .map((event) => JSON.parse(event.payloadJson));
    assert.equal(observations.length, 2);
    assert.equal(observations[0].result.providerRequestId, 'request-1');
    assert.equal(observations[1].result.readbackId, 'verification-1');
    assert.deepEqual(observations[1].previousObservation, {
      status: 'unknown',
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      result: { providerRequestId: 'request-1', delivery: 'response_lost' },
      stepVersion: unknown.step.rowVersion,
    });
    assert.throws(() => fixture.database.prepare(
      'DELETE FROM effect_audit_events WHERE operation_id = ?',
    ).run('operation-1'), /append-only/);
  } finally {
    fixture.close();
  }
});

test('keeps an operation pending while a failed step blocks its dependent', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-write', 1), true);
    fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 2,
      status: 'confirmed_failure',
      result: { applied: false },
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      writerGeneration: 1,
    });

    assert.equal(fixture.effects.get('operation-1')?.operation.status, 'pending');
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-readback', 1), false);
  } finally {
    fixture.close();
  }
});

test('recovers unknown results and keeps an old receipt as history only', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-write', 1), true);
    const recoveringAt = new Date().toISOString();
    fixture.database.prepare(`
      UPDATE controller_writer SET generation = 2, status = 'recovering', heartbeat_at = ?, updated_at = ?
      WHERE singleton_id = 1
    `).run(recoveringAt, recoveringAt);
    fixture.effectResults.recoverPendingSteps(2);

    const recovered = fixture.effects.get('operation-1');
    assert.equal(recovered?.operation.status, 'unknown');
    assert.equal(recovered?.steps.find((step) => step.stepId === 'step-write')?.status, 'unknown');
    assert.equal(recovered?.steps.find((step) => step.stepId === 'step-readback')?.status, 'pending');
    assert.equal(recovered?.steps.find((step) => step.stepId === 'step-readback')?.resultSource, null);
    fixture.database.prepare(`
      UPDATE controller_writer SET status = 'healthy', heartbeat_at = ?, updated_at = ?
      WHERE singleton_id = 1
    `).run(recoveringAt, recoveringAt);
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-readback', 2), false);
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-audit', 2), true);
    fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-audit',
      expectedStepVersion: 2,
      status: 'confirmed_success',
      result: { auditReceipt: 'audit-1' },
      resultGeneration: 2,
      resultSource: 'provider_receipt',
      writerGeneration: 2,
    });
    const staleReceipt = fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 3,
      status: 'confirmed_success',
      result: { providerReceiptId: 'late-receipt' },
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      writerGeneration: 2,
    });
    assert.equal(staleReceipt.historyOnly, true);
    assert.equal(staleReceipt.step.status, 'unknown');
    assert.equal(fixture.effects.listAudit('operation-1').at(-1)?.eventType, 'stale_effect_observation');

    const reconciled = fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 3,
      status: 'confirmed_success',
      result: { checkedAt: recoveringAt, providerState: 'applied' },
      resultGeneration: 2,
      resultSource: 'reconciliation',
      writerGeneration: 2,
    });
    assert.equal(reconciled.historyOnly, false);
    assert.equal(
      fixture.effects.get('operation-1')?.steps.find((step) => step.stepId === 'step-write')?.status,
      'confirmed_success',
    );
    assert.equal(fixture.effects.get('operation-1')?.operation.status, 'pending');
    assert.equal(fixture.effects.claimStepStart('operation-1', 'step-readback', 2), true);
    fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-readback',
      expectedStepVersion: 2,
      status: 'confirmed_success',
      result: { verified: true },
      resultGeneration: 2,
      resultSource: 'reconciliation',
      writerGeneration: 2,
    });
    assert.equal(fixture.effects.get('operation-1')?.operation.status, 'confirmed_success');
  } finally {
    fixture.close();
  }
});
