import type {
  ApprovalDecision,
  ApprovalResolveResponse,
  ConversationCreateRequest,
  ConversationCreateResponse,
  ConversationSnapshot,
  ConversationTraceRecord,
  MessageRequest,
  MessageResponse,
  OperationCancelCommand,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  StreamTokenRenewalResponse,
} from "./conversation-types.js";

const browserGlobal = globalThis as unknown as {
  document?: { querySelector(selector: string): { content?: string } | null };
};
const CSRF = browserGlobal.document?.querySelector('meta[name="vf-token"]')?.content ?? "";
const JSON_HEADERS = { "content-type": "application/json" } as const;
const WEIGHTS = {
  responses: 0.2,
  evidence: 0.1,
  agreement: 0.25,
  conflict_resolution: 0.2,
  evidence_quality: 0.15,
  convergence: 0.1,
} as const;

type GateValue = boolean | "not_applicable";
type ScoreAxis = keyof typeof WEIGHTS;
type FullAssessment = Extract<ConversationTraceRecord["event"], { type: "evaluator_assessment" }>;
type CompletedRound = {
  responses: Map<string, ResponseState>;
  assessments: FullAssessment[];
  decision: "abort" | "complete" | null;
  consumed: string[];
  ended: boolean;
};
type ResponseState = {
  claim: string | null;
  evidence: string[];
  complete: boolean;
  invalid: boolean;
};
const EMPTY_RESPONSE: ResponseState = {
  claim: null,
  evidence: [],
  complete: false,
  invalid: false,
};

export class ConversationApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ConversationApiError";
    this.status = status;
    this.code = code;
  }
}

function requestHeaders(write: boolean): Record<string, string> {
  if (!write || !CSRF) return { ...JSON_HEADERS };
  return { ...JSON_HEADERS, "x-vibeflow-token": CSRF };
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ConversationApiError(response.status, null, "conversation response was invalid");
  }
}

async function readError(response: Response): Promise<ConversationApiError> {
  let code: string | null = null;
  let message = `conversation request failed (${response.status})`;
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    code = typeof body.code === "string" ? body.code : null;
    if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
    else if (code) message = code;
  } catch {
    // Status-only fallback is adequate here.
  }
  return new ConversationApiError(response.status, code, message);
}

async function jsonRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: requestHeaders(method !== "GET"),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return parseJson<T>(response);
}

const conversationRoute = (conversationId: string, suffix = "") =>
  `/api/conversations/${encodeURIComponent(conversationId)}${suffix}`;
const getConversationJson = <T>(conversationId: string, suffix: string, signal?: AbortSignal) =>
  jsonRequest<T>("GET", conversationRoute(conversationId, suffix), undefined, signal);
