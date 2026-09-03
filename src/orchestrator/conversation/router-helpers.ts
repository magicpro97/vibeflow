import type { ResolvedAgentBinding } from "../../agents/binding.js";
import { isReadOnlyRole } from "../../agents/role.js";
import { ENGINES, type Engine } from "../../core.js";
import { AGENT_ROLE_SOURCE } from "../../core/agent-contract.js";
import { ROLE_SANDBOX, isMutatingRoleToolIntent } from "../../core/role-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../core/role-name-contract.js";
import {
  supportsAuthenticatedCoordinationOutput,
  supportsConversationRoleAuthority,
} from "../../dispatch/session-contract.js";
import { CONVERSATION_POLICY } from "./conversation-policy-contract.js";

export const ENGINE_PRECEDENCE: readonly Engine[] = Object.freeze([...ENGINES]);

export const COORDINATE_ROUTE_PROJECTION_ERROR = Object.freeze({
  EXECUTOR_UNAVAILABLE: "coordinate_executor_unavailable",
  ENGINE_UNSUPPORTED: "coordinate_engine_unsupported",
  ENGINE_NOT_DISTINCT: "coordinate_engine_not_distinct",
} as const);
export type CoordinateRouteProjectionError =
  (typeof COORDINATE_ROUTE_PROJECTION_ERROR)[keyof typeof COORDINATE_ROUTE_PROJECTION_ERROR];

interface CoordinateRouteParticipantProjection {
  readonly roleRef: string;
  readonly engine?: Engine;
  readonly model?: string;
}

type CoordinateRouteProjection =
  | { readonly ok: true; readonly participants: readonly CoordinateRouteParticipantProjection[] }
  | { readonly ok: false; readonly error: CoordinateRouteProjectionError };

/** Canonical raw projection; resolved role authority is checked after binding materialization. */
export function projectCoordinateRouteParticipants(input: {
  requested: readonly CoordinateRouteParticipantProjection[];
  participants: readonly CoordinateRouteParticipantProjection[];
  coordinatorRole: string;
  readyEngines: readonly Engine[];
}): CoordinateRouteProjection {
  if (input.participants.length < 2)
    return { ok: false, error: COORDINATE_ROUTE_PROJECTION_ERROR.EXECUTOR_UNAVAILABLE };
  if (
    input.requested.some(
      ({ engine }) => engine !== undefined && !supportsAuthenticatedCoordinationOutput(engine),
    )
  )
    return { ok: false, error: COORDINATE_ROUTE_PROJECTION_ERROR.ENGINE_UNSUPPORTED };
  const explicitExecutorEngines = new Set(
    input.requested.slice(1).flatMap(({ engine }) => (engine === undefined ? [] : [engine])),
  );
  const coordinatorEngine =
    input.requested[0]?.engine ??
    input.readyEngines.find((engine) => !explicitExecutorEngines.has(engine));
  if (!coordinatorEngine)
    return { ok: false, error: COORDINATE_ROUTE_PROJECTION_ERROR.EXECUTOR_UNAVAILABLE };
  const participants: CoordinateRouteParticipantProjection[] = [];
  for (const [index, participant] of input.participants.entries()) {
    if (index === 0) {
      participants.push(
        Object.freeze({
          roleRef: input.coordinatorRole,
          engine: coordinatorEngine,
          ...(participant.model !== undefined ? { model: participant.model } : {}),
        }),
      );
      continue;
    }
    const selectedEngine: Engine | undefined =
      input.requested[index]?.engine ??
      input.readyEngines.find((candidate) => candidate !== coordinatorEngine);
    if (!selectedEngine)
      return { ok: false, error: COORDINATE_ROUTE_PROJECTION_ERROR.EXECUTOR_UNAVAILABLE };
    if (selectedEngine === coordinatorEngine)
      return { ok: false, error: COORDINATE_ROUTE_PROJECTION_ERROR.ENGINE_NOT_DISTINCT };
    participants.push(
      Object.freeze({
        roleRef: participant.roleRef,
        engine: selectedEngine,
        ...(participant.model !== undefined ? { model: participant.model } : {}),
      }),
    );
  }
  return { ok: true, participants: Object.freeze(participants) };
}

export const normalizedRoutingText = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();

