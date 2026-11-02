# Use SQLite for v1 workflow state

Status: Accepted · Date: 2026-11-01

Use SQLite for Controller workflow state on the initial single-host
installation.

The expected workload does not justify operating a separate database service.
SQLite keeps deployment small at the cost of serialized writes and downtime
when the host fails.

Reconsider a client/server database if measured contention, multiple active
writers or multi-host availability become requirements.

Related documents: [state storage](../architecture.md#3-state-and-effect-contracts),
[backup and recovery](../../spec.md#r10-preservation-operations-and-recovery).
