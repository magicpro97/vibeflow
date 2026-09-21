import type { CapabilityConversationActionDomainV1 } from "../capabilities/action-domain/domain-handler.js";
import {
  type CapabilityRuntimeFactoryOptionsV1,
  productionCapabilityRuntimeV1,
} from "../capabilities/runtime-factory.js";
import { type Engine, cwd } from "../core.js";
import { ConversationAskCompatibilityV1 } from "../orchestrator/conversation/conversation-ask-compatibility.js";
import { ConversationHomeCreateBrokerV1 } from "../orchestrator/conversation/conversation-home-create-authority.js";
import { createPrivateFileRangeHandoffId } from "../orchestrator/conversation/private-file-range-staging-store.js";
import type {
  Classification,
  ClassificationInput,
  ClassifierProject,
} from "../orchestrator/conversation/project-classifier.js";
import {
  DEFAULT_PROJECT_CLASSIFICATION_SETTINGS,
  type ProjectClassificationSettings,
  resolveProjectClassificationEngine,
} from "../project-classification-settings.js";
import {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
} from "../server/conversation-auth.js";
import { isConversationLoopbackHost } from "../server/conversation-host.js";
import type { ConversationMessageQueueHttpAuthorityV1 } from "../server/conversation-message-queue-route.js";
import type { ConversationHttpAuthority } from "../server/conversation-route.js";
import { readSettings } from "../settings.js";
import {
  type ProjectClassifierRuntimeSeams,
  projectClassifier,
} from "../skills/project-classifier-runtime.js";
import { type ConversationCommandDeps, conversationBootstrap } from "./_shared.js";

const AUTHORITIES = new Map<string, ConversationHttpAuthority>();

/** The registry fields the classify join reads: the classifier's catalog row plus its engine. */
type ClassifierRegistryRow = ClassifierProject & { readonly engine: { readonly cli: Engine } };

/** The classifier factory, as a seam: production is {@link projectClassifier}, tests spy on it. */
export type ConversationProjectClassifierFactory = (
  projects: readonly ClassifierProject[],
  seams?: ProjectClassifierRuntimeSeams,
) => { classify(input: ClassificationInput): Promise<Classification> };

/**
 * The classify join: one registry snapshot plus the stored policy → the tier ladder the route
 * runs, with the resolved engine forwarded into the classifier's AI seam.
 *
 * It is a named function because this join is the line no test could see: the engine resolution
 * (`test/project-classifier-runtime.test.ts`) and the seam's own `engine` spread (same file) are
 * both pinned, so replacing the call below with `projectClassifier(projects, {})` left every one
 * of the 8856 tests green. `factory` is the seam that makes the join observable.
 */
export function buildConversationProjectClassifier(
  projects: readonly ClassifierRegistryRow[],
  policy: {
    readonly settings: ProjectClassificationSettings;
    readonly project_id?: string | undefined;
  },
  factory: ConversationProjectClassifierFactory = projectClassifier,
): { classify(input: ClassificationInput): Promise<Classification> } {
  const project =
    policy.project_id === undefined
      ? undefined
      : projects.find((row) => row.id === policy.project_id);
  // Precedence lives in the settings module: project override, then the global block, then
  // "unset" — which must stay an absent key so the seam keeps its own fallback.
  const engine = resolveProjectClassificationEngine({
    settings: policy.settings,
    ...(project === undefined ? {} : { project }),
  });
  return factory(projects, { ...(engine === undefined ? {} : { engine }) });
}

