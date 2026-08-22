import { TRACE_LIMITS, utf8Bytes } from "./limits.js";
import type {
  InternalTraceStoreRecord,
  StoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
  TraceEvent,
} from "./types.js";

type Rule = (value: unknown) => boolean;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const fail = (message: string): never => {
  throw new Error(`trace journal: ${message}`);
};
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const text: Rule = (value) =>
  typeof value === "string" && utf8Bytes(value) <= TRACE_LIMITS.maxTextBytes;
const reference: Rule = (value) =>
  typeof value === "string" && utf8Bytes(value) <= TRACE_LIMITS.maxReferenceBytes;
const number: Rule = (value) => typeof value === "number" && Number.isFinite(value);
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
  (rule: Rule): Rule =>
  (value) =>
    Array.isArray(value) && value.length <= TRACE_LIMITS.maxArrayItems && value.every(rule);
const nullableText = union(nil, text);
const nullableReference = union(nil, reference);
const textArray = array(text);
const referenceArray = array(reference);
const engine = literal("claude", "codex", "copilot", "opencode", "antigravity");
const modelCredential =
  /(?:^|[._/@:+-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|A[KS]IA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{20,})(?=$|[._/@:+-])|(?:^|[._/@:+-])(?:token|secret|password|credential|api[_-]?key|access[_-]?key)(?:$|[._/@:+-])/i;
const localModelPath =
  /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|(?:src|test|tests|docs|lib|dist|build|private|artifacts?|evidence|coverage|scripts?|config)[\\/])/i;
export const isValidParticipantModel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  utf8Bytes(value) <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value) &&
  !value.includes("..") &&
  !value.includes("//") &&
  !localModelPath.test(value) &&
  !modelCredential.test(value);
const model = union(nil, isValidParticipantModel);
const tools = array(literal("read", "write", "edit", "bash", "grep", "glob", "web"));
const lifecycle = literal("INIT", "ACTIVE", "PAUSED", "COMPLETED", "STOPPED", "FAILED", "ABORTED");

