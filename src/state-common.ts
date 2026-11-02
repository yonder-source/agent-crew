import type Database from "better-sqlite3";

export type JobControl = "run" | "pause" | "cancel";
export type ExecutionLifecycle =
	| "reserved"
	| "starting"
	| "active"
	| "stopping"
	| "terminal";
export type UsageCoverage = "observed" | "partial" | "unknown";

export type JobRecord = {
	jobId: string;
	repositoryId: string;
	issueId: string;
	scopeRevisionId: string;
	phase: string;
	requestedControl: JobControl;
	rowVersion: number;
	eventSequence: number;
	createdAt: string;
	updatedAt: string;
};

export type ExecutionRecord = {
	executionId: string;
	jobId: string;
	ownershipGeneration: number;
	lifecycle: ExecutionLifecycle;
	terminalOutcome: string | null;
	rowVersion: number;
	createdAt: string;
	updatedAt: string;
};

export type JobEvent = {
	eventId: number;
	jobId: string;
	sequence: number;
	rowVersion: number;
	eventType: string;
	payloadJson: string;
	writerGeneration: number;
	occurredAt: string;
};

export type RawJob = {
	job_id: string;
	repository_id: string;
	issue_id: string;
	scope_revision_id: string;
	phase: string;
	requested_control: JobControl;
	row_version: number;
	event_sequence: number;
	created_at: string;
	updated_at: string;
};

export type RawExecution = {
	execution_id: string;
	job_id: string;
	ownership_generation: number;
	lifecycle: ExecutionLifecycle;
	terminal_outcome: string | null;
	row_version: number;
	created_at: string;
	updated_at: string;
};

type RawWriter = {
	generation: number;
	status: string;
	heartbeat_at: string | null;
};

type RawEvent = {
	event_id: number;
	job_id: string;
	sequence: number;
	row_version: number;
	event_type: string;
	payload_json: string;
	writer_generation: number;
	occurred_at: string;
};

export class StateError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StateError";
	}
}

const MAX_HEARTBEAT_AGE_MS = 15_000;

export function assertText(value: string, label: string): void {
	if (value.length === 0 || value.trim() !== value) {
		throw new StateError(
			"INVALID_INPUT",
			`${label} must be a non-empty trimmed string`,
		);
	}
}

export function serialize(value: unknown): string {
	try {
		const serialized = JSON.stringify(value ?? {});
		if (serialized === undefined)
			throw new Error("JSON value is not serializable");
		return serialized;
	} catch {
		throw new StateError(
			"INVALID_INPUT",
			"Event payload must be JSON serializable",
		);
	}
}

