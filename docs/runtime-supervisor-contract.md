# Runtime supervisor contract

**Status:** Proposed Controller interface for WBS4. No live adapter or runtime
integration is selected or enabled.

## Boundary

The Controller calls a trusted supervisor through the `RuntimeSupervisor`
interface. The supervisor alone holds the authority to create, inspect, and
terminate isolated runtime tasks. Coding tasks receive no Docker or Swarm
administration socket, host credentials, publication credentials, or supervisor
credentials. A runtime profile is a Controller-provided, versioned snapshot;
this interface does not define who may edit or approve that configuration.

The request binds a launch to its job, repository, issue, execution, ownership
generation, scope revision, policy version, configuration revision, pinned
runtime image, source bundle and full commit, workspace/tool/network grants,
budget profile, and declared validation commands. Its canonical fingerprint is
the supervisor lookup and idempotency key alongside `launchId`.

The live supervisor must authenticate the Controller and authorize the exact
execution, generation, configuration revision, and grant IDs before creating
any task. It resolves grants against operator-installed policy and rejects
missing, stale, incompatible, or unenforceable grants. A grant ID or a caller's
fingerprint alone is not evidence of enforcement. The Controller copies only
declared profile fields; configuration objects cannot override job identities.

The supervisor enforces non-root execution, approved source/image identity,
workspace mounts, process/tool permissions, and outbound destinations outside
the model. It excludes host homes, other-job files, management networks, Docker
sockets, and infrastructure/publication credentials, including from subprocesses
and package scripts. Inspection must verify the actual task configuration
against the accepted launch fingerprint, rather than merely echoing request
fields. T05 qualification must demonstrate these properties with the selected
installation; fake-supervisor tests cannot prove isolation.

## Operations and outcomes

- `startTask` is idempotent for the same launch ID and request fingerprint. A
  repeated ID with different content is rejected without creating a task. An
  `accepted` response identifies the task but does not prove it is running. A
  `rejected` response means the supervisor authoritatively did not create a
  task.
- `inspectTask` looks up the exact launch binding. `present` returns the task
  identity, status, launch ID, job and execution IDs, ownership generation, and
  request fingerprint. `not_created` is allowed only when the supervisor can
  authoritatively establish that no task was created. `unknown` carries no
  retry permission.
- `terminateTask` is idempotent for its operation ID and exact task binding. An
  `accepted` response means termination was requested, not completed. The
  Controller must inspect until the exact task is confirmed stopped before
  treating termination as complete or permitting replacement work.

Live adapters must apply finite, configured transport timeouts to every
operation. Timeout leaves the outcome unknown; an underlying supervisor action
may still finish. Elapsed time never proves non-creation or permits resending
start. Runtime active-time deadlines are separate supervisor controls in 4.2.

Supervisor adapters must validate provider responses before returning these
typed outcomes. Transport errors, malformed responses, stale task generations,
or mismatched fingerprints are unknown outcomes and must not activate an
execution or authorize another task.

## Controller ordering

The Controller stores the effect intent, stable step identity, request
fingerprint, and audit evidence before calling `startTask`; it performs no
network or supervisor call inside a SQLite transaction. It inspects after an
accepted response and activates only when inspection proves that the matching
task is running and the current execution transition still passes ownership,
issue/readiness, and job-control checks. Lost responses and uncertain
inspections remain unknown and are reconciled by the same launch identity
without resending start. Conflicting observations are retained for operator
resolution rather than replacing a confirmed outcome.

The Controller persists an accepted task ID before inspection and retains it
through unknown observations and reconciliation. Every later observation must
agree with that identity, including after a confirmed receipt. The append-only
audit retains accepted and conflicting inspection payloads with their source
and Controller timestamp. A definitive failure is replayed with its original
reason, task identity, and terminal outcome.

## Unresolved launches and operator resolution

An unresolved launch has a durable `runtime_launch_unresolved` job blocker
containing the operation/execution IDs and the action
`reconcile_or_request_operator`. Its effect history contains the latest reason
and source observations. Reconciliation inspects the existing launch; it never
creates a replacement. Consistent activation or confirmed launch failure
resolves the blocker. Scope/policy changes and unavailable readiness keep
activation blocked even when the runtime is running.

If inspection cannot establish a consistent outcome, an authorized installation
operator inspects the trusted supervisor's task and receipt records. A matching
running task can be reconciled subject to current activation checks.
Authoritative non-creation resolves failure only when it does not contradict a
known task receipt. For a task that existed, verified termination and the 4.3
stop/preservation path must precede replacement work. Conflicting evidence stays
recorded; clearing a blocker or a timeout does not authorize a replacement or
erase task identity. Any operator-facing resolution command must authenticate
the operator and record current authorization and exact launch bindings before
performing an effect; no public resolution command is exposed by this slice.

The fake supervisor used by deterministic tests verifies this Controller
contract only. Before enabling a live adapter, WBS4 requires the version-specific
OpenClaw/SDK, Swarm, identity, permission, and supervisor qualification recorded
by T05, plus the approved installation and credential boundary. Metering
qualification under T07 remains a separate prerequisite for unattended coding.
