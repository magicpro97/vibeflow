import type { ConversationArtifactStore } from "./artifact-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { ContextHandoffV1 } from "./handoff-types.js";
import { publishedRevisionTransitionMap } from "./lineage-published-transition.js";

export class ConversationHandoffCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationHandoffCorruptError";
  }
}

export class ConversationHandoffService {
  constructor(
    private readonly artifacts: ConversationArtifactStore,
    private readonly home: ConversationHomeAuthorities,
  ) {}

  read(childConversationId: string): ContextHandoffV1 | null {
    const manifest = this.artifacts.read(childConversationId);
    if (!manifest || !manifest.parent_conversation_id || !manifest.parent_revision_id) return null;
    const transition = publishedRevisionTransitionMap(this.home.publishedRevisionTransitions()).get(
      childConversationId,
    );
    if (!transition) return null;
    const authority = transition.authority as {
      operation?: {
        handoff_digest?: unknown;
        parent?: { conversation_id?: unknown; revision_id?: unknown };
        child?: { conversation_id?: unknown; revision_id?: unknown };
      };
    };
    const digest = authority.operation?.handoff_digest;
    if (typeof digest !== "string")
      throw new ConversationHandoffCorruptError("published child has no handoff digest");
    const handoff = this.home.handoffs.read(digest);
    if (!handoff)
      throw new ConversationHandoffCorruptError("published child handoff object is absent");
    if (
      authority.operation?.child?.conversation_id !== manifest.conversation_id ||
      authority.operation.child.revision_id !== manifest.revision_id ||
      authority.operation.parent?.conversation_id !== manifest.parent_conversation_id ||
      authority.operation.parent.revision_id !== manifest.parent_revision_id ||
      handoff.source.conversation_id !== manifest.parent_conversation_id ||
      handoff.source.revision_id !== manifest.parent_revision_id ||
      handoff.digest !== digest
    )
      throw new ConversationHandoffCorruptError(
        "published child and context handoff authority disagree",
      );
    return handoff;
  }
}
