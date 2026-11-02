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
    assert.equal(effects.claimStepStart('operation-2', 'step-write-replacement', 1), true);
  } finally {
    fixture.close();
  }
});

test('refuses to start an intent after its job scope revision changes', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    const effects = new EffectStore(new StateContext(fixture.database));
    effects.begin(beginInput(job.jobId));
    fixture.jobs.transition({
      jobId: job.jobId,
      expectedVersion: 2,
      writerGeneration: 1,
      scopeRevisionId: 'scope-2',
      eventType: 'scope_revision_changed',
    });

    assert.equal(effects.claimStepStart('operation-1', 'step-write', 1), false);
    assert.equal(effects.listAudit('operation-1').at(-1)?.eventType, 'effect_step_start_rejected_stale_scope');
  } finally {
    fixture.close();
  }
});

test('audits stale effect requests without changing their outcomes or steps', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    const before = fixture.effects.get('operation-1');
    fixture.database.prepare('UPDATE controller_writer SET generation = 2').run();
    assert.throws(() => fixture.effects.begin(beginInput(job.jobId)), (error: unknown) => (
      error instanceof StateError && error.code === 'STALE_GENERATION'
    ));
    assert.throws(() => fixture.effects.claimStepStart('operation-1', 'step-write', 1), (error: unknown) => (
      error instanceof StateError && error.code === 'STALE_GENERATION'
    ));
    assert.throws(() => fixture.effectResults.recordResult({
      operationId: 'operation-1', stepId: 'step-write', expectedStepVersion: 1,
      status: 'confirmed_success', result: { receiptId: 'late-receipt' }, resultGeneration: 1,
      resultSource: 'provider_receipt', writerGeneration: 1,
    }), (error: unknown) => error instanceof StateError && error.code === 'STALE_GENERATION');
    assert.throws(() => fixture.effectResults.retryStep({
      operationId: 'operation-1', stepId: 'step-write', expectedStepVersion: 1,
      safetyClassification: 'confirmed_not_applied', writerGeneration: 1,
    }), (error: unknown) => error instanceof StateError && error.code === 'STALE_GENERATION');
    const after = fixture.effects.get('operation-1');
    assert.deepEqual(after?.steps, before?.steps);
    assert.deepEqual(after?.authorization, before?.authorization);
    assert.equal(after?.operation.status, before?.operation.status);
    const rejections = fixture.effects.listAudit('operation-1').slice(-4);
    assert.deepEqual(rejections.map((event) => event.eventType), [
      'effect_intent_rejected_stale_generation', 'effect_start_rejected_stale_generation',
      'effect_result_rejected_stale_generation', 'effect_retry_rejected_stale_generation',
    ]);
    assert.equal(JSON.parse(rejections[1]?.payloadJson ?? '{}').stepId, 'step-write');
    assert.equal(JSON.parse(rejections[2]?.payloadJson ?? '{}').result.receiptId, 'late-receipt');
    assert.deepEqual(fixture.jobs.listEvents(job.jobId).slice(-4).map((event) => ({
      type: event.eventType,
      generation: event.writerGeneration,
    })), [
      { type: 'effect_intent_rejected_stale_generation', generation: 1 },
      { type: 'effect_start_rejected_stale_generation', generation: 1 },
      { type: 'effect_result_rejected_stale_generation', generation: 1 },
      { type: 'effect_retry_rejected_stale_generation', generation: 1 },
    ]);
  } finally {
    fixture.close();
  }
});

test('fails closed when the rejection audit cannot be committed atomically', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    const before = fixture.jobs.get(job.jobId);
    fixture.database.prepare('UPDATE controller_writer SET generation = 2').run();
    fixture.database.exec(`
      CREATE TRIGGER reject_stale_audit BEFORE INSERT ON effect_audit_events
      WHEN NEW.event_type = 'effect_start_rejected_stale_generation'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `);
    assert.throws(() => fixture.effects.claimStepStart('operation-1', 'step-write', 1), (error: unknown) => (
      error instanceof StateError && error.code === 'AUDIT_UNAVAILABLE'
    ));
    assert.deepEqual(fixture.jobs.get(job.jobId), before);
    assert.equal(fixture.effects.get('operation-1')?.steps.find((step) => step.stepId === 'step-write')?.attemptCount, 0);
  } finally {
    fixture.close();
  }
});

test('audits stale effect job versions and latches an expired writer unhealthy', () => {
  const fixture = createStateFixture();
  try {
    const job = createJob(fixture.jobs);
    fixture.effects.begin(beginInput(job.jobId));
    const newOperation = { ...beginInput(job.jobId), operationId: 'operation-2' };
    assert.throws(() => fixture.effects.begin(newOperation), (error: unknown) => (
      error instanceof StateError && error.code === 'STALE_ROW_VERSION'
    ));
    assert.equal(fixture.jobs.listEvents(job.jobId).at(-1)?.eventType, 'effect_intent_rejected_stale_row_version');
    const expiredAt = new Date(Date.now() - 16_000).toISOString();
    fixture.database.prepare('UPDATE controller_writer SET heartbeat_at = ?').run(expiredAt);
    assert.throws(() => fixture.effects.claimStepStart('operation-1', 'step-write', 1), (error: unknown) => (
      error instanceof StateError && error.code === 'WRITER_UNHEALTHY'
    ));
    assert.equal(fixture.jobs.listEvents(job.jobId).at(-1)?.eventType, 'effect_start_rejected_writer_unhealthy');
    assert.deepEqual(fixture.database.prepare('SELECT status FROM controller_writer').get(), { status: 'unhealthy' });
    assert.equal(fixture.effects.get('operation-2'), undefined);
    assert.equal(fixture.effects.get('operation-1')?.steps.find((step) => step.stepId === 'step-write')?.attemptCount, 0);
  } finally {
    fixture.close();
  }
});
