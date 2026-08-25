import type { materializeAgentBinding, previewAgentBinding } from "../../agents/binding.js";
import { conversationRoleSpecs } from "../../agents/role.js";
import { ENGINES } from "../../core.js";
import { preflightAll } from "../../preflight.js";
import { type ConversationIsolationAuthority, bindWithIsolation } from "./bootstrap-isolation.js";
import {
  conversationBindingInput,
  explicitConversationParticipants,
  requestedConversationMaxRounds,
} from "./bootstrap-request.js";
import type { RuntimeCreateRequest, RuntimePreviewRequest } from "./policy-registry.js";
import {
  type ConversationDomainRole,
  type ConversationEngineReadiness,
  type ConversationRoutingAuthority,
  type ConversationRoutingInput,
  routeConversation,
} from "./router.js";
import type { ConversationCreateRequest } from "./types.js";

export interface ConversationRoutingContext {
  workflowReady?: boolean;
  attachments?: readonly string[];
  skillDomains?: readonly string[];
}

export interface ConversationRequestResolutionOptions {
  routingContext?: (
    request: ConversationCreateRequest,
  ) => ConversationRoutingContext | Promise<ConversationRoutingContext>;
  readiness?: () => readonly ConversationEngineReadiness[];
  domainRoles?: readonly ConversationDomainRole[];
  registeredRoles?: readonly string[];
}

export interface ConversationBindingFactory {
  materialize: typeof materializeAgentBinding;
  preview: typeof previewAgentBinding;
}

interface ConversationRequestResolutionDependencies {
  options: ConversationRequestResolutionOptions;
  repoRoot: string;
  phase: number;
  binder: ConversationBindingFactory;
  isolationAuthority?: ConversationIsolationAuthority;
}

const fail = (message: string): never => {
  throw new Error(`conversation bootstrap: ${message}`);
};

/** Testable projection for the production no-probe readiness default. */
export function defaultConversationReadiness(
  repoRoot: string,
  phase: number,
): ConversationEngineReadiness[] {
  return preflightAll([...ENGINES], { probe: false, cacheKey: repoRoot }).map((status) => ({
    engine: status.engine,
    ready: status.level === "ready",
    admitted: phase > 1 || status.engine === "claude" || status.engine === "codex",
  }));
}

function routingAuthority(
  options: ConversationRequestResolutionOptions,
  repoRoot: string,
  phase: number,
): ConversationRoutingAuthority {
  const roles = [
    ...conversationRoleSpecs().map((role) => role.name),
    ...(options.registeredRoles ?? []),
  ];
  return {
    registeredPolicies: ["direct", "debate", "plan", "review", "verify", "orchestrate"],
    registeredRoles: [...new Set(roles)],
    engines: [...(options.readiness?.() ?? defaultConversationReadiness(repoRoot, phase))],
    domainRoles: [...(options.domainRoles ?? [])],
  };
}

async function selectedRoute(
  request: ConversationCreateRequest,
  options: ConversationRequestResolutionOptions,
  repoRoot: string,
  phase: number,
) {
  const extra = (await options.routingContext?.(request)) ?? {};
  const input: ConversationRoutingInput = {
    topic: request.topic,
    explicitPolicy: request.policy,
    participants: explicitConversationParticipants(request),
    workflowReady: extra.workflowReady,
    attachments: extra.attachments,
    skillDomains: extra.skillDomains,
  };
  const authority = routingAuthority(options, repoRoot, phase);
  const route = routeConversation(input, authority);
  const participants = [...route.participants];
  let evaluatorAutoAdded = false;
  if (
    route.policy === "debate" &&
    !participants.some((item) => item.roleRef === "brainstorm-evaluator")
  ) {
    const engine =
      participants[0]?.engine ??
      authority.engines.find((item) => item.ready && item.admitted)?.engine;
    participants.push({ roleRef: "brainstorm-evaluator", ...(engine ? { engine } : {}) });
    evaluatorAutoAdded = true;
  }
  if (participants.some((participant) => participant.engine === undefined)) {
    fail("no ready admitted engine");
  }
  return { route, participants, evaluatorAutoAdded };
}

export function createConversationRequestResolvers({
  options,
  repoRoot,
  phase,
  binder,
  isolationAuthority,
}: ConversationRequestResolutionDependencies): Readonly<{
  resolveCreateRequest(request: ConversationCreateRequest): Promise<RuntimeCreateRequest>;
  resolveDryRunRequest(request: ConversationCreateRequest): Promise<RuntimePreviewRequest>;
}> {
  const resolveCreateRequest = async (
    request: ConversationCreateRequest,
  ): Promise<RuntimeCreateRequest> => {
    const maxRounds = requestedConversationMaxRounds(request);
    const selection = await selectedRoute(request, options, repoRoot, phase);
    return {
      topic: request.topic,
      policy: selection.route.policy,
      maxRounds,
      evaluatorAutoAdded: selection.evaluatorAutoAdded,
      repoRoot,
      phase,
      ...(request.private_file_range
        ? { private_file_range: structuredClone(request.private_file_range) }
        : {}),
      bindings: await Promise.all(
        selection.participants.map(async (participant, index) => {
          const input = conversationBindingInput(participant);
          return {
            participantId: `participant-${index + 1}`,
            input,
            materialized: await bindWithIsolation(
              isolationAuthority,
              repoRoot,
              phase,
              request.topic,
              (bindingOptions) => binder.materialize(input, bindingOptions),
            ),
          };
        }),
      ),
    };
  };
  const resolveDryRunRequest = async (
    request: ConversationCreateRequest,
  ): Promise<RuntimePreviewRequest> => {
    const maxRounds = requestedConversationMaxRounds(request);
    const selection = await selectedRoute(request, options, repoRoot, phase);
    return {
      topic: request.topic,
      policy: selection.route.policy,
      maxRounds,
      evaluatorAutoAdded: selection.evaluatorAutoAdded,
      repoRoot,
      phase,
      ...(request.private_file_range
        ? { private_file_range: structuredClone(request.private_file_range) }
        : {}),
      bindings: await Promise.all(
        selection.participants.map(async (participant, index) => {
          const input = conversationBindingInput(participant);
          return {
            participantId: `participant-${index + 1}`,
            input,
            preview: await bindWithIsolation(
              isolationAuthority,
              repoRoot,
              phase,
              request.topic,
              (bindingOptions) => binder.preview(input, bindingOptions),
            ),
          };
        }),
      ),
    };
  };
  return Object.freeze({ resolveCreateRequest, resolveDryRunRequest });
}
