# Durable state kernel

The Controller's state kernel uses one SQLite writer, short synchronous
transactions and version checks. The supported startup command is
`node scripts/start.mjs`; it acquires the installation's nonblocking `flock`
before starting Node. Keep the lock file on the same host-local persistent
volume as the database.

## Writer lifecycle

After the lock is held, startup increments `controller_writer.generation` and
sets the writer to `recovering`. Recovery marks started effect steps owned by
an earlier generation as `unknown`; intents with no start claim remain pending.
It records each classification before dependent work is reopened. Only after
that pass succeeds does the writer become `healthy` and the HTTP listener
start. Heartbeats run every five seconds;
three missed intervals latch the writer to `unhealthy`. That state rejects
claims, intent writes and result writes without enabling takeover.

A planned replacement stops new claims and effect starts, waits for in-flight
work, shuts down the Controller and verifies process exit and lock release.
For an unresponsive process, an authorized operator must stop it and verify
both process exit and lock release before starting a replacement. Heartbeat
age and PID absence alone never authorize replacement.

## State records

- `JobStore` creates one stable job per repository and issue, applies
  row-version-fenced phase/control/scope updates, and records blockers.
- `ExecutionStore` reserves at most one live execution per job, enforces the
  lifecycle and ownership generation, and stores versioned cumulative usage.
- `EffectStore.begin` persists an operation identity, argument fingerprint,
  target, expected job/execution/scope/policy versions, authorization evidence,
  step identities and the intent audit event in one transaction. The caller
  must commit this intent before invoking an adapter.
- `EffectStore.claimStepStart` atomically claims one pending step after its
  dependencies are confirmed successful. It rechecks job control, scope,
  execution version/lifecycle/ownership and matching unknown operations inside
  the claim transaction. Paused or cancelled jobs, stopping/terminal executions
  and replaced operations cannot start steps. Duplicate start claims return false.
  An identical operation identity and command return
  the existing state. Changed command or authorization data under the same
  identity is audited and rejected.
- A matching action remains blocked while an earlier operation is unknown.
  Replacing it requires a new operation identity, a fresh authorization record
  and a `replacementForOperationId` link to the single unresolved operation
  that has no replacement. Each predecessor accepts one successor; a successor
  with an unknown outcome can itself be explicitly replaced. The predecessor's
  result stays in history, while the successor determines the unknown-outcome
  barrier. `EffectStore.get` exposes the successor as `replacementOperationId`.
- `EffectResultStore.recordResult` records a provider receipt or reconciliation
  using the expected step version and current writer generation. A late result
  from an older generation is appended to audit history and cannot change the
  current step state. Unknown results remain visible until current-generation
  reconciliation confirms success or failure. Every accepted result is also
  appended with its receipt and any previous observation, so reconciliation
  cannot erase earlier evidence.
- `EffectResultStore.retryStep` accepts only a confirmed failure classified by
  the adapter as a safe read or confirmed not applied. It preserves the prior
  result in audit history and queues another start with the same operation and
  step identities; adapters own retry counts, backoff and jitter.

Rejected stale intents, starts, results and retries are recorded in the job
event stream and, for an existing operation, its effect audit stream in one
transaction. Stale result rejections retain the submitted receipt as history.
If that audit transaction fails, the call reports `AUDIT_UNAVAILABLE`.

Authorization evidence and effect results are separate immutable/observed
records. Audit history is append-only. Persist only structured receipts and
verification evidence needed for reconciliation; do not place credentials or
unfiltered request bodies in audit payloads.

## Migrations and checks

Add ordered schema changes to `controllerMigrations` in `src/migrations.ts`.
Do not edit an applied migration; add the next version and cover rollback,
reopen and constraint behavior in temporary-database tests. `openDatabase`
verifies WAL mode, `synchronous=FULL`, foreign keys and the busy timeout before
applying migrations.

Run repository checks in the pinned Docker image:

```sh
docker build -f Dockerfile.check -t agent-crew-check:local .
docker run --rm agent-crew-check:local
```

Tests use isolated temporary SQLite files and local child processes. They do
not contact GitHub, Slack, OpenClaw or a model provider.