export const routingStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const COORDINATE_TOPOLOGY_DIAGNOSTIC = Object.freeze({
  POLICY_NONCANONICAL: "coordination_policy_noncanonical",
  PARTICIPANTS_INVALID: "coordination_requires_coordinator_and_executor",
  MATERIALIZATION_CHANGED: "coordination_binding_materialization_changed",
  COORDINATOR_AUTHORITY_INVALID: "coordination_coordinator_authority_invalid",
  EXECUTOR_AUTHORITY_INVALID: "coordination_executor_authority_invalid",
  EXECUTOR_ENGINE_NOT_DISTINCT: "coordination_executor_engine_not_distinct",
  HOST_TOOLS_FORBIDDEN: "coordination_host_tools_forbidden",
  BINDING_UNAVAILABLE: "coordination_binding_unavailable",
} as const);
export type CoordinateTopologyDiagnostic =
  (typeof COORDINATE_TOPOLOGY_DIAGNOSTIC)[keyof typeof COORDINATE_TOPOLOGY_DIAGNOSTIC];

interface CoordinateExpectedBinding {
  readonly roleRef: string;
  readonly engine: Engine;
}

interface CoordinateBindingReadiness {
  readonly engine_available: boolean;
  readonly model_valid: boolean;
}

export interface CoordinateTopologyAuthority {
  readonly policy: string;
  readonly bindings: readonly ResolvedAgentBinding[];
  readonly expectedBindings?: readonly CoordinateExpectedBinding[];
  readonly participantIds?: readonly string[];
  readonly bindingReadiness?: readonly CoordinateBindingReadiness[];
  readonly hostTools?: readonly (readonly string[] | undefined)[];
}

const completeOrderedAuthority = (
  authority: CoordinateTopologyAuthority,
  values: readonly unknown[] | undefined,
): boolean => values === undefined || values.length === authority.bindings.length;

/** One fail-closed authority check shared by bootstrap and the live coordinate policy. */
export function coordinateTopologyDiagnostic(
  authority: CoordinateTopologyAuthority,
): CoordinateTopologyDiagnostic | null {
  if (authority.policy !== CONVERSATION_POLICY.COORDINATE)
    return COORDINATE_TOPOLOGY_DIAGNOSTIC.POLICY_NONCANONICAL;
  if (
    authority.bindings.length < 2 ||
    !completeOrderedAuthority(authority, authority.expectedBindings) ||
    !completeOrderedAuthority(authority, authority.participantIds) ||
    !completeOrderedAuthority(authority, authority.bindingReadiness) ||
    !completeOrderedAuthority(authority, authority.hostTools) ||
    (authority.participantIds !== undefined &&
      (new Set(authority.participantIds).size !== authority.participantIds.length ||
        authority.participantIds.some((id) => !id.trim())))
  )
    return COORDINATE_TOPOLOGY_DIAGNOSTIC.PARTICIPANTS_INVALID;
  if (
    authority.expectedBindings?.some((expected, index) => {
      const observed = authority.bindings[index];
      return (
        !observed ||
        observed.role.spec.name !== expected.roleRef ||
        observed.engine !== expected.engine
      );
    })
  )
    return COORDINATE_TOPOLOGY_DIAGNOSTIC.MATERIALIZATION_CHANGED;
  if (
    authority.bindingReadiness?.some(
      (readiness) => !readiness.engine_available || !readiness.model_valid,
    )
  )
    return COORDINATE_TOPOLOGY_DIAGNOSTIC.BINDING_UNAVAILABLE;
  if (authority.hostTools?.some((tools) => !Array.isArray(tools) || tools.length > 0))
    return COORDINATE_TOPOLOGY_DIAGNOSTIC.HOST_TOOLS_FORBIDDEN;
  const coordinator = authority.bindings[0];
  if (
    !coordinator ||
    coordinator.role.spec.name !== CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR ||
    coordinator.role.source !== AGENT_ROLE_SOURCE.BUILTIN ||
    coordinator.role.spec.sandbox !== ROLE_SANDBOX.READ_ONLY ||
    coordinator.sandbox !== ROLE_SANDBOX.READ_ONLY ||
    !isReadOnlyRole(coordinator.role.spec) ||
    !supportsConversationRoleAuthority(coordinator.engine) ||
    !supportsAuthenticatedCoordinationOutput(coordinator.engine)
  )
    return COORDINATE_TOPOLOGY_DIAGNOSTIC.COORDINATOR_AUTHORITY_INVALID;
  for (const executor of authority.bindings.slice(1)) {
    if (executor.engine === coordinator.engine)
      return COORDINATE_TOPOLOGY_DIAGNOSTIC.EXECUTOR_ENGINE_NOT_DISTINCT;
    if (
      executor.role.spec.sandbox !== ROLE_SANDBOX.WORKSPACE_WRITE ||
      executor.sandbox !== ROLE_SANDBOX.WORKSPACE_WRITE ||
      !executor.role.spec.tools.some(isMutatingRoleToolIntent) ||
      !executor.tool_intents.some(isMutatingRoleToolIntent) ||
      !supportsConversationRoleAuthority(executor.engine) ||
      !supportsAuthenticatedCoordinationOutput(executor.engine)
    )
      return COORDINATE_TOPOLOGY_DIAGNOSTIC.EXECUTOR_AUTHORITY_INVALID;
  }
  return null;
}

