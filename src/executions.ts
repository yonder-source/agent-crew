import {
  assertText,
  mapExecution,
  StateError,
  type ExecutionLifecycle,
  type ExecutionRecord,
  type RawExecution,
  type UsageCoverage,
} from './state-common.js';
import type { StateContext } from './state-common.js';

type ExecutionTransitionBase = {
  executionId: string;
  expectedVersion: number;
  writerGeneration: number;
  terminalOutcome?: string;
  eventPayload?: unknown;
};

type ExecutionTransition = ExecutionTransitionBase & {
  lifecycle: ExecutionLifecycle;
  expectedIssueHeadVersion?: number;
  expectedReadinessHeadVersion?: number;
};

type UsageInput = {
  writerGeneration: number;
  metric: string;
  value: number | null;
  coverage: UsageCoverage;
  expectedVersion?: number;
} & ({ jobId: string; executionId?: never } | { jobId?: never; executionId: string });

export class ExecutionStore {
  constructor(private readonly state: StateContext) {}

  reserve(input: {
    executionId: string;
    jobId: string;
    expectedJobVersion: number;
    writerGeneration: number;
  }): ExecutionRecord {
    assertText(input.executionId, 'executionId');
    const occurredAt = this.state.now().toISOString();
    return this.state.runWithStaleAudit(input.jobId, input.writerGeneration, occurredAt, 'execution_reservation', () => {
      this.state.assertWriter(input.writerGeneration, occurredAt);
      const job = this.state.getJobOrThrow(input.jobId);
      if (job.row_version !== input.expectedJobVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Job changed since the caller read it');
      }
      if (job.requested_control !== 'run') {
        throw new StateError('JOB_CONTROL_BLOCKS_EXECUTION', 'Job control does not permit a new execution');
      }
      const liveExecution = this.state.database.prepare(
        "SELECT execution_id FROM executions WHERE job_id = ? AND lifecycle <> 'terminal'",
      ).get(input.jobId) as { execution_id: string } | undefined;
      if (liveExecution) {
        throw new StateError('LIVE_EXECUTION_EXISTS', 'Job already has a live execution');
      }

      this.state.database.prepare(`
        INSERT INTO executions (
          execution_id, job_id, ownership_generation, lifecycle, terminal_outcome,
          row_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'reserved', NULL, 1, ?, ?)
      `).run(input.executionId, input.jobId, input.writerGeneration, occurredAt, occurredAt);
      const nextVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.bumpJob(job, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: input.jobId,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'execution_reserved',
        payload: { executionId: input.executionId },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return mapExecution(this.state.getExecutionOrThrow(input.executionId));
    });
  }

  get(executionId: string): ExecutionRecord | undefined {
    const row = this.state.database.prepare(
      'SELECT * FROM executions WHERE execution_id = ?',
    ).get(executionId) as RawExecution | undefined;
    return row ? mapExecution(row) : undefined;
  }

  transition(input: ExecutionTransition): ExecutionRecord {
    const owner = this.state.database.prepare(
      'SELECT job_id FROM executions WHERE execution_id = ?',
    ).get(input.executionId) as { job_id: string } | undefined;
    if (!owner) throw new StateError('EXECUTION_NOT_FOUND', 'Execution does not exist');
    const occurredAt = this.state.now().toISOString();
    return this.state.runWithStaleAudit(owner.job_id, input.writerGeneration, occurredAt, 'execution_transition', () => {
      const execution = this.state.getExecutionOrThrow(input.executionId);
      const job = this.state.getJobOrThrow(execution.job_id);
      this.state.assertWriter(input.writerGeneration, occurredAt);
      if (execution.ownership_generation !== input.writerGeneration) {
        throw new StateError('STALE_GENERATION', 'Execution belongs to a replaced writer generation');
      }
      if (execution.row_version !== input.expectedVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Execution changed since the caller read it');
      }
      if (!this.canTransition(execution.lifecycle, input.lifecycle)) {
        throw new StateError('INVALID_EXECUTION_TRANSITION', 'Execution lifecycle transition is not allowed');
      }
      if (input.lifecycle === 'starting') {
        if (input.expectedIssueHeadVersion === undefined || input.expectedReadinessHeadVersion === undefined) {
          throw new StateError('START_EVIDENCE_REQUIRED', 'Execution start requires current issue and readiness versions');
        }
        const issueHead = this.state.database.prepare(`
          SELECT h.head_version, o.status, o.scope_revision_id
          FROM issue_read_heads h JOIN issue_read_observations o USING (observation_id)
          WHERE h.repository_id = ? AND h.issue_id = ?
        `).get(job.repository_id, job.issue_id) as { head_version: number; status: string; scope_revision_id: string | null } | undefined;
        if (issueHead?.status !== 'complete') {
          throw new StateError('START_SCOPE_UNAVAILABLE', 'Current issue scope is unavailable at execution start');
        }
        if (issueHead.head_version !== input.expectedIssueHeadVersion || issueHead.scope_revision_id !== job.scope_revision_id) {
          throw new StateError('START_SCOPE_STALE', 'Current issue scope no longer matches the reserved job');
        }
        const readinessHead = this.state.database.prepare(`
          SELECT h.head_version, o.status, o.label_present
          FROM readiness_heads h JOIN readiness_observations o USING (observation_id)
          WHERE h.repository_id = ? AND h.issue_id = ?
        `).get(job.repository_id, job.issue_id) as { head_version: number; status: string; label_present: number | null } | undefined;
        if (readinessHead?.status !== 'complete') {
          throw new StateError('READINESS_UNAVAILABLE', 'Current readiness is unavailable at execution start');
        }
        if (readinessHead.head_version !== input.expectedReadinessHeadVersion || readinessHead.label_present !== 1) {
          throw new StateError('READINESS_REMOVED', 'Issue readiness no longer permits execution start');
        }
        if (job.requested_control !== 'run') {
          throw new StateError('JOB_CONTROL_BLOCKS_EXECUTION', 'Job control does not permit execution start');
        }
      }
      if (input.lifecycle === 'active' && job.requested_control !== 'run') {
        throw new StateError('JOB_CONTROL_BLOCKS_EXECUTION', 'Job control does not permit execution activation');
      }
      const terminalOutcome = input.lifecycle === 'terminal' ? input.terminalOutcome : undefined;
      if (input.lifecycle === 'terminal') assertText(terminalOutcome ?? '', 'terminalOutcome');

      const nextExecutionVersion = execution.row_version + 1;
      const nextJobVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.database.prepare(`
        UPDATE executions
        SET lifecycle = ?, terminal_outcome = ?, row_version = ?, updated_at = ?
        WHERE execution_id = ? AND row_version = ?
      `).run(
        input.lifecycle,
        terminalOutcome ?? null,
        nextExecutionVersion,
        occurredAt,
        input.executionId,
        input.expectedVersion,
      );
      this.state.bumpJob(job, nextJobVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: job.job_id,
        sequence: nextSequence,
        rowVersion: nextJobVersion,
        eventType: 'execution_lifecycle_changed',
        payload: {
          ...asObject(input.eventPayload),
          executionId: input.executionId,
          lifecycle: input.lifecycle,
        },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return mapExecution(this.state.getExecutionOrThrow(input.executionId));
    });
  }

  recordUsage(input: UsageInput): { rowVersion: number } {
    assertText(input.metric, 'metric');
    if (input.coverage === 'unknown' ? input.value !== null : input.value === null || input.value < 0) {
      throw new StateError('INVALID_INPUT', 'Usage value must match its coverage state');
    }
    const ownerJobId = input.jobId ?? (this.state.database.prepare(
      'SELECT job_id FROM executions WHERE execution_id = ?',
    ).get(input.executionId) as { job_id: string } | undefined)?.job_id;
    if (!ownerJobId) throw new StateError('JOB_NOT_FOUND', 'Usage owner does not exist');
    const occurredAt = this.state.now().toISOString();

    return this.state.runWithStaleAudit(ownerJobId, input.writerGeneration, occurredAt, 'usage_update', () => {
      this.state.assertWriter(input.writerGeneration, occurredAt);
      const job = this.state.getJobOrThrow(ownerJobId);
      const existing = input.jobId
        ? this.state.database.prepare(
          'SELECT row_version FROM usage_counters WHERE job_id = ? AND metric = ?',
        ).get(input.jobId, input.metric) as { row_version: number } | undefined
        : this.state.database.prepare(
          'SELECT row_version FROM usage_counters WHERE execution_id = ? AND metric = ?',
        ).get(input.executionId, input.metric) as { row_version: number } | undefined;
      if (existing && (input.expectedVersion === undefined || existing.row_version !== input.expectedVersion)) {
        throw new StateError('STALE_ROW_VERSION', 'Usage counter changed since the caller read it');
      }
      if (!existing && input.expectedVersion !== undefined) {
        throw new StateError('STALE_ROW_VERSION', 'Usage counter does not exist at the expected version');
      }

      const counterVersion = (existing?.row_version ?? 0) + 1;
      const nextJobVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      if (input.jobId) {
        this.state.database.prepare(`
          INSERT INTO usage_counters (job_id, execution_id, metric, value, coverage, row_version, updated_at)
          VALUES (?, NULL, ?, ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET value = excluded.value, coverage = excluded.coverage,
            row_version = excluded.row_version, updated_at = excluded.updated_at
        `).run(input.jobId, input.metric, input.value, input.coverage, counterVersion, occurredAt);
      } else {
        this.state.database.prepare(`
          INSERT INTO usage_counters (job_id, execution_id, metric, value, coverage, row_version, updated_at)
          VALUES (NULL, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET value = excluded.value, coverage = excluded.coverage,
            row_version = excluded.row_version, updated_at = excluded.updated_at
        `).run(input.executionId, input.metric, input.value, input.coverage, counterVersion, occurredAt);
      }
      this.state.bumpJob(job, nextJobVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: ownerJobId,
        sequence: nextSequence,
        rowVersion: nextJobVersion,
        eventType: 'usage_counter_recorded',
        payload: {
          metric: input.metric,
          ownerType: input.jobId ? 'job' : 'execution',
          ownerId: input.jobId ?? input.executionId,
          coverage: input.coverage,
          value: input.value,
        },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return { rowVersion: counterVersion };
    });
  }

  private canTransition(from: ExecutionLifecycle, to: ExecutionLifecycle): boolean {
    const allowed: Record<ExecutionLifecycle, ExecutionLifecycle[]> = {
      reserved: ['starting', 'stopping', 'terminal'],
      starting: ['active', 'stopping', 'terminal'],
      active: ['stopping', 'terminal'],
      stopping: ['terminal'],
      terminal: [],
    };
    return allowed[from].includes(to);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
