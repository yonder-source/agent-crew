import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueScopeStore } from './issue-scopes.js';
import { createStateFixture } from './state-fixture.js';

function read(overrides: Partial<Parameters<IssueScopeStore['recordCompleteRead']>[0]> = {}) {
  return {
    observationId: 'observation-1',
    scopeRevisionId: 'scope-1',
    repositoryId: 'repo-1',
    issueId: 'issue-1',
    sourceRevisionId: 'provider-revision-1',
    title: 'Task title',
    body: 'Accepted scope',
    dependencyIssueIds: ['issue-3', 'issue-2'],
    templateVersion: '1',
    policyVersion: 'policy-1',
    observedAt: '2026-11-02T00:00:00.000Z',
    expectedHeadVersion: 0,
    writerGeneration: 1,
    ...overrides,
  };
}

test('complete issue reads save immutable content snapshots and advance the current head', () => {
  const fixture = createStateFixture();
  try {
    const scopes = new IssueScopeStore(fixture.state);
    const first = scopes.recordCompleteRead(read());
    const second = scopes.recordCompleteRead(read({
      observationId: 'observation-2',
      scopeRevisionId: 'scope-duplicate',
      sourceRevisionId: 'provider-revision-2',
      dependencyIssueIds: ['issue-2', 'issue-3', 'issue-2'],
      expectedHeadVersion: 1,
      observedAt: '2026-11-02T00:01:00.000Z',
    }));

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.equal(second.revision.scopeRevisionId, first.revision.scopeRevisionId);
    assert.deepEqual(second.revision.dependencyIssueIds, ['issue-2', 'issue-3']);
    assert.equal(second.head.headVersion, 2);
    assert.equal(second.head.sourceRevisionId, 'provider-revision-2');
    assert.equal((fixture.database.prepare('SELECT count(*) AS count FROM issue_scope_revisions').get() as { count: number }).count, 1);
  } finally {
    fixture.close();
  }
});

test('changed issue content creates a new retained revision', () => {
  const fixture = createStateFixture();
  try {
    const scopes = new IssueScopeStore(fixture.state);
    const first = scopes.recordCompleteRead(read());
    const next = scopes.recordCompleteRead(read({
      observationId: 'observation-2', scopeRevisionId: 'scope-2',
      title: 'Updated title', expectedHeadVersion: 1,
    }));
    assert.notEqual(next.revision.scopeRevisionId, first.revision.scopeRevisionId);
    assert.equal(scopes.getRevision(first.revision.scopeRevisionId)?.title, 'Task title');
    assert.equal(next.head.scopeRevisionId, next.revision.scopeRevisionId);
  } finally {
    fixture.close();
  }
});

test('unusable reads make currentness unavailable while retaining prior scope revisions', () => {
  const fixture = createStateFixture();
  try {
    const scopes = new IssueScopeStore(fixture.state);
    const first = scopes.recordCompleteRead(read());
    const unavailable = scopes.recordUnusableRead({
      observationId: 'observation-2', repositoryId: 'repo-1', issueId: 'issue-1',
      status: 'incomplete', observedAt: '2026-11-02T00:01:00.000Z',
      expectedHeadVersion: 1, writerGeneration: 1,
    });
    assert.equal(unavailable.accepted, true);
    assert.equal(unavailable.head?.status, 'incomplete');
    assert.equal(unavailable.head?.scopeRevisionId, null);
    assert.ok(scopes.getRevision(first.revision.scopeRevisionId));
  } finally {
    fixture.close();
  }
});

test('late reads with an obsolete head version are retained but cannot replace the current head', () => {
  const fixture = createStateFixture();
  try {
    const scopes = new IssueScopeStore(fixture.state);
    scopes.recordCompleteRead(read());
    const current = scopes.recordCompleteRead(read({
      observationId: 'observation-current', scopeRevisionId: 'scope-current',
      sourceRevisionId: 'provider-current', title: 'Current title', expectedHeadVersion: 1,
    }));
    const delayed = scopes.recordCompleteRead(read({
      observationId: 'observation-delayed', scopeRevisionId: 'scope-delayed',
      sourceRevisionId: 'provider-delayed', title: 'Delayed title', expectedHeadVersion: 1,
    }));

    assert.equal(delayed.accepted, false);
    assert.equal(delayed.head.observationId, current.head.observationId);
    assert.equal(scopes.getHead('repo-1', 'issue-1')?.contentFingerprint, current.head.contentFingerprint);
    assert.equal((fixture.database.prepare("SELECT status FROM issue_read_observations WHERE observation_id = 'observation-delayed:superseded'").get() as { status: string }).status, 'superseded');
  } finally {
    fixture.close();
  }
});

test('issue scope revisions and read observations reject mutation', () => {
  const fixture = createStateFixture();
  try {
    const scopes = new IssueScopeStore(fixture.state);
    const result = scopes.recordCompleteRead(read());
    assert.throws(() => fixture.database.prepare('UPDATE issue_scope_revisions SET title = ?').run('mutated'), /immutable/);
    assert.throws(() => fixture.database.prepare('DELETE FROM issue_read_observations').run(), /append-only/);
    assert.ok(scopes.getRevision(result.revision.scopeRevisionId));
  } finally {
    fixture.close();
  }
});
