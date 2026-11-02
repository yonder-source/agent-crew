import assert from 'node:assert/strict';
import test from 'node:test';
import { createEffectInput, createJob, createStateFixture, type StateFixture } from './state-fixture.js';
import { StateError } from './state-common.js';
import { WriterCoordinator } from './writer.js';

function startAndObserve(fixture: StateFixture, operationId: string, status: 'unknown' | 'confirmed_success') {
  const stepId = `${operationId}-write`;
  assert.equal(fixture.effects.claimStepStart(operationId, stepId, 1), true);
  const step = fixture.effects.get(operationId)?.steps.find((step) => step.stepId === stepId);
  assert.ok(step);
  return fixture.effectResults.recordResult({
    operationId, stepId, expectedStepVersion: step.rowVersion, status,
    result: { providerRequestId: operationId }, resultGeneration: 1,
    resultSource: 'provider_receipt', writerGeneration: 1,
  });
}

test('a successful replacement clears the barrier and survives writer recovery', async () => {
  const fixture = createStateFixture();
  let writer: WriterCoordinator | undefined;
  try {
    createJob(fixture.jobs);
    fixture.effects.begin(createEffectInput(fixture, 'original'));
    startAndObserve(fixture, 'original', 'unknown');
    fixture.effects.begin(createEffectInput(fixture, 'replacement', { replacementForOperationId: 'original' }));
    startAndObserve(fixture, 'replacement', 'confirmed_success');
    writer = await WriterCoordinator.start(fixture.database, (generation) => {
      fixture.effectResults.recoverPendingSteps(generation);
    });
    fixture.effects.begin(createEffectInput(fixture, 'later', { writerGeneration: writer.generation }));
    assert.equal(fixture.effects.claimStepStart('later', 'later-write', writer.generation), true);
    assert.equal(fixture.effects.get('original')?.operation.status, 'unknown');
    assert.equal(fixture.effects.get('original')?.replacementOperationId, 'replacement');
    assert.equal(fixture.effects.listAudit('original').at(-1)?.eventType, 'operation_replaced');
  } finally {
    writer?.stop();
    fixture.close();
  }
});

test('unknown replacements form one chain and retire all predecessor starts', () => {
  const fixture = createStateFixture();
  try {
    createJob(fixture.jobs);
    const original = createEffectInput(fixture, 'original');
    original.steps.push({ stepId: 'remaining', stepKey: 'remaining', target: { action: 'other' } });
    fixture.effects.begin(original);
    startAndObserve(fixture, 'original', 'unknown');
    fixture.effects.begin(createEffectInput(fixture, 'replacement', { replacementForOperationId: 'original' }));
    assert.equal(fixture.effects.claimStepStart('original', 'remaining', 1), false);
    assert.equal(fixture.effects.listAudit('original').at(-1)?.eventType, 'effect_step_start_rejected_replaced_operation');
    assert.throws(() => fixture.effects.begin(createEffectInput(fixture, 'fork', {
      replacementForOperationId: 'original',
    })), (error: unknown) => error instanceof StateError && error.code === 'UNKNOWN_EFFECT_BLOCKS_DUPLICATE');
    startAndObserve(fixture, 'replacement', 'unknown');
    assert.throws(() => fixture.effects.begin(createEffectInput(fixture, 'unlinked')), (error: unknown) => (
      error instanceof StateError && error.code === 'UNKNOWN_EFFECT_BLOCKS_DUPLICATE'
    ));
    fixture.effects.begin(createEffectInput(fixture, 'successor', { replacementForOperationId: 'replacement' }));
    startAndObserve(fixture, 'successor', 'confirmed_success');
    fixture.effects.begin(createEffectInput(fixture, 'later'));
    assert.equal(fixture.effects.claimStepStart('later', 'later-write', 1), true);
    assert.equal(fixture.effects.get('original')?.replacementOperationId, 'replacement');
    assert.equal(fixture.effects.get('replacement')?.replacementOperationId, 'successor');
    assert.equal(fixture.effects.get('replacement')?.operation.status, 'unknown');
    assert.equal(fixture.effects.get('fork'), undefined);
  } finally {
    fixture.close();
  }
});
