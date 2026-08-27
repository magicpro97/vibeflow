import { toRaw } from "vue";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  CONVERSATION_HUMAN_REACTION_REQUEST_MODE,
  CONVERSATION_INTERACTION_SCHEMA_VERSION,
} from "../../orchestrator/conversation/conversation-interaction-contract.js";
import { CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE } from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import { CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION } from "../../orchestrator/conversation/conversation-private-context-broker-wire.js";
import { type BrowserActionCandidate, conversationHomeApi } from "./conversation-home-api.js";
import {
  moveHomeQuoteReference,
  sameHomeQuoteRef,
  toHomeCanonicalMessageReference,
  toHomeCanonicalQuoteReference,
  toggleHomeQuoteReference,
} from "./conversation-home-authoring.js";
import { createHomeCapabilityTargetRuntime } from "./conversation-home-capability-target-runtime.js";
import type { HomeCommandRuntimeInput } from "./conversation-home-command-input.js";
import { createHomeUnavailableInteractionReporter } from "./conversation-home-interaction-feedback.js";
import type { HomePrivateContextCapture } from "./conversation-home-private-context-types.js";
import { createHomeProposalRuntime } from "./conversation-home-proposal-runtime.js";
import { capabilityRepairCandidate } from "./conversation-home-recovery.js";
import {
  captureHomeCommandToken,
  createHomeActionKey,
  matchesHomeCommandToken,
  readableHomeError,
} from "./conversation-home-runtime.js";
import { HOME_COMPOSER_INTENT_KIND, parseComposerIntent } from "./conversation-home-state.js";
import { applyHomeReactionFold } from "./conversation-home-stream.js";
import type {
  HomeCapabilityItem,
  HomeQuoteReference,
  HomeReactionEmoji,
} from "./conversation-home-types.js";
export function createHomeCommandRuntime(input: HomeCommandRuntimeInput) {
  const isCurrent = (command: ReturnType<typeof captureHomeCommandToken>) =>
    matchesHomeCommandToken(
      input.activation,
      command,
      input.activeRootId.value,
      input.selectedConversationId.value,
    );
  const finishSubmitting = (command: ReturnType<typeof captureHomeCommandToken>) => {
    if (input.submittingToken.value !== command.command_id) return;
    input.submittingToken.value = null;
    input.submitting.value = false;
  };
  const finishReactionBusy = (
    busyKey: string,
    command: ReturnType<typeof captureHomeCommandToken>,
  ) => {
    if (input.reactionBusyTokens.value[busyKey] !== command.command_id) return;
    const nextBusy = { ...input.reactionBusy.value };
    const nextTokens = { ...input.reactionBusyTokens.value };
    delete nextBusy[busyKey];
    delete nextTokens[busyKey];
    input.reactionBusy.value = nextBusy;
    input.reactionBusyTokens.value = nextTokens;
  };
  const sameQuoteSelection = (
    left: readonly HomeQuoteReference[],
    right: readonly HomeQuoteReference[],
  ): boolean =>
    left.length === right.length &&
    left.every((item, index) => {
      const candidate = right[index];
      return candidate ? sameHomeQuoteRef(item, candidate) : false;
    });

  const clearSubmittedComposer = (
    draft: string,
    quoteRefs: readonly HomeQuoteReference[],
    privateContext: HomePrivateContextCapture | null,
  ) => {
    if (input.draft.value === draft) input.draft.value = "";
    if (sameQuoteSelection(input.quoteRefs.value, quoteRefs)) input.quoteRefs.value = [];
    privateContext?.clearIfCurrent();
  };

  const restoreSubmittedComposer = (
    draft: string,
    quoteRefs: readonly HomeQuoteReference[],
    privateContext: HomePrivateContextCapture | null,
  ): boolean => {
    if (
      input.draft.value !== "" ||
      input.quoteRefs.value.length > 0 ||
      input.privateContext.present()
    )
      return false;
    if (privateContext && !privateContext.restoreIfVacant()) return false;
    input.draft.value = draft;
    input.quoteRefs.value = quoteRefs.map((reference) => structuredClone(reference));
    return true;
  };

  const clearSubmittedDraft = (draft: string) => {
    if (input.draft.value === draft) input.draft.value = "";
  };

  const { publishCandidate, transportCandidate, proposeCandidate } = createHomeProposalRuntime({
    activation: input.activation,
    activeRevision: input.activeRevision,
    activeRootId: input.activeRootId,
    selectedConversationId: input.selectedConversationId,
    online: input.online,
    pendingActions: input.pendingActions,
    refreshActiveSelection: input.refreshActiveSelection,
  });
  const capabilityTargets = createHomeCapabilityTargetRuntime({
    activation: input.activation,
    activeRevision: input.activeRevision,
    activeRootId: input.activeRootId,
    selectedConversationId: input.selectedConversationId,
    draft: input.draft,
    online: input.online,
    submitting: input.submitting,
    submittingToken: input.submittingToken,
    composerError: input.composerError,
    transportCandidate,
    publishCandidate,
    refreshActiveSelection: input.refreshActiveSelection,
  });
  const reportUnavailableInteraction = createHomeUnavailableInteractionReporter(input);

  async function submitDraft(): Promise<void> {
    if (!input.online.value) return;
    if (input.messageQueue.currentEdit()) {
      await input.messageQueue.saveEdit();
      return;
    }
    const intent = parseComposerIntent(input.draft.value);
    capabilityTargets.reconcileCapabilityTargetDraft();
    if (intent.kind === HOME_COMPOSER_INTENT_KIND.EMPTY) return;
    if (intent.kind === HOME_COMPOSER_INTENT_KIND.INVALID) {
      input.composerError.value = intent.message;
      return;
    }
    if (input.quoteRefs.value.length && intent.kind !== HOME_COMPOSER_INTENT_KIND.MESSAGE) {
      input.composerError.value =
        "Quoted sources only attach to natural-language replies. Remove them before sending a typed action.";
      return;
    }
    if (input.privateContext.present() && intent.kind !== HOME_COMPOSER_INTENT_KIND.MESSAGE) {
      input.composerError.value =
        "Private file ranges only attach to natural-language goals or replies. Remove the selected range before sending a typed action.";
      return;
    }
    const submittedDraft = input.draft.value;
    const activeRevision = input.activeRevision.value;
    const submittedQuotes = structuredClone(toRaw(input.quoteRefs.value));
    if (intent.kind === HOME_COMPOSER_INTENT_KIND.MESSAGE && input.activeRootId.value) {
      try {
        if (!activeRevision)
          throw new Error("Refresh this conversation before sending so its head can be verified.");
        const rootSessionId = input.activeRootId.value;
        const privateContext = input.privateContext.captureForMessage(rootSessionId);
        if (input.privateContext.present() && !privateContext)
          throw new Error("Refresh this private context selection before sending.");
        const readyQuotes = input.quoteRefs.value.map((reference) => {
          if (reference.root_session_id !== rootSessionId)
            throw new Error(
              "One quoted source belongs to another conversation. Remove it or return to that session.",
            );
          const canonical = toHomeCanonicalQuoteReference(reference);
          if (!canonical)
            throw new Error(
              "One quoted source still lacks an immutable public locator. Refresh the conversation or remove it.",
            );
          return canonical;
        });
        await input.messageQueue.enqueue({
          ...(privateContext ? { idempotency_key: privateContext.idempotency_key } : {}),
          content: intent.content,
          target_participants: intent.targets,
          quote_refs: readyQuotes,
          private_context_present: privateContext !== null,
          clearIfCurrent: () =>
            clearSubmittedComposer(submittedDraft, submittedQuotes, privateContext),
          restoreIfVacant: () =>
            restoreSubmittedComposer(submittedDraft, submittedQuotes, privateContext),
        });
      } catch (error) {
        input.composerError.value = readableHomeError(error);
      }
      return;
    }
    if (input.submitting.value) return;
    if (intent.kind === HOME_COMPOSER_INTENT_KIND.INSTALL_CAPABILITY) {
      try {
        if (!input.activeRootId.value || !activeRevision)
          throw new Error("Open a conversation before installing a capability.");
        const automatic = capabilityTargets.prepareCapabilityInstall(
          intent,
          activeRevision,
          submittedDraft,
        );
        if (automatic) await capabilityTargets.confirmCapabilityTargets();
      } catch (error) {
        input.composerError.value = readableHomeError(error);
      }
      return;
    }
    const command = captureHomeCommandToken(
      input.activation,
      input.activeRootId.value,
      input.selectedConversationId.value,
    );
    input.submittingToken.value = command.command_id;
    input.submitting.value = true;
    input.composerError.value = "";
    try {
      if (!input.activeRootId.value) {
        if (
          intent.kind !== HOME_COMPOSER_INTENT_KIND.MESSAGE ||
          intent.targets !== CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
        )
          throw new Error("Start with a natural-language goal, then add agents or capabilities.");
        const privateContext = input.privateContext.captureForCreate();
        if (input.privateContext.present() && !privateContext)
          throw new Error(
            "Refresh this private context selection before creating the conversation.",
          );
        const createRequest = {
          schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
          idempotency_key:
            privateContext?.idempotency_key ?? `home-create.${createHomeActionKey()}`.slice(0, 128),
          topic: intent.content,
          private_context_present: privateContext !== null,
        };
        let created: Awaited<ReturnType<typeof conversationHomeApi.create>>;
        try {
          created = await conversationHomeApi.create(createRequest);
        } catch (error) {
          if (!(error instanceof TypeError) || !isCurrent(command) || !input.online.value)
            throw error;
          created = await conversationHomeApi.create(createRequest);
        }
        if (!isCurrent(command)) return;
        clearSubmittedComposer(submittedDraft, [], privateContext);
        input.sessionQuery.value = "";
        await input.refreshSessions("");
        if (!isCurrent(command)) return;
        const root = input.sessions.value.find(
          (item) =>
            item.root_session_id === created.conversation_id ||
            item.root.conversation_id === created.conversation_id,
        );
        await input.selectSession(root?.root_session_id ?? created.conversation_id);
        return;
      }
      if (!activeRevision)
        throw new Error("Refresh this conversation before sending so its head can be verified.");
      if (intent.kind === HOME_COMPOSER_INTENT_KIND.MESSAGE)
        throw new Error("Open the current root session before sending this message.");
      const candidate: BrowserActionCandidate =
        intent.kind === HOME_COMPOSER_INTENT_KIND.ADD_PARTICIPANT
          ? {
              type: HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT,
              participant: {
                role_ref: intent.roleRef,
                engine: intent.engine,
                model: intent.model,
                skill_refs: [],
              },
            }
          : intent.kind === HOME_COMPOSER_INTENT_KIND.REMOVE_PARTICIPANT
            ? {
                type: HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT,
                participant_id: intent.participantId,
              }
            : {
                type: HOST_ACTION_KIND.CAPABILITY_REMOVE,
                package_id: intent.packageId,
                scope: intent.scope,
                cascade: false,
              };
      const proposed = await proposeCandidate(candidate, {
        refreshSelection: false,
      });
      if (!isCurrent(command) || !proposed) return;
      clearSubmittedDraft(submittedDraft);
      if (input.activeRootId.value) await input.refreshActiveSelection();
    } catch (error) {
      if (isCurrent(command)) input.composerError.value = readableHomeError(error);
    } finally {
      finishSubmitting(command);
    }
  }
  async function proposeSettings(changes: {
    policy?: string;
    max_rounds?: number;
    baseline_enabled?: boolean;
  }): Promise<boolean> {
    try {
      return await proposeCandidate({
        type: HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS,
        changes,
      });
    } catch (error) {
      input.activationError.value = readableHomeError(error);
      return false;
    }
  }

  async function proposeCapabilityRepair(item: Pick<HomeCapabilityItem, "package_id" | "scope">) {
    try {
      return await proposeCandidate(capabilityRepairCandidate(item));
    } catch (error) {
      input.activationError.value = readableHomeError(error);
      return false;
    }
  }

  async function toggleReaction(
    reference: HomeQuoteReference,
    emoji: HomeReactionEmoji,
  ): Promise<void> {
    const rootSessionId = input.activeRootId.value;
    const conversationId = input.selectedConversationId.value;
    if (!rootSessionId || reference.root_session_id !== rootSessionId) {
      input.activationError.value =
        "This reaction target belongs to another conversation. Return to that session first.";
      return;
    }
    const messageRef = toHomeCanonicalMessageReference(reference);
    if (!messageRef) {
      input.activationError.value =
        "This message is still waiting on a typed public locator before reactions can be updated.";
      return;
    }
    const busyKey = messageRef.target_event_id;
    if (input.reactionBusy.value[busyKey] || !input.online.value) return;
    const command = captureHomeCommandToken(input.activation, rootSessionId, conversationId);
    input.reactionBusy.value = { ...input.reactionBusy.value, [busyKey]: true };
    input.reactionBusyTokens.value = {
      ...input.reactionBusyTokens.value,
      [busyKey]: command.command_id,
    };
    input.activationError.value = "";
    try {
      const response = await conversationHomeApi.reaction({
        schema_version: CONVERSATION_INTERACTION_SCHEMA_VERSION,
        idempotency_key: `home-reaction.${createHomeActionKey()}`.slice(0, 128),
        mode: CONVERSATION_HUMAN_REACTION_REQUEST_MODE.TOGGLE_SELF,
        emoji,
        message_ref: messageRef,
      });
      if (!isCurrent(command)) return;
      input.timeline.value = applyHomeReactionFold(
        input.timeline.value,
        response.message_ref,
        response.reactions,
      );
    } catch (error) {
      if (isCurrent(command)) input.activationError.value = readableHomeError(error);
    } finally {
      finishReactionBusy(busyKey, command);
    }
  }

  function toggleQuoteReference(reference: HomeQuoteReference): void {
    const result = toggleHomeQuoteReference(input.quoteRefs.value, reference);
    input.quoteRefs.value = result.next;
    input.composerError.value = result.error;
  }

  function removeQuoteReference(reference: HomeQuoteReference): void {
    input.quoteRefs.value = input.quoteRefs.value.filter(
      (item) => !sameHomeQuoteRef(item, reference),
    );
    input.composerError.value = "";
  }

  function moveQuoteReference(index: number, direction: -1 | 1): void {
    input.quoteRefs.value = moveHomeQuoteReference(input.quoteRefs.value, index, direction);
    input.composerError.value = "";
  }

  return {
    ...capabilityTargets,
    proposeCandidate,
    submitDraft,
    proposeSettings,
    proposeCapabilityRepair,
    toggleQuoteReference,
    removeQuoteReference,
    moveQuoteReference,
    toggleReaction,
    reportUnavailableInteraction,
  };
}
