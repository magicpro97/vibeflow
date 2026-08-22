import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINES, type Engine, cwd, writeFileSafe } from "../core.js";
import { checkReviewEvidence, defaultGit } from "../hooks/review-evidence.js";
import {
  type ConversationBootstrapOptions,
  createConversationBootstrap,
} from "../orchestrator/conversation/bootstrap.js";
import type {
  OrchestrateLibrary,
  PlanLibrary,
  PolicyVerifyReport,
  ReviewLibrary,
  ReviewLibraryResult,
  VerifyLibrary,
} from "../orchestrator/conversation/services.js";
import type {
  ConversationCreateParticipant,
  ConversationCreateRequest,
  ConversationInvocationOptions,
  ConversationService,
  MessageResponse,
} from "../orchestrator/conversation/types.js";
import type { PublicStoredTraceEvent } from "../orchestrator/trace/types.js";
import { verifyLockGate } from "../skills/verify-lock.js";
import {
  type VerifyReport,
  buildPlanPrompt,
  collectVerifyReportAsync,
  executeConversationWorkflow,
} from "./_shared.js";

export const CONVERSATION_EXIT = Object.freeze({
  ok: 0,
  validation: 1,
  engineStart: 2,
  transport: 3,
  failed: 4,
  aborted: 5,
});

export interface ParsedConversationArgv {
  positionals: string[];
  flags: Record<string, string | boolean>;
  participants: string[];
  unknownFlags: string[];
}

export interface ConversationCommandDeps {
  service?: ConversationService;
  createService?: () => ConversationService;
  bootstrap?: Omit<ConversationBootstrapOptions, "repoRoot" | "libraries"> &
    Partial<Pick<ConversationBootstrapOptions, "libraries">>;
}

export interface ConversationExecutionRecord {
  conversationId: string;
  revisionId?: string;
  status: "completed" | "aborted" | "failed" | "awaiting_approval" | "accepted" | "stopped";
  artifactRefs: string[];
  output: string;
  response?: MessageResponse;
  events: PublicStoredTraceEvent[];
}

export interface ConversationMessageResult extends ConversationExecutionRecord {
  childConversationId?: string;
}

interface ProductionLibraryDeps {
  collectVerify?: (
    base: string,
  ) => Promise<VerifyReport | { gates: PolicyVerifyReport } | PolicyVerifyReport>;
}

const VALID_ENGINES = new Set<string>(ENGINES);
const START_ERROR_HINTS = /no ready admitted engine|explicit_engine_unavailable|unsupported engine/;
const TRANSPORT_ERROR_HINTS = /conversation not found|configure failed|persistence failed/;
const VALIDATION_ERROR_HINTS =
  /invalid|unknown explicit|unsupported engine|missing --max-rounds|participant/;
const VALUE_FLAGS = new Set(["policy", "resume", "max-rounds"]);
const JSON_ERROR_CODES: Record<number, string> = {
  1: "validation_error",
  2: "engine_start_error",
  3: "transport_error",
  4: "conversation_failed",
  5: "conversation_aborted",
};

function parseTokenValue(args: string[], index: number): [string | boolean, number] {
  const current = args[index] as string;
  const equals = current.indexOf("=");
  if (equals >= 0) return [current.slice(equals + 1), index];
  const next = args[index + 1];
  if (next && !next.startsWith("-")) return [next, index + 1];
  return [true, index];
}

export function parseConversationArgv(
  argv: string[],
  allowedFlags: readonly string[],
): ParsedConversationArgv {
  const allow = new Set(allowedFlags);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const participants: string[] = [];
  const unknownFlags: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2).split("=")[0] ?? "";
    const wantsValue = key === "participant" || VALUE_FLAGS.has(key) || token.includes("=");
    const [value, consumed] = wantsValue ? parseTokenValue(argv, index) : [true, index];
    if (key === "participant") {
      if (typeof value === "string" && value.trim()) participants.push(value.trim());
      else unknownFlags.push("--participant");
      index = consumed;
      continue;
    }
    if (!allow.has(key)) {
      unknownFlags.push(`--${key}`);
      index = consumed;
      continue;
    }
    flags[key] = value;
    index = consumed;
  }
  return { positionals, flags, participants, unknownFlags };
}

