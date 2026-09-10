import type {
  AgentBinding,
  MaterializeAgentBindingOptions,
  MaterializedAgentBinding,
  PreviewAgentBinding,
  ResolvedAgentBinding,
} from "../../agents/binding.js";
import { ALL_ROLE_NAMES } from "../../agents/role-templates.js";
import { ENGINES } from "../../core/agent-contract.js";
import {
  supportsConversationRoleAuthority,
  supportsPhaseOneConversationAuthority,
} from "../../dispatch/session-contract.js";
import { checkEngineAsync, getCachedProbe, preflightAll, setCachedProbe } from "../../preflight.js";
import { type ConversationIsolationAuthority, bindWithIsolation } from "./bootstrap-isolation.js";
import {
  conversationBindingInput,
  explicitConversationParticipants,
  requestedConversationMaxRounds,
} from "./bootstrap-request.js";
import { AGENT_ACTION_CANDIDATE_ROLE } from "./conversation-agent-action-candidate-contract.js";
import { materializeConversationHostTools } from "./conversation-host-tool-policy.js";
import { CONVERSATION_POLICIES } from "./conversation-policy-contract.js";
import { CONVERSATION_POLICY } from "./conversation-policy-contract.js";
import type { RuntimeCreateRequest, RuntimePreviewRequest } from "./policy-registry.js";
import { coordinateTopologyDiagnostic } from "./router-helpers.js";
import {
  type ConversationDomainRole,
  type ConversationEngineReadiness,
  type ConversationRoutingAuthority,
  type ConversationRoutingInput,
  routeConversation,
} from "./router.js";
import type { ConversationCreateRequest, ConversationHostToolV1 } from "./types.js";

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
  materialize(
    binding: AgentBinding,
    options: MaterializeAgentBindingOptions,
  ): MaterializedAgentBinding | Promise<MaterializedAgentBinding>;
  preview(binding: AgentBinding, options: MaterializeAgentBindingOptions): PreviewAgentBinding;
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

function resolvedHostTools(participant: {
  roleRef: string;
  hostTools?: readonly ConversationHostToolV1[];
}): ConversationHostToolV1[] {
  return materializeConversationHostTools({
    roleRef: participant.roleRef,
    ...(participant.hostTools !== undefined ? { explicit: participant.hostTools } : {}),
  });
}

/** Testable projection for the production no-probe readiness default. */
export function defaultConversationReadiness(
  repoRoot: string,
  phase: number,
): ConversationEngineReadiness[] {
  return preflightAll([...ENGINES], { probe: false, cacheKey: repoRoot }).map((status) => ({
    engine: status.engine,
    ready: status.level === "ready",
    admitted:
      supportsConversationRoleAuthority(status.engine) &&
      (phase > 1 || supportsPhaseOneConversationAuthority(status.engine)),
  }));
}

/**
 * Live readiness for conversation routing: the auto engine selection must only
 * admit engines that actually respond to a probe, otherwise a preferred engine
 * with a revoked/expired credential (e.g. claude 401) is chosen and every
 * create fails with "conversation binding requires a verified engine". Uses the
 * shared probe cache (60s TTL) so repeated creates stay cheap; the first probe
 * after TTL expiry bounds each engine to `LIVE_PROBE_TIMEOUT_MS` in parallel.
 */
export async function liveConversationReadiness(
  repoRoot: string,
  phase: number,
): Promise<ConversationEngineReadiness[]> {
  // Separate cache lane (["live"] args) so static probe:false results (which
  // stamp every installed engine "ready") can never satisfy a live probe request.
  const LIVE_READINESS_CACHE_LANE = ["live"] as const;
  const LIVE_PROBE_TIMEOUT_MS = 10_000;
  const statuses = await Promise.all(
    [...ENGINES].map(async (engine) => {
      const cached = getCachedProbe(engine, repoRoot, LIVE_READINESS_CACHE_LANE);
      if (cached) return cached;
      const fresh = await checkEngineAsync(engine, {
        cacheKey: repoRoot,
        probeTimeoutMs: LIVE_PROBE_TIMEOUT_MS,
      });
      setCachedProbe(engine, repoRoot, LIVE_READINESS_CACHE_LANE, fresh);
      return fresh;
    }),
  );
  return statuses.map((status) => ({
    engine: status.engine,
    ready: status.level === "ready",
    admitted:
      supportsConversationRoleAuthority(status.engine) &&
      (phase > 1 || supportsPhaseOneConversationAuthority(status.engine)),
  }));
}

