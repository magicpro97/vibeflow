import type { CapabilityConversationActionDomainV1 } from "../capabilities/action-domain/domain-handler.js";
import {
  type CapabilityRuntimeFactoryOptionsV1,
  productionCapabilityRuntimeV1,
} from "../capabilities/runtime-factory.js";
import { cwd } from "../core.js";
import { ConversationAskCompatibilityV1 } from "../orchestrator/conversation/conversation-ask-compatibility.js";
import { ConversationHomeCreateBrokerV1 } from "../orchestrator/conversation/conversation-home-create-authority.js";
import { createPrivateFileRangeHandoffId } from "../orchestrator/conversation/private-file-range-staging-store.js";
import {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
} from "../server/conversation-auth.js";
import { isConversationLoopbackHost } from "../server/conversation-host.js";
import type { ConversationMessageQueueHttpAuthorityV1 } from "../server/conversation-message-queue-route.js";
import type { ConversationHttpAuthority } from "../server/conversation-route.js";
import { type ConversationCommandDeps, conversationBootstrap } from "./_shared.js";

const AUTHORITIES = new Map<string, ConversationHttpAuthority>();

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
