import type { CapabilityConversationActionDomainV1 } from "../capabilities/action-domain/domain-handler.js";
import {
  type CapabilityRuntimeFactoryOptionsV1,
  productionCapabilityRuntimeV1,
} from "../capabilities/runtime-factory.js";
import { cwd } from "../core.js";
import { createPrivateFileRangeHandoffId } from "../orchestrator/conversation/private-file-range-staging-store.js";
import {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
} from "../server/conversation-auth.js";
import { isConversationLoopbackHost } from "../server/conversation-host.js";
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
    },
  } satisfies ConversationHttpAuthority;
  if (cacheable) AUTHORITIES.set(key, authority);
  return authority;
}
