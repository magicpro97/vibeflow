import { computed, reactive } from "vue";
import { isAgentEngine } from "../../core/agent-contract.js";
import {
  CONVERSATION_LIFECYCLE,
  CONVERSATION_OPERATION_STATE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import {
  CONVERSATION_CLIENT_STREAM_STATE,
  type ConversationClientStreamState,
} from "../../orchestrator/conversation/conversation-sse-contract.js";
import {
  projectConversationBaseline,
  projectConversationDecisionMatrix,
} from "./conversation-api.js";
import { buildConversationMessages } from "./conversation-message-projection.js";
import {
  isConversationPublicTraceRecordWireV1,
  isConversationSnapshotWireV1,
} from "./conversation-public-wire.js";
import { collectTraceSessions } from "./conversation-session-projection.js";
import type {
  ConversationCreateParticipant,
  ConversationCreateRequest,
  ConversationSnapshot,
  ConversationTraceRecord,
} from "./conversation-types.js";
import { OPAQUE_ARTIFACT_PATTERN, isTerminalLifecycle } from "./conversation-types.js";

const opaqueArtifact = (value: string | null | undefined) =>
  value && OPAQUE_ARTIFACT_PATTERN.test(value) ? value : null;

export interface ConversationWorkspaceState {
  activeConversationId: string | null;
  activeLocation: string | null;
  parentConversationId: string | null;
  parentLocation: string | null;
  childConversationId: string | null;
  snapshot: ConversationSnapshot | null;
  traces: ConversationTraceRecord[];
  cursor: number;
  streamToken: string | null;
  streamTokenExpiresAt: string | null;
  streamVersion: number;
  streamStatus: ConversationClientStreamState;
  streamError: string | null;
  notice: string | null;
}

export type DecisionMatrix = NonNullable<ReturnType<typeof projectConversationDecisionMatrix>>;
export type BaselineComparisonView = NonNullable<ReturnType<typeof projectConversationBaseline>>;

export function createConversationState(): ConversationWorkspaceState {
  return {
    activeConversationId: null,
    activeLocation: null,
    parentConversationId: null,
    parentLocation: null,
    childConversationId: null,
    snapshot: null,
    traces: [],
    cursor: 0,
    streamToken: null,
    streamTokenExpiresAt: null,
    streamVersion: 0,
    streamStatus: CONVERSATION_CLIENT_STREAM_STATE.IDLE,
    streamError: null,
    notice: null,
  };
}

export function resetConversationState(
  state: ConversationWorkspaceState,
  conversationId: string,
  options: {
    location?: string | null;
    parentConversationId?: string | null;
    parentLocation?: string | null;
  } = {},
) {
  state.activeConversationId = conversationId;
  state.activeLocation =
    options.location ?? `/api/conversations/${encodeURIComponent(conversationId)}`;
  state.parentConversationId = options.parentConversationId ?? null;
  state.parentLocation = options.parentLocation ?? null;
  state.childConversationId = null;
  state.snapshot = null;
  state.traces = [];
  state.cursor = 0;
  state.streamError = null;
  state.notice = null;
}

export function setStreamCredentials(
  state: ConversationWorkspaceState,
  token: string | null,
  expiresAt: string | null,
) {
  state.streamToken = token;
  state.streamTokenExpiresAt = expiresAt;
  state.streamVersion += 1;
}

export function applyConversationSnapshot(
  state: ConversationWorkspaceState,
  snapshot: ConversationSnapshot,
) {
  if (!isConversationSnapshotWireV1(snapshot)) return false;
  if (snapshot.conversation_id !== state.activeConversationId) return false;
  if (state.snapshot && snapshot.last_seq < Math.max(state.snapshot.last_seq, state.cursor)) {
    return false;
  }
  state.snapshot = snapshot;
  return true;
}

export function applyConversationTrace(
  state: ConversationWorkspaceState,
  record: ConversationTraceRecord,
) {
  if (!isConversationPublicTraceRecordWireV1(record)) return false;
  if (record.conversation_id !== state.activeConversationId) return false;
  if (record.seq <= state.cursor || state.traces.some((entry) => entry.seq === record.seq)) {
    return false;
  }
  let index = state.traces.length;
  while (index > 0 && (state.traces[index - 1]?.seq ?? 0) > record.seq) index -= 1;
  state.traces.splice(index, 0, record);
  state.cursor = Math.max(state.cursor, record.seq);
  if (!state.snapshot) return true;
  state.snapshot.last_seq = Math.max(state.snapshot.last_seq, record.seq);
  if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE) {
    state.snapshot.lifecycle = record.event.payload.lifecycle;
    state.snapshot.health = record.event.payload.health;
  } else if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL) {
    state.snapshot.lifecycle = record.event.payload.lifecycle;
  } else if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE) {
    state.snapshot.consensus_score = record.event.payload.decision.score;
  }
  return true;
}

