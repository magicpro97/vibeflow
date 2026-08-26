import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ActionAuthorityStoreOptions } from "../../actions/index.js";
import { materializeAgentBinding, previewAgentBinding } from "../../agents/binding.js";
import type { EngineSessionAdapterOptions } from "../../dispatch/session-types.js";
import { createEngineSessionAdapter } from "../../dispatch/session.js";
import type { DurableArtifactRegistry } from "../trace/artifacts.js";
import { ensurePrivateDirectory } from "../trace/path-safety.js";
import type { TraceStore, TraceStoreOptions } from "../trace/store.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import {
  type ConversationIsolationAuthority,
  bindWithIsolation,
  defaultConversationIsolationAuthority,
  withAttemptIsolation,
} from "./bootstrap-isolation.js";
import { createConversationPersistence } from "./bootstrap-persistence.js";
import { persistedPlanLocator } from "./bootstrap-plan-locator.js";
import {
  type ConversationBindingFactory,
  type ConversationRequestResolutionOptions,
  createConversationRequestResolvers,
} from "./bootstrap-request-resolution.js";
import { createConversationSocialAuthority } from "./bootstrap-social-authority.js";
import { deriveConversationBrowserKey } from "./browser-authority-key.js";
import { registerCapabilityConversationProposalBase } from "./capability-proposal-base.js";
import { CatalogCursorCodec } from "./catalog-cursor.js";
import type { ConversationActionDomainPlannerExecutorV1 } from "./conversation-action-domain.js";
import type { ConversationActionService } from "./conversation-action-service.js";
import { ConversationAgentActionCandidateAuthorityV1 } from "./conversation-agent-action-candidate-authority.js";
import { createConversationBrowserAuthorities } from "./conversation-browser-authorities.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { ConversationMessageQueueRuntimeV1 } from "./conversation-message-queue-runtime.js";
import { ConversationPrivateContextBrokerV1 } from "./conversation-private-context-broker-store.js";
import { ConversationUserMessageAuthorityV1 } from "./conversation-user-message-authority.js";
import { DebateConversationPolicy } from "./debate-policy.js";
import { DirectConversationPolicy } from "./direct-policy.js";
import { fail as rejectConversationState } from "./fold-validation.js";
import { ConversationLineageService } from "./lineage-service.js";
import { OrchestrateConversationPolicy } from "./orchestrate-policy.js";
import { PlanConversationPolicy } from "./plan-policy.js";
import { ConversationPolicyRegistry } from "./policy-registry.js";
import { ReviewConversationPolicy, createReviewEvidenceAuthority } from "./review-policy.js";
import { ConversationOrchestrator } from "./service.js";
import {
  InjectedOrchestrateService,
  InjectedPlanService,
  InjectedReviewService,
  InjectedVerifyService,
  type OrchestrateLibrary,
  type PlanLibrary,
  type ReviewEvidenceAuthority,
  type ReviewLibrary,
  type VerifyLibrary,
} from "./services.js";
import type { ConversationService } from "./types.js";
import { VerifyConversationPolicy } from "./verify-policy.js";

export interface ConversationBootstrapLibraries {
  plan: PlanLibrary;
  review: ReviewLibrary;
  verify: VerifyLibrary;
  orchestrate: Omit<OrchestrateLibrary, "cancel">;
}
export interface ConversationBootstrapOptions extends ConversationRequestResolutionOptions {
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
  /** Unit-test seam. Production always uses the canonical current-HEAD evidence checker. */
  reviewEvidenceAuthority?: ReviewEvidenceAuthority;
  bindingFactory?: ConversationBindingFactory;
  isolationAuthority?: ConversationIsolationAuthority;
  actionDomains?: readonly ConversationActionDomainPlannerExecutorV1[];
  actionDomainFactories?: readonly ((
    actions: ConversationActionService,
  ) => ConversationActionDomainPlannerExecutorV1)[];
  /** Fault-injection seam for durable ActionAuthorityStore recovery tests. */
  actionAuthorityFault?: ActionAuthorityStoreOptions["fault"];
  /** Async materialization barrier used only by crash/concurrency authority tests. */
  agentActionCandidateBarrier?: (input: {
    point: "after-proposal-materialized";
    conversation_id: string;
  }) => Promise<void>;
}
export interface ConversationBootstrap {
  service: ConversationOrchestrator;
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
    homeAuthorities: ConversationHomeAuthorities;
    policies: ConversationPolicyRegistry;
    agentActionCandidates: ConversationAgentActionCandidateAuthorityV1;
    messageQueue: ConversationMessageQueueRuntimeV1;
    privateContextBroker: ConversationPrivateContextBrokerV1;
    browser: ReturnType<typeof createConversationBrowserAuthorities>;
  }>;
}
export { defaultConversationReadiness } from "./bootstrap-request-resolution.js";

