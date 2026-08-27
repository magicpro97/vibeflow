import type { MaterializedAgentBinding, PreviewAgentBinding } from "../../agents/binding.js";
import { createSpawnOptionsProjection } from "../../dispatch/session-types.js";
import type { TraceCorrelation, TraceEvent } from "../trace/types.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import type {
  AttemptEmission,
  ConversationContext,
  ConversationManifest,
  CoordinatorEmission,
  PolicyAttemptPurpose,
} from "./types.js";

const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== "object") return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.isFrozen(value) ? value : Object.freeze(value);
};
export const snapshotRuntimeValue = <T>(value: T): T => deepFreeze(structuredClone(value));

const jsonEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export function snapshotMaterializedBindings(
  bindings: readonly MaterializedAgentBinding[],
): MaterializedAgentBinding[] {
  return bindings.map((binding) => {
    const { resolved, spawn } = binding;
    if (
      resolved.engine !== spawn.engine ||
      resolved.model !== spawn.model ||
      resolved.sessionMode !== spawn.sessionMode ||
      resolved.sandbox !== spawn.sandbox ||
      resolved.role.resolved_hash !== spawn.trace_metadata.role_resolved_hash ||
      !jsonEqual(
        resolved.skills.map((skill) => skill.resolved_hash),
        spawn.trace_metadata.skill_resolved_hashes,
      ) ||
      !jsonEqual(resolved.provenance, spawn.provenance) ||
      !jsonEqual(resolved.env_policy, spawn.env_policy) ||
      !jsonEqual(resolved.isolation, spawn.isolation)
    ) {
      throw new Error("materialized binding authority mismatch");
    }
    const envPolicy = deepFreeze(spawn.env_policy);
    const isolation = deepFreeze(spawn.isolation);
    const snapshot = deepFreeze({
      ...structuredClone(resolved),
      env_policy: envPolicy,
      isolation,
    });
    return Object.freeze({
      resolved: snapshot,
      spawn: createSpawnOptionsProjection({
        ...spawn,
        env_policy: envPolicy,
        isolation,
      }),
    });
  });
}

export function immutableResolvedBindings(
  bindings: readonly MaterializedAgentBinding[],
): MaterializedAgentBinding["resolved"][] {
  return bindings.map((binding) => deepFreeze(structuredClone(binding.resolved)));
}

export function policyContextView(
  manifest: ConversationManifest,
  bindings: readonly MaterializedAgentBinding[],
): Pick<
  ConversationContext,
  | "topic"
  | "policy"
  | "maxRounds"
  | "baselineEnabled"
  | "evaluatorAutoAdded"
  | "bindings"
  | "participantIds"
  | "bindingReadiness"
> {
  return Object.freeze({
    topic: manifest.topic,
    policy: manifest.policy,
    maxRounds: manifest.max_rounds,
    baselineEnabled: manifest.baseline_enabled ?? true,
    evaluatorAutoAdded: manifest.evaluator_auto_added ?? false,
    bindings: Object.freeze(immutableResolvedBindings(bindings)),
    participantIds: Object.freeze(manifest.bindings.map((binding) => binding.participant_id)),
    bindingReadiness: Object.freeze(
      bindings.map(() => Object.freeze({ engine_available: true, model_valid: true })),
    ),
  });
}

export function previewAgentPolicyContext(
  manifest: ConversationManifest,
  previews: readonly PreviewAgentBinding[],
  correlation: Readonly<TraceCorrelation>,
): ConversationContext {
  const denied = () => {
    throw new Error("dry-run context is read-only");
  };
  return Object.freeze({
    correlation,
    topic: manifest.topic,
    policy: manifest.policy,
    maxRounds: manifest.max_rounds,
    baselineEnabled: manifest.baseline_enabled ?? true,
    evaluatorAutoAdded: manifest.evaluator_auto_added ?? false,
    bindings: Object.freeze(previews.map(({ resolved }) => deepFreeze(structuredClone(resolved)))),
    participantIds: Object.freeze(manifest.bindings.map(({ participant_id: id }) => id)),
    bindingReadiness: Object.freeze(
      previews.map(({ engineAvailable, modelValid }) =>
        Object.freeze({ engine_available: engineAvailable, model_valid: modelValid }),
      ),
    ),
    signal: new AbortController().signal,
    messages: () => Promise.resolve(Object.freeze([])),
    prepareTurn: () => Promise.reject(new Error("dry-run context is read-only")),
    publishSocialIntent: () => ({
      accepted: false,
      diagnostic_code: "dry_run_context",
    }),
    stageActionCandidate: () => ({
      accepted: false,
      diagnostic_code: "dry_run_context",
    }),
    emit: () => Promise.reject(new Error("dry-run context is read-only")),
    launchAttempt: denied,
    createArtifact: () => Promise.reject(new Error("dry-run context is read-only")),
    updateArtifact: () => Promise.reject(new Error("dry-run context is read-only")),
  });
}

