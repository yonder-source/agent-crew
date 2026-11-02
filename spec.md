# Agent Crew specification

Version: 0.1.0 · Updated: 2026-11-02 · Status: draft for review.

## 1. Product outcome and release scope

Agent Crew coordinates development agents through Slack, from GitHub issue
clarification to reviewed pull requests. Routine operation continues
without an open IDE or a connected personal workstation.

```text
Discuss → refine issue → human marks ready → automatic admission → implement/test
       → clarify or recover → Controller publishes PR → bounded repair
       → human review/merge → verify delivery and settle cleanup
```

## 2. Roles and workflow terms

### Human roles

| Role | Responsibility |
| --- | --- |
| Product owner/requester | Set requirements and approve material changes |
| Reviewer/approver | Review code, approve protected candidates and merge |
| Operator | Configure the installation, provision secrets, deploy and recover infrastructure |

### Agent roles

| Role | Responsibility |
| --- | --- |
| Designer agent | Investigate the repository, clarify requirements and save agreed changes to issues |
| Coding agent | Implement the agreed scope, run validation, report progress and request publication |

### Workflow terms

| Term | Meaning |
| --- | --- |
| Caller identity | Verified person or service initiating a Controller request |
| Job | Durable implementation task for one issue, retaining scope revisions, execution history and cumulative usage |
| Execution | One bounded coding attempt within a job |
| Session | OpenClaw conversation holding an agent's interaction history and context |
| Task runtime | Isolated environment containing an execution's workspace, tools and subprocesses |
| Repair attempt | One automated cycle addressing a batch of CI failures or authorized review feedback on the existing PR |
| Ownership generation | Version of execution ownership distinguishing the current worker from replaced workers |
| Scope revision | Recorded issue content, dependencies, relevant policy and human agreement |
| Candidate | Exact commit submitted for validation and publication |
| Effect | External change, such as an issue update, Slack send, branch push or runtime launch |
| Checkpoint | Private source snapshot and restore metadata |
| Operationally idle | No active coding execution or unresolved start, stop or write operation that conflicts with maintenance |

## 3. Technical baseline

- Build a modular Controller in Node.js and TypeScript.
- Use OpenClaw for the Gateway, sessions, agent runtime, outbound Slack Socket
  Mode and management UI.
- Deploy platform services through Docker Swarm on one trusted hosting machine
  initially, using pinned images and persistent storage.
- Store workflow state in SQLite.
- Provision credentials from the operator's host through Docker Secrets.
- Monitor GitHub through polling.

Component design: [architecture.md](docs/architecture.md).
Technical rationale: [ADRs](docs/adr/README.md).

## 4. Functional requirements

