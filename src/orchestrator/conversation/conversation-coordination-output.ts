import {
  CONVERSATION_COORDINATION_DIAGNOSTIC,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_LIMIT,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCES,
  CONVERSATION_COORDINATION_SCHEMA_VERSION,
  type ConversationCoordinationDirectiveKindV1,
  type ConversationCoordinationLaneV1,
} from "./conversation-coordination-contract.js";
import type { ConversationCoordinationDirectiveV1 } from "./conversation-coordination-records.js";
import { parseConversationCoordinationDirective } from "./conversation-coordination-validation.js";
import { CONVERSATION_DELEGATION_VERIFY_ORACLES } from "./conversation-delegation-workspace-contract.js";

export const CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC = Object.freeze({
  EMPTY: "coordination_output_empty",
  TOO_LARGE: "coordination_output_too_large",
  NOT_JSON_OBJECT: "coordination_output_not_json_object",
  INVALID_DIRECTIVE: "coordination_output_invalid_directive",
  UNEXPECTED_DIRECTIVE: "coordination_output_unexpected_directive",
} as const);
export type ConversationCoordinationOutputDiagnosticV1 =
  (typeof CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC)[keyof typeof CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC];

export type ConversationCoordinationOutputParseResultV1 =
  | { ok: true; directive: ConversationCoordinationDirectiveV1 }
  | { ok: false; diagnostic_code: ConversationCoordinationOutputDiagnosticV1 };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseConversationCoordinationOutput(
  output: string,
  lane: Exclude<ConversationCoordinationLaneV1, typeof CONVERSATION_COORDINATION_LANE.HOST>,
  allowedKinds: readonly ConversationCoordinationDirectiveKindV1[],
): ConversationCoordinationOutputParseResultV1 {
  const source = output.trim();
  if (!source)
    return { ok: false, diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.EMPTY };
  if (Buffer.byteLength(source, "utf8") > CONVERSATION_COORDINATION_LIMIT.MAX_OUTPUT_BYTES)
    return { ok: false, diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.TOO_LARGE };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      ok: false,
      diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.NOT_JSON_OBJECT,
    };
  }
  if (!object(value))
    return {
      ok: false,
      diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.NOT_JSON_OBJECT,
    };
  const directive = parseConversationCoordinationDirective(value, lane);
  if (!directive)
    return {
      ok: false,
      diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.INVALID_DIRECTIVE,
    };
  if (!allowedKinds.some((kind) => kind === directive.kind))
    return {
      ok: false,
      diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.UNEXPECTED_DIRECTIVE,
    };
  return { ok: true, directive };
}

const VERIFY_ORACLE_VOCABULARY = CONVERSATION_DELEGATION_VERIFY_ORACLES.map((oracle) =>
  JSON.stringify(oracle),
).join("|");
const DIRECTIVE_SCHEMA: Readonly<Record<ConversationCoordinationDirectiveKindV1, string>> =
  Object.freeze({
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK]: `task:{task_id,executor_participant_id,goal,scope[],forbidden[],must_haves[],verify_oracles:[${VERIFY_ORACLE_VOCABULARY}],source_message_refs[]}`,
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION]:
      'resolution:{task_id,question_id,answer,source:"task-spec|conversation-context|repo-evidence|safe-default",source_refs[],assumptions[]}',
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE]:
      "finalization:{completed_task_ids[],reviewed_head,summary,evidence_refs[]}",
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT]: `escalation:{task_id,question_id,question,reason_code,resolution_attempts:[${CONVERSATION_COORDINATION_RESOLUTION_SOURCES.map((source) => `{source:"${source}",outcome,source_refs[]}`).join(",")}],impact,options[2..5]}`,
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION]:
      "clarification:{task_id,question_id,question,blocking_reason,attempted_interpretations[],required_decision}",
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK]:
      "completion:{task_id,summary,changed_paths[],evidence_refs[],verification:{commands[],passed:true}}",
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED]:
      "blocked:{task_id,reason,evidence_refs[],recoverable:boolean}",
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT]: "host-only",
    [CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH]: "host-only",
  });

export function renderConversationCoordinationOutputContract(
  lane: Exclude<ConversationCoordinationLaneV1, typeof CONVERSATION_COORDINATION_LANE.HOST>,
  allowedKinds: readonly ConversationCoordinationDirectiveKindV1[],
  diagnosticCode?: string,
): string {
  const alternatives = allowedKinds
    .map((kind) => `kind:"${kind}",${DIRECTIVE_SCHEMA[kind]}`)
    .join(" OR ");
  const routing =
    lane === CONVERSATION_COORDINATION_LANE.EXECUTOR
      ? "Clarifications go only to the coordinator through request_coordinator_clarification; never address the user or another executor. Before complete_delegated_task, commit every scoped change in the assigned worktree, leave it clean, run every assigned task.verify_oracles entry successfully, and copy that exact ordered array into completion.verification.commands."
      : `For delegation, scope and forbidden contain only canonical repo-relative path selectors; use a trailing slash for a directory tree. copy source_message_refs only from delivered message IDs or topic_message_ref. verify_oracles is an ordered non-empty array drawn only from this exact closed vocabulary: ${VERIFY_ORACLE_VOCABULARY}. Resolve from the delivered task/spec, conversation context, repo evidence, or a safe reversible default before request_user_input.`;
  const correction = (() => {
    if (diagnosticCode === CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_REQUIRES_CLEAN_COMMIT)
      return "Correction required: the workspace was dirty, uncommitted, ambiguous, or still active. Commit all scoped changes, confirm the worktree is clean, rerun verification, then return complete_delegated_task with real evidence.";
    if (diagnosticCode === CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_VERIFICATION_FAILED)
      return "Correction required: host verification did not validate the current clean commit. Inspect the verification failure, fix the scoped work, commit it, rerun every required check, and return complete_delegated_task only when the host can verify that exact commit.";
    return null;
  })();
  return [
    `Coordination control output is mandatory. Return exactly one JSON object, with no markdown or surrounding prose: {"schema_version":"${CONVERSATION_COORDINATION_SCHEMA_VERSION}",<one of: ${alternatives}>}.`,
    "Use every named field exactly; omit no field and add no field. Arrays contain unique non-empty strings.",
    routing,
    ...(correction ? [correction] : []),
  ].join(" ");
}
