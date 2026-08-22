import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentBinding,
  materializeAgentBinding,
  previewAgentBinding,
} from "../../agents/binding.js";
import { conversationRoleSpecs } from "../../agents/role.js";
import { ENGINES, type Engine } from "../../core.js";
import type { EngineSessionAdapterOptions } from "../../dispatch/session-types.js";
import { createEngineSessionAdapter } from "../../dispatch/session.js";
import { preflightAll } from "../../preflight.js";
import { DurableArtifactRegistry } from "../trace/artifacts.js";
import { TRACE_LIMITS, utf8Bytes } from "../trace/limits.js";
import { ensurePrivateDirectory } from "../trace/path-safety.js";
import { TraceStore, type TraceStoreOptions } from "../trace/store.js";
import { ConversationArtifactStore } from "./artifact-store.js";
import {
  type ConversationIsolationAuthority,
  bindWithIsolation,
  defaultConversationIsolationAuthority,
  withAttemptIsolation,
} from "./bootstrap-isolation.js";
import { DebateConversationPolicy } from "./debate-policy.js";
import { DirectConversationPolicy } from "./direct-policy.js";
import { OrchestrateConversationPolicy } from "./orchestrate-policy.js";
import { PlanConversationPolicy } from "./plan-policy.js";
import {
  ConversationPolicyRegistry,
  type RuntimeCreateRequest,
  type RuntimePreviewRequest,
} from "./policy-registry.js";
import { ReviewConversationPolicy, createReviewEvidenceAuthority } from "./review-policy.js";
import {
  type ConversationDomainRole,
  type ConversationEngineReadiness,
  type ConversationRoutingAuthority,
  type ConversationRoutingInput,
  routeConversation,
} from "./router.js";
import { ConversationOrchestrator } from "./service.js";
import {
  InjectedOrchestrateService,
  InjectedPlanService,
  InjectedReviewService,
  InjectedVerifyService,
  type OrchestrateLibrary,
  type PlanArtifact,
  type PlanArtifactLocator,
  type PlanLibrary,
  type ReviewEvidenceAuthority,
  type ReviewLibrary,
  type VerifyLibrary,
} from "./services.js";
import type {
  ConversationContext,
  ConversationCreateRequest,
  ConversationService,
} from "./types.js";
import { VerifyConversationPolicy } from "./verify-policy.js";

export interface ConversationBootstrapLibraries {
  plan: PlanLibrary;
  review: ReviewLibrary;
  verify: VerifyLibrary;
  orchestrate: Omit<OrchestrateLibrary, "cancel">;
}
interface RoutingContext {
  workflowReady?: boolean;
  attachments?: readonly string[];
  skillDomains?: readonly string[];
}
interface BindingFactory {
  materialize: typeof materializeAgentBinding;
  preview: typeof previewAgentBinding;
}
export interface ConversationBootstrapOptions {
  repoRoot: string;
  libraries: ConversationBootstrapLibraries;
  stateDir?: string;
  phase?: number;
  session?: EngineSessionAdapterOptions;
  mirror?: TraceStoreOptions["mirror"];
  id?: (kind: string) => string;
  now?: () => string;
  schedule?: (task: () => void) => void;
  actor?: string;
  routingContext?: (request: ConversationCreateRequest) => RoutingContext | Promise<RoutingContext>;
  readiness?: () => readonly ConversationEngineReadiness[];
  domainRoles?: readonly ConversationDomainRole[];
  registeredRoles?: readonly string[];
  /** Unit-test seam. Production always uses the canonical current-HEAD evidence checker. */
  reviewEvidenceAuthority?: ReviewEvidenceAuthority;
  bindingFactory?: BindingFactory;
  isolationAuthority?: ConversationIsolationAuthority;
}
export interface ConversationBootstrap {
  service: ConversationService;
  services: Readonly<{
    plan: InjectedPlanService;
    review: InjectedReviewService;
    verify: InjectedVerifyService;
    orchestrate: InjectedOrchestrateService;
  }>;
  authorities: Readonly<{
    artifactRegistry: DurableArtifactRegistry;
    traceStore: TraceStore;
    artifactStore: ConversationArtifactStore;
    policies: ConversationPolicyRegistry;
  }>;
}
const fail = (message: string): never => {
  throw new Error(`conversation bootstrap: ${message}`);
};

