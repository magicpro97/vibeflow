# ADR-008: Conversation runtime authority and durable public replay

## Status

Accepted (2026-08-23)

## Context

VibeFlow exposes conversations through the CLI, HTTP API, SSE, and web workspace. Direct
answers, debates, plans, reviews, verification, and orchestration have different execution
policies, but they must agree on one lifecycle and one externally observable history. Running
a second service in the UI or reconstructing state from process logs would create competing
writers, inconsistent approval state, and replay gaps after reconnect.

Conversation records also cross a security boundary. Internal role/provider prompt templates,
rendered provider prompts, engine-native session ids, environment variables, credentials, local
paths, and provider-specific tool records are useful inside the process but are not safe public
fields. User topics, messages, and engine outputs must remain observable after redaction. Browser
clients need resumable streams and artifact access without receiving the private inputs.

## Decision

### 1. One process and bootstrap own the runtime

`createConversationBootstrap()` constructs the process-scoped trace store, artifact store,
opaque-id registry, agent-binding authority, policy library, and `ConversationOrchestrator`.
The CLI and HTTP server receive that authority by dependency injection and reuse it. The
orchestrator is the sole lifecycle and trace writer; policy implementations request actions
through it instead of maintaining parallel state.

A process restart may reconstruct durable public state from the trace and artifact stores,
but it does not pretend that an interrupted provider process or its in-memory credentials are
still live. Controls return typed conflicts when the required live authority no longer exists.

### 2. The ordered trace is the durable source of truth

Every public event is appended with a monotonically increasing `seq` and full public
correlation fields. Snapshots, rounds, approval cards, operation state, messages, session
reconciliation, decision matrices, and artifact views are projections of this trace. The
general logbus may mirror sanitized events for operator visibility, but it is not a replay or
state authority and cannot fill missing trace records.

Terminal traces are immutable. A message sent to a completed conversation creates a child
revision linked to the parent; it never reopens and rewrites the terminal parent.

### 3. Artifacts cross the boundary only through opaque capabilities

The durable artifact store may use internal references and filesystem locations. Approval and
operation result `artifact_refs` are stable public catalog ids; they identify results but grant
no download authority. Public `artifact_created` and `artifact_updated` events separately expose
a conversation-scoped opaque `ref`. The authenticated artifact route resolves
`(conversation_id, ref)` inside the server; clients cannot submit a catalog id or local path.
Bytes are fetched only with that trace-emitted opaque reference.

### 4. Credentials are separated by purpose

Provider credentials and native engine session ids remain in private process state. JSON,
control, snapshot, and artifact requests use a process-local conversation session. On
loopback, the browser receives it as an `HttpOnly`, `SameSite=Strict` cookie and writes also
carry the page's CSRF token.

SSE uses a different 256-bit bearer token. It is scoped to one conversation, expires after
15 minutes, is stored only as a digest by the server, and is renewed through the
session-authenticated endpoint. The web client holds it in memory, not local or session
storage. A session cookie is not accepted as an SSE credential, and an SSE token cannot
authorize artifacts or mutations. LAN-bound pages receive no conversation session and fail
closed.

### 5. SSE has an explicit replay barrier

Clients resume with `Last-Event-ID` or `?since=`; supplying both requires equal values. The
server subscribes before replay, buffers concurrent records, replays all durable records with
`seq` greater than the cursor in ascending order, emits a snapshot at the replay boundary,
and then drains buffered live records. This ordering closes the subscribe/replay race.

Clients treat `seq` as the deduplication key because a reconnect can legitimately deliver a
record already observed at the previous connection boundary. The durable trace remains the
authority if a log mirror, network connection, or browser render drops an event.

### 6. Errors and controls are typed public outcomes

The HTTP boundary validates exact DTO keys, bounded text, identifiers, participant engines,
and route/body identity. Authentication failures use `401`/`403`, malformed input and cursors
use `400`, missing conversations or routes use `404`, lifecycle and idempotency conflicts use
`409`, and unexpected runtime failures use a sanitized `500` code. Accepted asynchronous
mutations return `202`.

The CLI maps the same runtime outcomes to stable exit codes: `0` success, accepted
`awaiting_approval`, dry-run, or stopped; `1` validation; `2` engine start; `3` transport;
`4` failed; and `5` aborted. An approval wait remains explicit in JSON with its current
public catalog artifact ids. JSON mode emits one document so automation never has to separate
streamed deltas from a terminal result.

## Consequences and tradeoffs

Positive:

- CLI, API, SSE, and UI observe the same lifecycle, controls, and ordered trace.
- Replay is deterministic and survives browser reconnects and process-independent log loss.
- Public DTOs are provider-neutral. They disclose redacted user messages and outputs, but not
  credentials, native ids, internal/provider prompts, environment values, or local artifact paths.
- Approval and cancellation idempotency are enforced at one authority instead of in each
  transport.

Costs:

- A single live process is an availability boundary for active engine operations and
  process-local credentials.
- Trace schema evolution requires backward-compatible projections or explicit migration.
- The subscribe/buffer/replay barrier and scoped token renewal add complexity to a simple
  EventSource endpoint.
- Opaque artifact resolution requires a registry rebuild from the canonical trace after a
  clean process start.

## Rejected alternatives

- **Separate CLI and web runtimes:** rejected because two writers can disagree on lifecycle,
  approvals, and sequence allocation.
- **Use logbus as conversation history:** rejected because logs are observational, may be
  truncated or filtered, and do not provide transactional replay boundaries.
- **Expose engine-native sessions or artifact paths:** rejected because provider identifiers,
  credentials, and filesystem topology would become public contracts and cross conversation
  boundaries.
- **Use the session cookie for EventSource:** rejected because EventSource cannot attach the
  write CSRF header and a broad session credential has more authority than a read-only,
  single-conversation stream requires.
- **Replay before subscribing:** rejected because an event appended between replay completion
  and subscription would be lost.
- **Reopen completed conversations in place:** rejected because it would mutate a terminal
  audit trail; child revisions preserve both histories.

## Related

- `src/orchestrator/conversation/bootstrap.ts`
- `src/orchestrator/conversation/service.ts`
- `src/orchestrator/trace/`
- `src/server/conversation-route.ts`
- `src/server/conversation-sse.ts`
- `src/server/conversation-auth.ts`