export function buildConversationHttpAuthority(
  deps: ConversationCommandDeps = {},
  host?: string,
  base = cwd(),
  capability: Omit<CapabilityRuntimeFactoryOptionsV1, "projectRoot"> = {},
): ConversationHttpAuthority {
  const loopback = isConversationLoopbackHost(host ?? "127.0.0.1");
  const key = `${base}:${loopback ? "loopback" : "lan"}`;
  const cacheable =
    !deps.service && !deps.createService && !deps.bootstrap && Object.keys(capability).length === 0;
  if (cacheable) {
    const cached = AUTHORITIES.get(key);
    if (cached) return cached;
  }
  const existingFactories = deps.bootstrap?.actionDomainFactories ?? [];
  const runtime = productionCapabilityRuntimeV1({ ...capability, projectRoot: base });
  let capabilityDomain: CapabilityConversationActionDomainV1 | null = null;
  const bootstrap = conversationBootstrap(
    {
      ...deps,
      bootstrap: {
        ...deps.bootstrap,
        actionDomainFactories: [
          ...existingFactories,
          (actions) => {
            capabilityDomain = runtime.conversationActionDomain(actions);
            return capabilityDomain;
          },
        ],
      },
    },
    base,
  );
  const composedCapabilityDomain = capabilityDomain as CapabilityConversationActionDomainV1 | null;
  if (!composedCapabilityDomain) throw new Error("capability action domain composition failed");
  const homeCreate = new ConversationHomeCreateBrokerV1(
    bootstrap.authorities.artifactStore.rootPath(),
    bootstrap.authorities.homeAuthorities.now,
    bootstrap.authorities.privateContextBroker,
    bootstrap.authorities.projects,
  );
  const messageQueue: ConversationMessageQueueHttpAuthorityV1["queue"] = {
    assertRoot: (rootSessionId: string) => {
      bootstrap.authorities.messageQueue.assertRoot(rootSessionId);
    },
    snapshot: (rootSessionId: string) => bootstrap.authorities.messageQueue.snapshot(rootSessionId),
    enqueue: (input: Parameters<typeof bootstrap.authorities.messageQueue.enqueue>[0]) =>
      bootstrap.authorities.messageQueue.enqueue(input),
    edit: (input: Parameters<typeof bootstrap.authorities.messageQueue.edit>[0]) =>
      bootstrap.authorities.messageQueue.edit(input),
    item: (rootSessionId: string, queueItemId: string) =>
      bootstrap.authorities.messageQueue.item(rootSessionId, queueItemId),
    stageMessagePrivateContext: (input) =>
      bootstrap.authorities.privateContextBroker.stageMessage({
        ...input,
        resolve_authority: () =>
          bootstrap.authorities.messageQueue.resolveAuthority(input.root_session_id),
      }),
    discardMessagePrivateContext: (input) =>
      bootstrap.authorities.privateContextBroker.mutations.discardMessage(input),
    stageDraftPrivateContext: (input) =>
      bootstrap.authorities.privateContextBroker.stageDraft(input),
    discardDraftPrivateContext: (input) =>
      bootstrap.authorities.privateContextBroker.mutations.discardDraft(input),
  };
  const askCompatibility = new ConversationAskCompatibilityV1({
    privateContext: bootstrap.authorities.privateContextBroker,
    homeCreate,
    startAllocated: (input) => bootstrap.service.startAllocated(input),
    queue: bootstrap.authorities.messageQueue,
  });
  const authority = {
    service: bootstrap.service,
    sessions: new ConversationSessionAuthority({ loopback }),
    streamTokens: new ConversationStreamTokenAuthority(),
    privateFileRanges: {
      createId: () => createPrivateFileRangeHandoffId(),
      stage: (input) => bootstrap.authorities.homeAuthorities.privateFileRanges.stage(input),
    },
    artifacts: {
      ancestry: bootstrap.authorities.browser.artifactResolver,
      store: bootstrap.authorities.artifactStore,
    },
    browser: {
      ...bootstrap.authorities.browser,
      legacyAdopt: {
        inspect: (input) => composedCapabilityDomain.inspectAdoptCandidates(input),
      },
      messageQueue,
      // The rail's divider labels and the settings panel's override rows read this registry;
      // `moveProject` is the chip's confirm and re-binds the active revision through the same
      // catalog notifier a committed message uses.
      projects: {
        listProjects: () => bootstrap.authorities.projects.list(),
        updateProject: ({ project_id, engine }) =>
          bootstrap.authorities.projects.update(project_id, { engine }),
        moveProject: bootstrap.authorities.rebindConversationProject,
        // The AI tier runs on stored policy: the conversation's own project engine override, then
        // the global classifier block, then away from both — so an edited project engine or a
        // settings save reaches the next verdict without a restart. The join itself lives in
        // `buildConversationProjectClassifier` so it is observable in unit tests.
        classify: async ({ message, repo_root, project_id }) =>
          buildConversationProjectClassifier(bootstrap.authorities.projects.list(), {
            settings:
              readSettings(base).projectClassification ?? DEFAULT_PROJECT_CLASSIFICATION_SETTINGS,
            ...(project_id === undefined ? {} : { project_id }),
          }).classify({
            message,
            ...(repo_root === undefined ? {} : { repo_root }),
          }),
      },
    },
    homeCreate: {
      create: async ({ principal_digest, request }) => {
        const prepared = homeCreate.prepare({ principal_digest, request });
        const started = await bootstrap.service.startAllocated({
          allocation: prepared.allocation,
          created_at: prepared.created_at,
          private_context_consumed: prepared.private_context_consumed,
          initial_context_record_digest: prepared.initial_context_record_digest,
          request: {
            topic: request.topic,
            ...(request.policy === undefined ? {} : { policy: request.policy }),
            ...(request.participants === undefined
              ? {}
              : { participants: structuredClone(request.participants) }),
            ...(request.max_rounds === undefined ? {} : { max_rounds: request.max_rounds }),
            ...(request.project_id === undefined ? {} : { project_id: request.project_id }),
          },
          ...(prepared.private_file_range
            ? { private_file_range: prepared.private_file_range }
            : {}),
          before_publish: (initialContextRecordDigest) =>
            prepared.beforePublish(initialContextRecordDigest),
        });
        return { conversation_id: started.conversation_id, replayed: prepared.replayed };
      },
    },
    compatibilityMessages: {
      queue: {
        resolveCommittedConversation: (conversationId) =>
          bootstrap.authorities.messageQueue.resolveCommittedConversation(conversationId),
        enqueueCompatibility: (conversationId, principalDigest, idempotencyKey, request) =>
          bootstrap.authorities.messageQueue.enqueueCompatibility(
            conversationId,
            principalDigest,
            idempotencyKey,
            request,
          ),
        item: (rootSessionId, queueItemId) =>
          bootstrap.authorities.messageQueue.item(rootSessionId, queueItemId),
      },
    },
    messageQueueEvents: {
      rootSessionId: (conversationId) =>
        bootstrap.authorities.messageQueue.rootSessionId(conversationId),
      subscribe: (rootSessionId, listener) =>
        bootstrap.authorities.messageQueue.subscribe(rootSessionId, listener),
    },
    askCompatibility: {
      submit: (input) => askCompatibility.submit(input),
    },
  } satisfies ConversationHttpAuthority;
  if (cacheable) AUTHORITIES.set(key, authority);
  return authority;
}
