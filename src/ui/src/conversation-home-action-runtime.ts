import type { ComputedRef, Ref } from "vue";
import { ConversationHomeApiError, conversationHomeApi } from "./conversation-home-api.js";
import {
  captureHomeCommandToken,
  isHomePendingChallengeExpired,
  matchesHomeCommandToken,
  readableHomeError,
} from "./conversation-home-runtime.js";
import type { ActivationEpoch } from "./conversation-home-state.js";
import type { HomeActionView, HomePendingChallenge } from "./conversation-home-types.js";

interface HomeActionMutationRuntimeInput {
  activation: Pick<ActivationEpoch, "captureGeneration" | "isGenerationCurrent">;
  activeRootId: Ref<string | null>;
  selectedConversationId: ComputedRef<string | null>;
  online: Ref<boolean>;
  pendingActions: Ref<HomeActionView[]>;
  activationError: Ref<string>;
  challenges: Ref<Record<string, HomePendingChallenge>>;
  actionBusy: Ref<Record<string, boolean>>;
  actionBusyTokens: Ref<Record<string, string>>;
}

function removeRecordEntry<Value>(
  source: Record<string, Value>,
  key: string,
): Record<string, Value> {
  if (!(key in source)) return source;
  const next = { ...source };
  delete next[key];
  return next;
}

export function createHomeActionMutationRuntime(input: HomeActionMutationRuntimeInput) {
  const isCurrent = (command: ReturnType<typeof captureHomeCommandToken>) =>
    matchesHomeCommandToken(
      input.activation,
      command,
      input.activeRootId.value,
      input.selectedConversationId.value,
    );

  const applyCurrentView = (
    proposalId: string,
    apply: (view: HomeActionView) => void,
    fallback: HomeActionView,
  ): void => {
    const current =
      input.pendingActions.value.find((item) => item.proposal.proposal_id === proposalId) ??
      fallback;
    apply(current);
  };

  const beginBusy = (proposalId: string, commandId: string): void => {
    input.actionBusy.value = { ...input.actionBusy.value, [proposalId]: true };
    input.actionBusyTokens.value = {
      ...input.actionBusyTokens.value,
      [proposalId]: commandId,
    };
  };

  const finishBusy = (
    proposalId: string,
    command: ReturnType<typeof captureHomeCommandToken>,
  ): void => {
    if (input.actionBusyTokens.value[proposalId] !== command.command_id) return;
    input.actionBusy.value = removeRecordEntry(input.actionBusy.value, proposalId);
    input.actionBusyTokens.value = removeRecordEntry(input.actionBusyTokens.value, proposalId);
  };

  const clearChallenge = (proposalId: string): void => {
    if (!(proposalId in input.challenges.value)) return;
    const next = { ...input.challenges.value };
    delete next[proposalId];
    input.challenges.value = next;
  };

  const readChallenge = (proposalId: string): HomePendingChallenge | null => {
    const challenge = input.challenges.value[proposalId];
    if (!challenge) return null;
    if (!isHomePendingChallengeExpired(challenge)) return challenge;
    clearChallenge(proposalId);
    input.activationError.value = "Review confirmation expired. Request a new one.";
    return null;
  };

  const challengeClassForView = (
    view: HomeActionView,
  ): "fresh-user-scope" | "public-literal" | null =>
    view.proposal.action_type === "conversation.publish_suspected_literal"
      ? "public-literal"
      : view.proposal.scope === "user"
        ? "fresh-user-scope"
        : null;

  async function mutateAction(
    view: HomeActionView,
    mutation: "approve" | "deny" | "commit" | "cancel",
  ): Promise<void> {
    const conversationId = input.selectedConversationId.value;
    const proposalId = view.proposal.proposal_id;
    if (!conversationId || !input.online.value || input.actionBusy.value[proposalId]) return;
    const command = captureHomeCommandToken(
      input.activation,
      input.activeRootId.value,
      conversationId,
    );
    beginBusy(proposalId, command.command_id);
    try {
      if (mutation === "commit") {
        if (!view.approval) throw new Error("Approve this proposal before running it.");
        const result = await conversationHomeApi.commit(
          conversationId,
          proposalId,
          view.proposal.proposal_digest,
          view.approval.approval_id,
        );
        if (!isCurrent(command)) return;
        applyCurrentView(
          proposalId,
          (current) => {
            current.operation = result.operation;
          },
          view,
        );
        clearChallenge(proposalId);
        return;
      }
      if (mutation === "cancel") {
        const result = await conversationHomeApi.cancel(
          conversationId,
          proposalId,
          view.proposal.proposal_digest,
        );
        if (!isCurrent(command)) return;
        applyCurrentView(
          proposalId,
          (current) => {
            current.operation = result.operation;
          },
          view,
        );
        clearChallenge(proposalId);
        return;
      }
      const challengeClass = challengeClassForView(view);
      const challenge = mutation === "approve" ? readChallenge(proposalId) : null;
      if (mutation === "approve" && challengeClass && !challenge) return;
      const result = await conversationHomeApi.approve(
        conversationId,
        proposalId,
        view.proposal.proposal_digest,
        mutation === "approve" ? "approved" : "denied",
        challenge ? { id: challenge.id, response: challenge.response } : null,
      );
      if (!isCurrent(command)) return;
      applyCurrentView(
        proposalId,
        (current) => {
          current.approval = result.approval;
          current.operation = result.operation;
        },
        view,
      );
      clearChallenge(proposalId);
    } catch (error) {
      if (
        isCurrent(command) &&
        error instanceof ConversationHomeApiError &&
        (error.publicError.code === "challenge_expired" ||
          error.publicError.code === "stale_proposal")
      )
        clearChallenge(proposalId);
      if (isCurrent(command)) input.activationError.value = readableHomeError(error);
    } finally {
      finishBusy(proposalId, command);
    }
  }

  async function requestChallenge(view: HomeActionView): Promise<void> {
    const conversationId = input.selectedConversationId.value;
    const proposalId = view.proposal.proposal_id;
    if (!conversationId || !input.online.value || input.actionBusy.value[proposalId]) return;
    const command = captureHomeCommandToken(
      input.activation,
      input.activeRootId.value,
      conversationId,
    );
    beginBusy(proposalId, command.command_id);
    clearChallenge(proposalId);
    try {
      const challengeClass = challengeClassForView(view);
      if (!challengeClass) return;
      const result = await conversationHomeApi.challenge(
        conversationId,
        proposalId,
        view.proposal.proposal_digest,
        challengeClass,
      );
      if (!isCurrent(command)) return;
      const nextChallenge: HomePendingChallenge = {
        id: result.challenge_id,
        phrase: result.display_phrase,
        response: "",
        expires_at: result.expires_at,
      };
      if (isHomePendingChallengeExpired(nextChallenge))
        throw new Error("Review confirmation was invalid or already expired.");
      input.challenges.value = {
        ...input.challenges.value,
        [proposalId]: nextChallenge,
      };
    } catch (error) {
      if (isCurrent(command)) {
        clearChallenge(proposalId);
        input.activationError.value = readableHomeError(error);
      }
    } finally {
      finishBusy(proposalId, command);
    }
  }

  return {
    mutateAction,
    requestChallenge,
  };
}
