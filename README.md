# Agent Crew

Agent Crew coordinates development agents under human supervision, from
clarifying GitHub issues to preparing pull requests for review. OpenClaw
provides agent sessions and Slack integration. The Controller manages
workflow, permissions and recovery.

**Status:** Specification draft; runnable Controller foundation established.

- [Specification](spec.md) — requirements and acceptance criteria
- [Architecture](docs/architecture.md) — components and trust boundaries
- [Architecture decisions](docs/adr/README.md) — key choices and trade-offs

## Run locally

Use Docker with the pinned Node.js 22.23.1 image. Build and run the Controller
with a persistent state volume:

```sh
docker build -t agent-crew:local .
docker run --rm --name agent-crew -p 3000:3000 -v agent-crew-state:/data agent-crew:local
```

The `/healthz` endpoint reports startup and SQLite schema readiness. Configuration
uses `HOST`, `PORT`, `DATABASE_PATH`, `LOCK_PATH` and `LOG_LEVEL`; see
[`.env.example`](.env.example). Startup acquires an OS-level `flock` for the
process lifetime so only one Controller can write the database. This foundation
does not require GitHub, Slack or model credentials.

Run the source checks in the same pinned Node image:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace node:22.23.1-bookworm-slim sh -lc 'npm ci && npm run check'
```

Licensed under the [MIT License](LICENSE).