export function parseParticipantSpec(spec: string): ConversationCreateParticipant {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) throw new Error(`invalid participant "${spec}"`);
  const roleRef = spec.slice(0, at).trim();
  const rest = spec.slice(at + 1).trim();
  const colon = rest.indexOf(":");
  const engine = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
  const model = (colon >= 0 ? rest.slice(colon + 1) : "").trim();
  if (!roleRef) throw new Error(`invalid participant "${spec}"`);
  if (!VALID_ENGINES.has(engine)) throw new Error(`unsupported engine "${engine}"`);
  return {
    role_ref: roleRef,
    engine,
    ...(model ? { model } : {}),
  };
}

export function parseMaxRounds(value: string | boolean | undefined): number | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) throw new Error("missing --max-rounds value");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid --max-rounds value");
  return parsed;
}

function promptAttempt(
  context: Parameters<NonNullable<PlanLibrary["create"]>>[0]["context"],
  bindingIndex: number,
  purpose: "plan" | "review",
  promptInput: string,
) {
  const participantId = context.participantIds[bindingIndex];
  if (!participantId) throw new Error(`missing ${purpose} participant`);
  return context.launchAttempt({ participantId, bindingIndex, purpose, promptInput });
}

const readBriefRaw = (base: string): string | null => {
  const path = join(base, ".vibeflow", "knowledge", "coordinator-brief.md");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};
const sidecarPlanPath = (base: string, revisionId: string): string =>
  join(base, ".vibeflow", "plans", `${revisionId}.md`);
const lifecycleStatus = (lifecycle: string): ConversationExecutionRecord["status"] =>
  lifecycle === "COMPLETED"
    ? "completed"
    : lifecycle === "STOPPED"
      ? "stopped"
      : lifecycle === "ABORTED"
        ? "aborted"
        : "failed";

const runVerifyReport = async (
  base: string,
  inject?: ProductionLibraryDeps["collectVerify"],
): Promise<PolicyVerifyReport> => {
  const report = inject
    ? await inject(base)
    : await collectVerifyReportAsync(base, { requireReviewEvidence: true });
  return "gates" in report ? report.gates : report;
};

export function productionLibraries(
  base: string,
  inject: ProductionLibraryDeps = {},
): ConversationBootstrapOptions["libraries"] {
  const planLibrary: PlanLibrary = {
    create: async ({ context }) => {
      const prompt = buildPlanPrompt(context.topic, readBriefRaw(base));
      const attempt = promptAttempt(context, 0, "plan", prompt);
      const result = await attempt.completion;
      if (!result.ok || !result.output.trim()) throw new Error(result.reason ?? "plan failed");
      writeFileSafe(sidecarPlanPath(base, context.correlation.revision_id), result.output);
      return { content: result.output, revision_id: context.correlation.revision_id };
    },
    update: async ({ revision }) => {
      writeFileSafe(sidecarPlanPath(base, revision.revision_id), revision.content);
      return { content: revision.content };
    },
  };
  const reviewLibrary: ReviewLibrary = {
    currentHead: () => "HEAD",
    review: async ({ artifact, head_sha }) => {
      const review = checkReviewEvidence(base, true, defaultGit, head_sha);
      return {
        reviewed_head: head_sha,
        reviewer: "human-only",
        outcome: review.ok ? "approved" : "changes_requested",
        evidence_refs: review.ok ? [artifact.ref] : [],
      } satisfies ReviewLibraryResult;
    },
  };
  const verifyLibrary: VerifyLibrary = {
    run: async () => runVerifyReport(base, inject.collectVerify),
  };
  const orchestrateLibrary: OrchestrateLibrary = {
    dryRun: async () => ({
      participants: [],
      evaluator_auto_added: false,
      engines_available: [],
      models_valid: true,
    }),
    execute: async ({ context }) => executeConversationWorkflow(base, context),
  };
  return {
    plan: planLibrary,
    review: reviewLibrary,
    verify: verifyLibrary,
    orchestrate: orchestrateLibrary,
  };
}

export function conversationBootstrap(deps: ConversationCommandDeps = {}, base = cwd()) {
  return createConversationBootstrap({
    repoRoot: base,
    libraries: deps.bootstrap?.libraries ?? productionLibraries(base),
    ...(deps.bootstrap ?? {}),
  });
}