export const currentConversationCursor = (state: ConversationWorkspaceState) => state.cursor;

function parseConversationParticipants(text: string): ConversationCreateParticipant[] | undefined {
  const lines = text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  return lines.map((line) => {
    const match = /^([^@\s]+)@([a-z]+)(?::(.+))?$/i.exec(line);
    const engine = match?.[2]?.toLowerCase() ?? "";
    if (!match || !isAgentEngine(engine)) throw new Error(`Invalid participant: ${line}`);
    return {
      role_ref: match[1] as string,
      engine,
      ...(match[3] ? { model: match[3] } : {}),
    };
  });
}

export function buildConversationCreateRequest(draft: {
  topic: string;
  policy: string;
  participants: string;
  maxRounds: string;
}) {
  const topic = draft.topic.trim();
  if (!topic) return { request: null, error: "Topic is required." };
  const maxRounds = draft.maxRounds.trim() ? Number(draft.maxRounds) : undefined;
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
    return { request: null, error: "Max rounds must be a positive integer." };
  }
  try {
    const participants = parseConversationParticipants(draft.participants);
    return {
      request: {
        topic,
        ...(draft.policy.trim() ? { policy: draft.policy.trim() } : {}),
        ...(participants ? { participants } : {}),
        ...(maxRounds !== undefined ? { max_rounds: maxRounds } : {}),
      } satisfies ConversationCreateRequest,
      error: null,
    };
  } catch (error) {
    return {
      request: null,
      error: error instanceof Error ? error.message : "Participants were invalid.",
    };
  }
}

export function collectConversationApprovals(records: readonly ConversationTraceRecord[]) {
  const approvals = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.APPROVAL_REQUESTED) {
      approvals.set(record.event.payload.token.approval_id, {
        approval_id: record.event.payload.token.approval_id,
        operation_id: record.event.payload.token.operation_id,
        actor: record.event.payload.token.actor,
        description: record.event.payload.description,
        requested_at: record.ts,
        resolved: false,
        decision: null,
      });
    } else if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.APPROVAL_RESOLVED) {
      const current = approvals.get(record.event.payload.decision.approval_id);
      if (!current) continue;
      current.resolved = true;
      current.decision = { ...record.event.payload.decision };
    }
  }
  return [...approvals.values()].sort((left, right) =>
    String(right.requested_at).localeCompare(String(left.requested_at)),
  ) as Array<{
    approval_id: string;
    operation_id: string;
    actor: string;
    description: string;
    requested_at: string;
    resolved: boolean;
    decision: ConversationTraceRecord["event"] extends infer Event
      ? Event extends {
          type: typeof CONVERSATION_TRACE_EVENT_KIND.APPROVAL_RESOLVED;
          payload: { decision: infer Decision };
        }
        ? Decision
        : never
      : never;
  }>;
}

export function collectConversationOperations(records: readonly ConversationTraceRecord[]) {
  const operations = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.OPERATION_LIFECYCLE) {
      const current = operations.get(record.event.payload.operation_id);
      operations.set(record.event.payload.operation_id, {
        operation_id: record.event.payload.operation_id,
        attempt_id: record.event.payload.attempt_id,
        state: record.event.payload.state,
        last_seq: record.seq,
        cancelled: current?.cancelled ?? false,
        cancelled_by: current?.cancelled_by ?? null,
        cancel_reason: current?.cancel_reason ?? null,
      });
    } else if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.CALLER_CANCELLED) {
      const current = operations.get(record.event.payload.operation_id);
      if (!current) continue;
      current.cancelled = true;
      current.cancelled_by = record.event.payload.actor;
      current.cancel_reason = record.event.payload.reason;
      current.last_seq = record.seq;
    }
  }
  return [...operations.values()].sort(
    (left, right) => Number(right.last_seq) - Number(left.last_seq),
  ) as Array<{
    operation_id: string;
    attempt_id: string;
    state: ConversationTraceRecord["event"] extends infer Event
      ? Event extends {
          type: typeof CONVERSATION_TRACE_EVENT_KIND.OPERATION_LIFECYCLE;
          payload: { state: infer State };
        }
        ? State
        : never
      : never;
    last_seq: number;
    cancelled: boolean;
    cancelled_by: string | null;
    cancel_reason: string | null;
  }>;
}

