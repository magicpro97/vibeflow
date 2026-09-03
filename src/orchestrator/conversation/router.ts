import type { Engine } from "../../core.js";
import { CONVERSATION_ROLE_NAME } from "../../core/role-name-contract.js";
import { supportsAuthenticatedCoordinationOutput } from "../../dispatch/session-contract.js";
import { CONVERSATION_POLICY } from "./conversation-policy-contract.js";
import {
  COORDINATE_ROUTE_PROJECTION_ERROR,
  ENGINE_PRECEDENCE,
  explicitMultiParticipantPolicy,
  normalizedRoutingText,
  projectCoordinateRouteParticipants,
  routingAttachmentExtension,
  routingStringList,
  selectConversationIntent,
} from "./router-helpers.js";

export interface ConversationRouteParticipant {
  readonly roleRef: string;
  readonly engine?: Engine;
  readonly model?: string;
}
export interface ConversationRoutingInput {
  readonly topic: string;
  readonly explicitPolicy?: string | null;
  readonly participants?: readonly ConversationRouteParticipant[];
  readonly workflowReady?: boolean;
  readonly attachments?: readonly string[];
  readonly skillDomains?: readonly string[];
}
export interface ConversationEngineReadiness {
  readonly engine: Engine;
  readonly ready: boolean;
  readonly admitted: boolean;
}
export interface ConversationDomainRole {
  readonly roleRef: string;
  readonly domains: readonly string[];
  readonly attachmentExtensions: readonly string[];
}
export interface ConversationRoutingAuthority {
  readonly registeredPolicies: readonly string[];
  readonly registeredRoles: readonly string[];
  readonly engines: readonly ConversationEngineReadiness[];
  readonly domainRoles: readonly ConversationDomainRole[];
}
export type ConversationRouteReason =
  | "explicit_policy"
  | "explicit_participants"
  | "ready_workflow_execute"
  | "verify_intent"
  | "review_intent"
  | "plan_intent"
  | "debate_intent"
  | "domain_role_match"
  | "direct_fallback";
export interface ConversationRoute {
  readonly policy: string;
  readonly participants: readonly ConversationRouteParticipant[];
  readonly reason: ConversationRouteReason;
}

export const CONVERSATION_ROUTING_ERROR_CODE = Object.freeze({
  INVALID_ROUTING_INPUT: "invalid_routing_input",
  INVALID_ROUTING_AUTHORITY: "invalid_routing_authority",
  UNKNOWN_EXPLICIT_POLICY: "unknown_explicit_policy",
  UNKNOWN_EXPLICIT_ROLE: "unknown_explicit_role",
  EXPLICIT_ENGINE_UNAVAILABLE: "explicit_engine_unavailable",
  COORDINATE_EXECUTOR_UNAVAILABLE: COORDINATE_ROUTE_PROJECTION_ERROR.EXECUTOR_UNAVAILABLE,
  COORDINATE_ENGINE_UNSUPPORTED: COORDINATE_ROUTE_PROJECTION_ERROR.ENGINE_UNSUPPORTED,
  COORDINATE_ENGINE_NOT_DISTINCT: COORDINATE_ROUTE_PROJECTION_ERROR.ENGINE_NOT_DISTINCT,
  POLICY_UNAVAILABLE: "policy_unavailable",
  ROLE_UNAVAILABLE: "role_unavailable",
} as const);
export type ConversationRoutingErrorCode =
  (typeof CONVERSATION_ROUTING_ERROR_CODE)[keyof typeof CONVERSATION_ROUTING_ERROR_CODE];

export class ConversationRoutingError extends Error {
  override readonly name = "ConversationRoutingError";

  constructor(readonly code: ConversationRoutingErrorCode) {
    super(code);
  }
}

const normalizedRegistry = (values: unknown): ReadonlyMap<string, string> => {
  if (!routingStringList(values)) {
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_AUTHORITY);
  }
  const output = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string" || !normalizedRoutingText(value)) {
      throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_AUTHORITY);
    }
    const key = normalizedRoutingText(value);
    const prior = output.get(key);
    if (prior !== undefined && prior !== value) {
      throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_AUTHORITY);
    }
    output.set(key, value);
  }
  return output;
};

function validateInput(value: unknown): asserts value is ConversationRoutingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_INPUT);
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.topic !== "string" ||
    (input.explicitPolicy !== undefined &&
      input.explicitPolicy !== null &&
      typeof input.explicitPolicy !== "string") ||
    (input.workflowReady !== undefined && typeof input.workflowReady !== "boolean") ||
    (input.attachments !== undefined && !routingStringList(input.attachments)) ||
    (input.skillDomains !== undefined && !routingStringList(input.skillDomains)) ||
    (input.participants !== undefined &&
      (!Array.isArray(input.participants) ||
        input.participants.some(
          (item) =>
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            typeof (item as Record<string, unknown>).roleRef !== "string" ||
            ((item as Record<string, unknown>).engine !== undefined &&
              !ENGINE_PRECEDENCE.includes((item as Record<string, unknown>).engine as Engine)) ||
            ((item as Record<string, unknown>).model !== undefined &&
              typeof (item as Record<string, unknown>).model !== "string"),
        )))
  ) {
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_INPUT);
  }
}

