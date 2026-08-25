import type { ConversationActionService } from "./conversation-action-service.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { resolveRevisionBase } from "./revision-source.js";

export function registerCapabilityConversationProposalBase(input: {
  actions: ConversationActionService;
  artifactRoot: string;
  traceRoot: string;
  home: ConversationHomeAuthorities;
}): void {
  const resolveBase = (conversationId: string) =>
    resolveRevisionBase({
      artifactRoot: input.artifactRoot,
      traceRoot: input.traceRoot,
      conversationId,
      home: input.home,
    });
  input.actions.registerCapabilityActionRootResolver((conversationId) => ({
    root_session_id: resolveBase(conversationId).lineage.root_session_id,
  }));
  input.actions.registerCapabilityProposalBaseResolver((request) => {
    const base = resolveBase(request.conversation_id);
    const expected = request.expected;
    if (
      expected.conversation_id !== base.parent.node.conversation_id ||
      expected.revision_id !== base.parent.node.revision_id ||
      expected.last_seq !== base.parent.source.journal_head.last_seq ||
      expected.conversation_lock_digest !== base.lock.lock_digest ||
      (expected.mode === "lineage-recovery" &&
        (expected.root_session_id !== base.lineage.root_session_id ||
          expected.lineage_head_digest !== base.head.content_digest ||
          expected.lineage_head_epoch !== base.head.head_epoch))
    )
      throw new Error("capability proposal expected conversation source is stale");
    return {
      root_session_id: base.lineage.root_session_id,
      conversation_id: base.parent.node.conversation_id,
      revision_id: base.parent.node.revision_id,
      last_seq: base.parent.source.journal_head.last_seq,
      conversation_lock_digest: base.lock.lock_digest,
      lineage_head_digest: base.head.content_digest,
      lineage_head_epoch: base.head.head_epoch,
    };
  });
}
