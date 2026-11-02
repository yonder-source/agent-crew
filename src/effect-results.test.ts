import assert from 'node:assert/strict';
import test from 'node:test';
import { createJob, createStateFixture } from './state-fixture.js';

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
    ],
    writerGeneration: 1,
  };
}

test('blocks dependent steps until success and records effect results separately', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    assert.equal(fixture.effects.canStartStep('operation-1', 'step-write', 1), true);
    assert.equal(fixture.effects.canStartStep('operation-1', 'step-readback', 1), false);

    const result = fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 1,
      status: 'confirmed_success',
      result: { providerReceiptId: 'receipt-1' },
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      writerGeneration: 1,
    });
    assert.equal(result.historyOnly, false);
    assert.equal(result.step.status, 'confirmed_success');
    assert.equal(fixture.effects.canStartStep('operation-1', 'step-readback', 1), true);
    assert.equal(fixture.effects.get('operation-1')?.operation.status, 'pending');
    assert.equal(fixture.effects.listAudit('operation-1').at(-1)?.eventType, 'effect_result_recorded');
  } finally {
    fixture.close();
  }
});

test('recovers unknown results and keeps an old receipt as history only', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    const recoveringAt = new Date().toISOString();
    fixture.database.prepare(`
      UPDATE controller_writer SET generation = 2, status = 'recovering', heartbeat_at = ?, updated_at = ?
      WHERE singleton_id = 1
    `).run(recoveringAt, recoveringAt);
    fixture.effectResults.recoverPendingSteps(2);

    const recovered = fixture.effects.get('operation-1');
    assert.equal(recovered?.operation.status, 'unknown');
    assert.equal(recovered?.steps[0]?.status, 'unknown');
    assert.equal(recovered?.steps[0]?.resultSource, 'recovery');
    fixture.database.prepare(`
      UPDATE controller_writer SET status = 'healthy', heartbeat_at = ?, updated_at = ?
      WHERE singleton_id = 1
    `).run(recoveringAt, recoveringAt);
    assert.equal(fixture.effects.canStartStep('operation-1', 'step-readback', 2), false);
    const staleReceipt = fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 2,
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
      expectedStepVersion: 2,
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
    assert.equal(fixture.effects.get('operation-1')?.operation.status, 'unknown');
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
