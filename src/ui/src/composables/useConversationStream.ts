import { onUnmounted, watch } from "vue";
import {
  conversationApi,
  conversationEventsUrl,
  parseConversationSseRecord,
} from "../conversation-api.js";
import { type ConversationWorkspaceState, collectTraceSessions } from "../conversation-store.js";
import {
  type ConversationSnapshot,
  type ConversationTraceRecord,
  createConversationStreamAttemptGuard,
  recoverConversationStreamAttempt,
} from "../conversation-types.js";

type MessageKind =
  | "boundary"
  | "user"
  | "participant"
  | "assessment"
  | "decision"
  | "status"
  | "error"
  | "precommit";

const scoreGate = (gates: Array<{ value: boolean | "not_applicable" }>) => {
  let passed = 0;
  let applicable = 0;
  for (const gate of gates) {
    if (gate.value === "not_applicable") continue;
    applicable += 1;
    if (gate.value) passed += 1;
  }
  return applicable === 0 ? "0/0" : `${passed}/${applicable}`;
};

const participantLookup = (snapshot: ConversationSnapshot | null) =>
  new Map(
    (snapshot?.participants ?? []).map((participant) => [participant.participant_id, participant]),
  );

const collectMessageMeta =
  (
    participants: ReturnType<typeof participantLookup>,
    sessions: ReturnType<typeof collectTraceSessions>,
  ) =>
  (participantId: string | null, fallback: string | null = null) => {
    const participant = participantId ? (participants.get(participantId) ?? null) : null;
    const session = participant?.public_session_ref
      ? (sessions.get(participant.public_session_ref) ?? null)
      : null;
    return {
      role_ref: participant?.role_ref ?? fallback,
      engine: participant?.engine ?? null,
      model: participant?.model ?? null,
      public_session_ref: participant?.public_session_ref ?? null,
      session_status: session?.status ?? null,
    };
  };

const makeMessage = (
  record: ConversationTraceRecord,
  meta: ReturnType<ReturnType<typeof collectMessageMeta>>,
  seed: {
    key: string;
    kind: MessageKind;
    title: string;
    body: string;
    round_id?: string | null;
    participant_id?: string | null;
    claim?: string | null;
    evidence?: string[];
    complete?: boolean;
    trace_seqs?: number[];
  },
) => ({
  key: seed.key,
  kind: seed.kind,
  seq: record.seq,
  ts: record.ts,
  round_id: seed.round_id ?? null,
  participant_id: seed.participant_id ?? null,
  title: seed.title,
  body: seed.body,
  claim: seed.claim ?? null,
  evidence: seed.evidence ?? [],
  complete: seed.complete ?? true,
  trace_seqs: seed.trace_seqs ?? [record.seq],
  ...meta,
});

export function buildConversationMessages(
  snapshot: ConversationSnapshot | null,
  records: readonly ConversationTraceRecord[],
) {
  const participants = participantLookup(snapshot);
  const sessions = collectTraceSessions(records);
  const meta = collectMessageMeta(participants, sessions);
  const messages: Array<ReturnType<typeof makeMessage>> = [];
  const threaded = new Map<string, ReturnType<typeof makeMessage>>();

  for (const record of records) {
    const event = record.event;
    switch (event.type) {
      case "round_boundary":
        messages.push(
          makeMessage(record, meta(null), {
            key: `boundary-${record.seq}`,
            kind: "boundary",
            title: `Round ${event.payload.phase}`,
            body: event.payload.round_id,
            round_id: event.payload.round_id,
          }),
        );
        break;
      case "user_message":
        messages.push(
          makeMessage(record, meta(null), {
            key: `user-${record.seq}`,
            kind: "user",
            title: "User message",
            body: event.payload.content,
          }),
        );
        break;
      case "precommit":
        messages.push(
          makeMessage(record, meta(event.payload.participant_id), {
            key: `precommit-${record.seq}`,
            kind: "precommit",
            title: "Draft claim",
            body: event.payload.answer,
            round_id: event.payload.round_id,
            participant_id: event.payload.participant_id,
            claim: event.payload.answer,
            evidence: [...event.payload.evidence],
          }),
        );
        break;
      case "agent_response_delta": {
        const key = `${event.payload.round_id}:${event.payload.participant_id}`;
        const current = threaded.get(key);
        if (!current) {
          const created = makeMessage(
            record,
            meta(event.payload.participant_id, record.role_ref ?? null),
            {
              key,
              kind: "participant",
              title: "Participant response",
              body: event.payload.content_delta,
              round_id: event.payload.round_id,
              participant_id: event.payload.participant_id,
              claim: event.payload.final_claim,
              evidence: event.payload.completes_response ? [...event.payload.final_evidence] : [],
              complete: event.payload.completes_response,
            },
          );
          threaded.set(key, created);
          messages.push(created);
          break;
        }
        current.seq = record.seq;
        current.ts = record.ts;
        current.body += event.payload.content_delta;
        current.claim = event.payload.final_claim ?? current.claim;
        current.evidence = event.payload.completes_response
          ? [...event.payload.final_evidence]
          : current.evidence;
        current.complete = current.complete || event.payload.completes_response;
        current.trace_seqs.push(record.seq);
        break;
      }
      case "evaluator_assessment":
        messages.push(
          makeMessage(record, meta(record.participant_id ?? null, record.role_ref ?? null), {
            key: `assessment-${record.seq}`,
            kind: "assessment",
            title: `${event.payload.stage === "blind" ? "Blind" : "Full"} assessment`,
            body: [
              `agreement ${scoreGate([event.payload.assessment.agreement])}`,
              `conflict ${scoreGate([event.payload.assessment.conflict_resolution])}`,
              `evidence ${scoreGate([
                event.payload.assessment.evidence_quality,
                event.payload.assessment.convergence,
              ])}`,
            ].join(" · "),
            round_id: event.payload.round_id,
            participant_id: record.participant_id ?? null,
          }),
        );
        break;
      case "consensus_update":
        messages.push(
          makeMessage(record, meta(null), {
            key: `decision-${record.seq}`,
            kind: "decision",
            title: "Consensus update",
            body:
              event.payload.decision.score === null
                ? event.payload.decision.outcome
                : `${event.payload.decision.outcome} · score ${event.payload.decision.score.toFixed(
                    2,
                  )}`,
            round_id: event.payload.round_id,
          }),
        );
        break;
      case "state_change":
      case "conversation_terminal":
        messages.push(
          makeMessage(record, meta(null), {
            key: `state-${record.seq}`,
            kind: "status",
            title: "Lifecycle",
            body:
              event.type === "state_change"
                ? `${event.payload.lifecycle} · ${event.payload.health}`
                : event.payload.lifecycle,
          }),
        );
        break;
      case "error":
        messages.push(
          makeMessage(record, meta(null), {
            key: `error-${record.seq}`,
            kind: "error",
            title: event.payload.code,
            body: event.payload.message,
          }),
        );
        break;
    }
  }

  return messages;
}

