import { EffectAuditLog } from './effect-audit.js';
import { createHash } from 'node:crypto';
import { assertText, StateError } from './state-common.js';
import type { RawExecution, StateContext } from './state-common.js';
import {
  canonicalJson,
  mapAudit,
  mapAuthorization,
  mapOperation,
  mapStep,
  type BeginEffectInput,
  type EffectAuditEvent,
  type EffectOperationView,
  type EffectStep,
  type EffectStepInput,
  type RawAuthorization,
  type RawAuditEvent,
  type RawOperation,
  type RawStep,
} from './effect-model.js';

export class EffectStore {
  private readonly audit: EffectAuditLog;

  constructor(private readonly state: StateContext) {
    this.audit = new EffectAuditLog(state);
  }

  begin(input: BeginEffectInput): { view: EffectOperationView; duplicate: boolean } {
    for (const [label, value] of Object.entries({
      operationId: input.operationId,
      jobId: input.jobId,
      operationKind: input.operationKind,
      scopeRevisionId: input.scopeRevisionId,
      policyVersion: input.policyVersion,
      callerIdentity: input.callerIdentity,
    })) assertText(value, label);
    if (!Number.isSafeInteger(input.expectedJobVersion) || input.expectedJobVersion < 1) {
      throw new StateError('INVALID_INPUT', 'expectedJobVersion must be a positive integer');
    }
    if (!Number.isSafeInteger(input.writerGeneration) || input.writerGeneration < 1) {
      throw new StateError('INVALID_INPUT', 'writerGeneration must be a positive integer');
    }
    if (input.executionId && (!Number.isSafeInteger(input.expectedExecutionVersion) || (input.expectedExecutionVersion ?? 0) < 1)) {
      throw new StateError('INVALID_INPUT', 'expectedExecutionVersion is required for execution effects');
    }
    if (!input.executionId && input.expectedExecutionVersion !== undefined) {
      throw new StateError('INVALID_INPUT', 'expectedExecutionVersion requires an executionId');
    }
    if (input.steps.length === 0) throw new StateError('INVALID_INPUT', 'An effect operation requires at least one step');
    const argumentJson = canonicalJson(input.arguments);
    const argumentFingerprint = createHash('sha256').update(argumentJson).digest('hex');
    const targetJson = canonicalJson(input.target);
    const grantJson = canonicalJson(input.grant);
    const steps = this.validateSteps(input.steps);
    const occurredAt = this.state.now().toISOString();

    const result = this.state.runWithStaleAudit(input.jobId, input.writerGeneration, occurredAt, 'effect_intent', () => {
      this.state.assertWriter(input.writerGeneration, occurredAt);
      const existing = this.state.database.prepare(
        'SELECT * FROM effect_operations WHERE operation_id = ?',
      ).get(input.operationId) as RawOperation | undefined;
      if (existing) {
        const authorization = this.state.database.prepare(
          'SELECT * FROM effect_authorization_evidence WHERE operation_id = ?',
        ).get(input.operationId) as RawAuthorization;
        if (this.matches(existing, authorization, input, argumentFingerprint, targetJson, grantJson, steps)) {
          return { duplicate: true, conflict: false, blocked: false };
        }
        this.audit.append(input.operationId, 'operation_identity_conflict', {
          attemptedArgumentFingerprint: argumentFingerprint,
          attemptedOperationKind: input.operationKind,
          attemptedTarget: targetJson,
        }, input.writerGeneration, occurredAt);
        return { duplicate: false, conflict: true, blocked: false };
      }

      const job = this.state.getJobOrThrow(input.jobId);
      if (job.row_version !== input.expectedJobVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Job changed since the effect was authorized');
      }
      if (job.scope_revision_id !== input.scopeRevisionId) {
        throw new StateError('STALE_SCOPE_REVISION', 'Effect scope does not match the current job scope');
      }
      const unresolved = this.state.database.prepare(`
        SELECT operation_id, job_id FROM effect_operations
        WHERE operation_kind = ? AND target_json = ? AND status = 'unknown'
        ORDER BY created_at, operation_id
      `).all(input.operationKind, targetJson) as Array<{ operation_id: string; job_id: string }>;
      const replacementIsExplicit = input.replacementForOperationId !== undefined
        && unresolved.length === 1
        && unresolved[0]?.operation_id === input.replacementForOperationId
        && unresolved[0]?.job_id === input.jobId;
      const blockedByUnknown = (unresolved.length > 0 && !replacementIsExplicit)
        || (input.replacementForOperationId !== undefined && !replacementIsExplicit);
      if (blockedByUnknown) {
        const blockedOperationId = unresolved[0]?.operation_id ?? input.replacementForOperationId;
        if (blockedOperationId) {
          const existingBlocked = this.state.database.prepare(
            'SELECT 1 AS found FROM effect_operations WHERE operation_id = ?',
          ).get(blockedOperationId);
          if (existingBlocked) {
            this.audit.append(blockedOperationId, 'unknown_effect_duplicate_blocked', {
              attemptedOperationId: input.operationId,
              attemptedArgumentFingerprint: argumentFingerprint,
              replacementForOperationId: input.replacementForOperationId ?? null,
            }, input.writerGeneration, occurredAt);
          }
        }
        return { duplicate: false, conflict: false, blocked: true };
      }
      let execution: RawExecution | undefined;
      if (input.executionId) {
        execution = this.state.getExecutionOrThrow(input.executionId);
        if (
          execution.job_id !== input.jobId
          || execution.row_version !== input.expectedExecutionVersion
          || execution.ownership_generation !== input.writerGeneration
        ) {
          throw new StateError('STALE_GENERATION', 'Effect execution binding or ownership is stale');
        }
      }

      this.state.database.prepare(`
        INSERT INTO effect_operations (
          operation_id, job_id, execution_id, replacement_for_operation_id,
          operation_kind, argument_fingerprint, target_json,
          expected_job_version, expected_execution_version, scope_revision_id, policy_version,
          writer_generation, status, row_version, event_sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, 1, ?, ?)
      `).run(
        input.operationId,
        input.jobId,
        input.executionId ?? null,
        input.replacementForOperationId ?? null,
        input.operationKind,
        argumentFingerprint,
        targetJson,
        input.expectedJobVersion,
        input.expectedExecutionVersion ?? null,
        input.scopeRevisionId,
        input.policyVersion,
        input.writerGeneration,
        occurredAt,
        occurredAt,
      );
      this.state.database.prepare(`
        INSERT INTO effect_authorization_evidence (
          operation_id, caller_identity, grant_json, target_json, expected_job_version,
          expected_execution_version, scope_revision_id, policy_version, writer_generation, authorized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.operationId,
        input.callerIdentity,
        grantJson,
        targetJson,
        input.expectedJobVersion,
        input.expectedExecutionVersion ?? null,
        input.scopeRevisionId,
        input.policyVersion,
        input.writerGeneration,
        occurredAt,
      );
      const stepIds = new Map(steps.map((step) => [step.stepKey, step.stepId]));
      for (const step of steps) {
        this.state.database.prepare(`
          INSERT INTO effect_steps (
            step_id, operation_id, step_key, target_json, status, result_json,
            result_generation, result_source, row_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, 1, ?, ?)
        `).run(step.stepId, input.operationId, step.stepKey, step.targetJson, occurredAt, occurredAt);
      }
      const insertDependency = this.state.database.prepare(
        'INSERT INTO effect_step_dependencies (step_id, depends_on_step_id) VALUES (?, ?)',
      );
      for (const step of steps) {
        for (const dependsOn of step.dependsOn ?? []) insertDependency.run(step.stepId, stepIds.get(dependsOn));
      }
      this.audit.append(input.operationId, 'operation_intent_recorded', {
        operationKind: input.operationKind,
        argumentFingerprint,
        stepCount: steps.length,
      }, input.writerGeneration, occurredAt, true);
      const nextVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.bumpJob(job, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: input.jobId,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'effect_intent_recorded',
        payload: { operationId: input.operationId, operationKind: input.operationKind },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return { duplicate: false, conflict: false, blocked: false };
    });

    if (result.conflict) throw new StateError('OPERATION_ID_CONFLICT', 'Operation identity was reused with changed command or authorization data');
    if (result.blocked) throw new StateError('UNKNOWN_EFFECT_BLOCKS_DUPLICATE', 'An unknown effect must be reconciled or explicitly replaced before a matching action can start');
    return { view: this.get(input.operationId) as EffectOperationView, duplicate: result.duplicate };
  }

  get(operationId: string): EffectOperationView | undefined {
    const raw = this.state.database.prepare(
      'SELECT * FROM effect_operations WHERE operation_id = ?',
    ).get(operationId) as RawOperation | undefined;
    if (!raw) return undefined;
    const authorization = this.state.database.prepare(
      'SELECT * FROM effect_authorization_evidence WHERE operation_id = ?',
    ).get(operationId) as RawAuthorization;
    return {
      operation: mapOperation(raw),
      steps: this.listSteps(operationId),
      authorization: mapAuthorization(authorization),
    };
  }

  listSteps(operationId: string): EffectStep[] {
    const rows = this.state.database.prepare(
      'SELECT * FROM effect_steps WHERE operation_id = ? ORDER BY step_key',
    ).all(operationId) as RawStep[];
    const dependencies = this.state.database.prepare(`
      SELECT child.step_id, parent.step_key
      FROM effect_step_dependencies dependency
      JOIN effect_steps child ON child.step_id = dependency.step_id
      JOIN effect_steps parent ON parent.step_id = dependency.depends_on_step_id
      WHERE child.operation_id = ? ORDER BY parent.step_key
    `).all(operationId) as Array<{ step_id: string; step_key: string }>;
    const byStep = new Map<string, string[]>();
    for (const row of dependencies) byStep.set(row.step_id, [...(byStep.get(row.step_id) ?? []), row.step_key]);
    return rows.map((row) => mapStep(row, byStep.get(row.step_id) ?? []));
  }

  listAudit(operationId: string): EffectAuditEvent[] {
    const rows = this.state.database.prepare(
      'SELECT * FROM effect_audit_events WHERE operation_id = ? ORDER BY sequence',
    ).all(operationId) as RawAuditEvent[];
    return rows.map(mapAudit);
  }

  claimStepStart(operationId: string, stepId: string, writerGeneration: number): boolean {
    const owner = this.state.database.prepare(
      'SELECT job_id FROM effect_operations WHERE operation_id = ?',
    ).get(operationId) as { job_id: string } | undefined;
    if (!owner) return false;
    const occurredAt = this.state.now().toISOString();
    return this.state.runWithStaleAudit(owner.job_id, writerGeneration, occurredAt, 'effect_start', () => {
      this.state.assertWriter(writerGeneration, occurredAt);
      const step = this.state.database.prepare(`
        SELECT step.*, operation.job_id, operation.writer_generation, operation.scope_revision_id
        FROM effect_steps step JOIN effect_operations operation USING (operation_id)
        WHERE step.operation_id = ? AND step.step_id = ?
      `).get(operationId, stepId) as (
        RawStep & { job_id: string; writer_generation: number; scope_revision_id: string }
      ) | undefined;
      if (
        step?.status !== 'pending'
        || step.started_at !== null
        || step.writer_generation !== writerGeneration
      ) return false;
      if (this.state.getJobOrThrow(step.job_id).scope_revision_id !== step.scope_revision_id) {
        this.audit.append(operationId, 'effect_step_start_rejected_stale_scope', {
          stepId,
          expectedScopeRevisionId: step.scope_revision_id,
        }, writerGeneration, occurredAt);
        return false;
      }
      const blockedDependency = this.state.database.prepare(`
        SELECT 1 AS blocked
        FROM effect_step_dependencies dependency
        JOIN effect_steps parent ON parent.step_id = dependency.depends_on_step_id
        WHERE dependency.step_id = ? AND parent.status <> 'confirmed_success'
        LIMIT 1
      `).get(stepId);
      if (blockedDependency) return false;
      const claim = this.state.database.prepare(`
        UPDATE effect_steps SET started_generation = ?, started_at = ?,
          attempt_count = attempt_count + 1, row_version = row_version + 1, updated_at = ?
        WHERE step_id = ? AND status = 'pending' AND started_at IS NULL AND row_version = ?
      `).run(writerGeneration, occurredAt, occurredAt, stepId, step.row_version);
      if (claim.changes !== 1) return false;
      this.audit.append(operationId, 'effect_step_start_claimed', {
        stepId,
        stepVersion: step.row_version + 1,
        attemptCount: step.attempt_count + 1,
      }, writerGeneration, occurredAt);
      const job = this.state.getJobOrThrow(step.job_id);
      const nextJobVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.bumpJob(job, nextJobVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: job.job_id,
        sequence: nextSequence,
        rowVersion: nextJobVersion,
        eventType: 'effect_step_start_claimed',
        payload: { operationId, stepId },
        writerGeneration,
        occurredAt,
      });
      return true;
    });
  }

  private validateSteps(input: EffectStepInput[]): Array<EffectStepInput & { targetJson: string }> {
    const byKey = new Map<string, EffectStepInput>();
    const ids = new Set<string>();
    for (const step of input) {
      assertText(step.stepId, 'stepId');
      assertText(step.stepKey, 'stepKey');
      if (ids.has(step.stepId) || byKey.has(step.stepKey)) {
        throw new StateError('INVALID_INPUT', 'Effect step IDs and keys must be unique');
      }
      ids.add(step.stepId);
      byKey.set(step.stepKey, step);
    }
    const checked = input.map((step) => ({ ...step, targetJson: canonicalJson(step.target) }));
    for (const step of checked) {
      const seen = new Set<string>();
      for (const dependency of step.dependsOn ?? []) {
        if (!byKey.has(dependency) || dependency === step.stepKey || seen.has(dependency)) {
          throw new StateError('INVALID_INPUT', 'Effect step dependencies must reference unique sibling steps');
        }
        seen.add(dependency);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visiting.has(key)) throw new StateError('INVALID_INPUT', 'Effect step dependencies cannot contain cycles');
      if (visited.has(key)) return;
      visiting.add(key);
      for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of byKey.keys()) visit(key);
    return checked;
  }

  private matches(
    existing: RawOperation,
    authorization: RawAuthorization,
    input: BeginEffectInput,
    fingerprint: string,
    targetJson: string,
    grantJson: string,
    requestedSteps: Array<EffectStepInput & { targetJson: string }>,
  ): boolean {
    if (
      existing.job_id !== input.jobId
      || existing.execution_id !== (input.executionId ?? null)
      || existing.replacement_for_operation_id !== (input.replacementForOperationId ?? null)
      || existing.operation_kind !== input.operationKind
      || existing.argument_fingerprint !== fingerprint
      || existing.target_json !== targetJson
      || existing.expected_job_version !== input.expectedJobVersion
      || existing.expected_execution_version !== (input.expectedExecutionVersion ?? null)
      || existing.scope_revision_id !== input.scopeRevisionId
      || existing.policy_version !== input.policyVersion
      || authorization.caller_identity !== input.callerIdentity
      || authorization.grant_json !== grantJson
    ) return false;
    const current = this.listSteps(input.operationId);
    if (current.length !== requestedSteps.length) return false;
    const byKey = new Map(current.map((step) => [step.stepKey, step]));
    return requestedSteps.every((step) => {
      const existingStep = byKey.get(step.stepKey);
      return existingStep !== undefined
        && existingStep.stepId === step.stepId
        && existingStep.targetJson === step.targetJson
        && JSON.stringify([...existingStep.dependsOn].sort()) === JSON.stringify([...(step.dependsOn ?? [])].sort());
    });
  }

}
