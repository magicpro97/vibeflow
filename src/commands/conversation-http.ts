import { cwd } from "../core.js";
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
): ConversationHttpAuthority {
  const loopback = isConversationLoopbackHost(host ?? "127.0.0.1");
  const key = `${base}:${loopback ? "loopback" : "lan"}`;
  if (!deps.service && !deps.createService && !deps.bootstrap) {
    const cached = AUTHORITIES.get(key);
    if (cached) return cached;
  }
  const bootstrap = conversationBootstrap(deps, base);
  const authority = {
    service: bootstrap.service,
    sessions: new ConversationSessionAuthority({ loopback }),
    streamTokens: new ConversationStreamTokenAuthority(),
    artifacts: {
      registry: bootstrap.authorities.artifactRegistry,
      store: bootstrap.authorities.artifactStore,
    },
  } satisfies ConversationHttpAuthority;
  if (!deps.service && !deps.createService && !deps.bootstrap) AUTHORITIES.set(key, authority);
  return authority;
}
