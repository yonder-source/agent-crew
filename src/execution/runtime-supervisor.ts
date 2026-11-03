export type RuntimeLaunchProfile = {
	configurationRevisionId: string;
	runtimeImage: string;
	sourceBundleId: string;
	sourceCommitSha: string;
	workspaceGrantId: string;
	toolGrantId: string;
	networkGrantId: string;
	budgetProfileRevisionId: string;
	validationCommands: string[];
};

export type RuntimeTaskStartRequest = RuntimeLaunchProfile & {
	launchId: string;
	jobId: string;
	repositoryId: string;
	issueId: string;
	executionId: string;
	ownershipGeneration: number;
	scopeRevisionId: string;
	policyVersion: string;
	requestFingerprint: string;
};

export type RuntimeTaskReference = Pick<
	RuntimeTaskStartRequest,
	| "launchId"
	| "jobId"
	| "executionId"
	| "ownershipGeneration"
	| "requestFingerprint"
> & {
	taskId: string;
	status: "starting" | "running" | "stopping" | "stopped";
};

export type RuntimeTaskInspection =
	| { kind: "present"; task: RuntimeTaskReference }
	| { kind: "not_created"; authoritative: true }
	| { kind: "unknown" };

export type RuntimeTaskStartResult =
	| { kind: "accepted"; taskId: string }
	| { kind: "rejected"; reasonCode: string };

export type RuntimeTaskTerminateRequest = Pick<
	RuntimeTaskStartRequest,
	"launchId" | "jobId" | "executionId" | "ownershipGeneration" | "requestFingerprint"
> & {
	operationId: string;
	taskId: string;
};

export type RuntimeTaskTerminateResult =
	| { kind: "accepted" }
	| { kind: "rejected"; reasonCode: string };

export interface RuntimeSupervisor {
	startTask(request: RuntimeTaskStartRequest): Promise<RuntimeTaskStartResult>;
	inspectTask(
		request: Pick<
			RuntimeTaskStartRequest,
			"launchId" | "jobId" | "executionId" | "ownershipGeneration" | "requestFingerprint"
		>,
	): Promise<RuntimeTaskInspection>;
	terminateTask(request: RuntimeTaskTerminateRequest): Promise<RuntimeTaskTerminateResult>;
}
