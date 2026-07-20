# ADR-006: Workflow Pipeline Observability

## Status

Accepted

## Context

Multiple workflows and dependency waves existed in persistence/scheduler but UI exposed only one active ledger and uncorrelated raw logs.

## Decision

- Workflow identity is `(repoPath, task_id)`; runId identifies only one dispatch attempt.
- LogEvent gains optional workflowId/repoPath for backward compatibility.
- Home dashboard polls all registered workflow snapshots; one selected workflow gets SSE.
- Pipeline layout uses Vue/CSS/SVG, no graph dependency.
- Existing active session stream stays unchanged.

### Log ownership model

Log events written by a running workflow carry `workflowId` (state.task_id) and
`repoPath` (absolute local path). These are set once at `installLogbus()` time
and merged into every event by the `Logbus.write()` method. Events written
without a context (legacy or non-workflow paths) omit both fields and remain
fully parseable. A `(repoPath, workflowId)` pair is the stable dashboard
identity across runs.

### Dashboard read model

`WorkflowDashboardItem` is a derived view built from the registry, per-project
`WORKFLOW_STATE.json`, and the tail of each project's durable log. Status is
determined by the highest-priority state found: `running > blocked > done > pending`.
`scheduleWaves()` is duplicated in the UI (src/ui/src/lib/pipeline.ts) as a
pure browser-safe function; the server scheduleWaves in
`src/server/dashboard.ts` serves the dashboard API.

### Pipeline graph

CSS Grid columns map to scheduler waves. Each node is a `<button>` with
status-based coloring. The SVG edge overlay is decorative only; screen readers
receive an ordered text list of the execution order (`Wave 1: A, B`, etc.).
Node click selects the unit and scopes the log drawer.

## Consequences

Positive: progress/dependency/log ownership visible; no new external service.

Negative: polling reads each registered state; dashboard intentionally monitors
registered local repos only; legacy logs have reduced identity.

## Rejected alternatives

- Treat runId as workflow ID.
- Global merged EventSource across all logs in v1.
- Add D3/ELK/Cytoscape.