const frozenParticipant = (
  roleRef: string,
  engine?: Engine,
  model?: string,
): ConversationRouteParticipant =>
  Object.freeze({
    roleRef,
    ...(engine ? { engine } : {}),
    ...(model !== undefined ? { model } : {}),
  });

const frozenRoute = (
  policy: string,
  participants: readonly ConversationRouteParticipant[],
  reason: ConversationRouteReason,
): ConversationRoute =>
  Object.freeze({
    policy,
    participants: Object.freeze([...participants]),
    reason,
  });

function engineAuthority(authority: ConversationRoutingAuthority): ReadonlyMap<Engine, boolean> {
  const statuses = new Map<Engine, boolean>();
  if (!Array.isArray(authority.engines)) {
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_AUTHORITY);
  }
  for (const item of authority.engines) {
    if (
      !item ||
      typeof item !== "object" ||
      !ENGINE_PRECEDENCE.includes(item.engine) ||
      typeof item.ready !== "boolean" ||
      typeof item.admitted !== "boolean" ||
      statuses.has(item.engine)
    ) {
      throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_AUTHORITY);
    }
    statuses.set(item.engine, item.ready === true && item.admitted === true);
  }
  return statuses;
}

function validateDomainRoles(
  value: unknown,
  roles: ReadonlyMap<string, string>,
): asserts value is readonly ConversationDomainRole[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as ConversationDomainRole).roleRef !== "string" ||
        !roles.has(normalizedRoutingText((item as ConversationDomainRole).roleRef)) ||
        !routingStringList((item as ConversationDomainRole).domains) ||
        !routingStringList((item as ConversationDomainRole).attachmentExtensions),
    )
  ) {
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_AUTHORITY);
  }
}

const preferredEngine = (statuses: ReadonlyMap<Engine, boolean>): Engine | undefined =>
  ENGINE_PRECEDENCE.find((engine) => statuses.get(engine) === true);

const required = (
  registry: ReadonlyMap<string, string>,
  value: string,
  code:
    | typeof CONVERSATION_ROUTING_ERROR_CODE.POLICY_UNAVAILABLE
    | typeof CONVERSATION_ROUTING_ERROR_CODE.ROLE_UNAVAILABLE,
): string => {
  const found = registry.get(normalizedRoutingText(value));
  if (!found) throw new ConversationRoutingError(code);
  return found;
};

function explicitParticipants(
  input: ConversationRoutingInput,
  roles: ReadonlyMap<string, string>,
  engines: ReadonlyMap<Engine, boolean>,
): readonly ConversationRouteParticipant[] {
  const selected = input.participants ?? [];
  const fallback = preferredEngine(engines);
  return Object.freeze(
    selected.map((participant) => {
      const roleRef = roles.get(normalizedRoutingText(participant.roleRef));
      if (!roleRef)
        throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.UNKNOWN_EXPLICIT_ROLE);
      if (participant.engine !== undefined && engines.get(participant.engine) !== true) {
        throw new ConversationRoutingError(
          CONVERSATION_ROUTING_ERROR_CODE.EXPLICIT_ENGINE_UNAVAILABLE,
        );
      }
      return frozenParticipant(roleRef, participant.engine ?? fallback, participant.model);
    }),
  );
}

function canonicalCoordinateParticipants(
  requested: readonly ConversationRouteParticipant[],
  participants: readonly ConversationRouteParticipant[],
  roles: ReadonlyMap<string, string>,
  engines: ReadonlyMap<Engine, boolean>,
): readonly ConversationRouteParticipant[] {
  const ready = ENGINE_PRECEDENCE.filter(
    (engine) => engines.get(engine) === true && supportsAuthenticatedCoordinationOutput(engine),
  );
  const projected = projectCoordinateRouteParticipants({
    requested,
    participants,
    coordinatorRole: required(
      roles,
      CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
      CONVERSATION_ROUTING_ERROR_CODE.ROLE_UNAVAILABLE,
    ),
    readyEngines: ready,
  });
  if (!projected.ok) throw new ConversationRoutingError(projected.error);
  return projected.participants;
}

function defaultParticipants(
  policy: string,
  roles: ReadonlyMap<string, string>,
  engine: Engine | undefined,
  executorEngine: Engine | undefined,
): readonly ConversationRouteParticipant[] {
  if (
    normalizedRoutingText(policy) === CONVERSATION_POLICY.COORDINATE &&
    (!engine || !executorEngine)
  )
    throw new ConversationRoutingError(
      CONVERSATION_ROUTING_ERROR_CODE.COORDINATE_EXECUTOR_UNAVAILABLE,
    );
  const defaults =
    normalizedRoutingText(policy) === CONVERSATION_POLICY.DEBATE
      ? [CONVERSATION_ROLE_NAME.BRAINSTORM_PARTICIPANT, CONVERSATION_ROLE_NAME.BRAINSTORM_SKEPTIC]
      : normalizedRoutingText(policy) === CONVERSATION_POLICY.COORDINATE
        ? [
            CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
            CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
          ]
        : [CONVERSATION_ROLE_NAME.DIRECT];
  return Object.freeze(
    defaults.map((role, index) =>
      frozenParticipant(
        required(roles, role, CONVERSATION_ROUTING_ERROR_CODE.ROLE_UNAVAILABLE),
        index === 1 ? executorEngine : engine,
      ),
    ),
  );
}