export function conversationService(
  deps: ConversationCommandDeps = {},
  base = cwd(),
): ConversationService {
  if (deps.service) return deps.service;
  if (deps.createService) return deps.createService();
  return conversationBootstrap(deps, base).service;
}

export function classifyConversationError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (VALIDATION_ERROR_HINTS.test(lower)) return CONVERSATION_EXIT.validation;
  if (START_ERROR_HINTS.test(lower)) return CONVERSATION_EXIT.engineStart;
  if (TRANSPORT_ERROR_HINTS.test(lower)) return CONVERSATION_EXIT.transport;
  return CONVERSATION_EXIT.failed;
}

export function classifyConversationResult(
  status: ConversationExecutionRecord["status"],
  events: readonly PublicStoredTraceEvent[],
): number {
  if (
    status === "completed" ||
    status === "accepted" ||
    status === "awaiting_approval" ||
    status === "stopped"
  )
    return CONVERSATION_EXIT.ok;
  if (status === "aborted") return CONVERSATION_EXIT.aborted;
  const errorCodes = events.flatMap((event) =>
    event.event.type === "error" && "code" in event.event.payload
      ? [String(event.event.payload.code).toLowerCase()]
      : [],
  );
  if (errorCodes.some((code) => code.includes("start") || code.includes("unavailable")))
    return CONVERSATION_EXIT.engineStart;
  if (errorCodes.some((code) => code.includes("transport"))) return CONVERSATION_EXIT.transport;
  return CONVERSATION_EXIT.failed;
}

export function jsonWrite(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

export function conversationJsonErrorCode(exit: number): string {
  return JSON_ERROR_CODES[exit] ?? "conversation_failed";
}

function subscribeOutput(
  service: ConversationService,
  conversationId: string,
  onDelta?: (chunk: string) => void,
  afterSeq = 0,
) {
  const events: PublicStoredTraceEvent[] = [];
  let output = "";
  let lastSeq = afterSeq;
  const listener = (event: PublicStoredTraceEvent) => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    events.push(event);
    if (event.event.type !== "agent_response_delta") return;
    const delta = String(event.event.payload.content_delta ?? "");
    if (!delta) return;
    output += delta;
    onDelta?.(delta);
  };
  const unsubscribe = service.subscribe(conversationId, listener, afterSeq);
  const replayReady =
    unsubscribe && "replayReady" in unsubscribe
      ? (unsubscribe.replayReady ?? Promise.resolve())
      : Promise.resolve();
  return { events, output: () => output, unsubscribe, replayReady };
}

export async function executeConversationCreate(
  service: ConversationService,
  request: ConversationCreateRequest,
  onDelta?: (chunk: string) => void,
  options?: ConversationInvocationOptions,
): Promise<ConversationExecutionRecord> {
  const started = await service.start(request, options);
  const stream = subscribeOutput(service, started.conversation_id, onDelta);
  try {
    const completed = await started.completion;
    await stream.replayReady;
    return {
      conversationId: completed.conversation_id,
      revisionId: completed.revision_id,
      status: completed.result.status,
      artifactRefs: [...completed.result.artifact_refs],
      output: stream.output(),
      events: stream.events,
    };
  } finally {
    stream.unsubscribe?.();
  }
}

export async function executeConversationMessage(
  service: ConversationService,
  conversationId: string,
  content: string,
  onDelta?: (chunk: string) => void,
): Promise<ConversationMessageResult> {
  const current = await service.snapshot(conversationId);
  const afterSeq = current?.last_seq ?? 0;
  const response = await service.message(conversationId, { content });
  const childConversationId = response.child_conversation_id;
  const targetConversationId = childConversationId ?? conversationId;
  const stream = subscribeOutput(
    service,
    targetConversationId,
    onDelta,
    childConversationId ? 0 : afterSeq,
  );
  try {
    while (true) {
      const snapshot = await service.snapshot(targetConversationId);
      if (!snapshot) throw new Error("conversation not found");
      if (["COMPLETED", "FAILED", "ABORTED", "STOPPED"].includes(snapshot.lifecycle)) {
        await stream.replayReady;
        return {
          conversationId: targetConversationId,
          status: lifecycleStatus(snapshot.lifecycle),
          artifactRefs: [],
          output: stream.output(),
          response,
          ...(childConversationId ? { childConversationId } : {}),
          events: stream.events,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    stream.unsubscribe?.();
  }
}
