import assert from 'node:assert/strict';
import test from 'node:test';
import { EffectStore } from './effects.js';
import { StateError } from './state-common.js';
import { StateContext } from './state-common.js';
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