function persistedPlanLocator(store: ConversationArtifactStore): PlanArtifactLocator {
  return (context: ConversationContext): PlanArtifact | null => {
    let conversationId: string | null = context.correlation.conversation_id;
    const visited = new Set<string>();
    while (conversationId && !visited.has(conversationId) && visited.size < 64) {
      visited.add(conversationId);
      const record = store.readRecord(conversationId);
      if (!record) return null;
      const plan = record.artifacts.filter((entry) => entry.artifact_type === "plan").at(-1);
      if (plan) {
        return Object.freeze({
          artifact_id: plan.artifact_id,
          revision_id: record.manifest.revision_id,
          ref: plan.ref,
        });
      }
      conversationId = record.manifest.parent_conversation_id;
    }
    return null;
  };
}

const validEngine = (value: string): value is Engine => ENGINES.includes(value as Engine);

function explicitParticipants(request: ConversationCreateRequest) {
  return request.participants?.map((participant) => {
    const engine = participant.engine;
    if (!validEngine(engine)) fail(`unsupported engine: ${engine}`);
    return {
      roleRef: participant.role_ref,
      engine: engine as Engine,
      ...(participant.model === undefined ? {} : { model: participant.model }),
    };
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
    admitted: phase > 1 || status.engine === "claude" || status.engine === "codex",
  }));
}

function authority(
  options: ConversationBootstrapOptions,
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
  options: ConversationBootstrapOptions,
  repoRoot: string,
  phase: number,
) {
  const extra = (await options.routingContext?.(request)) ?? {};
  const input: ConversationRoutingInput = {
    topic: request.topic,
    explicitPolicy: request.policy,
    participants: explicitParticipants(request),
    workflowReady: extra.workflowReady,
    attachments: extra.attachments,
    skillDomains: extra.skillDomains,
  };
  const routeAuthority = authority(options, repoRoot, phase);
  const route = routeConversation(input, routeAuthority);
  const participants = [...route.participants];
  let evaluatorAutoAdded = false;
  if (
    route.policy === "debate" &&
    !participants.some((item) => item.roleRef === "brainstorm-evaluator")
  ) {
    const engine =
      participants[0]?.engine ??
      routeAuthority.engines.find((item) => item.ready && item.admitted)?.engine;
    participants.push({ roleRef: "brainstorm-evaluator", ...(engine ? { engine } : {}) });
    evaluatorAutoAdded = true;
  }
  if (participants.some((participant) => participant.engine === undefined)) {
    fail("no ready admitted engine");
  }
  return { route, participants, evaluatorAutoAdded };
}

function bindingInput(participant: {
  roleRef: string;
  engine?: Engine;
  model?: string;
}): AgentBinding {
  const engine = participant.engine;
  if (!engine) fail("participant engine is missing");
  return {
    roleRef: participant.roleRef,
    engine: engine as Engine,
    sessionMode: "fresh",
    ...(participant.model === undefined ? {} : { modelOverride: participant.model }),
  };
}

function requestedMaxRounds(request: ConversationCreateRequest): number {
  if (!request.topic.trim() || utf8Bytes(request.topic) > TRACE_LIMITS.maxTextBytes) {
    fail("invalid topic");
  }
  if ((request.participants?.length ?? 0) > 64) fail("too many participants");
  const maxRounds = request.max_rounds ?? 3;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > TRACE_LIMITS.maxArrayItems) {
    fail("invalid max rounds");
  }
  return maxRounds;
}