export function previewPolicyContext(
  manifest: ConversationManifest,
  bindings: readonly MaterializedAgentBinding[],
  correlation: Readonly<TraceCorrelation>,
): ConversationContext {
  const denied = () => {
    throw new Error("dry-run context is read-only");
  };
  return Object.freeze({
    correlation,
    ...policyContextView(manifest, snapshotMaterializedBindings(bindings)),
    signal: new AbortController().signal,
    messages: () => Promise.resolve(Object.freeze([])),
    prepareTurn: () => Promise.reject(new Error("dry-run context is read-only")),
    publishSocialIntent: () => ({
      accepted: false,
      diagnostic_code: "dry_run_context",
    }),
    stageActionCandidate: () => ({
      accepted: false,
      diagnostic_code: "dry_run_context",
    }),
    emit: () => Promise.reject(new Error("dry-run context is read-only")),
    launchAttempt: denied,
    createArtifact: () => Promise.reject(new Error("dry-run context is read-only")),
    updateArtifact: () => Promise.reject(new Error("dry-run context is read-only")),
  });
}

export function previewBindingPolicyContext(
  manifest: ConversationManifest,
  bindings: readonly (MaterializedAgentBinding | PreviewAgentBinding)[],
  correlation: Readonly<TraceCorrelation>,
): ConversationContext {
  return bindings.every((binding) => "spawn" in binding)
    ? previewPolicyContext(manifest, bindings as MaterializedAgentBinding[], correlation)
    : previewAgentPolicyContext(manifest, bindings as PreviewAgentBinding[], correlation);
}

const coordinatorTypes = new Set<CoordinatorEmission["event"]["type"]>([
  CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY,
  CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE,
  CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT,
  CONVERSATION_TRACE_EVENT_KIND.SYNTHESIS_COMPLETED,
  CONVERSATION_TRACE_EVENT_KIND.DRY_RUN_RESULT,
  CONVERSATION_TRACE_EVENT_KIND.APPROVAL_REQUESTED,
  CONVERSATION_TRACE_EVENT_KIND.ERROR,
]);
const attemptTypes = new Set<AttemptEmission["event"]["type"]>([
  CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT,
  CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
  CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION,
  CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT,
  CONVERSATION_TRACE_EVENT_KIND.ERROR,
]);
const responseTypes = Object.freeze([
  CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
  CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION,
  CONVERSATION_TRACE_EVENT_KIND.ERROR,
] as const);
const purposeTypes: Record<PolicyAttemptPurpose, ReadonlySet<AttemptEmission["event"]["type"]>> = {
  baseline: new Set(),
  participant: new Set([CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT, ...responseTypes]),
  evaluator: new Set([
    CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT,
    CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION,
    CONVERSATION_TRACE_EVENT_KIND.ERROR,
  ]),
  direct: new Set(responseTypes),
  plan: new Set(responseTypes),
  review: new Set(responseTypes),
  verify: new Set(responseTypes),
  orchestrate: new Set(responseTypes),
};
const reservedIdempotencyKey =
  /^(?:conversation|participant|attempt|native-history|approval|caller-cancelled|message):/;

export function assertPolicyIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !key || reservedIdempotencyKey.test(key)) {
    throw new Error("policy idempotency key uses reserved runtime authority");
  }
}

export function assertCoordinatorEmission(
  emission: { idempotency_key: string; event: TraceEvent },
  operationId: string,
): asserts emission is CoordinatorEmission {
  assertPolicyIdempotencyKey(emission.idempotency_key);
  if (!coordinatorTypes.has(emission.event.type as CoordinatorEmission["event"]["type"])) {
    throw new Error("policy coordinator event is not authorized");
  }
  if (
    emission.event.type === CONVERSATION_TRACE_EVENT_KIND.APPROVAL_REQUESTED &&
    emission.event.payload.token.operation_id !== operationId
  ) {
    throw new Error("approval operation lacks runtime authority");
  }
  if (
    emission.event.type === CONVERSATION_TRACE_EVENT_KIND.ERROR &&
    emission.event.payload.agent_id !== null
  ) {
    throw new Error("coordinator error cannot forge participant identity");
  }
}

export function assertAttemptEmission(
  emission: { idempotency_key: string; event: TraceEvent },
  participantId: string,
  purpose: PolicyAttemptPurpose,
): asserts emission is AttemptEmission {
  assertPolicyIdempotencyKey(emission.idempotency_key);
  if (!attemptTypes.has(emission.event.type as AttemptEmission["event"]["type"])) {
    throw new Error("policy attempt event is not authorized");
  }
  const event = emission.event;
  if (!purposeTypes[purpose].has(event.type as AttemptEmission["event"]["type"])) {
    throw new Error("attempt event is not authorized for purpose");
  }
  if (
    (event.type === CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT ||
      event.type === CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA) &&
    (purpose === "evaluator" || event.payload.participant_id !== participantId)
  ) {
    throw new Error("attempt participant correlation mismatch");
  }
  if (
    event.type === CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT &&
    purpose !== "evaluator"
  ) {
    throw new Error("assessment lacks evaluator authority");
  }
  if (
    event.type === CONVERSATION_TRACE_EVENT_KIND.ERROR &&
    event.payload.agent_id !== participantId
  ) {
    throw new Error("attempt error participant mismatch");
  }
}
