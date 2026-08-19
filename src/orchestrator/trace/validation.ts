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
const text: Rule = (value) => typeof value === "string";
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
    Array.isArray(value) && value.every(rule);
const nullableText = union(nil, text);
const textArray = array(text);
const engine = literal("claude", "codex", "copilot", "opencode", "antigravity");
const model = union(
  nil,
  literal(
    "haiku",
    "sonnet",
    "opus",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
    "gpt-5.4-codex",
  ),
);
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
  textArray,
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
  targetParticipants: union(literal("all"), textArray),
  roundPhase: literal("start", "end"),
  health: literal("healthy", "degraded"),
  baselineStatus: literal("success", "failed", "skipped"),
  nullableNumber: union(nil, number),
  engineArray: array(engine),
  approvalOutcome: literal("approve", "reject"),
  reconciliationStatus: literal("reconciled", "partial", "unavailable"),
};
rules.participant = compileShape(
  "participant_id:text role_ref:text engine:engine model:model",
  rules,
);
rules.dryRunParticipant = compileShape(
  "participant_id:text role_ref:text engine:engine model:model engine_available:boolean model_valid:boolean",
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
rules.approvalToken = compileShape("approval_id:text operation_id:text actor:text", rules);
rules.approvalDecision = compileShape(
  "approval_id:text operation_id:text actor:text outcome:approvalOutcome reason:nullableText",
  rules,
);
const eventSchemas = {
  conversation_configured: "topic:text participants:participantArray policy:text max_rounds:number",
  coordinator_decision: "selected_policy:text reason:text",
  participant_bound:
    "participant_id:text engine:engine model:model prompt_hash:text tools:tools sandbox:sandbox",
  skill_injected: "skill_refs:textArray resolved_hashes:textArray source:skillSource",
  precommit: "round_id:text participant_id:text answer:text evidence:textArray",
  agent_response_delta:
    "round_id:text participant_id:text content_delta:text final_claim:nullableText final_evidence:textArray completes_response:boolean",
  tool_action:
    "tool:text action:text status:toolStatus input_ref:nullableText output_ref:nullableText",
  evaluator_assessment: "round_id:text stage:assessmentStage assessment:assessment",
  user_message: "content:text target_participants:targetParticipants",
  consensus_update: "round_id:text decision:decision",
  round_boundary: "round_id:text phase:roundPhase",
  state_change: "lifecycle:lifecycle health:health terminal:boolean reason:nullableText",
  baseline_result:
    "status:baselineStatus answer:nullableText confidence:nullableNumber skip_reason:nullableText",
  synthesis_completed: "decision_matrix_ref:text baseline_comparison_ref:text",
  conversation_terminal: "lifecycle:terminalLifecycle terminal:true final_score:nullableNumber",
  dry_run_result:
    "participants:dryRunParticipantArray evaluator_auto_added:boolean engines_available:engineArray models_valid:boolean",
  error: "agent_id:nullableText code:text message:text",
  operation_lifecycle: "operation_id:text attempt_id:text state:operationState",
  approval_requested: "token:approvalToken description:text",
  approval_resolved: "decision:approvalDecision",
  caller_cancelled: "operation_id:text actor:text reason:nullableText",
  artifact_created: "artifact_id:text artifact_type:artifactType ref:text",
  artifact_updated: "artifact_id:text artifact_type:text ref:text previous_ref:text",
  native_history_reconciled:
    "public_session_ref:text status:reconciliationStatus imported_turn_count:number imported_tool_count:number provenance_refs:textArray evidence_refs:textArray completeness_reason:text",
} satisfies Record<TraceEvent["type"], string>;
rules.participantArray = array(rules.participant);
rules.dryRunParticipantArray = array(rules.dryRunParticipant);
const eventRules = new Map(
  Object.entries(eventSchemas).map(([type, spec]) => [type, compileShape(spec, rules)]),
);
const correlationSchema =
  "workflow_id:text conversation_id:text revision_id:text run_id:text turn_id:text operation_id:text attempt_id:text unit_id?:text participant_id?:text role_ref?:text role_resolved_hash?:text parent_attempt_id?:text skill_refs?:textArray skill_resolved_hashes?:textArray evidence_refs?:textArray engine?:engine";
const correlationRule = compileShape(correlationSchema, rules);
const eventRule = compileShape("type:text payload:any", { ...rules, any: () => true });
rules.event = (value) => {
  if (!eventRule(value)) return false;
  const event = value as { type: string; payload: unknown };
  return eventRules.get(event.type)?.(event.payload) === true;
};
const appendRule = compileShape("idempotency_key:text event:event", rules);
const storedRule = compileShape(
  `${correlationSchema} event_id:text seq:number ts:text idempotency_key:text event:event`,
  rules,
);
const journalRule = compileShape("stored_event:stored native_session_id:nullableText", {
  ...rules,
  stored: storedRule,
});

const json = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
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
    (Object.keys(value).length !== value.length ||
      Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key)))
  )
    return false;
  seen.add(value);
  const valid = Object.entries(value).every(
    ([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && json(item, seen),
  );
  seen.delete(value);
  return valid;
};
const iso = (value: string) =>
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
export const decodeRecord = (line: string): InternalTraceStoreRecord => {
  if (!line) fail("blank record");
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return fail("malformed record");
  }
  if (!json(record) || !journalRule(record)) fail("invalid record");
  return record as InternalTraceStoreRecord;
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
  nullableText(native);
export const validGenerated = (eventId: unknown, ts: unknown) =>
  typeof eventId === "string" && typeof ts === "string" && uuid.test(eventId) && iso(ts);
export const validReplayEvent = (event: StoredTraceEvent, conversationId: string, seq: number) =>
  event.conversation_id === conversationId &&
  uuid.test(event.event_id) &&
  Number.isSafeInteger(event.seq) &&
  event.seq === seq &&
  !!event.idempotency_key &&
  iso(event.ts);
