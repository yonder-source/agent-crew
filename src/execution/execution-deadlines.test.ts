import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardFixture } from '../../tests/fixtures/execution-guard-fixture.js';
import { ExecutionCommands, type ExecutionControlSupervisor, type RuntimeDeadlineRequest, type RuntimeDeadlineReceipt } from './execution-controls.js';
import { ExecutionDeadlines, deadlineFingerprint } from './execution-deadlines.js';

test('independent fake deadline expires without Controller evaluation and duplicate grants cannot reset it', async () => {
  const f = await createGuardFixture();
  try {
    let now = 0;
    let expiresAt = Infinity;
    let registrations = 0;
    const receipts = new Map<string,RuntimeDeadlineReceipt>();
    const supervisor: ExecutionControlSupervisor = {
      ...f.supervisor, async terminateInference() {}, async inspectInference() { return now >= expiresAt ? 'stopped' : 'running'; },
      async configureDeadline(request) {
        registrations++;
        expiresAt = Math.min(now + request.remainingActiveMs, request.activeCeilingMs);
        const receipt: RuntimeDeadlineReceipt = { commandId: request.commandId, runId: request.run.runId, taskId: request.run.taskId,
          revision: request.expectedRevision + 1, remainingActiveMs: request.remainingActiveMs,
          requestFingerprint: deadlineFingerprint(request), independentlyEnforced: true };
        receipts.set(request.commandId,receipt);
        return receipt;
      },
      async inspectDeadline(commandId) { return receipts.get(commandId) ?? null; },
    };
    const commands = new ExecutionCommands(f.state,f.accounting);
    const deadlines = new ExecutionDeadlines(f.state,f.accounting,commands,supervisor,20);
    const request: RuntimeDeadlineRequest = { commandId: 'deadline-1', run: f.run, policyRevisionId: 'budget-1',
      remainingActiveMs: 100, jobRemainingActiveMs: 200, activeCeilingMs: 100, jobActiveCeilingMs: 200, maximumExtensionMs: 20, expectedRevision: 0, extensionGrantId: null };
    assert.equal((await deadlines.register(request,1))?.revision,1);
    now = 50;
    await deadlines.register(request,1);
    assert.equal(registrations,1);
    assert.equal(expiresAt,100);
    await deadlines.register({ ...request, commandId: 'deadline-refresh', expectedRevision: 1 },1);
    assert.equal(expiresAt,100);
    now = 101;
    assert.equal(await supervisor.inspectInference(f.run),'stopped');
    // The fake supervisor, not a Controller timer, observed the expiry.
    await assert.rejects(deadlines.register({ ...request, commandId: 'bad-extension', expectedRevision: 2,
      remainingActiveMs: 150, activeCeilingMs: 150, extensionGrantId: 'human-grant-1' },1),{ code: 'EXTENSION_NOT_AUTHORIZED' });
  } finally { f.close(); }
});

test('lost deadline responses reconcile the same command without registering twice', async () => {
  const f = await createGuardFixture();
  try {
    let calls = 0;
    let stored: RuntimeDeadlineReceipt | null = null;
    const supervisor: ExecutionControlSupervisor = {
      ...f.supervisor, async terminateInference() {}, async inspectInference() { return 'unknown'; },
      async configureDeadline(request) {
        calls++;
        stored = { commandId: request.commandId, runId: request.run.runId, taskId: request.run.taskId,
          requestFingerprint: deadlineFingerprint(request), revision: 1, remainingActiveMs: 100, independentlyEnforced: true };
        throw new Error('response lost');
      },
      async inspectDeadline() { return stored; },
    };
    const commands = new ExecutionCommands(f.state,f.accounting);
    const service = new ExecutionDeadlines(f.state,f.accounting,commands,supervisor,20);
    const request: RuntimeDeadlineRequest = { commandId: 'deadline-lost', run: f.run, policyRevisionId: 'budget-1',
      remainingActiveMs: 100, jobRemainingActiveMs: 200, activeCeilingMs: 100, jobActiveCeilingMs: 200, maximumExtensionMs: 20, expectedRevision: 0, extensionGrantId: null };
    assert.ok(await service.register(request,1));
    assert.ok(await service.register(request,1));
    assert.equal(calls,1);
  } finally { f.close(); }
});
