import { projectBaselineComparison } from "../orchestrator/conversation/baseline.js";
import { projectDecisionMatrix } from "../orchestrator/conversation/debate-projection.js";
import type { ConversationCreateRequest } from "../orchestrator/conversation/types.js";
import type { PublicStoredTraceEvent } from "../orchestrator/trace/types.js";
import {
  CONVERSATION_EXIT,
  type ConversationCommandDeps,
  assertNoResumeCreateFlags,
  c,
  classifyConversationError,
  classifyConversationResult,
  conversationJsonErrorCode,
  conversationService,
  executeConversationCreate,
  executeConversationMessage,
  jsonWrite,
  out,
  parseConversationArgv,
  parseMaxRounds,
  parseOptionalResumeId,
  parseParticipantSpec,
  publicResumeValidationMessage,
} from "./_shared.js";
type BrainstormStatus = "completed" | "stopped" | "failed" | "aborted";
type BrainstormErrorKind = "validation" | "engine_start" | "transport";
function hasEvaluator(participants: readonly { role_ref: string }[]): boolean {
  return participants.some((participant) => participant.role_ref === "brainstorm-evaluator");
}
const roundSix = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const averageConsensusScore = (
  rounds: readonly { decision: { score?: number | null } | null }[],
): number | null => {
  const scores = rounds.flatMap((round) =>
    typeof round.decision?.score === "number" ? [round.decision.score] : [],
  );
  return scores.length
    ? roundSix(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : null;
};
const terminalStatus = (status: string): BrainstormStatus => {
  if (
    status !== "completed" &&
    status !== "stopped" &&
    status !== "failed" &&
    status !== "aborted"
  ) {
    throw new Error("brainstorm did not reach a terminal state");
  }
  return status;
};
const errorKind = (exit: number): BrainstormErrorKind =>
  exit === CONVERSATION_EXIT.engineStart
    ? "engine_start"
    : exit === CONVERSATION_EXIT.transport
      ? "transport"
      : "validation";
const errorMessage = (kind: BrainstormErrorKind): string =>
  kind === "validation"
    ? "request validation failed"
    : kind === "engine_start"
      ? "engine start failed"
      : "conversation transport failed";

const normalizedErrorExit = (exit: number): number =>
  exit === CONVERSATION_EXIT.validation ||
  exit === CONVERSATION_EXIT.engineStart ||
  exit === CONVERSATION_EXIT.transport
    ? exit
    : CONVERSATION_EXIT.transport;
const safeCode = (value: unknown, fallback: string): string => {
  const compact = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return compact || fallback;
};

const transcriptPath = (conversationId: string, artifactId: string | null): string | null =>
  artifactId
    ? `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(
        artifactId,
      )}`
    : null;
const findLastRecord = <T>(
  records: readonly T[],
  predicate: (record: T) => boolean,
): T | undefined => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record !== undefined && predicate(record)) return record;
  }
  return undefined;
};

const transcriptArtifactRef = (records: readonly PublicStoredTraceEvent[]): string | null => {
  const created = findLastRecord(
    records,
    (record) =>
      record.event.type === "artifact_created" &&
      record.event.payload.artifact_type === "transcript",
  );
  if (created?.event.type === "artifact_created") return String(created.event.payload.ref);
  return null;
};

const terminalError = (
  records: readonly PublicStoredTraceEvent[],
  exit: number,
): { error_kind: BrainstormErrorKind; code: string; message: string } | null => {
  const error = findLastRecord(records, (record) => record.event.type === "error");
  const normalizedExit = normalizedErrorExit(exit);
  const kind = errorKind(normalizedExit);
  return error?.event.type === "error"
    ? Object.freeze({
        error_kind: kind,
        code: safeCode(error.event.payload.code, conversationJsonErrorCode(normalizedExit)),
        message: errorMessage(kind),
      })
    : null;
};
const hasDecisionData = (records: readonly PublicStoredTraceEvent[]): boolean =>
  records.some(({ event }) =>
    ["precommit", "agent_response_delta", "evaluator_assessment", "consensus_update"].includes(
      event.type,
    ),
  );

const errorOutput = (exit: number) =>
  Object.freeze({
    status: "error" as const,
    error: Object.freeze({
      error_kind: errorKind(exit),
      code: conversationJsonErrorCode(exit),
      message: errorMessage(errorKind(exit)),
    }),
  });
