# Execution guards and source recovery

**Status:** Executable Controller domain services and deterministic qualification.
Live OpenClaw/Gateway/Swarm adapters remain WBS8; installation qualification is WBS7.

## Service boundaries

| Service | Responsibility |
| --- | --- |
| `ExecutionAccounting` | Immutable launch/run bindings, usage reconciliation and active intervals |
| `ExecutionGuards` | Configured time, usage, burn, progress, native-loop and reporting-gap decisions |
| `ExecutionCommands` | Durable safety-effect intents, dispatch claims, observations and audit history |
| `ExecutionStopCoordinator` | Exact inference/task termination and inspected outcomes |
| `ExecutionDeadlines` | Idempotent supervisor allowance registration and bounded extension evidence |
| `SourceArchives` | Standalone compressed Git/index/worktree capture and fresh restoration |
| `ExecutionSources` | Immutable artifact storage, integrity verification and effect/source settlement |
| `ExecutionContinuations` | Current-authority reuse/replacement and publication-neutral source handoff |

Domain services are called by trusted Controller adapters. Actor/grant references,
runtime observations, capacity, policy limits and snapshot/workspace resolvers must
come from authenticated, authorized server-side configuration or intake. They are
not model-callable claims of authority. The concrete adapter must resolve and
enforce grants; saving an identifier does not prove platform enforcement.

## Accounting and policy

See [execution-accounting.md](execution-accounting.md) for observation identities,
counter resets, coverage and interval reconciliation. Response IDs must identify
distinct provider responses/attempts. Stable provider IDs and original observation
timestamps survive transport replay. A Controller restart is not a counter epoch.

All guard thresholds are required configuration, validated before use. The R6
default remains 20 minutes active time with a warning at 15 minutes; no token,
burn, progress or metering-grace fallback is invented. Job queries include prior
executions and scope revisions. Unknown categories are never reported as zero.

Guard decisions persist their reasons, exact run and next stop command. Repeated
signals share one stop identity. A stop command survives recovered guard
evaluation and cannot consume an extension or start another execution.
Native loop signals use this path; no separate heuristic detector is introduced.

## Safety effects and verified stop

Safety commands have their own durable ledger because ordinary execution effects
are deliberately revoked by pause/stopping. This ledger reuses the StateContext
writer fencing, immediate transactions and append-only job audit. It does not
relax EffectStore eligibility for issue, publication or ordinary runtime effects.

Ordering is: authorized/version-checked intent, durable dispatch claim, external
operation, fenced observation/receipt. No supervisor call or archive capture runs
inside a database transaction. A claimed command is inspected after interruption;
the Controller never blindly sends it again. Raw stale command receipts are kept
as history without replacing current evidence.

Inference and task termination are dispatched independently with finite configured
transport timeouts. Accepted requests, timeout and a stopped task alone are
insufficient. Both the exact task identity and inference termination must be
inspected. Receipts retain last observed output/active usage, observed stop
overshoot and the next action. Deterministic overshoot is not a live measurement.

An uncertain stop remains `termination_unverified`; its next action is to inspect
the same runtime or request an operator. A verified stop remains separate from
source/effect settlement. Source capture can proceed after revocation, but ordinary
work cannot. A recovery binding attributes an existing launch without activating it.

Terminal transitions and reservations check the same settlement barrier:
verified task/inference stop, a matching stopped-source artifact whose bytes still
match their durable hash, and no unresolved execution effects or safety commands.
Never-launched reservations and authoritative non-creation need no source artifact.
A task that existed but stopped before activation enters stopping/preservation.

## Independent deadlines and extension

The supervisor owns active-time enforcement, including while the Controller is
unavailable. Initial launch enforcement resolves the immutable budget-profile
grant before any model work; it cannot depend on a later Controller timer.

Deadline requests carry the exact run, policy revision, remaining execution/job
allowance, cumulative execution/job active-time ceilings, expected supervisor
revision and bounded human-extension grant. Supervisor revisions and request
fingerprints are inspected after lost responses. An unresolved revision blocks
another revision and continuation.

Cumulative ceilings are not reset by registration, waits, Controller restart or
a new provider run. The supervisor accumulates execution and job consumption,
clamps remaining allowance to each ceiling, and validates the operator-installed
policy and extension grant before changing a ceiling. Increasing either ceiling
requires a bounded grant; a consumed grant cannot authorize another increase.
A new execution retains the job-wide counter and ceiling. Registering the same
allowance again cannot create more active time. Fake expiry tests exercise this
contract; only the concrete independent supervisor can prove live enforcement.

## Source artifact and restore

Capture consumes a trusted, attributable read-only workspace snapshot. Establishing
that snapshot and fencing concurrent workspace mutation are adapter responsibilities.
The concrete archive implementation also checks HEAD, index and working files
again after capture to reject ordinary races.

Artifacts are gzip-compressed versioned manifests with SHA-256 hashes, a standalone
Git bundle, staged blob/index entries and tracked/untracked working-file bytes.
Git history and local commits are included, including extant unreachable
commits preserved under recovery refs. Full conversation history is outside this
source format. Capture rejects incomplete/external object dependencies, unsafe links,
special files, nested Git workspaces and unsupported index types. Required source
must not depend on an alternate object store or the original workspace.

Credential paths are excluded from working files. Credential-bearing staged or
committed content blocks capture, rather than leaking through the Git bundle.
The configured path policy supplements the built-in credential paths and markers;
the runtime grant must keep mounted infrastructure credentials outside the source
snapshot. Candidate hooks, filters and project scripts are never run.

Artifact roots and scratch paths are provisioned outside the workspace. Expected
hash, size and identity are durable before creating an exclusive immutable file.
The file and artifact directory are synced before verification/receipt. A failed
or interrupted capture retains its intent/source and blocks settlement. An output
with known metadata can be reconciled by hash; unknown capture output requires
operator inspection before authorizing a new capture.

Restore verifies the archive before creating a fresh destination and reconstructs
Git objects, refs, index and working files without checkout filters. Existing
destinations are not overwritten. A lost completion receipt is reconciled by
capturing and comparing the restored Git/index/file state, not by extracting
again. Partial/mismatched restoration remains blocked and retained.

## Continuation and WBS5 handoff

Reuse inspects the exact current runtime, inference and usable workspace, then
rechecks writer ownership, current issue/readiness, authorized scope/policy,
capacity and remaining budgets. Unknown metering cannot grant a new allowance.

Replacement requires a newly verified stopped-source checkpoint and reconciled
effects. It restores source before reserving the replacement, checks current
authority/capacity/budgets again, preserves the old execution and job totals, and
never overlaps an uncertain runtime. Cancellation cannot be undone by continuation.

The neutral handoff separates immutable launch input (`sourceBundleId`, base
commit) from the newly captured output artifact and candidate SHA. Scope, policy,
execution and generation remain bound. Agent validation results remain labeled
claims; they are not trusted provider CI evidence. Preparing a handoff leaves
the current owner active for WBS5 candidate submission.

WBS5 must rebase after this slice, renumber its unmerged migrations after schema12
and consume these boundaries. It continues to own candidate acceptance, ancestry/
tree checks, publication, repair and delivery. WBS6 owns retention/off-host recovery.
