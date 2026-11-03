import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { StateError, type StateContext } from '../state/state-common.js';

/** Lifecycle flags cannot substitute for stopped-task and source/effect evidence. */
export function assertExecutionSettled(state: StateContext, executionId: string): void {
  const launched = state.database.prepare(`SELECT 1 FROM effect_operations o JOIN effect_steps s USING(operation_id)
    WHERE o.execution_id = ? AND o.operation_kind = 'runtime_launch' AND s.started_at IS NOT NULL
      AND (s.status <> 'confirmed_failure' OR json_extract(s.result_json, '$.taskId') IS NOT NULL) LIMIT 1`).get(executionId);
  if (!launched) return;
  const settled = state.database.prepare(`SELECT a.storage_path, a.archive_sha256, a.bytes FROM execution_settlements e
    JOIN execution_commands c ON c.command_id = e.stop_command_id
    JOIN source_artifacts a ON a.artifact_id = e.artifact_id
    JOIN execution_runs r ON r.run_id = c.run_id
    WHERE e.execution_id = ? AND r.execution_id = e.execution_id AND a.run_id = c.run_id
      AND a.kind = 'stopped_checkpoint' AND a.status = 'verified'
      AND c.kind = 'stop' AND c.started = 1 AND json_extract(c.receipt_json, '$.stopped') = 1`).get(executionId) as { storage_path: string; archive_sha256: string; bytes: number } | undefined;
  const unresolved = state.database.prepare(`SELECT 1 FROM effect_operations o JOIN effect_steps s USING(operation_id)
    WHERE o.execution_id = ? AND s.status IN ('pending','unknown') LIMIT 1`).get(executionId);
  const commands = state.database.prepare(`SELECT 1 FROM execution_commands c JOIN execution_runs r USING(run_id)
    WHERE r.execution_id = ? AND c.receipt_json IS NULL LIMIT 1`).get(executionId);
  let intact = false;
  if (settled) {
    try {
      const stat = lstatSync(settled.storage_path);
      intact = stat.isFile() && !stat.isSymbolicLink() && stat.size === settled.bytes &&
        createHash('sha256').update(readFileSync(settled.storage_path)).digest('hex') === settled.archive_sha256;
    } catch { /* Missing or inaccessible source blocks replacement. */ }
  }
  if (!intact || unresolved || commands) throw new StateError('EXECUTION_UNSETTLED',
    'Verified termination, stopped-source checkpoint and reconciled effects are required');
}