/** Compose the one production conversation authority used by CLI and HTTP adapters. */
export function createConversationBootstrap(
  options: ConversationBootstrapOptions,
): ConversationBootstrap {
  const repoRoot = realpathSync(resolve(options.repoRoot));
  const phase = options.phase ?? 3;
  if (!Number.isSafeInteger(phase) || phase < 1) fail("invalid phase");
  const root = ensurePrivateDirectory(
    resolve(options.stateDir ?? join(repoRoot, ".vibeflow", "conversation")),
    fail,
  );
  const artifactRegistry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
  const traceStore = new TraceStore({
    dir: join(root, "trace"),
    artifactRegistry,
    ...(options.mirror ? { mirror: options.mirror } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const artifactStore = new ConversationArtifactStore({ dir: join(root, "artifacts") });
  const isolationAuthority = options.isolationAuthority ?? defaultConversationIsolationAuthority;
  const bindingIsolation =
    options.bindingFactory && !options.isolationAuthority ? undefined : isolationAuthority;
  const sessionAdapter = withAttemptIsolation(
    createEngineSessionAdapter({
      ...options.session,
      evidenceRoot: options.session?.evidenceRoot ?? join(root, "attempts"),
    }),
    isolationAuthority,
    repoRoot,
  );
  const locatePlan = persistedPlanLocator(artifactStore);
  const plan = new InjectedPlanService({ ...options.libraries.plan, locate: locatePlan });
  const review = new InjectedReviewService(
    options.libraries.review,
    options.reviewEvidenceAuthority ?? createReviewEvidenceAuthority(repoRoot),
  );
  const verify = new InjectedVerifyService(options.libraries.verify);
  const serviceHolder: { current?: ConversationOrchestrator } = {};
  const orchestrate = new InjectedOrchestrateService(
    {
      ...options.libraries.orchestrate,
      cancel: (command) => {
        const authority = serviceHolder.current;
        if (!authority) fail("cancellation authority is not ready");
        return (authority as ConversationOrchestrator).cancelOperation(command);
      },
    },
    options.actor,
  );
  const reviewPolicy = new ReviewConversationPolicy(review, locatePlan);
  const verifyPolicy = new VerifyConversationPolicy(verify, locatePlan);
  const orchestratePolicy = new OrchestrateConversationPolicy(orchestrate);
  const planPolicy = new PlanConversationPolicy(plan, locatePlan, {
    orchestrate: orchestratePolicy,
    review: reviewPolicy,
    verify: verifyPolicy,
  });
  const policies = new ConversationPolicyRegistry([
    new DirectConversationPolicy(),
    new DebateConversationPolicy(),
    planPolicy,
    reviewPolicy,
    verifyPolicy,
    orchestratePolicy,
  ]);
  const binder = options.bindingFactory ?? {
    materialize: materializeAgentBinding,
    preview: previewAgentBinding,
  };
  const resolveCreateRequest = async (
    request: ConversationCreateRequest,
  ): Promise<RuntimeCreateRequest> => {
    const maxRounds = requestedMaxRounds(request);
    const selection = await selectedRoute(request, options, repoRoot, phase);
    return {
      topic: request.topic,
      policy: selection.route.policy,
      maxRounds,
      evaluatorAutoAdded: selection.evaluatorAutoAdded,
      repoRoot,
      phase,
      bindings: await Promise.all(
        selection.participants.map(async (participant, index) => {
          const input = bindingInput(participant);
          return {
            participantId: `participant-${index + 1}`,
            input,
            materialized: await bindWithIsolation(
              bindingIsolation,
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
    const maxRounds = requestedMaxRounds(request);
    const selection = await selectedRoute(request, options, repoRoot, phase);
    return {
      topic: request.topic,
      policy: selection.route.policy,
      maxRounds,
      evaluatorAutoAdded: selection.evaluatorAutoAdded,
      repoRoot,
      phase,
      bindings: await Promise.all(
        selection.participants.map(async (participant, index) => {
          const input = bindingInput(participant);
          return {
            participantId: `participant-${index + 1}`,
            input,
            preview: await bindWithIsolation(
              bindingIsolation,
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
  const service = new ConversationOrchestrator({
    traceStore,
    artifactRegistry,
    artifactStore,
    sessionAdapter,
    policies,
    resolveCreateRequest,
    resolveDryRunRequest,
    rehydrateBinding: (binding, manifest) =>
      bindWithIsolation(
        bindingIsolation,
        manifest.repo_root,
        manifest.phase,
        manifest.task_text,
        (bindingOptions) => binder.materialize(binding.input, bindingOptions),
      ),
    ...(options.id ? { id: options.id } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  serviceHolder.current = service;
  return Object.freeze({
    service,
    services: Object.freeze({ plan, review, verify, orchestrate }),
    authorities: Object.freeze({ artifactRegistry, traceStore, artifactStore, policies }),
  });
}

export function createConversationService(
  options: ConversationBootstrapOptions,
): ConversationService {
  return createConversationBootstrap(options).service;
}