/** Compose the one production conversation authority used by CLI and HTTP adapters. */
export function createConversationBootstrap(
  options: ConversationBootstrapOptions,
): ConversationBootstrap {
  const repoRoot = realpathSync(resolve(options.repoRoot));
  const phase = options.phase ?? 3;
  if (!Number.isSafeInteger(phase) || phase < 1)
    throw new Error("conversation bootstrap: invalid phase");
  let root: string;
  try {
    root = ensurePrivateDirectory(
      resolve(options.stateDir ?? join(repoRoot, ".vibeflow", "conversation")),
      rejectConversationState,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unsafe state directory";
    throw new Error(`conversation bootstrap: ${detail}`, { cause: error });
  }
  const {
    artifactRegistry,
    traceStore,
    artifactStore,
    homeAuthorities,
    artifactRoot,
    traceRoot,
    browserAuthorityKey,
  } = createConversationPersistence({
    root,
    ...(options.mirror ? { mirror: options.mirror } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.actionAuthorityFault ? { actionFault: options.actionAuthorityFault } : {}),
  });
  const socialAuthority = createConversationSocialAuthority({
    artifactRoot,
    traceRoot,
    artifactRegistry,
    home: homeAuthorities,
  });
  const now = options.now ?? (() => new Date().toISOString());
  const privateContextBroker = new ConversationPrivateContextBrokerV1({
    artifactRoot,
    repoRoot,
    now,
  });
  const queueLineage = new ConversationLineageService({
    artifactRoot,
    traceRoot,
    scopeId: "vf-local-conversations",
    cursorCodec: new CatalogCursorCodec(
      deriveConversationBrowserKey(browserAuthorityKey, "message-queue-lineage"),
    ),
    publishedRevisionTransitions: () => homeAuthorities.publishedRevisionTransitions(),
    revisionRecoveryAuthority: (operationId) => {
      const operation = homeAuthorities.revisions.readOperation(operationId);
      const revision_plan = homeAuthorities.revisions.readPlan(operationId);
      return operation && revision_plan ? { operation, revision_plan } : null;
    },
    reservationHistory: ({ root_session_id }) =>
      homeAuthorities.lineage.readReservationHistory(root_session_id),
    headTransitions: () => homeAuthorities.headTransitions.readAll(),
    actionAuthority: homeAuthorities.reviewedActionAuthority(),
  });
  const messageQueueUserAuthority = new ConversationUserMessageAuthorityV1({
    lineage: queueLineage,
    artifactRegistry,
    artifactStore,
  });
  const agentActionCandidates = new ConversationAgentActionCandidateAuthorityV1({
    artifactRoot,
    traceRoot,
    home: homeAuthorities,
    ...(options.agentActionCandidateBarrier
      ? { barrier: options.agentActionCandidateBarrier }
      : {}),
  });
  const isolationAuthority = options.isolationAuthority ?? defaultConversationIsolationAuthority;
  const bindingIsolation =
    options.bindingFactory && !options.isolationAuthority ? undefined : isolationAuthority;
  const sessionAdapter = withAttemptIsolation(
    createEngineSessionAdapter({
      ...options.session,
      evidenceRoot: options.session?.evidenceRoot ?? join(root, "attempts"),
      privatePromptFileRoot: join(root, "session-prompts"),
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
      cancel: (command) =>
        (serviceHolder.current as ConversationOrchestrator).cancelOperation(command),
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
  const { resolveCreateRequest, resolveDryRunRequest } = createConversationRequestResolvers({
    options,
    repoRoot,
    phase,
    binder,
    ...(bindingIsolation ? { isolationAuthority: bindingIsolation } : {}),
  });
  let recordConversationSource: ((conversationId: string, recordedAt: string) => void) | null =
    null;
  const service = new ConversationOrchestrator({
    traceStore,
    artifactRegistry,
    artifactStore,
    artifactRoot,
    traceRoot,
    homeAuthorities,
    socialAuthority,
    agentActionCandidates,
    privateContextBroker,
    messageQueueUserAuthority,
    sessionAdapter,
    policies,
    onConversationSourceCommitted: (event) =>
      recordConversationSource?.(event.conversation_id, event.ts),
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
  if (!service.messageQueue)
    throw new Error("conversation bootstrap: message queue authority is unavailable");
  registerCapabilityConversationProposalBase({
    actions: homeAuthorities.actions,
    artifactRoot,
    traceRoot,
    home: homeAuthorities,
  });
  homeAuthorities.actions.registerAgentProposalReviewValidator(
    ({ proposal, now, phase, approval_id }) =>
      agentActionCandidates.assertReviewSource(proposal, now, phase, approval_id),
  );
  const additionalActionDomains = [
    ...(options.actionDomains ?? []),
    ...(options.actionDomainFactories ?? []).map((factory) => factory(homeAuthorities.actions)),
  ];
  const browser = createConversationBrowserAuthorities({
    artifactRoot,
    traceRoot,
    traceStore,
    browserAuthorityKey,
    artifactRegistry,
    artifactStore,
    home: homeAuthorities,
    service,
    ...(additionalActionDomains.length > 0 ? { additionalActionDomains } : {}),
  });
  agentActionCandidates.bind(browser.actions);
  recordConversationSource = (conversationId, recordedAt) =>
    browser.catalog.recordConversationSourceCommitted(conversationId, recordedAt);
  return Object.freeze({
    service,
    services: Object.freeze({ plan, review, verify, orchestrate }),
    authorities: Object.freeze({
      artifactRegistry,
      traceStore,
      artifactStore,
      homeAuthorities,
      policies,
      agentActionCandidates,
      messageQueue: service.messageQueue,
      privateContextBroker,
      browser,
    }),
  });
}

export function createConversationService(
  options: ConversationBootstrapOptions,
): ConversationService {
  return createConversationBootstrap(options).service;
}
