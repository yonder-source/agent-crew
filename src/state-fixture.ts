import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { ExecutionStore } from './executions.js';
import { JobStore } from './jobs.js';
import { StateContext } from './state-common.js';

export type StateFixture = {
  directory: string;
  path: string;
  database: Database.Database;
  jobs: JobStore;
  executions: ExecutionStore;
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

  return {
    directory,
    path,
    database,
    jobs: new JobStore(state),
    executions: new ExecutionStore(state),
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
