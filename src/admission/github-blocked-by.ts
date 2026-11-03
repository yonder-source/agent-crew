import { StateError } from "../state/state-common.js";
import type { DiscoveryDependencySnapshot } from "./discovery.js";

type GitHubBlockedIssue = {
	number: number;
	repository_url: string;
};

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export class GitHubBlockedByReader {
	private readonly repositoryUrl: string;
	private readonly maxGraphNodes: number;

	constructor(
		private readonly owner: string,
		private readonly repository: string,
		private readonly getInstallationToken: () => Promise<string>,
		private readonly fetcher: Fetcher = fetch,
		maxGraphNodes = 500,
	) {
		if (!owner.trim() || !repository.trim())
			throw new StateError(
				"INVALID_INPUT",
				"GitHub repository binding is required",
			);
		if (!Number.isSafeInteger(maxGraphNodes) || maxGraphNodes < 1)
			throw new StateError(
				"INVALID_INPUT",
				"Dependency graph limit must be positive",
			);
		this.repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
		this.maxGraphNodes = maxGraphNodes;
	}

	async readBlockedBy(
		repositoryId: string,
		issueId: string,
	): Promise<DiscoveryDependencySnapshot> {
		if (repositoryId !== `${this.owner}/${this.repository}`)
			throw new StateError(
				"REPOSITORY_BINDING_MISMATCH",
				"GitHub dependency reader is bound to another repository",
			);
		const graph: Record<string, string[]> = {};
		const visited = new Set<string>();
		const visit = async (currentIssueId: string): Promise<void> => {
			if (visited.has(currentIssueId)) return;
			if (visited.size >= this.maxGraphNodes)
				throw new StateError(
					"DEPENDENCY_GRAPH_TOO_LARGE",
					"Native dependency graph exceeds the configured read limit",
				);
			visited.add(currentIssueId);
			const dependencies = await this.listOneIssueBlockedBy(currentIssueId);
			graph[currentIssueId] = dependencies;
			for (const dependencyId of dependencies) await visit(dependencyId);
		};
		await visit(issueId);
		return {
			source: "github_blocked_by",
			issueIds: graph[issueId] ?? [],
			graph,
			completionEvidence: {},
		};
	}

	private async listOneIssueBlockedBy(issueId: string): Promise<string[]> {
		const issueNumber = Number(issueId);
		if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
			throw new StateError(
				"INVALID_INPUT",
				"GitHub issue IDs must be positive issue numbers",
			);
		const dependencies: string[] = [];
		let page = 1;
		while (true) {
			const url = new URL(
				`${this.repositoryUrl}/issues/${issueNumber}/dependencies/blocked_by`,
			);
			url.searchParams.set("per_page", "100");
			url.searchParams.set("page", String(page));
			const token = await this.getInstallationToken();
			const response = await this.fetcher(url.toString(), {
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2026-03-10",
				},
			});
			if (!response.ok)
				throw new StateError(
					"GITHUB_DEPENDENCY_READ_FAILED",
					"GitHub blocked_by read failed",
				);
			const rows = (await response.json()) as GitHubBlockedIssue[];
			for (const row of rows) {
				if (
					!Number.isSafeInteger(row.number) ||
					new URL(row.repository_url).toString() !== this.repositoryUrl
				)
					throw new StateError(
						"DEPENDENCY_REPOSITORY_MISMATCH",
						"GitHub blocked_by returned an issue outside the bound repository",
					);
				dependencies.push(String(row.number));
			}
			if (!this.hasNextPage(response.headers.get("link"))) break;
			page += 1;
		}
		return [...new Set(dependencies)].sort(
			(left, right) => Number(left) - Number(right),
		);
	}

	private hasNextPage(linkHeader: string | null): boolean {
		return (
			linkHeader?.split(",").some((entry) => /rel="next"/.test(entry)) ?? false
		);
	}
}