function routingAuthority(
  options: ConversationRequestResolutionOptions,
  roles: readonly string[],
  engines: readonly ConversationEngineReadiness[],
): ConversationRoutingAuthority {
  return {
    registeredPolicies: [...CONVERSATION_POLICIES],
    registeredRoles: [...new Set(roles)],
    engines: [...engines],
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
  const authority = routingAuthority(
    options,
    [...ALL_ROLE_NAMES, ...(options.registeredRoles ?? [])],
    await (options.readiness ? options.readiness() : liveConversationReadiness(repoRoot, phase)),
  );
  const route = routeConversation(input, authority);
  const participants = route.participants.map((participant, index) => {
    const requested = request.participants?.[index];
    return {
      ...participant,
      ...(route.policy === CONVERSATION_POLICY.COORDINATE
        ? { hostTools: [] }
        : requested?.host_tools !== undefined
          ? { hostTools: [...requested.host_tools] }
          : {}),
    };
  });
  let evaluatorAutoAdded = false;
  if (
    route.policy === CONVERSATION_POLICY.DEBATE &&
    !participants.some((item) => item.roleRef === AGENT_ACTION_CANDIDATE_ROLE.BRAINSTORM_EVALUATOR)
  ) {
    const engine =
      participants[0]?.engine ??
      authority.engines.find((item) => item.ready && item.admitted)?.engine;
    participants.push({
      roleRef: AGENT_ACTION_CANDIDATE_ROLE.BRAINSTORM_EVALUATOR,
      ...(engine ? { engine } : {}),
    });
    evaluatorAutoAdded = true;
  }
  if (participants.some((participant) => participant.engine === undefined)) {
    fail("no ready admitted engine");
  }
  return { route, participants, evaluatorAutoAdded };
}

interface ResolvedBootstrapBinding {
  readonly participantId: string;
  readonly input: AgentBinding;
  readonly hostTools?: readonly ConversationHostToolV1[];
  readonly resolved: ResolvedAgentBinding;
  readonly readiness?: Readonly<{ engine_available: boolean; model_valid: boolean }>;
}

function assertCoordinateBindings(policy: string, bindings: readonly ResolvedBootstrapBinding[]) {
  if (policy !== CONVERSATION_POLICY.COORDINATE) return;
  const diagnostic = coordinateTopologyDiagnostic({
    policy,
    bindings: bindings.map(({ resolved }) => resolved),
    expectedBindings: bindings.map(({ input }) => ({
      roleRef: input.roleRef,
      engine: input.engine,
    })),
    participantIds: bindings.map(({ participantId }) => participantId),
    hostTools: bindings.map(({ hostTools }) => hostTools),
    ...(bindings.every(({ readiness }) => readiness !== undefined)
      ? {
          bindingReadiness: bindings.map(
            ({ readiness }) => readiness as NonNullable<typeof readiness>,
          ),
        }
      : {}),
  });
  if (diagnostic) fail(diagnostic);
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
    const bindings = await Promise.all(
      selection.participants.map(async (participant, index) => {
        const input = conversationBindingInput(participant);
        return {
          participantId: `participant-${index + 1}`,
          input,
          hostTools: resolvedHostTools(participant),
          materialized: await bindWithIsolation(
            isolationAuthority,
            repoRoot,
            phase,
            request.topic,
            (bindingOptions) => binder.materialize(input, bindingOptions),
          ),
        };
      }),
    );
    assertCoordinateBindings(
      selection.route.policy,
      bindings.map((binding) => ({ ...binding, resolved: binding.materialized.resolved })),
    );
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
      bindings,
    };
  };
  const resolveDryRunRequest = async (
    request: ConversationCreateRequest,
  ): Promise<RuntimePreviewRequest> => {
    const maxRounds = requestedConversationMaxRounds(request);
    const selection = await selectedRoute(request, options, repoRoot, phase);
    const bindings = await Promise.all(
      selection.participants.map(async (participant, index) => {
        const input = conversationBindingInput(participant);
        const preview = await bindWithIsolation(
          isolationAuthority,
          repoRoot,
          phase,
          request.topic,
          (bindingOptions) => binder.preview(input, bindingOptions),
        );
        return {
          participantId: `participant-${index + 1}`,
          input,
          hostTools: resolvedHostTools(participant),
          preview,
        };
      }),
    );
    assertCoordinateBindings(
      selection.route.policy,
      bindings.map((binding) => ({
        ...binding,
        resolved: binding.preview.resolved,
        readiness: {
          engine_available: binding.preview.engineAvailable,
          model_valid: binding.preview.modelValid,
        },
      })),
    );
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
      bindings,
    };
  };
  return Object.freeze({ resolveCreateRequest, resolveDryRunRequest });
}
