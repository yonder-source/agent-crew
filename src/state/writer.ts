import type Database from 'better-sqlite3';
import { StateError } from './state-common.js';

export type WriterStatus = 'recovering' | 'healthy' | 'unhealthy' | 'stopped';

type RawWriter = {
  generation: number;
  status: WriterStatus;
  heartbeat_at: string | null;
};

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3;

export class WriterCoordinator {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    private readonly database: Database.Database,
    readonly generation: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static async start(
    database: Database.Database,
    recover: (generation: number) => void | Promise<void> = () => undefined,
    now: () => Date = () => new Date(),
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  ): Promise<WriterCoordinator> {
    const startedAt = now().toISOString();
    const generation = database.transaction(() => {
      const current = database.prepare(
        'SELECT generation FROM controller_writer WHERE singleton_id = 1',
      ).get() as { generation: number };
      const nextGeneration = current.generation + 1;
      database.prepare(`
        UPDATE controller_writer
        SET generation = ?, status = 'recovering', heartbeat_at = ?, updated_at = ?
        WHERE singleton_id = 1
      `).run(nextGeneration, startedAt, startedAt);
      return nextGeneration;
    }).immediate();

    const coordinator = new WriterCoordinator(database, generation, now);
    try {
      await recover(generation);
      coordinator.markHealthy();
      coordinator.heartbeatTimer = setInterval(() => coordinator.heartbeat(), heartbeatIntervalMs);
      coordinator.heartbeatTimer.unref();
      return coordinator;
    } catch (error) {
      coordinator.stop();
      throw error;
    }
  }

  status(): { generation: number; status: WriterStatus; heartbeatAt: string | null } {
    const row = this.database.prepare(
      'SELECT generation, status, heartbeat_at FROM controller_writer WHERE singleton_id = 1',
    ).get() as RawWriter;
    return { generation: row.generation, status: row.status, heartbeatAt: row.heartbeat_at };
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const stoppedAt = this.now().toISOString();
    this.database.prepare(`
      UPDATE controller_writer SET status = 'stopped', updated_at = ?
      WHERE singleton_id = 1 AND generation = ?
    `).run(stoppedAt, this.generation);
  }

  private markHealthy(): void {
    const healthyAt = this.now().toISOString();
    const result = this.database.prepare(`
      UPDATE controller_writer SET status = 'healthy', heartbeat_at = ?, updated_at = ?
      WHERE singleton_id = 1 AND generation = ? AND status = 'recovering'
    `).run(healthyAt, healthyAt, this.generation);
    if (result.changes !== 1) throw new StateError('WRITER_START_FAILED', 'Writer generation changed during recovery');
  }

  private heartbeat(): void {
    if (this.closed) return;
    const heartbeatAt = this.now().toISOString();
    const current = this.status();
    if (current.generation !== this.generation || current.status !== 'healthy' || !current.heartbeatAt) {
      this.stopHeartbeat();
      return;
    }
    const age = Date.parse(heartbeatAt) - Date.parse(current.heartbeatAt);
    if (!Number.isFinite(age) || age >= HEARTBEAT_TIMEOUT_MS) {
      this.database.prepare(`
        UPDATE controller_writer SET status = 'unhealthy', updated_at = ?
        WHERE singleton_id = 1 AND generation = ? AND status = 'healthy'
      `).run(heartbeatAt, this.generation);
      this.stopHeartbeat();
      return;
    }
    this.database.prepare(`
      UPDATE controller_writer SET heartbeat_at = ?, updated_at = ?
      WHERE singleton_id = 1 AND generation = ? AND status = 'healthy'
    `).run(heartbeatAt, heartbeatAt, this.generation);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
