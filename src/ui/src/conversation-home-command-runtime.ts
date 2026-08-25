import { type ComputedRef, type Ref, toRaw } from "vue";
import { type BrowserActionCandidate, conversationHomeApi } from "./conversation-home-api.js";
import {
  moveHomeQuoteReference,
  sameHomeQuoteRef,
  toHomeCanonicalMessageReference,
  toHomeCanonicalQuoteReference,
  toggleHomeQuoteReference,
} from "./conversation-home-authoring.js";
import { capabilityRepairCandidate } from "./conversation-home-recovery.js";
import {
  captureHomeCommandToken,
  createHomeActionKey,
  matchesHomeCommandToken,
  readableHomeError,
  sameHomePrivateFileRangeBinding,
} from "./conversation-home-runtime.js";
import { parseComposerIntent } from "./conversation-home-state.js";
import { applyHomeReactionFold } from "./conversation-home-stream.js";
import type {
  HomeActionView,
  HomeCapabilityItem,
  HomePrivateFileRangeBinding,
  HomeQuoteReference,
  HomeReactionEmoji,
  HomeRevisionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

interface HomeCommandRuntimeInput {
  activation: {
    captureGeneration(): number;
    isGenerationCurrent(generation: number): boolean;
  };
  activeRevision: ComputedRef<HomeRevisionSummary | null>;
  activeRootId: Ref<string | null>;
  selectedConversationId: ComputedRef<string | null>;
  draft: Ref<string>;
  online: Ref<boolean>;
  submitting: Ref<boolean>;
  submittingToken: Ref<string | null>;
  privateFileRange: Ref<HomePrivateFileRangeBinding | null>;
  composerError: Ref<string>;
  activationError: Ref<string>;
  quoteRefs: Ref<HomeQuoteReference[]>;
  reactionBusy: Ref<Record<string, boolean>>;
  reactionBusyTokens: Ref<Record<string, string>>;
  pendingActions: Ref<HomeActionView[]>;
  timeline: Ref<HomeTimelineResponse | null>;
  refreshSessions(query?: string): Promise<void>;
  refreshActiveSelection(): Promise<boolean>;
  refreshAuthoritativeActiveHead(expectedConversationId: string): Promise<boolean>;
  selectSession(rootSessionId: string): Promise<void>;
  sessions: Ref<Array<{ root_session_id: string; root: { conversation_id: string } }>>;
  sessionQuery: Ref<string>;
}

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
    privateFileRange: HomePrivateFileRangeBinding | null,
  ) => {
    if (input.draft.value === draft) input.draft.value = "";
    if (sameQuoteSelection(input.quoteRefs.value, quoteRefs)) input.quoteRefs.value = [];
    if (sameHomePrivateFileRangeBinding(input.privateFileRange.value, privateFileRange))
      input.privateFileRange.value = null;
  };

  const clearSubmittedDraft = (draft: string) => {
    if (input.draft.value === draft) input.draft.value = "";
  };

  async function proposeCandidate(
    candidate: BrowserActionCandidate,
    options: { refreshSelection?: boolean } = {},
  ): Promise<boolean> {
    const rootSessionId = input.activeRootId.value;
    const conversationId = input.selectedConversationId.value;
    const revision = input.activeRevision.value;
    if (!input.online.value) throw new Error("Reconnect before changing this conversation.");
    if (!rootSessionId || !conversationId || !revision)
      throw new Error("Open a conversation first.");
    const command = captureHomeCommandToken(input.activation, rootSessionId, conversationId);
    try {
      const view = await conversationHomeApi.propose(
        revision.conversation_id,
        {
          mode: "writable-revision",
          conversation_id: revision.conversation_id,
          revision_id: revision.revision_id,
          last_seq: revision.last_seq,
          conversation_lock_digest: revision.lock_digest,
        },
        candidate,
        createHomeActionKey(),
      );
      if (!isCurrent(command)) return false;
      input.pendingActions.value = [
        view,
        ...input.pendingActions.value.filter(
          (item) => item.proposal.proposal_id !== view.proposal.proposal_id,
        ),
      ];
      if (options.refreshSelection !== false) {
        return await input.refreshActiveSelection();
      }
      return true;
    } catch (error) {
      if (!isCurrent(command)) return false;
      throw error;
    }
  }

  async function submitDraft(): Promise<void> {
    if (input.submitting.value || !input.online.value) return;
    const intent = parseComposerIntent(input.draft.value);
    if (intent.kind === "empty") return;
    if (intent.kind === "invalid") {
      input.composerError.value = intent.message;
      return;
    }
    if (input.quoteRefs.value.length && intent.kind !== "message") {
      input.composerError.value =
        "Quoted sources only attach to natural-language replies. Remove them before sending a typed action.";
      return;
    }
    if (input.privateFileRange.value && intent.kind !== "message") {
      input.composerError.value =
        "Private file ranges only attach to natural-language goals or replies. Remove the selected range before sending a typed action.";
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
      const submittedDraft = input.draft.value;
      const submittedQuotes = structuredClone(toRaw(input.quoteRefs.value));
      const privateFileRange = input.privateFileRange.value
        ? structuredClone(toRaw(input.privateFileRange.value))
        : null;
      const activeRevision = input.activeRevision.value;
      if (!input.activeRootId.value) {
        if (intent.kind !== "message" || intent.targets !== "all")
          throw new Error("Start with a natural-language goal, then add agents or capabilities.");
        const created = await conversationHomeApi.create(
          intent.content,
          privateFileRange ?? undefined,
        );
        if (!isCurrent(command)) return;
        clearSubmittedComposer(submittedDraft, [], privateFileRange);
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
      if (intent.kind === "message") {
        const rootSessionId = input.activeRootId.value;
        const readyQuotes = input.quoteRefs.value.map((reference) => {
          if (rootSessionId && reference.root_session_id !== rootSessionId)
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
        const response = await conversationHomeApi.message(activeRevision.conversation_id, {
          content: intent.content,
          target_participants: intent.targets,
          ...(readyQuotes.length ? { quote_refs: readyQuotes } : {}),
          ...(privateFileRange ? { private_file_range: privateFileRange } : {}),
        });
        if (!isCurrent(command)) return;
        clearSubmittedComposer(submittedDraft, submittedQuotes, privateFileRange);
        if (response.child_conversation_id && rootSessionId) {
          try {
            const adopted = await input.refreshAuthoritativeActiveHead(
              response.child_conversation_id,
            );
            if (!adopted)
              throw new Error("The new revision did not become the authoritative session head.");
          } catch (error) {
            if (isCurrent(command)) input.activationError.value = readableHomeError(error);
          }
        }
        return;
      }
      const proposed = await proposeCandidate(
        intent.kind === "add-participant"
          ? {
              type: "conversation.add_participant",
              participant: {
                role_ref: intent.roleRef,
                engine: intent.engine,
                model: intent.model,
                skill_refs: [],
              },
            }
          : intent.kind === "remove-participant"
            ? { type: "conversation.remove_participant", participant_id: intent.participantId }
            : intent.kind === "install-capability"
              ? {
                  type: "capability.install",
                  package: { id: intent.packageId },
                  scope: intent.scope,
                  requested_targets: [],
                  inputs: [],
                }
              : {
                  type: "capability.remove",
                  package_id: intent.packageId,
                  scope: intent.scope,
                  cascade: false,
                },
        { refreshSelection: false },
      );
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
      return await proposeCandidate({ type: "conversation.update_settings", changes });
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
        schema_version: "1.0",
        idempotency_key: `home-reaction:${busyKey}:${emoji}:${createHomeActionKey()}`.slice(0, 200),
        mode: "toggle-self",
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

  function reportUnavailableInteraction(
    kind: "quote" | "reaction",
    diagnosticCode: string | null,
  ): void {
    const noun = kind === "quote" ? "Quotes" : "Reactions";
    const reason = diagnosticCode
      ? ` The backend reported ${diagnosticCode}.`
      : " This message has not reached an immutable public locator yet.";
    const target = kind === "quote" ? input.composerError : input.activationError;
    target.value = `${noun} are unavailable for this message right now.${reason}`;
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