function matchedDomainParticipant(
  input: ConversationRoutingInput,
  authority: ConversationRoutingAuthority,
  roles: ReadonlyMap<string, string>,
  engine: Engine | undefined,
): ConversationRouteParticipant | null {
  const domains = new Set((input.skillDomains ?? []).map(normalizedRoutingText).filter(Boolean));
  const extensions = new Set(
    (input.attachments ?? []).map(routingAttachmentExtension).filter(Boolean),
  );
  const matched = authority.domainRoles.flatMap((candidate) => {
    const byDomain = candidate.domains.some((domain) => domains.has(normalizedRoutingText(domain)));
    const byAttachment = candidate.attachmentExtensions.some((extension) =>
      extensions.has(normalizedRoutingText(extension).replace(/^\./, "")),
    );
    return byDomain || byAttachment ? [candidate.roleRef] : [];
  });
  if (!matched.length) return null;
  matched.sort((left, right) => {
    const a = normalizedRoutingText(left);
    const b = normalizedRoutingText(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const roleRef = roles.get(normalizedRoutingText(matched[0] as string));
  if (!roleRef)
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.ROLE_UNAVAILABLE);
  return frozenParticipant(roleRef, engine);
}

export function routeConversation(
  input: ConversationRoutingInput,
  authority: ConversationRoutingAuthority,
): ConversationRoute {
  validateInput(input);
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_AUTHORITY);
  }
  const policies = normalizedRegistry(authority.registeredPolicies);
  const roles = normalizedRegistry(authority.registeredRoles);
  const engines = engineAuthority(authority);
  validateDomainRoles(authority.domainRoles, roles);
  const preferred = preferredEngine(engines);
  const secondary = ENGINE_PRECEDENCE.find(
    (engine) => engine !== preferred && engines.get(engine) === true,
  );
  const coordinateEngines = ENGINE_PRECEDENCE.filter(
    (engine) => engines.get(engine) === true && supportsAuthenticatedCoordinationOutput(engine),
  );
  const explicit =
    input.explicitPolicy === null || input.explicitPolicy === undefined
      ? null
      : policies.get(normalizedRoutingText(input.explicitPolicy));
  if (input.explicitPolicy !== null && input.explicitPolicy !== undefined && !explicit) {
    throw new ConversationRoutingError(CONVERSATION_ROUTING_ERROR_CODE.UNKNOWN_EXPLICIT_POLICY);
  }
  const participants = explicitParticipants(input, roles, engines);
  if (explicit) {
    const coordinate = normalizedRoutingText(explicit) === CONVERSATION_POLICY.COORDINATE;
    return frozenRoute(
      explicit,
      participants.length
        ? coordinate
          ? canonicalCoordinateParticipants(input.participants ?? [], participants, roles, engines)
          : participants
        : defaultParticipants(
            explicit,
            roles,
            coordinate ? coordinateEngines[0] : preferred,
            coordinate ? coordinateEngines[1] : secondary,
          ),
      "explicit_policy",
    );
  }
  if (participants.length) {
    const policy = required(
      policies,
      participants.length > 1
        ? explicitMultiParticipantPolicy(participants)
        : CONVERSATION_POLICY.DIRECT,
      CONVERSATION_ROUTING_ERROR_CODE.POLICY_UNAVAILABLE,
    );
    return frozenRoute(
      policy,
      normalizedRoutingText(policy) === CONVERSATION_POLICY.COORDINATE
        ? canonicalCoordinateParticipants(input.participants ?? [], participants, roles, engines)
        : participants,
      "explicit_participants",
    );
  }

  const selected: readonly [string, ConversationRouteReason] = selectConversationIntent(
    input.topic,
    input.workflowReady,
  );
  if (selected[0] === CONVERSATION_POLICY.DIRECT) {
    const domain = matchedDomainParticipant(input, authority, roles, preferred);
    if (domain) {
      return frozenRoute(
        required(policies, "direct", CONVERSATION_ROUTING_ERROR_CODE.POLICY_UNAVAILABLE),
        [domain],
        "domain_role_match",
      );
    }
  }
  const policy = required(
    policies,
    selected[0],
    CONVERSATION_ROUTING_ERROR_CODE.POLICY_UNAVAILABLE,
  );
  return frozenRoute(policy, defaultParticipants(policy, roles, preferred, secondary), selected[1]);
}