interface ConversationStreamBindings {
  state: ConversationWorkspaceState;
  currentCursor(): number;
  applySnapshot(snapshot: ConversationSnapshot): boolean;
  applyTrace(raw: ReturnType<typeof parseConversationSseRecord>): boolean;
  setStreamCredentials(token: string | null, expiresAt: string | null): void;
}

export function useConversationStream(bindings: ConversationStreamBindings) {
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let destroyed = false;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const clearRenewal = () => {
    if (renewTimer !== null) clearTimeout(renewTimer);
    renewTimer = null;
  };
  const closeStream = () => {
    es?.close();
    es = null;
    clearRetry();
    clearRenewal();
  };
  const setStatus = (status: ConversationWorkspaceState["streamStatus"], error: string | null) => {
    bindings.state.streamStatus = status;
    bindings.state.streamError = error;
  };
  const scheduleReconnect = (delay = 1_000) => {
    clearRetry();
    if (destroyed || !bindings.state.activeConversationId || !bindings.state.streamToken) return;
    setStatus("reconnecting", "conversation stream disconnected");
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };
  const renewToken = async (
    attemptGuard?: ReturnType<typeof createConversationStreamAttemptGuard>,
  ) => {
    if (attemptGuard && !attemptGuard.canRecover()) return false;
    const conversationId = bindings.state.activeConversationId;
    if (!conversationId) return false;
    try {
      const renewed = await conversationApi.renewStreamToken(conversationId);
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      bindings.setStreamCredentials(renewed.stream_token, renewed.stream_token_expires_at);
      return true;
    } catch (error) {
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      setStatus(
        "error",
        error instanceof Error ? error.message : "conversation stream token renewal failed",
      );
      return false;
    }
  };
  const scheduleRenewal = (
    attemptGuard: ReturnType<typeof createConversationStreamAttemptGuard>,
  ) => {
    clearRenewal();
    const expiresAt = bindings.state.streamTokenExpiresAt;
    if (!expiresAt) return;
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires)) return;
    renewTimer = setTimeout(
      () => {
        renewTimer = null;
        if (attemptGuard.canRecover()) void renewToken(attemptGuard);
      },
      Math.max(1_000, expires - Date.now() - 30_000),
    );
  };

  const connect = async () => {
    const conversationId = bindings.state.activeConversationId;
    const streamToken = bindings.state.streamToken;
    if (!conversationId || !streamToken || destroyed) {
      closeStream();
      setStatus("idle", null);
      return;
    }
    generation += 1;
    const attempt = generation;
    const attemptGuard = createConversationStreamAttemptGuard();
    closeStream();
    setStatus("connecting", null);
    scheduleRenewal(attemptGuard);
    es = new EventSource(
      conversationEventsUrl(conversationId, streamToken, bindings.currentCursor()),
    );
    const current = es;

    current.addEventListener("snapshot", (event) => {
      if (attempt !== generation) return;
      try {
        bindings.applySnapshot(JSON.parse((event as MessageEvent).data) as ConversationSnapshot);
        setStatus("live", null);
      } catch {
        setStatus("error", "conversation snapshot was invalid");
      }
    });

    current.addEventListener("trace", (event) => {
      if (attempt !== generation) return;
      try {
        bindings.applyTrace(parseConversationSseRecord((event as MessageEvent).data));
        setStatus("live", null);
      } catch {
        setStatus("error", "conversation trace event was invalid");
      }
    });

    current.addEventListener("error", (event) => {
      if (attempt !== generation || !(event instanceof MessageEvent)) return;
      const failure = attemptGuard.acceptTypedError(event.data);
      if (failure.fatal) closeStream();
      setStatus("error", failure.message);
    });

    current.onerror = async () => {
      if (attempt !== generation || destroyed) return;
      await recoverConversationStreamAttempt(
        attemptGuard,
        async () => {
          current.close();
          es = null;
          return renewToken(attemptGuard);
        },
        () => attempt === generation && scheduleReconnect(1_500),
      );
    };
  };

  watch(
    () => [bindings.state.activeConversationId, bindings.state.streamToken] as const,
    () => {
      void connect();
    },
    { immediate: true },
  );

  onUnmounted(() => {
    destroyed = true;
    closeStream();
  });

  return {
    reconnect: () => void connect(),
    disconnect: () => {
      generation += 1;
      closeStream();
      setStatus("idle", null);
    },
  };
}
