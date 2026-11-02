import { assertText, mapEvent, mapJob, serialize, StateError } from './state-common.js';
import type { JobControl, JobEvent, JobRecord, RawJob, StateContext } from './state-common.js';

type JobInput = {
  jobId: string;
  repositoryId: string;
  issueId: string;
  scopeRevisionId: string;
  phase: string;
  writerGeneration: number;
};

type JobTransition = {
  jobId: string;
  expectedVersion: number;
  writerGeneration: number;
  eventType: string;
  eventPayload?: unknown;
  phase?: string;
  requestedControl?: JobControl;
  scopeRevisionId?: string;
};

export type JobBlocker = {
  blockerId: string;
  jobId: string;
  code: string;
  detailsJson: string;
  status: 'open' | 'resolved';
  createdGeneration: number;
  resolvedGeneration: number | null;
  createdAt: string;
  resolvedAt: string | null;
};

type RawBlocker = {
  blocker_id: string;
  job_id: string;
  code: string;
  details_json: string;
  status: 'open' | 'resolved';
  created_generation: number;
  resolved_generation: number | null;
  created_at: string;
  resolved_at: string | null;
};

function mapBlocker(row: RawBlocker): JobBlocker {
  return {
    blockerId: row.blocker_id,
    jobId: row.job_id,
    code: row.code,
    detailsJson: row.details_json,
    status: row.status,
    createdGeneration: row.created_generation,
    resolvedGeneration: row.resolved_generation,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class JobStore {
  constructor(private readonly state: StateContext) {}

  create(input: JobInput): JobRecord {
    for (const [label, value] of Object.entries({
      jobId: input.jobId,
      repositoryId: input.repositoryId,
      issueId: input.issueId,
      scopeRevisionId: input.scopeRevisionId,
      phase: input.phase,
    })) {
      assertText(value, label);
    }
    const createdAt = this.state.now().toISOString();

    return this.state.database.transaction(() => {
      this.state.assertWriter(input.writerGeneration, createdAt);
      const existing = this.state.database.prepare(
        'SELECT * FROM jobs WHERE repository_id = ? AND issue_id = ?',
      ).get(input.repositoryId, input.issueId) as RawJob | undefined;
      if (existing) {
        if (existing.job_id === input.jobId && existing.scope_revision_id === input.scopeRevisionId) {
          return mapJob(existing);
        }
        throw new StateError('JOB_ALREADY_EXISTS', 'A job already exists for this repository and issue');
      }

      this.state.database.prepare(`
        INSERT INTO jobs (
          job_id, repository_id, issue_id, scope_revision_id, phase,
          requested_control, row_version, event_sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'run', 1, 1, ?, ?)
      `).run(
        input.jobId,
        input.repositoryId,
        input.issueId,
        input.scopeRevisionId,
        input.phase,
        createdAt,
        createdAt,
      );
      this.state.insertEvent({
        jobId: input.jobId,
        sequence: 1,
        rowVersion: 1,
        eventType: 'job_created',
        payload: { repositoryId: input.repositoryId, issueId: input.issueId },
        writerGeneration: input.writerGeneration,
        occurredAt: createdAt,
      });
      return mapJob(this.state.getJobOrThrow(input.jobId));
    }).immediate();
  }

  get(jobId: string): JobRecord | undefined {
    const row = this.state.database.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as RawJob | undefined;
    return row ? mapJob(row) : undefined;
  }

  listEvents(jobId: string): JobEvent[] {
    const rows = this.state.database.prepare(
      'SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence',
    ).all(jobId) as Array<{
      event_id: number;
      job_id: string;
      sequence: number;
      row_version: number;
      event_type: string;
      payload_json: string;
      writer_generation: number;
      occurred_at: string;
    }>;
    return rows.map(mapEvent);
  }

  listBlockers(jobId: string): JobBlocker[] {
    const rows = this.state.database.prepare(
      'SELECT * FROM job_blockers WHERE job_id = ? ORDER BY created_at, blocker_id',
    ).all(jobId) as RawBlocker[];
    return rows.map(mapBlocker);
  }

  transition(input: JobTransition): JobRecord {
    assertText(input.eventType, 'eventType');
    if (input.phase !== undefined) assertText(input.phase, 'phase');
    if (input.scopeRevisionId !== undefined) assertText(input.scopeRevisionId, 'scopeRevisionId');
    if (input.phase === undefined && input.requestedControl === undefined && input.scopeRevisionId === undefined) {
      throw new StateError('INVALID_INPUT', 'A job transition must change at least one field');
    }

    const occurredAt = this.state.now().toISOString();
    return this.state.runWithStaleAudit(input.jobId, input.writerGeneration, occurredAt, 'job_transition', () => {
      const job = this.state.getJobOrThrow(input.jobId);
      this.state.assertWriter(input.writerGeneration, occurredAt);
      if (job.row_version !== input.expectedVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Job changed since the caller read it');
      }

      const nextVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.database.prepare(`
        UPDATE jobs SET
          phase = COALESCE(?, phase),
          requested_control = COALESCE(?, requested_control),
          scope_revision_id = COALESCE(?, scope_revision_id),
          row_version = ?, event_sequence = ?, updated_at = ?
        WHERE job_id = ? AND row_version = ?
      `).run(
        input.phase ?? null,
        input.requestedControl ?? null,
        input.scopeRevisionId ?? null,
        nextVersion,
        nextSequence,
        occurredAt,
        input.jobId,
        input.expectedVersion,
      );
      this.state.insertEvent({
        jobId: input.jobId,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: input.eventType,
        payload: input.eventPayload,
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return mapJob(this.state.getJobOrThrow(input.jobId));
    });
  }

  addBlocker(input: {
    blockerId: string;
    jobId: string;
    code: string;
    details: unknown;
    writerGeneration: number;
  }): JobRecord {
    assertText(input.blockerId, 'blockerId');
    assertText(input.code, 'code');
    const detailsJson = serialize(input.details);
    const occurredAt = this.state.now().toISOString();

    return this.state.runWithStaleAudit(input.jobId, input.writerGeneration, occurredAt, 'blocker_add', () => {
      this.state.assertWriter(input.writerGeneration, occurredAt);
      const job = this.state.getJobOrThrow(input.jobId);
      const existing = this.state.database.prepare(
        'SELECT * FROM job_blockers WHERE blocker_id = ?',
      ).get(input.blockerId) as RawBlocker | undefined;
      if (existing) {
        if (
          existing.job_id === input.jobId
          && existing.code === input.code
          && existing.details_json === detailsJson
          && existing.status === 'open'
        ) {
          return mapJob(job);
        }
        throw new StateError('BLOCKER_ID_CONFLICT', 'Blocker identity is already used');
      }

      const nextVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.database.prepare(`
        INSERT INTO job_blockers (
          blocker_id, job_id, code, details_json, status,
          created_generation, resolved_generation, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, 'open', ?, NULL, ?, NULL)
      `).run(input.blockerId, input.jobId, input.code, detailsJson, input.writerGeneration, occurredAt);
      this.state.bumpJob(job, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: input.jobId,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'blocker_added',
        payload: { blockerId: input.blockerId, code: input.code },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return mapJob(this.state.getJobOrThrow(input.jobId));
    });
  }

  resolveBlocker(input: {
    blockerId: string;
    expectedJobVersion: number;
    writerGeneration: number;
  }): JobRecord {
    const blockerJob = this.state.database.prepare(
      'SELECT job_id FROM job_blockers WHERE blocker_id = ?',
    ).get(input.blockerId) as { job_id: string } | undefined;
    if (!blockerJob) throw new StateError('BLOCKER_NOT_FOUND', 'Blocker does not exist');
    const occurredAt = this.state.now().toISOString();

    return this.state.runWithStaleAudit(blockerJob.job_id, input.writerGeneration, occurredAt, 'blocker_resolution', () => {
      const blocker = this.state.database.prepare(
        'SELECT * FROM job_blockers WHERE blocker_id = ?',
      ).get(input.blockerId) as RawBlocker | undefined;
      if (!blocker) throw new StateError('BLOCKER_NOT_FOUND', 'Blocker does not exist');
      const job = this.state.getJobOrThrow(blocker.job_id);
      this.state.assertWriter(input.writerGeneration, occurredAt);
      if (job.row_version !== input.expectedJobVersion) {
        throw new StateError('STALE_ROW_VERSION', 'Job changed since the caller read it');
      }
      if (blocker.status === 'resolved') return mapJob(job);

      const nextVersion = job.row_version + 1;
      const nextSequence = job.event_sequence + 1;
      this.state.database.prepare(`
        UPDATE job_blockers
        SET status = 'resolved', resolved_generation = ?, resolved_at = ?
        WHERE blocker_id = ? AND status = 'open'
      `).run(input.writerGeneration, occurredAt, input.blockerId);
      this.state.bumpJob(job, nextVersion, nextSequence, occurredAt);
      this.state.insertEvent({
        jobId: job.job_id,
        sequence: nextSequence,
        rowVersion: nextVersion,
        eventType: 'blocker_resolved',
        payload: { blockerId: input.blockerId },
        writerGeneration: input.writerGeneration,
        occurredAt,
      });
      return mapJob(this.state.getJobOrThrow(job.job_id));
    });
  }
}
