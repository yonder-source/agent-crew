import { canonicalJson } from './effect-model.js';
import type { StateContext } from './state-common.js';

export class EffectAuditLog {
  constructor(private readonly state: StateContext) {}

  append(
    operationId: string,
    eventType: string,
    payload: unknown,
    generation: number,
    occurredAt: string,
    initial = false,
  ): void {
    const operation = this.state.database.prepare(
      'SELECT event_sequence FROM effect_operations WHERE operation_id = ?',
    ).get(operationId) as { event_sequence: number };
    const sequence = operation.event_sequence + (initial ? 0 : 1);
    if (!initial) {
      this.state.database.prepare(`
        UPDATE effect_operations SET event_sequence = ?, row_version = row_version + 1, updated_at = ?
        WHERE operation_id = ?
      `).run(sequence, occurredAt, operationId);
    }
    this.state.database.prepare(`
      INSERT INTO effect_audit_events (
        operation_id, sequence, event_type, payload_json, writer_generation, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(operationId, sequence, eventType, canonicalJson(payload), generation, occurredAt);
  }
}
