# Execution accounting contract

`ExecutionAccounting` accepts observations only through trusted adapters. Its run
binding comes from the validated persisted launch request and its attributable
supervisor receipt. Binding a run requires a current, active execution and scope.
Transport authentication and concrete OpenClaw metering remain adapter work.
Bind prospectively before model work, or supply the verified original run start
time. Recovery bindings begin at launch dispatch; missing interval evidence
before recovery remains unknown rather than disappearing from the budget.

## Identity and reconciliation

Observation IDs are immutable. Identical replays are idempotent; changed payloads
under the same ID are rejected. Provider run/response/epoch identities must remain
stable across Controller restart. An epoch changes only when the provider resets
its cumulative counter. Sequence numbers and original observations are retained.

For each metric, cumulative epoch maxima are summed. Distinct response maxima are
summed separately. The larger total is the known lower bound: cumulative snapshots
and response receipts are never added together. Missing categories remain unknown.
A final report without a response ID attests to the entire epoch, including all
attempts; ordinary response-final receipts cannot establish run completeness.
Conflicting final epoch totals retain the larger amount with partial coverage.

Late observations are retained as history without altering totals. A healthy
current writer can explicitly reconcile prior work under a new observation ID;
the original history remains immutable. Reconciliation cannot change execution
lifecycle, ownership or requested control. Job queries aggregate every bound run,
including runs from previous executions and scope revisions.

## Active time

Supervisor intervals attest to active, waiting or stopped time. Active intervals
are unioned, so replay/overlap cannot double count. Waiting contributes no active
time. Gaps and contradictory activity retain partial coverage. A Controller outage
never becomes an assumed wait or zero usage. Queries use an injected clock.

This store derives authoritative aggregates from immutable observations. Legacy
`usage_counters` remain the low-level compatibility interface; guards must query
the accounting service rather than treating those manually set counters as
provider evidence.
