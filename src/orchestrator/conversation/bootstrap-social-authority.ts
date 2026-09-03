import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { ConversationMessageAuthorityV1 } from "./conversation-message-authority.js";
import { ConversationSocialAuthorityV1 } from "./conversation-social-authority.js";

export function createConversationSocialAuthority(input: {
  artifactRoot: string;
  traceRoot: string;
  artifactRegistry: ArtifactRegistry;
  home: ConversationHomeAuthorities;
}): ConversationSocialAuthorityV1 {
  return new ConversationSocialAuthorityV1(
    input.home.interactions,
    new ConversationMessageAuthorityV1(input),
    input.home.now,
  );
}