const topicWords = (topic: string): readonly string[] =>
  normalizedRoutingText(topic)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const hasPhrase = (words: readonly string[], phrase: readonly string[]): boolean => {
  if (!phrase.length || phrase.length > words.length) return false;
  for (let start = 0; start <= words.length - phrase.length; start += 1) {
    if (phrase.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
};

const hasAnyPhrase = (words: readonly string[], phrases: readonly (readonly string[])[]): boolean =>
  phrases.some((phrase) => hasPhrase(words, phrase));

const EXECUTE = [
  ["execute"],
  ["implement"],
  ["build"],
  ["ship"],
  ["run"],
  ["apply"],
  ["orchestrate"],
  ["dispatch"],
] as const;
const VERIFY = [
  ["verify"],
  ["test"],
  ["tests"],
  ["testing"],
  ["gate"],
  ["gates"],
  ["confidence"],
  ["validate"],
  ["validation"],
] as const;
const REVIEW = [["review"], ["audit"], ["critique"], ["assess"]] as const;
const PLAN = [
  ["plan"],
  ["planning"],
  ["design"],
  ["spec"],
  ["specification"],
  ["architecture"],
  ["roadmap"],
] as const;
const DEBATE = [
  ["brainstorm"],
  ["debate"],
  ["compare"],
  ["comparison"],
  ["option"],
  ["options"],
  ["alternative"],
  ["alternatives"],
  ["tradeoff"],
  ["tradeoffs"],
  ["trade", "off"],
  ["trade", "offs"],
  ["pros", "and", "cons"],
  ["versus"],
  ["vs"],
] as const;

export type ConversationIntentSelection = readonly [
  string,
  (
    | "ready_workflow_execute"
    | "verify_intent"
    | "review_intent"
    | "plan_intent"
    | "debate_intent"
    | "direct_fallback"
  ),
];

export const selectConversationIntent = (
  topic: string,
  workflowReady: boolean | undefined,
): ConversationIntentSelection => {
  const words = topicWords(topic);
  return workflowReady === true && hasAnyPhrase(words, EXECUTE)
    ? [CONVERSATION_POLICY.ORCHESTRATE, "ready_workflow_execute"]
    : hasAnyPhrase(words, VERIFY)
      ? [CONVERSATION_POLICY.VERIFY, "verify_intent"]
      : hasAnyPhrase(words, REVIEW)
        ? [CONVERSATION_POLICY.REVIEW, "review_intent"]
        : hasAnyPhrase(words, PLAN)
          ? [CONVERSATION_POLICY.PLAN, "plan_intent"]
          : hasAnyPhrase(words, DEBATE)
            ? [CONVERSATION_POLICY.DEBATE, "debate_intent"]
            : [CONVERSATION_POLICY.DIRECT, "direct_fallback"];
};

const BRAINSTORM_ROLE_NAMES = new Set<string>([
  CONVERSATION_ROLE_NAME.BRAINSTORM_PARTICIPANT,
  CONVERSATION_ROLE_NAME.BRAINSTORM_SKEPTIC,
  CONVERSATION_ROLE_NAME.BRAINSTORM_DOMAIN_EXPERT,
  CONVERSATION_ROLE_NAME.BRAINSTORM_EVALUATOR,
]);

export const explicitMultiParticipantPolicy = (
  participants: readonly { readonly roleRef: string }[],
): string =>
  participants.every((participant) => BRAINSTORM_ROLE_NAMES.has(participant.roleRef))
    ? CONVERSATION_POLICY.DEBATE
    : CONVERSATION_POLICY.COORDINATE;

export const routingAttachmentExtension = (value: string): string => {
  const name = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? normalizedRoutingText(name.slice(dot + 1)) : "";
};
