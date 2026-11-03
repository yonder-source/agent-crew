import { canonicalJson } from "../effects/effect-model.js";
import type { RuntimeTaskStartRequest } from "../execution/runtime-supervisor.js";
import { assertText, StateError, type StateContext } from "../state/state-common.js";

/** Agent-reported data; it is not a verified runtime receipt. */
export type ReportedValidationResult = {
	command: string;
	exitCode: number;
	observedAt: string;
};

export type CandidateSubmissionInput = {
	candidateId: string;
	executionId: string;
	expectedJobVersion: number;
	expectedExecutionVersion: number;
	candidateSha: string;
	baseSha: string;
	sourceBundleId: string;
	reportedValidationResults: ReportedValidationResult[];
	writerGeneration: number;
};

export type CandidateSubmissionRecord = {
	candidateId: string;
	jobId: string;
	executionId: string;
	ownershipGeneration: number;
	repositoryId: string;
	issueId: string;
	scopeRevisionId: string;
	policyVersion: string;
	sourceBundleId: string;
	baseSha: string;
	candidateSha: string;
	reportedValidationResults: ReportedValidationResult[];
	submittedAt: string;
};

type RawCandidateSubmission = {
	candidate_id: string;
	job_id: string;
	execution_id: string;
	ownership_generation: number;
	repository_id: string;
	issue_id: string;
	scope_revision_id: string;
	policy_version: string;
	source_bundle_id: string;
	base_sha: string;
	candidate_sha: string;
	reported_validation_json: string;
	submitted_at: string;
};

type RuntimeLaunchRow = {
	target_json: string;
};

function mapSubmission(row: RawCandidateSubmission): CandidateSubmissionRecord {
	return {
		candidateId: row.candidate_id,
		jobId: row.job_id,
		executionId: row.execution_id,
		ownershipGeneration: row.ownership_generation,
		repositoryId: row.repository_id,
		issueId: row.issue_id,
		scopeRevisionId: row.scope_revision_id,
		policyVersion: row.policy_version,
		sourceBundleId: row.source_bundle_id,
		baseSha: row.base_sha,
		candidateSha: row.candidate_sha,
		reportedValidationResults: JSON.parse(
			row.reported_validation_json,
		) as ReportedValidationResult[],
		submittedAt: row.submitted_at,
	};
}