const writeError = (exit: number): number => {
  jsonWrite(errorOutput(exit));
  return exit;
};
const denseCopy = <T, U>(
  items: readonly (T | null | undefined)[] | null | undefined,
  project: (item: T) => U,
): U[] => {
  const out: U[] = [];
  for (const item of items ?? []) if (item != null) out.push(project(item));
  return out;
};

const copyStrings = (items: readonly (string | null | undefined)[] | null | undefined): string[] =>
  denseCopy(items, (item) => item);

const projectDryRunParticipant = (participant: {
  participant_id: string;
  role_ref: string;
  engine: string;
  model: string | null;
  engine_available: boolean;
  model_valid: boolean;
}) => ({
  participant_id: participant.participant_id,
  role_ref: participant.role_ref,
  engine: participant.engine,
  model: participant.model,
  engine_available: participant.engine_available,
  model_valid: participant.model_valid,
});

const projectGate = (gate: { value: boolean | "not_applicable"; evidence: string }) => ({
  value: gate.value,
  evidence: gate.evidence,
});

const projectAssessment = (assessment: {
  agreement: { value: boolean; evidence: string };
  conflict_resolution: { value: boolean; evidence: string };
  evidence_quality: { value: boolean; evidence: string };
  convergence: { value: boolean | "not_applicable"; evidence: string };
}) => ({
  agreement: projectGate(assessment.agreement),
  conflict_resolution: projectGate(assessment.conflict_resolution),
  evidence_quality: projectGate(assessment.evidence_quality),
  convergence: projectGate(assessment.convergence),
});

const projectRoundResponse = (response: {
  participant_id: string;
  content: string;
  claim: string | null;
  evidence: readonly (string | null | undefined)[];
}) => ({
  participant_id: response.participant_id,
  content: response.content,
  claim: response.claim,
  evidence: copyStrings(response.evidence),
});

const projectRoundAssessment = (item: {
  stage: "blind" | "full";
  assessment: Parameters<typeof projectAssessment>[0];
}) => ({
  stage: item.stage,
  assessment: projectAssessment(item.assessment),
});

const projectRoundDecision = (
  decision:
    | { outcome: "abort"; score: null; reason?: string | null }
    | {
        outcome: "consensus" | "continue" | "exhausted";
        score: number;
        reason?: string | null;
      },
) =>
  decision.outcome === "abort"
    ? { outcome: "abort" as const, score: null, reason: decision.reason ?? null }
    : { outcome: decision.outcome, score: decision.score };

const projectRound = (round: {
  round_id: string;
  participant_responses: readonly (Parameters<typeof projectRoundResponse>[0] | null | undefined)[];
  evaluator_assessments: readonly (
    | Parameters<typeof projectRoundAssessment>[0]
    | null
    | undefined
  )[];
  decision: Parameters<typeof projectRoundDecision>[0] | null;
}) => ({
  round_id: round.round_id,
  participant_responses: denseCopy(round.participant_responses, projectRoundResponse),
  evaluator_assessments: denseCopy(round.evaluator_assessments, projectRoundAssessment),
  decision: round.decision ? projectRoundDecision(round.decision) : null,
});

async function brainstormExecutionJson(
  service: ReturnType<typeof conversationService>,
  execution:
    | Awaited<ReturnType<typeof executeConversationCreate>>
    | Awaited<ReturnType<typeof executeConversationMessage>>,
  baselineEnabled: boolean,
  participants: readonly { role_ref: string; engine_available?: boolean }[],
) {
  const snapshot = await service.snapshot(execution.conversationId);
  const records = [
    ...(((await service.events(execution.conversationId, 0)) ??
      execution.events) as PublicStoredTraceEvent[]),
  ].sort((left, right) => left.seq - right.seq);
  const rounds = snapshot?.rounds ?? [];
  const exit = classifyConversationResult(execution.status, records);
  const status = terminalStatus(execution.status);
  const decisionMatrix = hasDecisionData(records) ? projectDecisionMatrix(records as never) : null;
  const baselineComparison = projectBaselineComparison({
    enabled: baselineEnabled,
    nonEvaluatorParticipantCount:
      snapshot?.participants.filter(
        (participant) => participant.role_ref !== "brainstorm-evaluator",
      ).length ??
      participants.filter((participant) => participant.role_ref !== "brainstorm-evaluator").length,
    selectedEngineAvailable:
      participants.find((participant) => participant.role_ref !== "brainstorm-evaluator")
        ?.engine_available ?? true,
    decisionMatrix: decisionMatrix as never,
    records: records as never,
  });
  return Object.freeze({
    version: "1.0" as const,
    conversation_id: execution.conversationId,
    status,
    dry_run: false,
    rounds: denseCopy(rounds, projectRound),
    consensus_score: snapshot?.consensus_score ?? null,
    consensus_average: averageConsensusScore(rounds),
    decision_matrix: decisionMatrix,
    baseline_comparison: baselineComparison,
    transcript_path: transcriptPath(execution.conversationId, transcriptArtifactRef(records)),
    error: status === "failed" ? terminalError(records, exit) : null,
  });
}

