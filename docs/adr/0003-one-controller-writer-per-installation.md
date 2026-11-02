# Use one Controller writer per installation

Status: Accepted · Date: 2026-11-02

Run configuration, lifecycle and effect workers in one Controller process over
one host-local SQLite database. Hold an exclusive host-local OS process lock
throughout the writer's lifetime. Emit a heartbeat every five seconds; three
missed heartbeats mark the writer unhealthy and block new admissions and
effects, but never expire the lock or authorize automatic takeover. The lock,
not heartbeat age or PID absence, determines whether a replacement may start.
An authorized operator must stop a live but unresponsive writer, verify that it
exited and released the lock, then reconcile in-flight effects. A replacement
increments the durable writer generation before serving requests; state
mutations and effect completions from older generations are rejected and kept
as history. Keep runtime deadlines outside that process; their execution
placement is resolved under T05.

An installation-wide writer makes repository capacity, job ownership and effect
intent one transactional model. Per-repository Controllers would require an
additional management/coordination path for shared Gateway and installation
changes. The expected workload favors the simpler writer model.

The trade-off is a shared Controller failure and maintenance domain across
repositories. Short transactions and asynchronous provider work preserve normal
responsiveness; measured contention or stronger availability requirements can
justify a different process/storage design later.

Contract: [state and effect contracts](../architecture.md#3-state-and-effect-contracts).
