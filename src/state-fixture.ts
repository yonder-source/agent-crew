import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { ExecutionStore } from './executions.js';
import { EffectStore } from './effects.js';
import { EffectResultStore } from './effect-results.js';
import type { BeginEffectInput } from './effect-model.js';
import { JobStore } from './jobs.js';
import { StateContext } from './state-common.js';

export type StateFixture = {
  directory: string;
  path: string;
  database: Database.Database;
  jobs: JobStore;
  executions: ExecutionStore;
  effects: EffectStore;
  effectResults: EffectResultStore;
  state: StateContext;
  close: () => void;
};

export function createStateFixture(): StateFixture {
  const directory = mkdtempSync(join(tmpdir(), 'agent-crew-state-'));
  const path = join(directory, 'controller.sqlite');
  const database = openDatabase(path);
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE controller_writer
    SET generation = 1, status = 'healthy', heartbeat_at = ?, updated_at = ?
    WHERE singleton_id = 1
  `).run(now, now);
  const state = new StateContext(database);
  const effects = new EffectStore(state);

  return {
    directory,
    path,
    database,
    jobs: new JobStore(state),
    executions: new ExecutionStore(state),
    effects,
    effectResults: new EffectResultStore(state, effects),
    state,
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function createJob(jobs: JobStore) {
  return jobs.create({
    jobId: 'job-1',
    repositoryId: 'repo-1',
    issueId: 'issue-1',
    scopeRevisionId: 'scope-1',
    phase: 'queued',
    writerGeneration: 1,
  });
}

export function createEffectInput(
  fixture: StateFixture,
  operationId: string,
  overrides: Partial<BeginEffectInput> = {},
): BeginEffectInput {
  const job = fixture.jobs.get('job-1');
  if (!job) throw new Error('Create the fixture job before an effect');
  return {
    operationId,
    jobId: job.jobId,
    operationKind: 'github_issue_update',
    arguments: { body: 'accepted text' },
    target: { repositoryId: job.repositoryId, issueId: job.issueId },
    expectedJobVersion: job.rowVersion,
    scopeRevisionId: job.scopeRevisionId,
    policyVersion: 'policy-1',
    callerIdentity: 'human:123',
    grant: { action: 'issue.write' },
    steps: [{ stepId: `${operationId}-write`, stepKey: 'write', target: { fields: ['body'] } }],
    writerGeneration: 1,
    ...overrides,
  };
}
