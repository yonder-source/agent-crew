import assert from "node:assert/strict";
import test from "node:test";
import { GitHubBlockedByReader } from "./github-blocked-by.js";

test("reads native blocked_by relationships from GitHub and follows their graph", async () => {
	const requests: string[] = [];
	const reader = new GitHubBlockedByReader(
		"octo-org",
		"agent-crew",
		async () => "short-lived-token",
		async (url, init) => {
			requests.push(url);
			assert.equal(init.method, "GET");
			assert.equal(
				new Headers(init.headers).get("authorization"),
				"Bearer short-lived-token",
			);
			const body = url.includes("/issues/12/")
				? [
						{
							number: 34,
							repository_url:
								"https://api.github.com/repos/octo-org/agent-crew",
						},
					]
				: [];
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	);

	const result = await reader.readBlockedBy("octo-org/agent-crew", "12");
	assert.deepEqual(result, {
		source: "github_blocked_by",
		issueIds: ["34"],
		graph: { "12": ["34"], "34": [] },
		completionEvidence: {},
	});
	assert.equal(requests.length, 2);
	assert.ok(
		requests.every((url) =>
			url.includes("/dependencies/blocked_by?per_page=100"),
		),
	);
});

test("rejects a dependency response for a different repository", async () => {
	const reader = new GitHubBlockedByReader(
		"octo-org",
		"agent-crew",
		async () => "short-lived-token",
		async () =>
			new Response(
				JSON.stringify([
					{
						number: 34,
						repository_url: "https://api.github.com/repos/other/repository",
					},
				]),
				{ status: 200 },
			),
	);
	await assert.rejects(reader.readBlockedBy("octo-org/agent-crew", "12"), {
		code: "DEPENDENCY_REPOSITORY_MISMATCH",
	});
});
