# Publication contract

Updated: 2026-11-03. Status: deterministic Controller module contract; live
GitHub publication is not qualified.

This document describes the internal module results used by the job view and
future Controller API adapters. It does not claim that a browser UI or public
HTTP route exists.

## Candidate publication

`CandidateStore.submit` records immutable candidate identity, source bundle,
base revision, execution and ownership generation, scope and policy revisions,
and the task runtime's reported validation results. Reported local results are
claims; a reported failure blocks publication, while provider checks remain the
authoritative validation evidence. The publication adapter verifies that the
source bundle contains the exact candidate and base relationship and binds its
artifact digest into the push intent.

`PublicationCoordinator.publish` derives its repository target and protected
change classification through the configured `PublicationPolicy`. Before each
external write, it requires the candidate to remain the job's latest submission
from its current execution, with job control permitting publication and the
current issue and readiness heads matching its approved scope. It
returns:

| Status | Meaning | Job view |
| --- | --- | --- |
| `published` | Controller effects and provider readback bind the exact candidate to one open PR | PR number, candidate SHA, base branch and publication receipt |
| `pending` | A write result or complete provider read is not yet attributable | Reconciliation required; no conflicting retry |
| `blocked` | Candidate binding, branch state, policy, or required protected change approval is invalid | Reason code and expected/observed identity |

Push and PR create/update are separate durable effect operations. A lost write
response is reconciled by reading the configured branch and job marker. The
publisher can recover an unbound PR only through the matching previously
started PR intent or confirmed receipt; a remote job marker alone cannot
establish attribution. In-flight and unknown publication writes fence the
repository/task branch across candidates and across push/PR operations.
The publisher blocks on an unexpected branch head or an unattributed PR. Protected
or uncertain changes require a decision receipt bound to candidate SHA, base
SHA and policy version; that evidence is stored in effect authorization.
An unexpected branch is preserved through a separate durable provider effect;
its result includes expected and observed heads, private checkpoint ID, artifact
digest and commit summaries. One immutable task-branch/PR binding is stored per
job and reused for repair candidates.

## Checks and reviews

`PublicationEvidenceStore` accepts a snapshot only when its PR number and target
branch match the confirmed Controller PR effect receipt. Each immutable
snapshot stores the provider identity/cursor, candidate and base SHAs, policy
revision, confirming PR operation ID, PR number and base branch, check
identities and producers, synthetic merge parents, current review states, PR
state and observation time.

Read-only provider inspection can precede effect intent. Pushes, PR updates,
runtime mutations and source-artifact creation or preservation require durable
intent before execution; provider reads also run outside database transactions.

`evaluatePublicationReadiness` returns `ready`, `blocked`, or `repair_required`.
Missing, pending, stale, wrong-target or wrong-producer checks block. Only a
current required-check failure or an authorized exact-candidate
`changes_requested` review is actionable repair evidence. Dismissed reviews and
reviewers who are no longer authorized do not satisfy approval. Allowed
`neutral` or `skipped` checks are not listed as executed validation.
Informational `commented` reviews do not replace a reviewer's effective
decision. An unresolved authorized change request blocks delivery even when
another reviewer approved or the PR has already merged.

Repair admission and delivery verification invoke the injected
`PublicationEvidenceReader.readFresh` for each new decision. The reader must
fetch current PR head/base/state, checks and reviews; saved observations cannot
be substituted for that read. The Controller supplies a new snapshot ID and
checks that the observation belongs to the read's time interval. It saves the
result under writer and job-version fences before evaluating it. A changed
job or writer, unavailable read, or reused observation blocks the decision.
`maximumEvidenceAgeMs` bounds the fresh observation's age; it does not authorize
using a cached snapshot. Repeating an already recorded decision ID returns its
original result without creating another decision or reservation.

## Repair

`RepairStore.reserve` performs the fresh decision read and, in one SQLite
transaction, evaluates it, reserves a new execution and consumes one job-wide repair
allowance. Repeating the same reservation ID returns the original reservation
without consuming another attempt. The default allowance is one attempt across
restarts and scope revisions. Each reservation retains the batch of failed
check identifiers and authorized change-request review bodies and inline
comments that triggered the repair. These are untrusted provider text and are
stored as evidence, not interpreted as instructions by the Controller.
`extendAllowance` requires an injected authority verifier and stores the
immutable human decision receipt before increasing the allowance.

## Delivery

`DeliveryStore.verify` performs the fresh decision read and records an immutable
`complete` or `blocked` decision from that snapshot. Completion requires a merged PR, the
exact candidate head, a merge commit with exactly the candidate and verified
base as parents, current required checks, and current authorized review. A
merge that bypassed any of these gates is retained as a blocked delivery
observation with its reasons.

## Enablement gates

The modules use replaceable provider and authorization interfaces. Before live
publication is enabled, operators must qualify GitHub write/readback receipts
and retry limits under T04, and review the exact protected path/control coverage
under T08. Fake-provider tests establish deterministic logic only. Human PR
review and merge remain outside Controller authority.
