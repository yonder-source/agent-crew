import assert from 'node:assert/strict';
import test from 'node:test';
import type { BeginEffectInput } from './effect-model.js';
import { EffectStore } from './effects.js';
import { StateError } from './state-common.js';
import { StateContext } from './state-common.js';
import { createJob, createStateFixture } from './state-fixture.js';

function beginInput(jobId: string): BeginEffectInput {
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

test('deduplicates identical operation identities and audits changed arguments', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const effects = new EffectStore(new StateContext(fixture.database));
    const initial = effects.begin(beginInput(job.jobId));
    assert.equal(initial.duplicate, false);
    assert.equal(initial.view.operation.status, 'pending');
    assert.equal(initial.view.operation.argumentFingerprint.length, 64);
    assert.equal(initial.view.authorization.callerIdentity, 'human:123');

    const duplicateInput = beginInput(job.jobId);
    duplicateInput.arguments = { title: 'Accepted title', body: 'accepted text' };
    const duplicate = effects.begin(duplicateInput);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.view.operation.operationId, initial.view.operation.operationId);

    const changed = beginInput(job.jobId);
    changed.arguments = { title: 'Changed title', body: 'accepted text' };
    assert.throws(() => effects.begin(changed), (error: unknown) => (
      error instanceof StateError && error.code === 'OPERATION_ID_CONFLICT'
    ));
    assert.equal(effects.listAudit('operation-1').at(-1)?.eventType, 'operation_identity_conflict');
    assert.deepEqual(
      Object.fromEntries(effects.listSteps('operation-1').map((step) => [step.stepKey, step.dependsOn])),
      { readback: ['write'], write: [] },
    );
    assert.throws(() => fixture.database.prepare(
      'UPDATE effect_authorization_evidence SET caller_identity = ? WHERE operation_id = ?',
    ).run('human:changed', 'operation-1'), /immutable/);
  } finally {
    fixture.close();
  }
});

test('blocks a new matching operation until it explicitly replaces an unknown one', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const effects = new EffectStore(new StateContext(fixture.database));
    effects.begin(beginInput(job.jobId));
    assert.equal(effects.claimStepStart('operation-1', 'step-write', 1), true);
    fixture.effectResults.recordResult({
      operationId: 'operation-1',
      stepId: 'step-write',
      expectedStepVersion: 2,
      status: 'unknown',
      result: { delivery: 'response_lost' },
      resultGeneration: 1,
      resultSource: 'provider_receipt',
      writerGeneration: 1,
    });

    const replacement = beginInput(job.jobId);
    replacement.operationId = 'operation-2';
    replacement.expectedJobVersion = 4;
    replacement.steps = replacement.steps.map((step) => ({
      ...step,
      stepId: `${step.stepId}-replacement`,
    }));
    assert.throws(() => effects.begin(replacement), (error: unknown) => (
      error instanceof StateError && error.code === 'UNKNOWN_EFFECT_BLOCKS_DUPLICATE'
    ));
    assert.equal(effects.listAudit('operation-1').at(-1)?.eventType, 'unknown_effect_duplicate_blocked');

    replacement.replacementForOperationId = 'operation-1';
    replacement.callerIdentity = 'human:456';
    replacement.grant = { action: 'issue.write', replacementApproved: true };
    const accepted = effects.begin(replacement);
    assert.equal(accepted.view.operation.replacementForOperationId, 'operation-1');
    assert.equal(accepted.view.authorization.callerIdentity, 'human:456');
  } finally {
    fixture.close();
  }
});