export function collectConversationArtifacts(records: readonly ConversationTraceRecord[]) {
  const artifacts = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if (
      record.event.type !== CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED &&
      record.event.type !== CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED
    ) {
      continue;
    }
    artifacts.set(record.event.payload.artifact_id, {
      artifact_id: record.event.payload.artifact_id,
      artifact_type: record.event.payload.artifact_type,
      opaque_id: opaqueArtifact(record.event.payload.ref),
      previous_opaque_id:
        record.event.type === CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED
          ? opaqueArtifact(record.event.payload.previous_ref)
          : null,
      last_seq: record.seq,
      ts: record.ts,
      status:
        record.event.type === CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED
          ? "created"
          : "updated",
    });
  }
  return [...artifacts.values()].sort(
    (left, right) => Number(right.last_seq) - Number(left.last_seq),
  ) as Array<{
    artifact_id: string;
    artifact_type: string;
    opaque_id: string | null;
    previous_opaque_id: string | null;
    last_seq: number;
    ts: string;
    status: "created" | "updated";
  }>;
}

export function conversationControls(
  snapshot: ConversationSnapshot | null,
  operations: ReturnType<typeof collectConversationOperations>,
  approvals: ReturnType<typeof collectConversationApprovals>,
) {
  const lifecycle = snapshot?.lifecycle ?? CONVERSATION_LIFECYCLE.INIT;
  return {
    canPause: lifecycle === CONVERSATION_LIFECYCLE.ACTIVE,
    canResume: lifecycle === CONVERSATION_LIFECYCLE.PAUSED,
    canStop:
      lifecycle === CONVERSATION_LIFECYCLE.INIT ||
      lifecycle === CONVERSATION_LIFECYCLE.ACTIVE ||
      lifecycle === CONVERSATION_LIFECYCLE.PAUSED,
    canInject: lifecycle === CONVERSATION_LIFECYCLE.ACTIVE,
    canRevise: lifecycle === CONVERSATION_LIFECYCLE.COMPLETED,
    canCancel:
      !isTerminalLifecycle(lifecycle) &&
      operations.some(
        (operation) =>
          !operation.cancelled && operation.state !== CONVERSATION_OPERATION_STATE.COMPLETED,
      ),
    canResolveApproval: (approvalId: string, operationId: string) =>
      lifecycle === CONVERSATION_LIFECYCLE.ACTIVE &&
      approvals.some(
        (approval) =>
          approval.approval_id === approvalId &&
          approval.operation_id === operationId &&
          !approval.resolved,
      ) &&
      operations.some(
        (operation) => operation.operation_id === operationId && !operation.cancelled,
      ),
    hasPendingApproval: approvals.some((approval) => !approval.resolved),
  };
}

export type ConversationApprovalView = ReturnType<typeof collectConversationApprovals>[number];
export type ConversationOperationView = ReturnType<typeof collectConversationOperations>[number];
export type ConversationArtifactView = ReturnType<typeof collectConversationArtifacts>[number];
export type ConversationMessageView = ReturnType<typeof buildConversationMessages>[number];
export type TraceSessionView = ReturnType<typeof collectTraceSessions> extends Map<
  string,
  infer View
>
  ? View
  : never;
export type ConversationControls = ReturnType<typeof conversationControls>;

export { buildConversationMessages };
export { collectTraceSessions };
export { projectConversationBaseline, projectConversationDecisionMatrix };

export function useConversationWorkspaceModel() {
  const state = reactive(createConversationState());
  const approvals = computed(() => collectConversationApprovals(state.traces));
  const operations = computed(() => collectConversationOperations(state.traces));
  const sessions = computed(() => collectTraceSessions(state.traces));
  const artifacts = computed(() => collectConversationArtifacts(state.traces));
  const messages = computed(() => buildConversationMessages(state.snapshot, state.traces));
  const decisionMatrix = computed(() => projectConversationDecisionMatrix(state.traces));
  const baseline = computed(() => projectConversationBaseline(state.traces, decisionMatrix.value));
  const controls = computed(() =>
    conversationControls(state.snapshot, operations.value, approvals.value),
  );
  return {
    state,
    approvals,
    operations,
    sessions,
    artifacts,
    messages,
    decisionMatrix,
    baseline,
    controls,
  };
}
