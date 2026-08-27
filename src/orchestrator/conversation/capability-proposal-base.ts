import { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { ConversationActionService } from "./conversation-action-service.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { ConversationRevisionConflictError } from "./revision-errors.js";
import { resolveRevisionBase } from "./revision-source.js";

export class CapabilityConversationSourceStaleError extends ConversationRevisionConflictError {
  override readonly name = "CapabilityConversationSourceStaleError";
  readonly code = PUBLIC_ERROR_CODE.STALE_CONVERSATION;

  constructor() {
    super("capability proposal expected conversation source is stale");
  }
}

export function registerCapabilityConversationProposalBase(input: {
  actions: ConversationActionService;
  artifactRoot: string;
  traceRoot: string;
  home: ConversationHomeAuthorities;
}): void {
  const resolveBase = (conversationId: string) => {
    try {
      return resolveRevisionBase({
        artifactRoot: input.artifactRoot,
        traceRoot: input.traceRoot,
        conversationId,
        home: input.home,
      });
    } catch (error) {
      if (error instanceof ConversationRevisionConflictError)
        throw new CapabilityConversationSourceStaleError();
      throw error;
    }
  };
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
      throw new CapabilityConversationSourceStaleError();
    return {
      root_session_id: base.lineage.root_session_id,
      conversation_id: base.parent.node.conversation_id,
      revision_id: base.parent.node.revision_id,
      last_seq: base.parent.source.journal_head.last_seq,
      conversation_lock_digest: base.lock.lock_digest,
      lineage_head_digest: base.head.content_digest,
      lineage_head_epoch: base.head.head_epoch,
      participant_binding_set_digest: digestV1(
        "VF-CONVERSATION-PARTICIPANT-BINDING-SET\0v1\0",
        base.parent.source.manifest.bindings,
      ),
      participants: base.parent.source.manifest.bindings
        .map((binding) => ({
          participant_id: binding.participant_id,
          engine: binding.input.engine,
        }))
        .sort((left, right) => left.participant_id.localeCompare(right.participant_id)),
    };
  });
}
