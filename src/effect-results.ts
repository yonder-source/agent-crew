import { StateError } from './state-common.js';
import type { StateContext } from './state-common.js';
import { canonicalJson, outcomeFor } from './effect-model.js';
import type { EffectOutcome, EffectResultSource, EffectStep, RawOperation, RawStep } from './effect-model.js';
import type { EffectStore } from './effects.js';

export class EffectResultStore {
  constructor(private readonly state: StateContext, private readonly effects: EffectStore) {}

  recordResult(input: {
    operationId: string;
    stepId: string;
    expectedStepVersion: number;
    status: Exclude<EffectOutcome, 'pending'>;
    result: unknown;
    resultGeneration: number;
    resultSource: Exclude<EffectResultSource, 'recovery'>;
    writerGeneration: number;
  }): { step: EffectStep; historyOnly: boolean } {
    if (!Number.isSafeInteger(input.expectedStepVersion) || input.expectedStepVersion < 1) {
      throw new StateError('INVALID_INPUT', 'expectedStepVersion must be a positive integer');
    }
    if (!Number.isSafeInteger(input.writerGeneration) || input.writerGeneration < 1) {
      throw new StateError('INVALID_INPUT', 'writerGeneration must be a positive integer');
    }
    if (!Number.isSafeInteger(input.resultGeneration) || input.resultGeneration < 1) {
      throw new StateError('INVALID_INPUT', 'resultGeneration must be a positive integer');
    }
    const rawOperation = this.state.database.prepare(
      'SELECT * FROM effect_operations WHERE operation_id = ?',
    ).get(input.operationId) as RawOperation | undefined;
    if (!rawOperation) throw new StateError('OPERATION_NOT_FOUND', 'Effect operation does not exist');
    const occurredAt = this.state.now().toISOString();
    const resultJson = canonicalJson(input.result);
    const mutation = this.state.runWithStaleAudit(
      rawOperation.job_id,
      input.writerGeneration,
      occurredAt,
      'effect_result',
      () => {
        this.state.assertWriter(input.writerGeneration, occurredAt);
        const step = this.state.database.prepare(
          'SELECT * FROM effect_steps WHERE operation_id = ? AND step_id = ?',
        ).get(input.operationId, input.stepId) as RawStep | undefined;
        if (!step) throw new StateError('STEP_NOT_FOUND', 'Effect step does not exist');
        if (step.row_version !== input.expectedStepVersion) {
          this.appendAudit(input.operationId, 'effect_result_rejected_stale_version', {
            stepId: input.stepId,
            expectedVersion: input.expectedStepVersion,
            actualVersion: step.row_version,
            observedStatus: input.status,
            resultGeneration: input.resultGeneration,
            resultSource: input.resultSource,
            result: JSON.parse(resultJson) as unknown,
          }, input.writerGeneration, occurredAt);
          return { historyOnly: true };
        }
        if (
          input.resultGeneration !== input.writerGeneration
          || (input.resultSource === 'provider_receipt' && input.resultGeneration !== rawOperation.writer_generation)
        ) {
          this.appendAudit(input.operationId, 'stale_effect_observation', {
            stepId: input.stepId,
            observedStatus: input.status,
            resultGeneration: input.resultGeneration,
            result: JSON.parse(resultJson) as unknown,
          }, input.writerGeneration, occurredAt);
          return { historyOnly: true };
        }
        if (step.status === 'confirmed_success' || step.status === 'confirmed_failure') {
          this.appendAudit(input.operationId, 'effect_result_observed_after_confirmation', {
            stepId: input.stepId,
            observedStatus: input.status,
            resultGeneration: input.resultGeneration,
            result: JSON.parse(resultJson) as unknown,
          }, input.writerGeneration, occurredAt);
          return { historyOnly: true };
        }

        this.state.database.prepare(`
          UPDATE effect_steps SET status = ?, result_json = ?, result_generation = ?,
            result_source = ?, row_version = row_version + 1, updated_at = ?
          WHERE step_id = ? AND row_version = ?
        `).run(
          input.status,
          resultJson,
          input.resultGeneration,
          input.resultSource,
          occurredAt,
          input.stepId,
          input.expectedStepVersion,
        );
        const stepOutcomes = this.state.database.prepare(
          'SELECT status FROM effect_steps WHERE operation_id = ?',
        ).all(input.operationId) as Array<{ status: EffectOutcome }>;
        const nextStatus = outcomeFor(stepOutcomes.map((row) => row.status));
        this.state.database.prepare(`
          UPDATE effect_operations SET status = ?, row_version = row_version + 1, updated_at = ?
          WHERE operation_id = ?
        `).run(nextStatus, occurredAt, input.operationId);
        this.appendAudit(input.operationId, 'effect_result_recorded', {
          stepId: input.stepId,
          status: input.status,
          resultGeneration: input.resultGeneration,
          resultSource: input.resultSource,
        }, input.writerGeneration, occurredAt);
        const job = this.state.getJobOrThrow(rawOperation.job_id);
        const nextJobVersion = job.row_version + 1;
        const nextSequence = job.event_sequence + 1;
        this.state.bumpJob(job, nextJobVersion, nextSequence, occurredAt);
        this.state.insertEvent({
          jobId: job.job_id,
          sequence: nextSequence,
          rowVersion: nextJobVersion,
          eventType: 'effect_result_recorded',
          payload: { operationId: input.operationId, stepId: input.stepId, status: input.status },
          writerGeneration: input.writerGeneration,
          occurredAt,
        });
        return { historyOnly: false };
      },
    );
    const updatedStep = this.effects.get(input.operationId)?.steps.find((step) => step.stepId === input.stepId);
    if (!updatedStep) throw new StateError('STEP_NOT_FOUND', 'Effect step does not exist');
    return { step: updatedStep, historyOnly: mutation.historyOnly };
  }

