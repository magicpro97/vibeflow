import { ENGINES, type Engine } from "../../core.js";

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

export type ConversationRoutingErrorCode =
  | "invalid_routing_input"
  | "invalid_routing_authority"
  | "unknown_explicit_policy"
  | "unknown_explicit_role"
  | "explicit_engine_unavailable"
  | "policy_unavailable"
  | "role_unavailable";

export class ConversationRoutingError extends Error {
  override readonly name = "ConversationRoutingError";

  constructor(readonly code: ConversationRoutingErrorCode) {
    super(code);
  }
}

const normalizedText = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const normalizedRegistry = (values: unknown): ReadonlyMap<string, string> => {
  if (!stringList(values)) throw new ConversationRoutingError("invalid_routing_authority");
  const output = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string" || !normalizedText(value)) {
      throw new ConversationRoutingError("invalid_routing_authority");
    }
    const key = normalizedText(value);
    const prior = output.get(key);
    if (prior !== undefined && prior !== value) {
      throw new ConversationRoutingError("invalid_routing_authority");
    }
    output.set(key, value);
  }
  return output;
};

function validateInput(value: unknown): asserts value is ConversationRoutingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationRoutingError("invalid_routing_input");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.topic !== "string" ||
    (input.explicitPolicy !== undefined &&
      input.explicitPolicy !== null &&
      typeof input.explicitPolicy !== "string") ||
    (input.workflowReady !== undefined && typeof input.workflowReady !== "boolean") ||
    (input.attachments !== undefined && !stringList(input.attachments)) ||
    (input.skillDomains !== undefined && !stringList(input.skillDomains)) ||
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
    throw new ConversationRoutingError("invalid_routing_input");
  }
}

const topicWords = (topic: string): readonly string[] =>
  normalizedText(topic)
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
const ENGINE_PRECEDENCE: readonly Engine[] = Object.freeze([...ENGINES]);

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
    throw new ConversationRoutingError("invalid_routing_authority");
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
      throw new ConversationRoutingError("invalid_routing_authority");
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
        !roles.has(normalizedText((item as ConversationDomainRole).roleRef)) ||
        !stringList((item as ConversationDomainRole).domains) ||
        !stringList((item as ConversationDomainRole).attachmentExtensions),
    )
  ) {
    throw new ConversationRoutingError("invalid_routing_authority");
  }
}

const preferredEngine = (statuses: ReadonlyMap<Engine, boolean>): Engine | undefined =>
  ENGINE_PRECEDENCE.find((engine) => statuses.get(engine) === true);

const required = (
  registry: ReadonlyMap<string, string>,
  value: string,
  code: "policy_unavailable" | "role_unavailable",
): string => {
  const found = registry.get(normalizedText(value));
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
      const roleRef = roles.get(normalizedText(participant.roleRef));
      if (!roleRef) throw new ConversationRoutingError("unknown_explicit_role");
      if (participant.engine !== undefined && engines.get(participant.engine) !== true) {
        throw new ConversationRoutingError("explicit_engine_unavailable");
      }
      return frozenParticipant(roleRef, participant.engine ?? fallback, participant.model);
    }),
  );
}

function defaultParticipants(
  policy: string,
  roles: ReadonlyMap<string, string>,
  engine: Engine | undefined,
): readonly ConversationRouteParticipant[] {
  const defaults =
    normalizedText(policy) === "debate"
      ? ["brainstorm-participant", "brainstorm-skeptic"]
      : ["direct"];
  return Object.freeze(
    defaults.map((role) => frozenParticipant(required(roles, role, "role_unavailable"), engine)),
  );
}

const attachmentExtension = (value: string): string => {
  const name = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? normalizedText(name.slice(dot + 1)) : "";
};

function matchedDomainParticipant(
  input: ConversationRoutingInput,
  authority: ConversationRoutingAuthority,
  roles: ReadonlyMap<string, string>,
  engine: Engine | undefined,
): ConversationRouteParticipant | null {
  const domains = new Set((input.skillDomains ?? []).map(normalizedText).filter(Boolean));
  const extensions = new Set((input.attachments ?? []).map(attachmentExtension).filter(Boolean));
  const matched = authority.domainRoles.flatMap((candidate) => {
    const byDomain = candidate.domains.some((domain) => domains.has(normalizedText(domain)));
    const byAttachment = candidate.attachmentExtensions.some((extension) =>
      extensions.has(normalizedText(extension).replace(/^\./, "")),
    );
    return byDomain || byAttachment ? [candidate.roleRef] : [];
  });
  if (!matched.length) return null;
  matched.sort((left, right) => {
    const a = normalizedText(left);
    const b = normalizedText(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const roleRef = roles.get(normalizedText(matched[0] as string));
  if (!roleRef) throw new ConversationRoutingError("role_unavailable");
  return frozenParticipant(roleRef, engine);
}

/** Pure Phase-2/3 coordinator: frozen precedence, no provider or filesystem reads. */
export function routeConversation(
  input: ConversationRoutingInput,
  authority: ConversationRoutingAuthority,
): ConversationRoute {
  validateInput(input);
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new ConversationRoutingError("invalid_routing_authority");
  }
  const policies = normalizedRegistry(authority.registeredPolicies);
  const roles = normalizedRegistry(authority.registeredRoles);
  const engines = engineAuthority(authority);
  validateDomainRoles(authority.domainRoles, roles);
  const preferred = preferredEngine(engines);
  const explicit =
    input.explicitPolicy === null || input.explicitPolicy === undefined
      ? null
      : policies.get(normalizedText(input.explicitPolicy));
  if (input.explicitPolicy !== null && input.explicitPolicy !== undefined && !explicit) {
    throw new ConversationRoutingError("unknown_explicit_policy");
  }
  const participants = explicitParticipants(input, roles, engines);
  if (explicit) {
    return frozenRoute(
      explicit,
      participants.length ? participants : defaultParticipants(explicit, roles, preferred),
      "explicit_policy",
    );
  }
  if (participants.length) {
    const policy = required(
      policies,
      participants.length > 1 ? "debate" : "direct",
      "policy_unavailable",
    );
    return frozenRoute(policy, participants, "explicit_participants");
  }

  const words = topicWords(input.topic);
  const selected: readonly [string, ConversationRouteReason] =
    input.workflowReady === true && hasAnyPhrase(words, EXECUTE)
      ? ["orchestrate", "ready_workflow_execute"]
      : hasAnyPhrase(words, VERIFY)
        ? ["verify", "verify_intent"]
        : hasAnyPhrase(words, REVIEW)
          ? ["review", "review_intent"]
          : hasAnyPhrase(words, PLAN)
            ? ["plan", "plan_intent"]
            : hasAnyPhrase(words, DEBATE)
              ? ["debate", "debate_intent"]
              : ["direct", "direct_fallback"];
  if (selected[0] === "direct") {
    const domain = matchedDomainParticipant(input, authority, roles, preferred);
    if (domain) {
      return frozenRoute(
        required(policies, "direct", "policy_unavailable"),
        [domain],
        "domain_role_match",
      );
    }
  }
  const policy = required(policies, selected[0], "policy_unavailable");
  return frozenRoute(policy, defaultParticipants(policy, roles, preferred), selected[1]);
}
