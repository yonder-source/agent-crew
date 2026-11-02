import { StateError } from './state-common.js';

export type EffectOutcome = 'pending' | 'confirmed_success' | 'confirmed_failure' | 'unknown';
export type EffectResultSource = 'provider_receipt' | 'reconciliation' | 'recovery';

export type EffectStepInput = {
  stepId: string;
  stepKey: string;
  target: unknown;
  dependsOn?: string[];
};

export type BeginEffectInput = {
  operationId: string;
  jobId: string;
  executionId?: string;
  replacementForOperationId?: string;
  operationKind: string;
  arguments: unknown;
  target: unknown;
  expectedJobVersion: number;
  expectedExecutionVersion?: number;
  scopeRevisionId: string;
  policyVersion: string;
  callerIdentity: string;
  grant: unknown;
  steps: EffectStepInput[];
  writerGeneration: number;
};

export type EffectOperation = {
  operationId: string;
  jobId: string;
  executionId: string | null;
  replacementForOperationId: string | null;
  operationKind: string;
  argumentFingerprint: string;
  targetJson: string;
  expectedJobVersion: number;
  expectedExecutionVersion: number | null;
  scopeRevisionId: string;
  policyVersion: string;
  writerGeneration: number;
  status: EffectOutcome;
  rowVersion: number;
  eventSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type EffectStep = {
  stepId: string;
  operationId: string;
  stepKey: string;
  targetJson: string;
  status: EffectOutcome;
  resultJson: string | null;
  resultGeneration: number | null;
  resultSource: EffectResultSource | null;
  rowVersion: number;
  startedGeneration: number | null;
  startedAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  dependsOn: string[];
};

export type EffectAuthorizationEvidence = {
  operationId: string;
  callerIdentity: string;
  grantJson: string;
  targetJson: string;
  expectedJobVersion: number;
  expectedExecutionVersion: number | null;
  scopeRevisionId: string;
  policyVersion: string;
  writerGeneration: number;
  authorizedAt: string;
};

export type EffectAuditEvent = {
  eventId: number;
  operationId: string;
  sequence: number;
  eventType: string;
  payloadJson: string;
  writerGeneration: number;
  occurredAt: string;
};

export type RawOperation = {
  operation_id: string;
  job_id: string;
  execution_id: string | null;
  replacement_for_operation_id: string | null;
  operation_kind: string;
  argument_fingerprint: string;
  target_json: string;
  expected_job_version: number;
  expected_execution_version: number | null;
  scope_revision_id: string;
  policy_version: string;
  writer_generation: number;
  status: EffectOutcome;
  row_version: number;
  event_sequence: number;
  created_at: string;
  updated_at: string;
};

export type RawStep = {
  step_id: string;
  operation_id: string;
  step_key: string;
  target_json: string;
  status: EffectOutcome;
  result_json: string | null;
  result_generation: number | null;
  result_source: EffectResultSource | null;
  row_version: number;
  started_generation: number | null;
  started_at: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
};

export type RawAuthorization = {
  operation_id: string;
  caller_identity: string;
  grant_json: string;
  target_json: string;
  expected_job_version: number;
  expected_execution_version: number | null;
  scope_revision_id: string;
  policy_version: string;
  writer_generation: number;
  authorized_at: string;
};

export type RawAuditEvent = {
  event_id: number;
  operation_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  writer_generation: number;
  occurred_at: string;
};

export type EffectOperationView = {
  operation: EffectOperation;
  replacementOperationId: string | null;
  steps: EffectStep[];
  authorization: EffectAuthorizationEvidence;
};

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current !== 'object') throw new StateError('INVALID_INPUT', 'Effect inputs must contain JSON values');
    if (ancestors.has(current)) throw new StateError('INVALID_INPUT', 'Effect inputs cannot contain cycles');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return current.map(normalize);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new StateError('INVALID_INPUT', 'Effect inputs must be plain JSON objects');
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(current).sort()) {
        output[key] = normalize((current as Record<string, unknown>)[key]);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  };

  try {
    return JSON.stringify(normalize(value));
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError('INVALID_INPUT', 'Effect inputs must be JSON serializable');
  }
}

export function mapOperation(row: RawOperation): EffectOperation {
  return {
    operationId: row.operation_id,
    jobId: row.job_id,
    executionId: row.execution_id,
    replacementForOperationId: row.replacement_for_operation_id,
    operationKind: row.operation_kind,
    argumentFingerprint: row.argument_fingerprint,
    targetJson: row.target_json,
    expectedJobVersion: row.expected_job_version,
    expectedExecutionVersion: row.expected_execution_version,
    scopeRevisionId: row.scope_revision_id,
    policyVersion: row.policy_version,
    writerGeneration: row.writer_generation,
    status: row.status,
    rowVersion: row.row_version,
    eventSequence: row.event_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStep(row: RawStep, dependsOn: string[]): EffectStep {
  return {
    stepId: row.step_id,
    operationId: row.operation_id,
    stepKey: row.step_key,
    targetJson: row.target_json,
    status: row.status,
    resultJson: row.result_json,
    resultGeneration: row.result_generation,
    resultSource: row.result_source,
    rowVersion: row.row_version,
    startedGeneration: row.started_generation,
    startedAt: row.started_at,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dependsOn,
  };
}

export function mapAuthorization(row: RawAuthorization): EffectAuthorizationEvidence {
  return {
    operationId: row.operation_id,
    callerIdentity: row.caller_identity,
    grantJson: row.grant_json,
    targetJson: row.target_json,
    expectedJobVersion: row.expected_job_version,
    expectedExecutionVersion: row.expected_execution_version,
    scopeRevisionId: row.scope_revision_id,
    policyVersion: row.policy_version,
    writerGeneration: row.writer_generation,
    authorizedAt: row.authorized_at,
  };
}

export function mapAudit(row: RawAuditEvent): EffectAuditEvent {
  return {
    eventId: row.event_id,
    operationId: row.operation_id,
    sequence: row.sequence,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    writerGeneration: row.writer_generation,
    occurredAt: row.occurred_at,
  };
}

export function outcomeFor(steps: EffectOutcome[]): EffectOutcome {
  if (steps.includes('unknown')) return 'unknown';
  if (steps.includes('pending')) return 'pending';
  if (steps.includes('confirmed_failure')) return 'confirmed_failure';
  return 'confirmed_success';
}