  recoverPendingSteps(generation: number): void {
    const occurredAt = this.state.now().toISOString();
    this.state.database.transaction(() => {
      const writer = this.state.database.prepare(
        'SELECT generation, status FROM controller_writer WHERE singleton_id = 1',
      ).get() as { generation: number; status: string };
      if (writer.generation !== generation || writer.status !== 'recovering') {
        throw new StateError('STALE_GENERATION', 'Effect recovery requires the current recovering writer');
      }
      const pending = this.state.database.prepare(`
        SELECT step.step_id, step.operation_id, operation.job_id, operation.writer_generation
        FROM effect_steps step JOIN effect_operations operation USING (operation_id)
        WHERE step.status = 'pending' AND operation.writer_generation < ?
        ORDER BY operation.operation_id, step.step_key
      `).all(generation) as Array<{
        step_id: string;
        operation_id: string;
        job_id: string;
        writer_generation: number;
      }>;
      const byOperation = new Map<string, typeof pending>();
      for (const row of pending) byOperation.set(row.operation_id, [...(byOperation.get(row.operation_id) ?? []), row]);
      for (const [operationId, rows] of byOperation) {
        for (const row of rows) {
          this.state.database.prepare(`
            UPDATE effect_steps SET status = 'unknown',
              result_json = ?, result_generation = ?, result_source = 'recovery',
              row_version = row_version + 1, updated_at = ?
            WHERE step_id = ? AND status = 'pending'
          `).run(
            canonicalJson({ classification: 'unresolved_after_process_replacement' }),
            generation,
            occurredAt,
            row.step_id,
          );
          this.appendAudit(operationId, 'step_outcome_unknown_after_replacement', {
            stepId: row.step_id,
            previousWriterGeneration: row.writer_generation,
            recoveryGeneration: generation,
          }, generation, occurredAt);
        }
        const statuses = this.state.database.prepare(
          'SELECT status FROM effect_steps WHERE operation_id = ?',
        ).all(operationId) as Array<{ status: EffectOutcome }>;
        this.state.database.prepare(`
          UPDATE effect_operations SET status = ?, row_version = row_version + 1, updated_at = ?
          WHERE operation_id = ?
        `).run(outcomeFor(statuses.map((row) => row.status)), occurredAt, operationId);
        const job = this.state.getJobOrThrow(rows[0]?.job_id ?? '');
        const nextJobVersion = job.row_version + 1;
        const nextSequence = job.event_sequence + 1;
        this.state.bumpJob(job, nextJobVersion, nextSequence, occurredAt);
        this.state.insertEvent({
          jobId: job.job_id,
          sequence: nextSequence,
          rowVersion: nextJobVersion,
          eventType: 'effect_recovery_required',
          payload: { operationId, unknownStepIds: rows.map((row) => row.step_id) },
          writerGeneration: generation,
          occurredAt,
        });
      }
    }).immediate();
  }

  private appendAudit(
    operationId: string,
    eventType: string,
    payload: unknown,
    generation: number,
    occurredAt: string,
  ): void {
    const operation = this.state.database.prepare(
      'SELECT event_sequence FROM effect_operations WHERE operation_id = ?',
    ).get(operationId) as { event_sequence: number };
    const sequence = operation.event_sequence + 1;
    this.state.database.prepare(`
      UPDATE effect_operations SET event_sequence = ?, row_version = row_version + 1, updated_at = ?
      WHERE operation_id = ?
    `).run(sequence, occurredAt, operationId);
    this.state.database.prepare(`
      INSERT INTO effect_audit_events (
        operation_id, sequence, event_type, payload_json, writer_generation, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(operationId, sequence, eventType, canonicalJson(payload), generation, occurredAt);
  }
}
