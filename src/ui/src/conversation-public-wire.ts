import { isAgentEngine } from "../../core/agent-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  isConversationMessageQueueQuoteTargetKind,
  isConversationMessageQueueTargetParticipantMode,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import * as ConversationWire from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import type { ConversationSnapshot, ConversationTraceRecord } from "./conversation-types.js";

/** Browser-safe public DTO emitted by conversation snapshot and SSE routes. */
export type ConversationPublicTraceRecordWireV1 = ConversationTraceRecord;

export const CONVERSATION_PUBLIC_WIRE_LIMITS = Object.freeze({
  maxTextBytes: 64 * 1024,
  maxReferenceBytes: 4 * 1024,
  maxArrayItems: 512,
} as const);

type Rule = (value: unknown) => boolean;
const encoder = new TextEncoder();
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const memberOf = <Value>(values: readonly Value[], value: unknown): value is Value =>
  values.some((candidate) => candidate === value);
const utf8Bytes = (value: string) => encoder.encode(value).byteLength;
const safePublicText = (value: string) => {
  for (const character of value) {
    if (character !== "\n" && character !== "\t" && /[\p{Cc}\p{Cf}]/u.test(character)) return false;
  }
  return true;
};
const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && descriptor.enumerable,
  );
};
const text: Rule = (value) =>
  typeof value === "string" &&
  utf8Bytes(value) <= CONVERSATION_PUBLIC_WIRE_LIMITS.maxTextBytes &&
  safePublicText(value);
const reference: Rule = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  utf8Bytes(value) <= CONVERSATION_PUBLIC_WIRE_LIMITS.maxReferenceBytes &&
  safePublicText(value) &&
  !value.includes("\n") &&
  !value.includes("\t");
const boolean: Rule = (value) => typeof value === "boolean";
const nil: Rule = (value) => value === null;
const literal =
  (...values: readonly unknown[]): Rule =>
  (value) =>
    values.includes(value);
const union =
  (...rules: readonly Rule[]): Rule =>
  (value) =>
    rules.some((rule) => rule(value));
const array =
  (rule: Rule, maximum: number = CONVERSATION_PUBLIC_WIRE_LIMITS.maxArrayItems): Rule =>
  (value) =>
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length <= maximum &&
    Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index)) &&
    value.every(rule);