Numerical defaults: [section 5](#5-default-policies-and-unresolved-limits).

### R1. Configuration and repository isolation

Use an authenticated Agent Crew configuration page in the OpenClaw management
UI to configure repository identity, Slack workspace, account and channel
mappings, agent roles, authorized people, the issue template, required checks,
execution policy and Docker Secret references.

Map authorized humans' GitHub and Slack identities and configure their
per-repository permissions.

Validate credentials, secret identities and readiness of configured agent
roles and tools before activating a configuration revision. Read the saved
configuration back to verify activation and report successful activation.

**Edge cases**

- Reject stale configuration writes.
- Report partially applied or unconfirmed revisions.
- Historical jobs keep stable identity through display name changes; reusing a
  mapping cannot bind them to a different repository or channel.

### R2. Slack operation and human questions

Persist each Slack thread's repository, issue and job bindings. Keep unbound
planning separate from admitted coding work. Preserve active task bindings
during inspection and issue selection.

Provide help, status and available actions.

Answer-dependent work waits; independent authorized work may continue.

**Edge cases**

- Human questions survive restarts and Slack failures. Expose the same pending
  question in the management UI, where an authorized human can answer under
  the same identity and version checks.

### R3. Requirements discovery and decomposition

The designer agent investigates the repository, groups related product
questions into manageable rounds and recommends options. Obtain explicit human
agreement, save each agreed round to the bound GitHub issue and read it back
to verify the update. Record unresolved choices.

Use a repository-owned, versioned clarification skill and issue template. Pin
and verify their deployed versions.

The initial template contains seven sections:

1. User outcome and current behavior.
2. Repository and branch contract.
3. Required behavior and edge cases.
4. Allowed scope and non-goals.
5. Acceptance and verification.
6. Execution decisions and stop conditions.
7. Delivery contract.

Support creating a new issue and explicitly selecting an existing issue.
Agents may propose parent/child issues and dependencies; humans agree before
creation and approve the integrated result. Split work for independently
reviewable PRs, without a fixed issue-size threshold.

Coding prerequisites require verified evidence that the prerequisite PR was
merged. Non-coding prerequisites require explicit authorized human
confirmation.

**Edge cases**

- Closing a non-coding prerequisite does not replace human confirmation.

### R4. Readiness and automatic admission

An authorized human applies `ready for agent`. Periodic discovery
automatically picks up eligible issues and assigns coding work. Agent tools
expose no operation for adding or removing the ready label.

Readiness has no automatic expiry. Before admission, verify current label
presence, the labeler's current authority, repository binding, issue evidence,
policy, dependencies and capacity. Record the exact issue content as the
admitted scope.

**Edge cases**

- Dependency cycles or missing completion evidence keep work queued with a
  visible reason.
- Deduplicate polls and claims into one job per issue, with at most one live
  execution per job.
- Removing readiness prevents queued or unstarted work from starting. Existing
  executions continue under their current scope and stop conditions.
- Reapplying readiness or reopening an issue with execution history does not
  create another job automatically. Show the existing job and available resume
  and retry actions.
- Changes following completed work use a new issue.

### R5. Collaborative changes and unexpected issue edits

After dispatch, humans request issue edits through the agent. Apply agreed
edits through the Controller within granted scope, verify by readback and
retain prior revisions. Ordinary edits preserve the job and readiness label;
coding may continue within agreed scope. Material rework needs human agreement.

Poll only the issue title, body and declared dependencies at the configured
interval, and verify freshness before publication. Match expected writes to
durable receipts. Unchanged content invokes no model and does not interrupt coding.

**Edge cases**

- Failed reads leave verification unavailable or delayed.
- Direct edits after readiness: send updated content and the prior revision
  or diff to the coding agent for assessment in Slack. After dispatch, continue
  if the edit fits agreed scope; otherwise stop affected work for human advice.
- Before dispatch, assign an agent to clarify direct edits and await human
  advice before implementation.
- Concurrent edits during an agreed update: durably queue the proposed version,
  preserve the remote version and notify the human in Slack. Revalidate the
  resolved version before applying it.
- Without atomic conditional updates, use a fresh preflight read, write and
  readback. V1 accepts the remaining risk of overwriting an undetected edit
  between read and write.

### R6. Execution, budgets and interruption

**Runtime and access**

- Run each execution in an isolated, non-root runtime with pinned source,
  explicit inputs and declared validation commands. Exclude host home
  directories, other-job files, Docker sockets and infrastructure credentials.
- Enforce workspace, input and tool grants outside the model, including for
  subprocesses and package scripts. Installation follows task and environment
  policy; package scripts cannot install globally or on the host.
- Restrict outbound access to configured dependency and task-service
  destinations. Block management endpoints and unrelated internal networks;
  extra access needs human authorization.

**Budget accounting**

Track active time and model usage per execution and job. Exclude human waits
from active time. Include observable usage from retries, fallbacks, compaction
and delegated sessions. Preserve both totals across restarts, repairs and scope
revisions.

Use native loop detection. Enforce the active-time limit independently of the
Controller.

**Stopping and continuation**

Pause, cancel and operator-authorized emergency stop block affected future
operations and terminate inference and runtime processes without model
cooperation. Verify termination and reconcile in-flight effects. Cancellation
preserves source and recorded remote effects. Continuation rechecks scope,
authority and capacity.

**Edge cases**

- Exhausted active time stops the execution and preserves progress pending a
  human decision on a bounded extension.
- Usage, burn-rate or progress limits block further work and request an abort
  of the exact run.
- Expose missing or partial metering. Missing or stale usage reports during
  coding stop the run after a configurable grace period; preserve progress and
  show the monitoring blocker. Calibrate thresholds and grace periods to the
  observed reporting interval.
- Post-response metering permits token-budget overshoot. Per-call admission
  and tighter quota enforcement require further runtime integration.
- Until termination is verified, report the stop as uncertain and block
  replacement execution.

### R7. Publication, review and completion

The coding agent commits locally and submits the candidate SHA to the
Controller's publication API or tool. The Controller derives repository,
issue, branch and PR targets from trusted job and execution bindings, pushes
validated candidates to the job's single task branch and creates or updates
its PR. Repairs follow the same path. Publication credentials stay outside
task runtimes; agents cannot push directly and the publisher executes no
candidate code.

Record validation commands, results and approvals against the exact candidate.
Verify the remote branch, PR identity and HEAD through GitHub. Require passing
checks and human review; verify final HEAD, checks and merge status on completion.
PR descriptions cannot authorize closing unrelated issues or marking tracking
issues or partial work as delivered.

Automated repair responds only to failed required CI checks or an authorized
reviewer's explicit request for changes. Batch actionable feedback at repair
start; preserve the repair count across restarts and scope revisions.

**Edge cases**

- Obtain exact-candidate human approval before publishing changes to CI
  workflows, required validation commands, agent instructions or harness
  permissions, or removal or weakening of required tests or checks. Ordinary
  test maintenance is allowed; uncertain detection needs human review.
- When `main` advances, update against a Controller-verified base and rerun
  validation. Escalate conflicts the agent cannot confidently resolve.
- Unexpected remote task-branch commits block pushing; preserve both versions
  for human resolution.
- Repair beyond the allowance requires human authorization.
- PR closure without merge stops automatic repair and publication. Preserve
  source and PR identity; reopening or replacement requires human authorization.
- Keep unresolved resources and conflicting effects visible after merge.
  Retry failed notifications without repeating merge or cleanup.

### R8. Durable state and external effects

Derive workflow state from durable job records and verify repository facts
against GitHub. Give each job a stable `job_id` and each execution an
`execution_id`. Link executions, Gateway sessions and Swarm observations to
the job.

Save human input and effect intent before acknowledging acceptance. Include
the operation identity, authenticated caller identity, authorization evidence,
job, execution, scope version and policy version. Record completion
separately, using a receipt or verification from the external service. Keep
append-only history and record late results. Give each new authorized action a
new identity. Track effects as pending, confirmed successful, confirmed failed
or unknown. Reusing source requires current authorization.

Slack and the UI share one job view. Show the phase, current execution,
blocker and next permitted action. Include issue and PR links, usage,
remaining budgets, worker readiness, runtime health, job progress and delivery
status.

**Edge cases**

- Record missing observations as unknown.
- Reject state changes and publication from stale ownership generations.
- A repeated request with the same operation identity and arguments returns
  the existing status or result without repeating work. Reject and audit
  changed arguments under the same identity.
- Retry transient failures of safe reads or operations known not to have
  started. Use bounded backoff and jitter.
- Permanent refusals block the operation.
- Reconcile uncertain writes before replay. Unknown outcomes block dependent
  or potentially duplicate actions, including after timeouts or exhausted
  retries. Independent authorized work may continue.
- Exhausted retries leave the operation blocked with its reason, responsible
  person or service and next action.

### R9. Authorization, credentials and data boundaries

**Permissions**

Keep management and internal control endpoints private. Authenticate requests
and check current caller permissions and repository binding; agent requests
also require matching role, session, issue, job, execution and ownership
generation where applicable. Repository and installation access are separate
grants. Isolate workspaces, credentials and grants by job, including jobs using
the same agent role.

**Credentials and service privileges**

- Provision Docker Secrets on the host; enforce per-service mounts and
  Docker/Swarm grants. Record immutable secret identities for rotation.
- Credential configuration accepts only references and safe metadata. Exclude
  plaintext from the UI, logs, fixtures and committed configuration.
- Keep publication and host credentials out of designer agent sessions,
  coding agent sessions and task workspaces.
- CI running agent-authored code receives no production or deployment secrets
  or write-capable repository tokens. Privileged follow-up operations validate
  their own inputs and permissions.

**Private inputs and audit**

Record explicit grants for other-repository or private-input access, with
separate publication authorization. Screen outgoing commits, PR bodies and
Slack messages for secrets and private inputs.

Audit rejected privileged requests with caller identity where available,
operation, bound target, reason and correlation ID; exclude raw payloads and
credentials.

**Edge cases**

- Revocation blocks existing jobs' commands from revoked humans and operations
  using revoked execution grants; retain completed-effect records.
- Missing authorization, scope or binding evidence blocks the privileged
  action with verification-unavailable status.
- Detected secrets or private inputs block the outgoing effect for human
  review. Report locations with values redacted; actual exposure also requires
  operator notification and redacted evidence.
- Unavailable audit recording blocks new privileged effects and shows the
  blocker; independent deadlines and emergency containment remain available.

### R10. Preservation, operations and recovery

Before destructive runtime cleanup, confirm that execution has stopped and
preserve unfinished source in a verified private checkpoint. Include Git
history, local commits, tracked and untracked task files, source identity and
restore metadata; exclude credentials. Test restoration in a fresh runtime.

Apply the configured retention period to successful-job checkpoints. Keep
unfinished or blocked checkpoints until those jobs are explicitly resolved.
Retain evidence needed to reconcile uncertain effects.

Before a planned Controller replacement, drain work until the system is
operationally idle. Stop new admissions, continuations, repair attempts and
external effects while active operations settle. Preserve queued work, pending
questions and jobs awaiting review. Confirm that the old writer has stopped,
activate the replacement and reconcile ownership. Then reopen admission.

Keep consistent off-host backups of workflow state and source artifacts.

**Edge cases**

- Preserve retained checkpoints when storage fills and report a storage
  blocker.
- Failed preservation blocks destructive cleanup.
- After an interruption, verify the existing session, runtime identity,
  workspace and ownership before reuse. Otherwise, confirm termination and
  restore the checkpoint in a fresh runtime. Missing source or uncertain
  ownership blocks restart.
- Use crash recovery and stale-worker fencing for unplanned replacement.
- After restoring a backup, keep dispatch paused. Reconcile restored records
  with actual runtimes and external state. Verify restored state references
  recoverable source artifacts. Preserve newer remote facts and prevent
  duplicate execution.

## 5. Default policies and unresolved limits

Store configurable limits in runtime configuration. Reject affected admission
when required configuration is unset or invalid, and report the settings that
need correction.

| Setting | v1 default |
| --- | --- |
| Active coding executions | 1 per repository |
| Automated repair allowance | 1 attempt per job |
| Active coding and repair time | 20 minutes; warning at 15 minutes |
| Active issue-change polling interval | 60 seconds |
| Successful-job checkpoint retention | 7 days |

Before operational acceptance, set token and burn-rate thresholds, the
metering grace period, checkpoint frequency, retry budgets and deadlines for
effects, and retention periods for audit records and backups. Calibrate token
limits using measured reporting cadence, model usage and stop overshoot.

## 6. Acceptance scenarios

Release acceptance covers permitted and rejected operations at each enforced
boundary. Effectful operations also cover duplicates, process interruption and
lost responses. Verify the supervised Slack/GitHub workflow on a disposable
deployment.

| ID | Observable scenario | Requirements |
| --- | --- | --- |
| A01 | Activate two repository mappings; reject stale configuration and operations targeting the wrong channel or repository | R1–R2, R9 |
| A02 | Clarify an issue through Slack without a local IDE; save and verify agreed decisions and record unresolved choices | R2–R3 |
| A03 | An authorized ready label admits one execution despite duplicate polls or button events; unauthorized labeling cannot start work | R4, R8–R9 |
| A04 | Missing or cyclic prerequisites block admission; require completion evidence and reuse the existing job when an issue is relabeled or reopened | R3–R4 |
| A05 | Removing readiness blocks unstarted work; existing executions follow their stop conditions; verify concurrent removal and admission | R4, R6 |
| A06 | Collaborative typo and scope edits preserve revisions and budgets while keeping the ready label; material rework requires human agreement | R5–R6 |
| A07 | Assess manual edits before pickup and while queued, running, paused or publishing; seek advice when needed; unchanged polling invokes no model | R4–R5 |
| A08 | Queue the proposed version on a concurrent issue edit; notify the human and test the remaining read-to-write race | R5 |
| A09 | Implement, validate and publish the bound PR; repair on the same branch and PR, verify the human merge and complete cleanup using provider evidence | R6–R8, R10 |
| A10 | Reject and audit requests with the wrong or stale session, issue, branch, candidate or request identity | R7–R9 |
| A11 | Apply publication checks when main or the remote task branch changes, protected controls change, required checks become stale or the PR closes without merging | R7, R9 |
| A12 | Reject repair triggers from ordinary discussion; enforce the repair allowance across restarts and scope revisions | R5–R7 |
| A13 | Interrupt the process during job claims, runtime launch and effect recording; recover a single owner and preserve unknown outcomes | R6, R8, R10 |
| A14 | Lose responses to issue updates, Slack sends, pushes, PR updates and configuration changes; reconcile each effect before duplicate or conflicting writes | R1–R2, R5, R7–R8 |
| A15 | Exercise transient failures, rate limits, permanent failures and exhausted retries; show attempt counts, blockers and next actions | R6, R8 |
| A16 | Pause or cancel during publication or resume; require a confirmed stop before replacement; emergency stop works without model cooperation | R6–R8 |
| A17 | Preserve local commits and tracked and untracked changes; restore them in a fresh runtime; failed preservation blocks cleanup | R6, R10 |
| A18 | Restore off-host backups after host loss; verify state and source artifacts, reconcile newer remote facts and prevent duplicate execution | R8, R10 |
| A19 | Revoke permissions or rotate credentials during work; preserve immutable secret references and isolation between agents, publication and the host | R1, R9–R10 |
| A20 | Use malicious issues, code, logs and dependency output to attempt access to other jobs, the host or credentials; verify non-root execution and tool, network and output restrictions | R6, R9 |
| A21 | A synthetic token-burning loop, lack of progress or stale metering blocks further work and aborts the run; measure usage coverage and stop overshoot | R6, R8 |
| A22 | Exercise Slack, log, provider and audit outages and storage exhaustion; show missing evidence and verify UI fallback and emergency controls | R2, R8–R10 |
| A23 | Drain work for a planned upgrade; stop the old writer before replacement; preserve queued work, questions and accumulated usage | R6, R8, R10 |
| A24 | Run jobs across repositories and above the default concurrency; preserve isolation and per-repository concurrency while unrelated work remains responsive | R1, R4, R6, R8 |

## 7. Technical decisions and verification

Resolve each contract before implementing dependent components.

| ID | Contract to complete | Required output |
| --- | --- | --- |
| T01 | Admission and initial scope evidence | Labeler's GitHub identity, application time and label history; identity mapping; initial observation; concurrent removal and admission; handling incomplete history |
| T02 | Issue writes | Expected content before and after each write, receipts, edit attribution, conflict detection and conditional-write support; document the remaining overwrite race |
| T03 | Persistence and lifecycle | Controller process layout, job and execution transitions, atomic version and ownership updates, observation ordering and rules for rebuilding status views |
| T04 | External-effect adapters | Schemas for each operation, key scope and retention, argument fingerprints, transactions for intent and audit records, retry budgets and reconciliation evidence |
| T05 | Runtime and privilege grants | Pinned OpenClaw and Swarm versions, management UI page integration, runtime placement, tool and network enforcement, service access to secrets and host operations, internal authentication and rotation |
| T06 | Source and backup recovery | Archive format, capture schedule, encryption, access controls, a consistent database and artifact manifest, and a restore procedure |
| T07 | Metering and limits | Hook coverage, loop detection and stopping a specific run; usage and burn-rate thresholds, grace periods and active-time accounting |
| T08 | Validation and protected changes | Validation of the exact candidate, required CI checks, authorized reviewer identities, detection of protected changes and escalation of uncertain cases |
| T09 | Operations and packaging | Repeatable installation, upgrades and maintenance; off-host storage configuration; access and retention policies; release packaging |