export function mapJob(row: RawJob): JobRecord {
	return {
		jobId: row.job_id,
		repositoryId: row.repository_id,
		issueId: row.issue_id,
		scopeRevisionId: row.scope_revision_id,
		phase: row.phase,
		requestedControl: row.requested_control,
		rowVersion: row.row_version,
		eventSequence: row.event_sequence,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function mapExecution(row: RawExecution): ExecutionRecord {
	return {
		executionId: row.execution_id,
		jobId: row.job_id,
		ownershipGeneration: row.ownership_generation,
		lifecycle: row.lifecycle,
		terminalOutcome: row.terminal_outcome,
		rowVersion: row.row_version,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function mapEvent(row: RawEvent): JobEvent {
	return {
		eventId: row.event_id,
		jobId: row.job_id,
		sequence: row.sequence,
		rowVersion: row.row_version,
		eventType: row.event_type,
		payloadJson: row.payload_json,
		writerGeneration: row.writer_generation,
		occurredAt: row.occurred_at,
	};
}

export class StateContext {
	constructor(
		readonly database: Database.Database,
		readonly now: () => Date = () => new Date(),
	) {}

	assertWriter(generation: number, now: string): void {
		const row = this.database
			.prepare(
				"SELECT generation, status, heartbeat_at FROM controller_writer WHERE singleton_id = 1",
			)
			.get() as RawWriter | undefined;
		if (!row || row.generation !== generation) {
			throw new StateError(
				"STALE_GENERATION",
				"Writer generation is not current",
			);
		}
		if (row.status !== "healthy" || !row.heartbeat_at) {
			throw new StateError(
				"WRITER_UNHEALTHY",
				"Controller writer is not healthy",
			);
		}
		const heartbeatAge = Date.parse(now) - Date.parse(row.heartbeat_at);
		if (
			!Number.isFinite(heartbeatAge) ||
			heartbeatAge >= MAX_HEARTBEAT_AGE_MS
		) {
			throw new StateError("WRITER_UNHEALTHY", "Controller heartbeat is stale");
		}
	}

	getJobOrThrow(jobId: string): RawJob {
		const row = this.database
			.prepare("SELECT * FROM jobs WHERE job_id = ?")
			.get(jobId) as RawJob | undefined;
		if (!row) throw new StateError("JOB_NOT_FOUND", "Job does not exist");
		return row;
	}

	getExecutionOrThrow(executionId: string): RawExecution {
		const row = this.database
			.prepare("SELECT * FROM executions WHERE execution_id = ?")
			.get(executionId) as RawExecution | undefined;
		if (!row)
			throw new StateError("EXECUTION_NOT_FOUND", "Execution does not exist");
		return row;
	}

	bumpJob(
		job: RawJob,
		rowVersion: number,
		eventSequence: number,
		updatedAt: string,
	): void {
		this.database
			.prepare(`
      UPDATE jobs SET row_version = ?, event_sequence = ?, updated_at = ?
      WHERE job_id = ? AND row_version = ?
    `)
			.run(rowVersion, eventSequence, updatedAt, job.job_id, job.row_version);
	}

	insertEvent(input: {
		jobId: string;
		sequence: number;
		rowVersion: number;
		eventType: string;
		payload: unknown;
		writerGeneration: number;
		occurredAt: string;
	}): void {
		this.database
			.prepare(`
      INSERT INTO job_events (
        job_id, sequence, row_version, event_type, payload_json, writer_generation, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				input.jobId,
				input.sequence,
				input.rowVersion,
				input.eventType,
				serialize(input.payload),
				input.writerGeneration,
				input.occurredAt,
			);
	}

	appendRejectedEvent(
		job: RawJob,
		operation: string,
		generation: number,
		error: StateError,
		occurredAt: string,
	): void {
		const sequence = job.event_sequence + 1;
		this.database
			.prepare("UPDATE jobs SET event_sequence = ? WHERE job_id = ?")
			.run(sequence, job.job_id);
		this.insertEvent({
			jobId: job.job_id,
			sequence,
			rowVersion: job.row_version,
			eventType: `${operation}_rejected_${error.code.toLowerCase()}`,
			payload: { code: error.code, message: error.message },
			writerGeneration: generation,
			occurredAt,
		});
	}

	runWithStaleAudit<T>(
		jobId: string,
		generation: number,
		occurredAt: string,
		operation: string,
		action: () => T,
		recordRejection?: (error: StateError) => void,
	): T {
		try {
			return this.database.transaction(action).immediate();
		} catch (error) {
			if (
				!(error instanceof StateError) ||
				!["STALE_GENERATION", "STALE_ROW_VERSION", "WRITER_UNHEALTHY"].includes(
					error.code,
				)
			) {
				throw error;
			}
			try {
				this.database
					.transaction(() => {
						if (error.code === "WRITER_UNHEALTHY") {
							this.database
								.prepare(`
              UPDATE controller_writer SET status = 'unhealthy', updated_at = ?
              WHERE singleton_id = 1 AND generation = ? AND status = 'healthy'
            `)
								.run(occurredAt, generation);
						}
						const job = this.getJobOrThrow(jobId);
						this.appendRejectedEvent(
							job,
							operation,
							generation,
							error,
							occurredAt,
						);
						recordRejection?.(error);
					})
					.immediate();
			} catch {
				throw new StateError(
					"AUDIT_UNAVAILABLE",
					"Rejected state mutation could not be recorded",
				);
			}
			throw error;
		}
	}

	runWithIntakeRejectionAudit<T>(input: {
		repositoryId: string | null;
		issueId: string | null;
		operationId: string;
		operation: string;
		generation: number;
		action: () => T;
	}): T {
		try {
			return this.database.transaction(input.action).immediate();
		} catch (error) {
			if (
				!(error instanceof StateError) ||
				!["STALE_GENERATION", "STALE_ROW_VERSION", "WRITER_UNHEALTHY"].includes(
					error.code,
				)
			) {
				throw error;
			}
			try {
				this.database
					.transaction(() => {
						const rejectedAt = this.now().toISOString();
						const writer = this.database
							.prepare(
								"SELECT generation, status FROM controller_writer WHERE singleton_id = 1",
							)
							.get() as { generation: number; status: string } | undefined;
						if (
							error.code === "WRITER_UNHEALTHY" &&
							writer?.status === "healthy"
						) {
							this.database
								.prepare(`
              UPDATE controller_writer SET status = 'unhealthy', updated_at = ?
              WHERE singleton_id = 1 AND generation = ?
            `)
								.run(rejectedAt, writer.generation);
						}
						this.database
							.prepare(`
            INSERT INTO intake_rejection_events (
              repository_id, issue_id, operation_id, operation, submitted_generation,
              current_generation, reason_code, rejected_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
							.run(
								input.repositoryId,
								input.issueId,
								input.operationId,
								input.operation,
								input.generation,
								writer?.generation ?? 0,
								error.code,
								rejectedAt,
							);
					})
					.immediate();
			} catch {
				throw new StateError(
					"AUDIT_UNAVAILABLE",
					"Rejected intake mutation could not be recorded",
				);
			}
			throw error;
		}
	}
}
