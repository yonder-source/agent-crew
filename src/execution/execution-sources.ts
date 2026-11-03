import { createHash } from 'node:crypto';
import { openSync, closeSync, fsyncSync, writeFileSync, readFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../effects/effect-model.js';
import type { ExecutionAccounting, RunBinding } from './execution-accounting.js';
import type { ExecutionCommands, ExecutionStopCoordinator } from './execution-controls.js';
import type { SourceArchives, SourceManifest } from './source-archives.js';
import { StateError, type StateContext } from '../state/state-common.js';

export type SourceArtifact = {
  artifactId: string; commandId: string; runId: string; archiveSha256: string; headSha: string;
  bytes: number; kind: 'stopped_checkpoint' | 'handoff'; status: 'writing' | 'verified';
};
type RawArtifact = {
  artifact_id: string; command_id: string; run_id: string; archive_sha256: string; head_sha: string;
  bytes: number; kind: SourceArtifact['kind']; status: SourceArtifact['status'];
};
export type WorkspaceSnapshot = { path: string; taskId: string; readOnly: true };

/** Snapshot resolver and storage root are host-provisioned, outside runtime credentials. */
export class ExecutionSources {
  private readonly root: string;
  constructor(private readonly state: StateContext, private readonly accounting: ExecutionAccounting,
    private readonly commands: ExecutionCommands, private readonly archives: SourceArchives,
    artifactDirectory: string, private readonly snapshot: (run: RunBinding) => WorkspaceSnapshot) {
    mkdirSync(artifactDirectory,{ recursive: true, mode: 0o700 });
    this.root = realpathSync(artifactDirectory);
  }

  get(artifactId: string): SourceArtifact | undefined {
    const row = this.state.database.prepare('SELECT * FROM source_artifacts WHERE artifact_id = ?').get(artifactId) as RawArtifact | undefined;
    return row && { artifactId: row.artifact_id, commandId: row.command_id, runId: row.run_id,
      archiveSha256: row.archive_sha256, headSha: row.head_sha, bytes: row.bytes, kind: row.kind, status: row.status };
  }

  capture(input: { commandId: string; runId: string; writerGeneration: number }): SourceArtifact {
    const run = this.requireRun(input.runId);
    const existing = this.commands.get(input.commandId);
    if (existing) {
      if (existing.runId !== run.runId || existing.kind !== 'checkpoint' ||
          JSON.parse(existing.requestJson).action !== 'capture') throw new StateError('COMMAND_ID_CONFLICT', 'Capture identity has different intent');
      return this.reconcile(input.commandId,input.writerGeneration);
    }
    const snapshot = this.snapshot(run);
    if (snapshot.taskId !== run.taskId || snapshot.readOnly !== true) throw new StateError('WORKSPACE_UNVERIFIED', 'Capture requires a bound read-only source snapshot');
    const storage = relative(realpathSync(snapshot.path),this.root);
    if (storage === '' || (!storage.startsWith(`..${sep}`) && storage !== '..' && !storage.startsWith(sep))) throw new StateError('SOURCE_STORAGE_UNSAFE','Artifacts must be outside source workspace');
    let kind: SourceArtifact['kind'] = 'handoff';
    this.commands.mutate(run.runId,input.writerGeneration,'source_capture_authorized',() => {
      const execution = this.state.getExecutionOrThrow(run.executionId);
      const job = this.state.getJobOrThrow(run.jobId);
      const stop = this.commands.forRun(run.runId,'stop')[0];
      const stopped = stop?.receiptJson && JSON.parse(stop.receiptJson).stopped === true;
      if (stopped) kind = 'stopped_checkpoint';
      else if (execution.lifecycle !== 'active' || execution.ownership_generation !== input.writerGeneration ||
          run.ownershipGeneration !== input.writerGeneration || job.requested_control !== 'run') {
        throw new StateError('SOURCE_CAPTURE_BLOCKED', 'Capture requires a current active owner or verified stopped runtime');
      }
      this.commands.intent(input.commandId,run.runId,'checkpoint',
        { action: 'capture', run, snapshotPath: realpathSync(snapshot.path), kind },input.writerGeneration);
    });
    if (!this.commands.claim(input.commandId,input.writerGeneration)) return this.reconcile(input.commandId,input.writerGeneration);
    const archive = this.archives.capture(snapshot.path);
    const artifactId = 'source:' + createHash('sha256').update(input.commandId).digest('hex');
    this.commands.mutate(run.runId,input.writerGeneration,'source_artifact_planned',() => {
      this.state.database.prepare(`INSERT INTO source_artifacts
        (artifact_id, command_id, run_id, storage_path, archive_sha256, head_sha, bytes, kind, status, writer_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'writing', ?, ?)`)
        .run(artifactId,input.commandId,run.runId,this.path(artifactId),archive.sha256,archive.head,archive.bytes.length,kind,
          input.writerGeneration,this.state.now().toISOString());
    });
    // Expected hash is durable before creating the immutable artifact. A crash
    // leaves writing/unknown evidence; never recapture or overwrite it blindly.
    const descriptor = openSync(this.path(artifactId),'wx',0o600);
    try { writeFileSync(descriptor,archive.bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const directory = openSync(this.root,'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return this.reconcile(input.commandId,input.writerGeneration);
  }

  reconcile(commandId: string, writerGeneration: number): SourceArtifact {
    const command = this.commands.get(commandId);
    if (command?.kind !== 'checkpoint' || JSON.parse(command.requestJson).action !== 'capture') {
      throw new StateError('CAPTURE_NOT_FOUND', 'Source capture intent is unavailable');
    }
    const row = this.state.database.prepare('SELECT artifact_id FROM source_artifacts WHERE command_id = ?').get(commandId) as { artifact_id: string } | undefined;
    if (!row) throw new StateError('SOURCE_CAPTURE_UNCERTAIN', 'Capture has no durable output metadata; inspect source before authorizing a new capture');
    const artifact = this.requireArtifact(row.artifact_id);
    this.verify(artifact.artifactId);
    this.commands.mutate(artifact.runId,writerGeneration,'source_artifact_verified',() => {
      this.state.database.prepare("UPDATE source_artifacts SET status = 'verified' WHERE artifact_id = ?").run(artifact.artifactId);
      this.commands.receipt(commandId,{ artifactId: artifact.artifactId, sha256: artifact.archiveSha256, verified: true },writerGeneration);
    });
    return this.requireArtifact(artifact.artifactId);
  }

  verify(artifactId: string): SourceManifest {
    const artifact = this.requireArtifact(artifactId);
    const path = this.path(artifactId);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes) throw new StateError('SOURCE_ARTIFACT_INVALID', 'Artifact file is missing or its identity or length changed');
    const manifest = this.archives.verify(readFileSync(path),artifact.archiveSha256);
    if (manifest.head !== artifact.headSha) throw new StateError('SOURCE_ARTIFACT_INVALID', 'Artifact HEAD changed');
    return manifest;
  }

  restore(input: { commandId: string; artifactId: string; destination: string; writerGeneration: number }): SourceManifest {
    z.string().min(1).parse(input.destination);
    const artifact = this.requireArtifact(input.artifactId);
    if (artifact.status !== 'verified') throw new StateError('SOURCE_UNVERIFIED', 'Restore requires a verified artifact');
    this.verify(artifact.artifactId);
    this.commands.intent(input.commandId,artifact.runId,'checkpoint',
      { action: 'restore', artifactId: artifact.artifactId, destination: input.destination },input.writerGeneration);
    if (!this.commands.claim(input.commandId,input.writerGeneration)) {
      const stat = lstatSync(input.destination, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('RESTORE_RECONCILIATION_REQUIRED','Restore destination is missing or unsafe');
      const expected = this.verify(artifact.artifactId);
      const observed = this.archives.capture(input.destination);
      const actual = this.archives.verify(observed.bytes,observed.sha256);
      const identity = (value: SourceManifest) => canonicalJson({ head: value.head, headRef: value.headRef, refs: value.refs, files: value.files, index: value.index });
      if (identity(expected) !== identity(actual)) throw new StateError('RESTORE_RECONCILIATION_REQUIRED','Prior destination does not match source artifact');
      this.commands.receipt(input.commandId,{ restored: true, artifactId: artifact.artifactId, destination: input.destination, head: actual.head },input.writerGeneration);
      return actual;
    }
    const restored = this.archives.restore(readFileSync(this.path(artifact.artifactId)),artifact.archiveSha256,input.destination);
    this.commands.receipt(input.commandId,{ restored: true, artifactId: artifact.artifactId, destination: input.destination, head: restored.head },input.writerGeneration);
    return restored;
  }

  async settle(runId: string, artifactId: string, stops: ExecutionStopCoordinator, writerGeneration: number): Promise<void> {
    const run = this.requireRun(runId);
    const stop = this.commands.forRun(runId,'stop')[0];
    if (!stop || !(await stops.reconcile(stop.commandId,writerGeneration)).stopped) throw new StateError('TERMINATION_UNVERIFIED', 'Runtime termination is not confirmed');
    const artifact = this.requireArtifact(artifactId);
    if (artifact.runId !== runId || artifact.kind !== 'stopped_checkpoint' || artifact.status !== 'verified') {
      throw new StateError('CHECKPOINT_REQUIRED', 'Settlement requires this stopped runtime source');
    }
    this.verify(artifactId);
    this.commands.mutate(runId,writerGeneration,'execution_source_settled',() => {
      const unresolved = this.state.database.prepare(`SELECT 1 FROM effect_operations o JOIN effect_steps s USING(operation_id)
        WHERE o.execution_id = ? AND s.status IN ('pending','unknown') LIMIT 1`).get(run.executionId);
      const commands = this.state.database.prepare(`SELECT 1 FROM execution_commands c JOIN execution_runs r USING(run_id)
        WHERE r.execution_id = ? AND c.started = 1 AND c.receipt_json IS NULL LIMIT 1`).get(run.executionId);
      if (unresolved || commands) throw new StateError('EFFECTS_UNRESOLVED', 'Execution effects require reconciliation before replacement');
      this.state.database.prepare(`INSERT INTO execution_settlements
        (execution_id, stop_command_id, artifact_id, settled_generation, settled_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(execution_id) DO UPDATE SET stop_command_id=excluded.stop_command_id,
          artifact_id=excluded.artifact_id, settled_generation=excluded.settled_generation, settled_at=excluded.settled_at`)
        .run(run.executionId,stop.commandId,artifactId,writerGeneration,this.state.now().toISOString());
    });
  }

  private path(artifactId: string): string { return join(this.root,createHash('sha256').update(artifactId).digest('hex')+'.json.gz'); }
  private requireRun(runId: string): RunBinding {
    const run = this.accounting.getRun(runId);
    if (!run) throw new StateError('RUN_NOT_FOUND','Run binding unavailable');
    return run;
  }
  private requireArtifact(artifactId: string): SourceArtifact {
    const artifact = this.get(artifactId);
    if (!artifact) throw new StateError('SOURCE_NOT_FOUND','Source artifact unavailable');
    return artifact;
  }
}
