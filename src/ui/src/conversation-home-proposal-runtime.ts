import type { ComputedRef, Ref } from "vue";
import { type BrowserActionCandidate, conversationHomeApi } from "./conversation-home-api.js";
import {
  type HomeCapabilityTargetAuthority,
  homeCapabilityTargetAuthority,
  sameHomeCapabilityTargetAuthority,
} from "./conversation-home-capability-target-authority.js";
import {
  captureHomeCommandToken,
  createHomeActionKey,
  matchesHomeCommandToken,
} from "./conversation-home-runtime.js";
import type { HomeActionView, HomeRevisionSummary } from "./conversation-home-types.js";

interface HomeProposalRuntimeInput {
  activation: {
    captureGeneration(): number;
    isGenerationCurrent(generation: number): boolean;
  };
  activeRevision: ComputedRef<HomeRevisionSummary | null>;
  activeRootId: Ref<string | null>;
  selectedConversationId: ComputedRef<string | null>;
  online: Ref<boolean>;
  pendingActions: Ref<HomeActionView[]>;
  refreshActiveSelection(): Promise<boolean>;
}

export function createHomeProposalRuntime(input: HomeProposalRuntimeInput) {
  const currentAuthority = (): HomeCapabilityTargetAuthority | null => {
    const rootSessionId = input.activeRootId.value;
    const revision = input.activeRevision.value;
    if (
      !rootSessionId ||
      !revision ||
      input.selectedConversationId.value !== revision.conversation_id
    )
      return null;
    return homeCapabilityTargetAuthority(rootSessionId, revision);
  };

  const isCurrent = (command: ReturnType<typeof captureHomeCommandToken>) =>
    matchesHomeCommandToken(
      input.activation,
      command,
      input.activeRootId.value,
      input.selectedConversationId.value,
    );

  const publishCandidate = (
    authority: HomeCapabilityTargetAuthority,
    view: HomeActionView,
  ): boolean => {
    const current = currentAuthority();
    if (!current || !sameHomeCapabilityTargetAuthority(authority, current)) return false;
    input.pendingActions.value = [
      view,
      ...input.pendingActions.value.filter(
        (item) => item.proposal.proposal_id !== view.proposal.proposal_id,
      ),
    ];
    return true;
  };

  async function transportCandidate(
    authority: HomeCapabilityTargetAuthority,
    candidate: BrowserActionCandidate,
  ): Promise<HomeActionView | null> {
    const rootSessionId = input.activeRootId.value;
    const conversationId = input.selectedConversationId.value;
    const revision = input.activeRevision.value;
    if (!input.online.value) throw new Error("Reconnect before changing this conversation.");
    if (!rootSessionId || !conversationId || !revision)
      throw new Error("Open a conversation first.");
    const current = currentAuthority();
    if (!current || !sameHomeCapabilityTargetAuthority(authority, current))
      throw new Error("Conversation authority changed before the proposal could be prepared.");
    const command = captureHomeCommandToken(input.activation, rootSessionId, conversationId);
    try {
      const view = await conversationHomeApi.propose(
        authority.conversation_id,
        {
          mode: "writable-revision",
          conversation_id: authority.conversation_id,
          revision_id: authority.revision_id,
          last_seq: authority.last_seq,
          conversation_lock_digest: authority.lock_digest,
        },
        candidate,
        createHomeActionKey(),
      );
      return isCurrent(command) ? view : null;
    } catch (error) {
      if (!isCurrent(command)) return null;
      throw error;
    }
  }

  async function proposeCandidate(
    candidate: BrowserActionCandidate,
    options: { refreshSelection?: boolean } = {},
  ): Promise<boolean> {
    const authority = currentAuthority();
    if (!authority) throw new Error("Open a conversation first.");
    const view = await transportCandidate(authority, candidate);
    if (!view || !publishCandidate(authority, view)) return false;
    return options.refreshSelection === false ? true : await input.refreshActiveSelection();
  }

  return { publishCandidate, transportCandidate, proposeCandidate };
}