function compileShape(spec: string, rules: Readonly<Record<string, Rule>>): Rule {
  const fields = new Map<string, { optional: boolean; rule: Rule }>();
  for (const token of spec.trim().split(/\s+/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?:([A-Za-z_][A-Za-z0-9_]*)$/.exec(token);
    if (!match) throw new Error("trace journal: malformed schema");
    const name = match[1] as string;
    const rule = rules[match[3] as string];
    if (fields.has(name)) fail("duplicate schema field");
    if (!rule) fail("missing schema rule");
    fields.set(name, { optional: !!match[2], rule: rule as Rule });
  }
  return (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return (
      Object.keys(object).every((key) => fields.has(key)) &&
      [...fields].every(([key, field]) =>
        own(object, key) ? field.rule(object[key]) : field.optional,
      )
    );
  };
}
const rules: Record<string, Rule> = {
  text,
  number,
  boolean,
  null: nil,
  nullableText,
  reference,
  nullableReference,
  textArray,
  referenceArray,
  engine,
  model,
  tools,
  lifecycle,
  terminalLifecycle: literal("COMPLETED", "STOPPED", "FAILED", "ABORTED"),
  operationState: literal("requested", "dispatched", "acknowledged", "completed", "ambiguous"),
  artifactType: literal("decision_matrix", "plan", "diff", "tests", "synthesis", "transcript"),
  true: literal(true),
  sandbox: literal("read-only", "workspace-write", "danger-full-access"),
  skillSource: literal("repo", "shared", "builtin"),
  toolStatus: literal("started", "completed", "failed"),
  assessmentStage: literal("blind", "full"),
  targetParticipants: union(literal("all"), referenceArray),
  roundPhase: literal("start", "end"),
  health: literal("healthy", "degraded"),
  baselineStatus: literal("success", "failed", "skipped"),
  nullableNumber: union(nil, number),
  engineArray: array(engine),
  approvalOutcome: literal("approve", "reject"),
  reconciliationStatus: literal("reconciled", "partial", "unavailable"),
};
rules.participant = compileShape(
  "participant_id:reference role_ref:reference engine:engine model:model",
  rules,
);
rules.dryRunParticipant = compileShape(
  "participant_id:reference role_ref:reference engine:engine model:model engine_available:boolean model_valid:boolean",
  rules,
);
rules.gate = compileShape("value:boolean evidence:text", rules);
rules.convergenceGate = compileShape("value:convergenceValue evidence:text", {
  ...rules,
  convergenceValue: union(boolean, literal("not_applicable")),
});
rules.assessment = compileShape(
  "agreement:gate conflict_resolution:gate evidence_quality:gate convergence:convergenceGate",
  rules,
);
rules.decision = union(
  compileShape("outcome:abort score:null reason:invalidAssessment", {
    ...rules,
    abort: literal("abort"),
    invalidAssessment: literal("invalid_assessment"),
  }),
  compileShape("outcome:continuingOutcome score:number", {
    ...rules,
    continuingOutcome: literal("consensus", "continue", "exhausted"),
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
const eventSchemas = {
  conversation_configured: "topic:text participants:participantArray policy:text max_rounds:number",
  coordinator_decision: "selected_policy:text reason:text",
  participant_bound:
    "participant_id:reference engine:engine model:model prompt_hash:reference tools:tools sandbox:sandbox",
  skill_injected: "skill_refs:referenceArray resolved_hashes:referenceArray source:skillSource",
  precommit: "round_id:reference participant_id:reference answer:text evidence:textArray",
  agent_response_delta:
    "round_id:reference participant_id:reference content_delta:text final_claim:nullableText final_evidence:textArray completes_response:boolean",
  tool_action:
    "tool:reference action:text status:toolStatus input_ref:nullableReference output_ref:nullableReference",
  evaluator_assessment: "round_id:reference stage:assessmentStage assessment:assessment",
  user_message: "content:text target_participants:targetParticipants",
  consensus_update: "round_id:reference decision:decision",
  round_boundary: "round_id:reference phase:roundPhase",
  state_change: "lifecycle:lifecycle health:health terminal:boolean reason:nullableText",
  baseline_result:
    "status:baselineStatus answer:nullableText confidence:nullableNumber skip_reason:nullableText",
  synthesis_completed: "decision_matrix_ref:reference baseline_comparison_ref:reference",
  conversation_terminal: "lifecycle:terminalLifecycle terminal:true final_score:nullableNumber",
  dry_run_result:
    "participants:dryRunParticipantArray evaluator_auto_added:boolean engines_available:engineArray models_valid:boolean",
  error: "agent_id:nullableReference code:reference message:text",
  operation_lifecycle: "operation_id:reference attempt_id:reference state:operationState",
  approval_requested: "token:approvalToken description:text",
  approval_resolved: "decision:approvalDecision",
  caller_cancelled: "operation_id:reference actor:reference reason:nullableText",
  artifact_created: "artifact_id:reference artifact_type:artifactType ref:reference",
  artifact_updated:
    "artifact_id:reference artifact_type:reference ref:reference previous_ref:reference",
  native_history_reconciled:
    "public_session_ref:reference status:reconciliationStatus imported_turn_count:number imported_tool_count:number provenance_refs:referenceArray evidence_refs:referenceArray completeness_reason:text",
} satisfies Record<TraceEvent["type"], string>;
rules.participantArray = array(rules.participant);
rules.dryRunParticipantArray = array(rules.dryRunParticipant);
const eventRules = new Map(
  Object.entries(eventSchemas).map(([type, spec]) => [type, compileShape(spec, rules)]),
);
const correlationSchema =
  "workflow_id:reference conversation_id:reference revision_id:reference run_id:reference turn_id:reference operation_id:reference attempt_id:reference unit_id?:reference participant_id?:reference role_ref?:reference role_resolved_hash?:reference parent_attempt_id?:reference skill_refs?:referenceArray skill_resolved_hashes?:referenceArray evidence_refs?:referenceArray engine?:engine";
const correlationRule = compileShape(correlationSchema, rules);
const eventRule = compileShape("type:text payload:any", { ...rules, any: () => true });
rules.event = (value) => {
  if (!eventRule(value)) return false;
  const event = value as { type: string; payload: unknown };
  return eventRules.get(event.type)?.(event.payload) === true;
};
const appendRule = compileShape("idempotency_key:reference event:event", rules);
const storedRule = compileShape(
  `${correlationSchema} event_id:reference seq:number ts:reference idempotency_key:reference event:event`,
  rules,
);
const journalRule = compileShape(
  "stored_event:stored native_session_id:nullableReference batch_id?:reference batch_index?:number batch_size?:number",
  { ...rules, stored: storedRule },
);

const json = (value: unknown, seen = new Set<object>(), depth = 0): boolean => {
  if (depth > TRACE_LIMITS.maxDepth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return utf8Bytes(value) <= TRACE_LIMITS.maxTextBytes;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || seen.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (
    (Array.isArray(value)
      ? proto !== Array.prototype
      : proto !== Object.prototype && proto !== null) ||
    Object.getOwnPropertySymbols(value).length ||
    own(value, "toJSON")
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.entries(descriptors).some(
      ([key, descriptor]) =>
        !("value" in descriptor) ||
        (!descriptor.enumerable && !(Array.isArray(value) && key === "length")),
    )
  )
    return false;
  if (
    Array.isArray(value) &&
    (value.length > TRACE_LIMITS.maxArrayItems ||
      Object.keys(value).length !== value.length ||
      Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key)))
  )
    return false;
  seen.add(value);
  const valid = Object.entries(value).every(
    ([key, item]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && json(item, seen, depth + 1),
  );
  seen.delete(value);
  return valid;
};
const iso = (value: string) =>
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
export const decodeRecord = (line: string): InternalTraceStoreRecord => {
  if (!line) fail("blank record");
  if (utf8Bytes(line) > TRACE_LIMITS.maxRecordBytes) fail("record too large");
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return fail("malformed record");
  }
  if (!json(record) || !journalRule(record)) fail("invalid record");
  const value = record as InternalTraceStoreRecord;
  const batch = [value.batch_id, value.batch_index, value.batch_size];
  const present = batch.filter((item) => item !== undefined).length;
  if (
    (present !== 0 && present !== batch.length) ||
    (present === batch.length &&
      (typeof value.batch_id !== "string" ||
        !Number.isSafeInteger(value.batch_index) ||
        !Number.isSafeInteger(value.batch_size) ||
        (value.batch_index as number) < 0 ||
        (value.batch_size as number) < 2 ||
        (value.batch_size as number) > 64 ||
        (value.batch_index as number) >= (value.batch_size as number)))
  )
    fail("invalid batch frame");
  return value;
};
export const validInput = (
  correlation: TraceCorrelation,
  input: TraceAppendInput,
  native: unknown,
) =>
  json(correlation) &&
  correlationRule(correlation) &&
  json(input) &&
  appendRule(input) &&
  !!input.idempotency_key &&
  nullableReference(native);
export const validGenerated = (eventId: unknown, ts: unknown) =>
  typeof eventId === "string" && typeof ts === "string" && uuid.test(eventId) && iso(ts);
export const validReplayEvent = (event: StoredTraceEvent, conversationId: string, seq: number) =>
  event.conversation_id === conversationId &&
  uuid.test(event.event_id) &&
  Number.isSafeInteger(event.seq) &&
  event.seq === seq &&
  !!event.idempotency_key &&
  iso(event.ts);
