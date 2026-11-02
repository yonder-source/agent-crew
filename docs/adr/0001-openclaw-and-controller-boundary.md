# Use OpenClaw with a modular Controller

Status: Accepted · Date: 2026-11-01

Use OpenClaw for conversations, agent execution and integrations, with a
modular Node.js/TypeScript Controller enforcing workflow policy.

Reusing OpenClaw avoids rebuilding session management, tool execution, Slack
transport and the management UI shell. Keeping policy in the Controller gives
Agent Crew control over authorization, durable jobs and external effects.

Keep Controller modules in one application. Extract a service when security or
operational requirements justify the additional deployment and coordination.
Process topology and runtime-supervision separation remain open under T03
and T05 in the specification.

Related documents: [technical baseline](../../spec.md#3-technical-baseline),
[component ownership](../architecture.md#1-components-and-ownership).