const postConversationJson = <T>(
  conversationId: string,
  suffix: string,
  body: unknown,
  signal?: AbortSignal,
) => jsonRequest<T>("POST", conversationRoute(conversationId, suffix), body, signal);

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const normalizeOption = (value: string) => {
  const normalized = value
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  return { option: normalized, key: normalized.toLowerCase() };
};
const compareCodePoints = (left: string, right: string) => {
  const a = [...left].map((value) => value.codePointAt(0) ?? 0);
  const b = [...right].map((value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return a.length - b.length;
};
const computeTokenSetDivergence = (left: string, right: string) => {
  const tokenize = (value: string) =>
    new Set(
      normalizeOption(value)
        .key.split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size && !b.size) return 0;
  if (!a.size || !b.size) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return round6((a.size + b.size - 2 * intersection) / (a.size + b.size - intersection));
};
const roundIdFor = (event: ConversationTraceRecord["event"]) => {
  const payload = event.payload as { round_id?: unknown };
  return typeof payload.round_id === "string" ? payload.round_id : null;
};

export function conversationEventsUrl(
  conversationId: string,
  streamToken: string,
  cursor = 0,
): string {
  const params = new URLSearchParams({ stream_token: streamToken });
  if (cursor > 0) params.set("since", String(cursor));
  return `/api/conversations/${encodeURIComponent(conversationId)}/events?${params.toString()}`;
}

export function conversationArtifactUrl(conversationId: string, opaqueId: string): string {
  return `${conversationRoute(conversationId, "/artifacts/")}${encodeURIComponent(opaqueId)}`;
}

export const conversationApi = {
  create: (request: ConversationCreateRequest, signal?: AbortSignal) =>
    jsonRequest<ConversationCreateResponse>("POST", "/api/conversations", request, signal),
  snapshot: (conversationId: string, signal?: AbortSignal) =>
    getConversationJson<ConversationSnapshot>(conversationId, "/snapshot", signal),
  renewStreamToken: (conversationId: string, signal?: AbortSignal) =>
    postConversationJson<StreamTokenRenewalResponse>(conversationId, "/stream-token", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  message: (conversationId: string, request: MessageRequest, signal?: AbortSignal) => postConversationJson<MessageResponse>(conversationId, "/messages", request, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  pause: (conversationId: string, signal?: AbortSignal) => postConversationJson<PauseResponse>(conversationId, "/pause", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  resume: (conversationId: string, signal?: AbortSignal) => postConversationJson<ResumeResponse>(conversationId, "/resume", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  stop: (conversationId: string, signal?: AbortSignal) => postConversationJson<StopResponse>(conversationId, "/stop", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid Bun LCOV phantom counters
  resolveApproval: (conversationId: string, approvalId: string, decision: ApprovalDecision, signal?: AbortSignal) => postConversationJson<ApprovalResolveResponse>(conversationId, `/approvals/${encodeURIComponent(approvalId)}/resolve`, decision, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid Bun LCOV phantom counters
  cancelOperation: (conversationId: string, command: OperationCancelCommand, signal?: AbortSignal) => postConversationJson<{ operation_id: string; cancelled: true }>(conversationId, `/operations/${encodeURIComponent(command.operation_id)}/cancel`, command, signal),
};

export function parseConversationSseRecord(raw: string): ConversationTraceRecord {
  return JSON.parse(raw) as ConversationTraceRecord;
}

function collectCompletedRounds(records: readonly ConversationTraceRecord[]) {
  const rounds = new Map<string, CompletedRound>();
  for (const record of records) {
    const event = record.event;
    const roundId = roundIdFor(event);
    if (event.type === "round_boundary" && event.payload.phase === "start") {
      rounds.set(
        event.payload.round_id,
        rounds.get(event.payload.round_id) ?? {
          responses: new Map(),
          assessments: [],
          decision: null,
          consumed: [record.ts],
          ended: false,
        },
      );
    }
    if (!roundId) continue;
    const round = rounds.get(roundId);
    if (!round || round.ended) continue;
    if (event.type === "agent_response_delta") {
      const response = round.responses.get(event.payload.participant_id) ?? { ...EMPTY_RESPONSE };
      if (response.complete) response.invalid = true;
      else if (event.payload.completes_response) {
        response.complete = true;
        response.claim = event.payload.final_claim;
        response.evidence = [...new Set(event.payload.final_evidence)];
      }
      round.responses.set(event.payload.participant_id, response);
      round.consumed.push(record.ts);
    } else if (event.type === "evaluator_assessment" && event.payload.stage === "full") {
      round.assessments.push(event);
      round.consumed.push(record.ts);
    } else if (event.type === "consensus_update") {
      round.decision = event.payload.decision.outcome === "abort" ? "abort" : "complete";
      round.consumed.push(record.ts);
    } else if (event.type === "round_boundary" && event.payload.phase === "end") {
      round.ended = true;
      round.consumed.push(record.ts);
    }
  }
  return [...rounds.values()].filter(
    (round) =>
      round.ended &&
      round.decision === "complete" &&
      round.responses.size > 0 &&
      [...round.responses.values()].every((response) => response.complete && !response.invalid),
  );
}

function gateRatio(
  rounds: ReturnType<typeof collectCompletedRounds>,
  name: Exclude<ScoreAxis, "responses" | "evidence">,
) {
  let passed = 0;
  let applicable = 0;
  for (const round of rounds) {
    for (const assessment of round.assessments) {
      const gate = assessment.payload.assessment[name];
      if ((gate.value as GateValue) === "not_applicable") continue;
      applicable += 1;
      if (gate.value) passed += 1;
    }
  }
  return applicable ? passed / applicable : 0;
}

export function projectConversationDecisionMatrix(records: readonly ConversationTraceRecord[]) {
  const completed = collectCompletedRounds(records);
  const groups = new Map<
    string,
    { option: string; key: string; responses: number; evidence: number }
  >();
  for (const round of completed) {
    for (const response of round.responses.values()) {
      if (!response.claim) continue;
      const normalized = normalizeOption(response.claim);
      if (!normalized.key) continue;
      const current = groups.get(normalized.key);
      if (!current) {
        groups.set(normalized.key, {
          option: normalized.option,
          key: normalized.key,
          responses: 1,
          evidence: response.evidence.length,
        });
        continue;
      }
      current.responses += 1;
      current.evidence += response.evidence.length;
      if (compareCodePoints(normalized.option, current.option) < 0) {
        current.option = normalized.option;
      }
    }
  }
  if (!groups.size) return null;

  const totalResponses = [...groups.values()].reduce((sum, group) => sum + group.responses, 0);
  const totalEvidence = [...groups.values()].reduce((sum, group) => sum + group.evidence, 0);
  const sharedScores = {
    agreement: round6(gateRatio(completed, "agreement")),
    conflict_resolution: round6(gateRatio(completed, "conflict_resolution")),
    evidence_quality: round6(gateRatio(completed, "evidence_quality")),
    convergence: round6(gateRatio(completed, "convergence")),
  };

  const rows = [...groups.values()]
    .map((group) => {
      const responses = round6(group.responses / totalResponses);
      const evidence = round6(totalEvidence ? group.evidence / totalEvidence : 0);
      return {
        option: group.option,
        key: group.key,
        responses: group.responses,
        scores: { responses, evidence, ...sharedScores },
        aggregate: round6(
          responses * WEIGHTS.responses +
            evidence * WEIGHTS.evidence +
            sharedScores.agreement * WEIGHTS.agreement +
            sharedScores.conflict_resolution * WEIGHTS.conflict_resolution +
            sharedScores.evidence_quality * WEIGHTS.evidence_quality +
            sharedScores.convergence * WEIGHTS.convergence,
        ),
      };
    })
    .sort(
      (left, right) =>
        right.aggregate - left.aggregate ||
        right.responses - left.responses ||
        compareCodePoints(left.key, right.key),
    )
    .map(({ key: _key, responses: _responses, ...row }, index) => ({
      ...row,
      rank: index + 1,
    }));

  return {
    rows,
    method: "weighted_sum" as const,
    generated_at:
      completed
        .flatMap((round) => round.consumed)
        .sort()
        .at(-1) ?? "",
  };
}

export function projectConversationBaseline(
  records: readonly ConversationTraceRecord[],
  decisionMatrix: ReturnType<typeof projectConversationDecisionMatrix>,
) {
  const baseline = [...records].reverse().find((record) => record.event.type === "baseline_result");
  if (!baseline || baseline.event.type !== "baseline_result") return null;

  const debateAnswer = decisionMatrix?.rows.find((row) => row.rank === 1)?.option ?? null;
  if (baseline.event.payload.status !== "success") {
    return {
      status: baseline.event.payload.status,
      baseline_answer: null,
      debate_answer: debateAnswer,
      divergence: null,
      skip_reason: baseline.event.payload.skip_reason,
    };
  }

  const baselineAnswer = baseline.event.payload.answer;
  return {
    status: baselineAnswer && debateAnswer ? "success" : "failed",
    baseline_answer: baselineAnswer,
    debate_answer: debateAnswer,
    divergence:
      baselineAnswer && debateAnswer
        ? computeTokenSetDivergence(baselineAnswer, debateAnswer)
        : null,
    skip_reason:
      baselineAnswer && debateAnswer
        ? null
        : baselineAnswer
          ? "no_debate_answer"
          : "baseline_missing",
  };
}