const nullableText = union(nil, text);
const nullableReference = union(nil, reference);
const textArray = array(text);
const referenceArray = array(reference);
const timestamp: Rule = (value) =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function compileShape(spec: string, rules: Readonly<Record<string, Rule>>): Rule {
  const fields = new Map<string, { optional: boolean; rule: Rule }>();
  for (const token of spec.trim().split(/\s+/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?:([A-Za-z_][A-Za-z0-9_]*)$/.exec(token);
    if (!match) throw new Error("conversation public wire schema is malformed");
    const name = match[1] as string;
    const rule = rules[match[3] as string];
    if (fields.has(name) || !rule)
      throw new Error("conversation public wire schema authority is invalid");
    fields.set(name, { optional: match[2] !== undefined, rule });
  }
  return (value) => {
    if (!plainRecord(value) || !Object.keys(value).every((key) => fields.has(key))) return false;
    return [...fields].every(([key, field]) =>
      own(value, key) ? field.rule(value[key]) : field.optional,
    );
  };
}

const rules: Record<string, Rule> = {
  text,
  reference,
  nonnegativeInteger: ConversationWire.isConversationNonnegativeSafeInteger,
  positiveInteger: ConversationWire.isConversationPositiveSafeInteger,
  score: ConversationWire.isConversationScore,
  boolean,
  nullableText,
  nullableReference,
  nullableScore: ConversationWire.isConversationNullableScore,
  textArray,
  referenceArray,
  timestamp,
  engine: isAgentEngine,
  model: nullableReference,
  tools: array((value) => memberOf(ConversationWire.CONVERSATION_TOOL_INTENTS, value)),
  lifecycle: (value) => memberOf(ConversationWire.CONVERSATION_LIFECYCLES, value),
  terminalLifecycle: (value) => memberOf(ConversationWire.CONVERSATION_TERMINAL_LIFECYCLES, value),
  health: (value) => memberOf(ConversationWire.CONVERSATION_HEALTH_VALUES, value),
  operationState: (value) => memberOf(ConversationWire.CONVERSATION_OPERATION_STATES, value),
  artifactType: (value) => memberOf(ConversationWire.CONVERSATION_ARTIFACT_TYPES, value),
  sandbox: (value) => memberOf(ConversationWire.CONVERSATION_SANDBOXES, value),
  skillSource: (value) => memberOf(ConversationWire.CONVERSATION_SKILL_SOURCES, value),
  toolStatus: (value) => memberOf(ConversationWire.CONVERSATION_TOOL_ACTION_STATUSES, value),
  assessmentStage: (value) => memberOf(ConversationWire.CONVERSATION_ASSESSMENT_STAGES, value),
  roundPhase: (value) => memberOf(ConversationWire.CONVERSATION_ROUND_PHASES, value),
  baselineStatus: (value) => memberOf(ConversationWire.CONVERSATION_BASELINE_STATUSES, value),
  nullableBaselineReason: union(nil, (value) =>
    memberOf(ConversationWire.CONVERSATION_BASELINE_REASONS, value),
  ),
  approvalOutcome: (value) => memberOf(ConversationWire.CONVERSATION_APPROVAL_OUTCOMES, value),
  reconciliationStatus: (value) =>
    memberOf(ConversationWire.CONVERSATION_RECONCILIATION_STATUSES, value),
  targetParticipants: union(isConversationMessageQueueTargetParticipantMode, referenceArray),
};
rules.participant = compileShape(
  "participant_id:reference role_ref:reference engine:engine model:model",
  rules,
);
rules.snapshotParticipant = compileShape(
  "participant_id:reference role_ref:reference engine:engine model:model public_session_ref:nullableReference",
  rules,
);
rules.dryRunParticipant = compileShape(
  "participant_id:reference role_ref:reference engine:engine model:model engine_available:boolean model_valid:boolean",
  rules,
);
rules.gate = compileShape("value:boolean evidence:text", rules);
rules.convergenceGate = compileShape("value:convergenceValue evidence:text", {
  ...rules,
  convergenceValue: union(
    boolean,
    literal(ConversationWire.CONVERSATION_CONVERGENCE_NOT_APPLICABLE),
  ),
});
rules.assessment = compileShape(
  "agreement:gate conflict_resolution:gate evidence_quality:gate convergence:convergenceGate",
  rules,
);
rules.decision = union(
  compileShape("outcome:abort score:nil reason:invalidAssessment", {
    ...rules,
    abort: literal(ConversationWire.CONVERSATION_DECISION_OUTCOME.ABORT),
    nil,
    invalidAssessment: literal(ConversationWire.CONVERSATION_INVALID_ASSESSMENT_REASON),
  }),
  compileShape("outcome:continuingOutcome score:score", {
    ...rules,
    continuingOutcome: (value) =>
      memberOf(ConversationWire.CONVERSATION_CONTINUING_DECISION_OUTCOMES, value),
  }),
);
rules.approvalToken = compileShape(
  "approval_id:reference operation_id:reference actor:reference",
  rules,
);
rules.approvalDecision = compileShape(
  "approval_id:reference operation_id:reference actor:reference outcome:approvalOutcome reason:nullableText",
  rules,
);
rules.publicMessageLocator = compileShape(
  "root_session_id:reference conversation_id:reference revision_id:reference target_event_id:reference target_kind:messageTargetKind content_digest:digest author_public_id:reference",
  {
    ...rules,
    messageTargetKind: isConversationMessageQueueQuoteTargetKind,
    digest: (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
  },
);
const quoteReferenceList = array(
  rules.publicMessageLocator as Rule,
  CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes,
);
rules.quoteReferenceArray = (value) =>
  quoteReferenceList(value) && (value as unknown[]).length >= 1;
rules.participantArray = array(rules.participant);
rules.snapshotParticipantArray = array(rules.snapshotParticipant);
rules.dryRunParticipantArray = array(rules.dryRunParticipant);

export const CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS =
  ConversationWire.CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS;

rules.terminalTrue = literal(true);
rules.engineArray = array(isAgentEngine);
const eventRules = new Map(
  Object.entries(CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS).map(([type, spec]) => [
    type,
    compileShape(spec, rules),
  ]),
);
const eventShell = compileShape("type:reference payload:any", { ...rules, any: () => true });
rules.event = (value) => {
  if (!eventShell(value)) return false;
  const event = value as { type: string; payload: unknown };
  return eventRules.get(event.type)?.(event.payload) === true;
};
const traceRecordRule = compileShape(
  "workflow_id:reference conversation_id:reference revision_id:reference run_id:reference turn_id:reference operation_id:reference attempt_id:reference unit_id?:reference participant_id?:reference role_ref?:reference role_resolved_hash?:reference skill_refs?:referenceArray skill_resolved_hashes?:referenceArray engine?:engine evidence_refs?:referenceArray parent_attempt_id?:reference event_id:reference seq:positiveInteger ts:timestamp public_session_ref:nullableReference event:event",
  rules,
);

rules.roundResponse = compileShape(
  "participant_id:reference content:text claim:nullableText evidence:textArray complete:boolean",
  rules,
);
rules.roundAssessment = compileShape("stage:assessmentStage assessment:assessment", rules);
rules.round = compileShape(
  "round_id:reference participant_responses:roundResponseArray evaluator_assessments:roundAssessmentArray decision:nullableDecision complete:boolean",
  {
    ...rules,
    roundResponseArray: array(rules.roundResponse),
    roundAssessmentArray: array(rules.roundAssessment),
    nullableDecision: union(nil, rules.decision),
  },
);
const snapshotRule = compileShape(
  "conversation_id:reference lifecycle:lifecycle health:health policy:text topic:text participants:snapshotParticipantArray rounds:roundArray consensus_score:nullableScore last_seq:nonnegativeInteger",
  { ...rules, roundArray: array(rules.round) },
);

export const CONVERSATION_TRACE_EVENT_TYPES = ConversationWire.CONVERSATION_TRACE_EVENT_KINDS;

export const isConversationPublicTraceRecordWireV1 = (
  value: unknown,
): value is ConversationPublicTraceRecordWireV1 => traceRecordRule(value);

export const isConversationSnapshotWireV1 = (value: unknown): value is ConversationSnapshot =>
  snapshotRule(value);