export async function brainstorm(
  argv: string[],
  deps: ConversationCommandDeps = {},
): Promise<number> {
  const parsed = parseConversationArgv(argv, [
    "json",
    "yes",
    "resume",
    "max-rounds",
    "no-baseline",
  ]);
  const json = parsed.flags.json === true;
  const options = parsed.flags["no-baseline"] === true ? { baselineEnabled: false } : undefined;
  if (parsed.unknownFlags.length) {
    if (json) return writeError(CONVERSATION_EXIT.validation);
    out("vf", c.red(`brainstorm: unknown flag(s): ${parsed.unknownFlags.join(", ")}`), {
      level: "error",
    });
    return CONVERSATION_EXIT.validation;
  }
  const topic = parsed.positionals.join(" ").trim();
  try {
    const resumeId = parseOptionalResumeId(parsed);
    if (!topic && !resumeId) {
      if (json) return writeError(CONVERSATION_EXIT.validation);
      out("vf", c.red('brainstorm: missing topic — e.g. `vf brainstorm "Compare options"`'), {
        level: "error",
      });
      return CONVERSATION_EXIT.validation;
    }
    if (resumeId) assertNoResumeCreateFlags(parsed, ["participant", "max-rounds", "no-baseline"]);
    const explicit = parsed.participants.map(parseParticipantSpec);
    const maxRounds = parseMaxRounds(parsed.flags["max-rounds"]);
    const service = conversationService(deps);
    const request: ConversationCreateRequest = {
      topic,
      policy: "debate",
      ...(explicit.length ? { participants: explicit } : {}),
      ...(maxRounds ? { max_rounds: maxRounds } : {}),
    };
    if (resumeId) {
      const resumed = await executeConversationMessage(
        service,
        resumeId,
        topic,
        json ? undefined : (chunk) => process.stdout.write(chunk),
      );
      const exit = classifyConversationResult(resumed.status, resumed.events);
      if (json) {
        jsonWrite(
          await brainstormExecutionJson(service, resumed, options?.baselineEnabled ?? true, []),
        );
      }
      return exit;
    }
    const preview = await service.dryRun(request, options);
    const nonEvaluators = preview.participants.filter(
      (participant) => participant.role_ref !== "brainstorm-evaluator",
    );
    const evaluators = preview.participants.filter(
      (participant) => participant.role_ref === "brainstorm-evaluator",
    );
    if (nonEvaluators.length < 2) {
      throw new Error("brainstorm requires at least two non-evaluator participants");
    }
    if (
      evaluators.length !== 1 ||
      (explicit.length > 0 && !hasEvaluator(explicit) && !preview.evaluator_auto_added)
    ) {
      throw new Error("brainstorm requires exactly one evaluator");
    }
    if (parsed.flags.yes !== true) {
      if (json) {
        return jsonWrite(
          Object.freeze({
            status: "dry_run" as const,
            dry_run: true,
            participants: denseCopy(preview.participants, projectDryRunParticipant),
            evaluator_auto_added: preview.evaluator_auto_added,
            engines_available: preview.engines_available,
            models_valid: preview.models_valid,
          }),
        );
      }
      out(
        "vf",
        c.dim(
          `brainstorm: dry run with ${preview.participants.length} participants (${preview.engines_available.join(", ") || "no ready engines"})`,
        ),
      );
      return CONVERSATION_EXIT.ok;
    }
    const execution = await executeConversationCreate(
      service,
      request,
      json ? undefined : (chunk) => process.stdout.write(chunk),
      options,
    );
    const exit = classifyConversationResult(execution.status, execution.events);
    if (json) {
      jsonWrite(
        await brainstormExecutionJson(
          service,
          execution,
          options?.baselineEnabled ?? true,
          preview.participants,
        ),
      );
    }
    return exit;
  } catch (error) {
    const exit = normalizedErrorExit(classifyConversationError(error));
    const message = publicResumeValidationMessage(error) ?? errorMessage(errorKind(exit));
    if (json) return writeError(exit);
    out("vf", c.red(`brainstorm: ${message}`), {
      level: "error",
    });
    return exit;
  }
}