function validSha(value: string): boolean {
	return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

export class CandidateStore {
	constructor(private readonly state: StateContext) {}

	submit(input: CandidateSubmissionInput): CandidateSubmissionRecord {
		assertText(input.candidateId, "candidateId");
		assertText(input.executionId, "executionId");
		assertText(input.sourceBundleId, "sourceBundleId");
		this.assertPositiveInteger(input.expectedJobVersion, "expectedJobVersion");
		this.assertPositiveInteger(
			input.expectedExecutionVersion,
			"expectedExecutionVersion",
		);
		this.assertPositiveInteger(input.writerGeneration, "writerGeneration");
		if (!validSha(input.candidateSha) || !validSha(input.baseSha)) {
			throw new StateError(
				"INVALID_CANDIDATE_SHA",
				"Candidate and base must be full Git commit SHAs",
			);
		}
		const reportedValidationResults = this.normalizeReportedValidationResults(
			input.reportedValidationResults,
		);

		const existing = this.get(input.candidateId);
		if (existing) {
			if (this.matchesSubmission(existing, input, reportedValidationResults)) {
				return existing;
			}
			throw new StateError(
				"CANDIDATE_ID_CONFLICT",
				"Candidate ID is already bound to different submission data",
			);
		}

		const execution = this.state.getExecutionOrThrow(input.executionId);
		const job = this.state.getJobOrThrow(execution.job_id);
		const occurredAt = this.state.now().toISOString();
		return this.state.runWithStaleAudit(
			job.job_id,
			input.writerGeneration,
			occurredAt,
			"candidate_submission",
			() => {
				this.state.assertWriter(input.writerGeneration, occurredAt);
				const currentJob = this.state.getJobOrThrow(job.job_id);
				const currentExecution = this.state.getExecutionOrThrow(
					input.executionId,
				);
				if (
					currentJob.row_version !== input.expectedJobVersion ||
					currentExecution.row_version !== input.expectedExecutionVersion
				) {
					throw new StateError(
						"STALE_ROW_VERSION",
						"Job or execution changed before candidate submission",
					);
				}
				if (currentExecution.job_id !== currentJob.job_id) {
					throw new StateError(
						"CANDIDATE_EXECUTION_BINDING_MISMATCH",
						"Candidate execution is not bound to its job",
					);
				}
				if (currentExecution.ownership_generation !== input.writerGeneration) {
					throw new StateError(
						"STALE_GENERATION",
						"Candidate was submitted by a replaced execution owner",
					);
				}
				if (currentExecution.lifecycle !== "active") {
					throw new StateError(
						"CANDIDATE_EXECUTION_NOT_CURRENT",
						"Only the current active execution may submit a candidate",
					);
				}
				const launchRequest = this.getConfirmedLaunchRequest(
					input.executionId,
					input.writerGeneration,
				);
				if (
					input.sourceBundleId !== launchRequest.sourceBundleId ||
					input.baseSha.toLowerCase() !==
						launchRequest.sourceCommitSha.toLowerCase() ||
					launchRequest.jobId !== currentJob.job_id ||
					launchRequest.repositoryId !== currentJob.repository_id ||
					launchRequest.issueId !== currentJob.issue_id ||
					launchRequest.scopeRevisionId !== currentJob.scope_revision_id
				) {
					throw new StateError(
						"CANDIDATE_SOURCE_MISMATCH",
						"Candidate source does not match the active execution launch",
					);
				}
				this.assertValidationCommands(
					reportedValidationResults,
					launchRequest.validationCommands,
				);
				const duplicate = this.state.database
					.prepare(
						"SELECT candidate_id FROM candidate_submissions WHERE execution_id = ? AND candidate_sha = ?",
					)
					.get(input.executionId, input.candidateSha.toLowerCase()) as
					| { candidate_id: string }
					| undefined;
				if (duplicate) {
					throw new StateError(
						"CANDIDATE_ALREADY_SUBMITTED",
						"This execution already has a submission for that commit",
					);
				}

				this.state.database
					.prepare(`
					INSERT INTO candidate_submissions (
						candidate_id, job_id, execution_id, ownership_generation,
						repository_id, issue_id, scope_revision_id, policy_version,
						source_bundle_id, base_sha, candidate_sha,
						reported_validation_json, submitted_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
					.run(
						input.candidateId,
						currentJob.job_id,
						currentExecution.execution_id,
						currentExecution.ownership_generation,
						currentJob.repository_id,
						currentJob.issue_id,
						currentJob.scope_revision_id,
						launchRequest.policyVersion,
						input.sourceBundleId,
						input.baseSha.toLowerCase(),
						input.candidateSha.toLowerCase(),
						canonicalJson(reportedValidationResults),
						occurredAt,
					);
				const nextVersion = currentJob.row_version + 1;
				const nextSequence = currentJob.event_sequence + 1;
				this.state.bumpJob(currentJob, nextVersion, nextSequence, occurredAt);
				this.state.insertEvent({
					jobId: currentJob.job_id,
					sequence: nextSequence,
					rowVersion: nextVersion,
					eventType: "candidate_submitted",
					payload: {
						candidateId: input.candidateId,
						executionId: input.executionId,
						candidateSha: input.candidateSha.toLowerCase(),
					},
					writerGeneration: input.writerGeneration,
					occurredAt,
				});
				return this.get(input.candidateId) as CandidateSubmissionRecord;
			},
		);
	}

	get(candidateId: string): CandidateSubmissionRecord | undefined {
		const row = this.state.database
			.prepare("SELECT * FROM candidate_submissions WHERE candidate_id = ?")
			.get(candidateId) as RawCandidateSubmission | undefined;
		return row ? mapSubmission(row) : undefined;
	}

	listForJob(jobId: string): CandidateSubmissionRecord[] {
		return (
			this.state.database
				.prepare(
					"SELECT * FROM candidate_submissions WHERE job_id = ? ORDER BY rowid",
				)
				.all(jobId) as RawCandidateSubmission[]
		).map(mapSubmission);
	}

	latestForJob(jobId: string): CandidateSubmissionRecord | undefined {
		const row = this.state.database
			.prepare("SELECT * FROM candidate_submissions WHERE job_id = ? ORDER BY rowid DESC LIMIT 1")
			.get(jobId) as RawCandidateSubmission | undefined;
		return row ? mapSubmission(row) : undefined;
	}

	private getConfirmedLaunchRequest(
		executionId: string,
		writerGeneration: number,
	): RuntimeTaskStartRequest {
		const row = this.state.database
			.prepare(`
				SELECT s.target_json
				FROM effect_operations o JOIN effect_steps s USING (operation_id)
				WHERE o.execution_id = ? AND o.writer_generation = ?
					AND o.operation_kind = 'runtime_launch'
					AND o.status = 'confirmed_success'
					AND s.step_key = 'launch' AND s.status = 'confirmed_success'
				ORDER BY o.created_at DESC LIMIT 1
			`)
			.get(executionId, writerGeneration) as RuntimeLaunchRow | undefined;
		if (!row) {
			throw new StateError(
				"CANDIDATE_LAUNCH_NOT_CONFIRMED",
				"Candidate requires a confirmed runtime launch",
			);
		}
		try {
			const request = JSON.parse(row.target_json) as RuntimeTaskStartRequest;
			if (
				request.executionId !== executionId ||
				request.ownershipGeneration !== writerGeneration ||
				!Array.isArray(request.validationCommands) ||
				request.validationCommands.length === 0 ||
				request.validationCommands.some(
					(command) =>
						typeof command !== "string" || command.trim() !== command,
				) ||
				!validSha(request.sourceCommitSha) ||
				typeof request.sourceBundleId !== "string" ||
				typeof request.jobId !== "string" ||
				typeof request.repositoryId !== "string" ||
				typeof request.issueId !== "string" ||
				typeof request.scopeRevisionId !== "string" ||
				typeof request.policyVersion !== "string"
			) {
				throw new Error("Runtime launch binding is invalid");
			}
			return request;
		} catch {
			throw new StateError(
				"CANDIDATE_LAUNCH_INVALID",
				"Confirmed runtime launch record is invalid",
			);
		}
	}

	private assertValidationCommands(
		results: ReportedValidationResult[],
		commands: string[],
	): void {
		if (results.length !== commands.length) {
			throw new StateError(
				"CANDIDATE_VALIDATION_INCOMPLETE",
				"Candidate must report each declared validation command exactly once",
			);
		}
		const remaining = new Map<string, number>();
		for (const command of commands) {
			remaining.set(command, (remaining.get(command) ?? 0) + 1);
		}
		for (const result of results) {
			const count = remaining.get(result.command) ?? 0;
			if (count === 0) {
				throw new StateError(
					"CANDIDATE_VALIDATION_MISMATCH",
					"Candidate validation commands do not match the launch profile",
				);
			}
			remaining.set(result.command, count - 1);
		}
		if ([...remaining.values()].some((count) => count > 0)) {
			throw new StateError(
				"CANDIDATE_VALIDATION_INCOMPLETE",
				"Candidate must report each declared validation command exactly once",
			);
		}
	}

	private normalizeReportedValidationResults(
		results: ReportedValidationResult[],
	): ReportedValidationResult[] {
		if (!Array.isArray(results)) {
			throw new StateError(
				"INVALID_CANDIDATE_VALIDATION",
				"Reported validation results must be an array",
			);
		}
		const normalized: ReportedValidationResult[] = [];
		for (const result of results) {
			if (
				result === null ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				typeof result.command !== "string" ||
				typeof result.observedAt !== "string"
			) {
				throw new StateError(
					"INVALID_CANDIDATE_VALIDATION",
					"Reported validation result is malformed",
				);
			}
			assertText(result.command, "validation command");
			if (
				!Number.isSafeInteger(result.exitCode) ||
				result.exitCode < 0 ||
				result.exitCode > 255 ||
				!Number.isFinite(Date.parse(result.observedAt))
			) {
				throw new StateError(
					"INVALID_CANDIDATE_VALIDATION",
					"Reported validation result has an invalid exit code or timestamp",
				);
			}
			normalized.push({
				command: result.command,
				exitCode: result.exitCode,
				observedAt: result.observedAt,
			});
		}
		return normalized;
	}

	private matchesSubmission(
		record: CandidateSubmissionRecord,
		input: CandidateSubmissionInput,
		reportedValidationResults: ReportedValidationResult[],
	): boolean {
		return (
			record.executionId === input.executionId &&
			record.ownershipGeneration === input.writerGeneration &&
			record.candidateSha === input.candidateSha.toLowerCase() &&
			record.baseSha === input.baseSha.toLowerCase() &&
			record.sourceBundleId === input.sourceBundleId &&
			canonicalJson(record.reportedValidationResults) ===
				canonicalJson(reportedValidationResults)
		);
	}

	private assertPositiveInteger(value: number, label: string): void {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new StateError(
				"INVALID_INPUT",
				`${label} must be a positive integer`,
			);
		}
	}
}
