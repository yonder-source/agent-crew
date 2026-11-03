import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGuardFixture } from '../../tests/fixtures/execution-guard-fixture.js';
import { ExecutionCommands, ExecutionStopCoordinator, type ExecutionControlSupervisor } from '../../src/execution/execution-controls.js';
import { ExecutionSources } from '../../src/execution/execution-sources.js';
import { SourceArchives } from '../../src/execution/source-archives.js';

export async function createSourceFixture() {
  const f = await createGuardFixture();
  const workspace = join(f.directory,'workspace');
  mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args],
    { cwd: workspace, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
  git('init','--template=','--initial-branch=task');
  writeFileSync(join(workspace,'task.txt'),'source\n');
  git('add','.'); git('commit','-m','source');
  const archives = new SourceArchives({ scratchDirectory: join(f.directory,'scratch'), maxArchiveBytes: 1000000,
    maxExpandedBytes: 4000000, maxFiles: 1000, gitTimeoutMs: 5000, excludedPaths: [] });
  const commands = new ExecutionCommands(f.state,f.accounting);
  const supervisor: ExecutionControlSupervisor = { ...f.supervisor,
    async terminateInference() {}, async inspectInference() { return 'stopped'; },
    async configureDeadline() { throw new Error('no deadline'); }, async inspectDeadline() { return null; } };
  const stops = new ExecutionStopCoordinator(f.state,f.accounting,f.launcher,commands,supervisor,50);
  const sources = new ExecutionSources(f.state,f.accounting,commands,archives,join(f.directory,'artifacts'),
    run => ({ path: workspace, taskId: run.taskId, readOnly: true }));
  return { ...f, workspace, archives, commands, supervisor, stops, sources, git,
    async stop() {
      const job = f.jobs.get('job-1'); const execution = f.executions.get('execution-1'); assert.ok(job && execution);
      const command = stops.request({ runId: f.run.runId, reason: 'checkpoint', control: 'pause',
        authority: { actor: 'human:1', grantId: 'stop', action: 'execution.stop' },
        expectedJobVersion: job.rowVersion, expectedExecutionVersion: execution.rowVersion, writerGeneration: 1 });
      await stops.dispatch(command.commandId,1); f.setStatus('stopped'); await stops.reconcile(command.commandId,1);
      return command;
    } };
}

