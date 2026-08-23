import { reactive, ref } from "vue";
import { ConversationApiError, conversationApi } from "../conversation-api.js";
import {
  applyConversationSnapshot,
  applyConversationTrace,
  buildConversationCreateRequest,
  currentConversationCursor,
  resetConversationState,
  setStreamCredentials,
  useConversationWorkspaceModel,
} from "../conversation-store.js";
import type { ApprovalOutcome } from "../conversation-types.js";
import { useConversationStream } from "./useConversationStream.js";

const conflictToNotice = { conflictToNotice: true } as const;

export function useConversationWorkspace(initialLegacyAskOpen = false) {
  const workspace = useConversationWorkspaceModel();
  const pending = ref(false);
  const localError = ref("");
  const resumeConversationId = ref("");
  const legacyAskOpen = ref(initialLegacyAskOpen);
  const traceOpen = ref(false);
  const selectedTraceSeq = ref<number | null>(null);
  const createForm = reactive({ topic: "", policy: "", participants: "", maxRounds: "" });

  const asMessage = (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback;
  const clearError = () => {
    localError.value = "";
  };
  const activeConversationId = () => workspace.state.activeConversationId;
  const hydrateSnapshot = async (conversationId: string) => {
    applyConversationSnapshot(workspace.state, await conversationApi.snapshot(conversationId));
  };
  const activateConversation = async (
    conversationId: string,
    token: string,
    expiresAt: string,
    options: {
      location?: string | null;
      parentConversationId?: string | null;
      parentLocation?: string | null;
    } = {},
  ) => {
    resetConversationState(workspace.state, conversationId, options);
    setStreamCredentials(workspace.state, token, expiresAt);
    await hydrateSnapshot(conversationId);
    workspace.state.notice = `Connected to ${conversationId}`;
  };
  const runPending = async (
    fallback: string,
    task: () => Promise<void>,
    options: { conflictToNotice?: boolean } = {},
  ) => {
    pending.value = true;
    clearError();
    try {
      await task();
    } catch (cause) {
      if (
        options.conflictToNotice &&
        cause instanceof ConversationApiError &&
        cause.status === 409
      ) {
        workspace.state.notice = cause.message;
      } else {
        localError.value = asMessage(cause, fallback);
      }
    } finally {
      pending.value = false;
    }
  };
  const withConversation = async (
    fallback: string,
    task: (conversationId: string) => Promise<void>,
    options: { conflictToNotice?: boolean } = {},
  ) => {
    const conversationId = activeConversationId();
    if (!conversationId) return;
    await runPending(fallback, () => task(conversationId), options);
  };

  const startConversation = async () => {
    clearError();
    const { request, error } = buildConversationCreateRequest(createForm);
    if (!request) {
      localError.value = error ?? "Topic is required.";
      return;
    }
    await runPending("Failed to start conversation.", async () => {
      const created = await conversationApi.create(request);
      await activateConversation(
        created.conversation_id,
        created.stream_token,
        created.stream_token_expires_at,
      );
    });
  };

  const resumeConversation = async (
    conversationId: string | null,
    options: { parentConversationId?: string | null; parentLocation?: string | null } = {},
  ) => {
    clearError();
    const trimmed = conversationId?.trim() ?? "";
    if (!trimmed) {
      localError.value = "Conversation id is required.";
      return;
    }
    await runPending("Failed to resume conversation.", async () => {
      const renewed = await conversationApi.renewStreamToken(trimmed);
      await activateConversation(
        trimmed,
        renewed.stream_token,
        renewed.stream_token_expires_at,
        options,
      );
    });
  };

  const resumeConversationFromInput = () => resumeConversation(resumeConversationId.value);

  const submitMessage = async (
    content: string,
    targets: string[] | "all",
    onSuccess: () => void,
  ) => {
    const parentId = activeConversationId();
    if (!parentId) return;
    await runPending("Failed to send message.", async () => {
      const parentLocation = workspace.state.activeLocation;
      const response = await conversationApi.message(parentId, {
        content,
        ...(targets === "all" ? {} : { target_participants: targets }),
      });
      onSuccess();
      if (!response.child_conversation_id) {
        workspace.state.notice = "Message accepted.";
        await hydrateSnapshot(parentId);
        return;
      }
      if (!response.location?.trim()) {
        throw new Error("Child conversation response is missing its location.");
      }
      const renewed = await conversationApi.renewStreamToken(response.child_conversation_id);
      await activateConversation(
        response.child_conversation_id,
        renewed.stream_token,
        renewed.stream_token_expires_at,
        { location: response.location, parentConversationId: parentId, parentLocation },
      );
      workspace.state.childConversationId = response.child_conversation_id;
      workspace.state.notice = `Switched to child conversation ${response.child_conversation_id}`;
    });
  };

  const pauseConversation = () =>
    withConversation("Failed to pause conversation.", async (conversationId) => {
      const paused = await conversationApi.pause(conversationId);
      workspace.state.notice = `Conversation ${paused.lifecycle.toLowerCase()}.`;
      await hydrateSnapshot(conversationId);
    });

  const resumeActiveConversation = () =>
    withConversation("Failed to resume conversation.", async (conversationId) => {
      const resumed = await conversationApi.resume(conversationId);
      workspace.state.notice = `Conversation ${resumed.active_state.toLowerCase()}.`;
      await hydrateSnapshot(conversationId);
    });

  const stopConversation = () =>
    withConversation("Failed to stop conversation.", async (conversationId) => {
      const stopped = await conversationApi.stop(conversationId);
      workspace.state.notice = `Conversation ${stopped.terminal_state.toLowerCase()}.`;
      await hydrateSnapshot(conversationId);
    });

  const resolveApproval = (
    approvalId: string,
    operationId: string,
    actor: string,
    outcome: ApprovalOutcome,
    reason: string | null,
  ) => {
    if (!workspace.controls.value.canResolveApproval(approvalId, operationId)) return;
    return withConversation(
      "Failed to resolve approval.",
      async (conversationId) => {
        await conversationApi.resolveApproval(conversationId, approvalId, {
          approval_id: approvalId,
          operation_id: operationId,
          actor,
          outcome,
          reason,
        });
        workspace.state.notice = `Approval ${outcome}d.`;
        await hydrateSnapshot(conversationId);
      },
      conflictToNotice,
    );
  };

  const cancelOperation = (operationId: string, reason: string | null) =>
    withConversation(
      "Failed to cancel operation.",
      async (conversationId) => {
        await conversationApi.cancelOperation(conversationId, {
          conversation_id: conversationId,
          operation_id: operationId,
          actor: "web-ui",
          reason,
        });
        workspace.state.notice = `Cancellation requested for ${operationId}.`;
        await hydrateSnapshot(conversationId);
      },
      conflictToNotice,
    );

  const openTrace = (seq: number) => {
    if (!seq) return;
    selectedTraceSeq.value = seq;
    traceOpen.value = true;
  };

  useConversationStream({
    state: workspace.state,
    currentCursor: () => currentConversationCursor(workspace.state),
    applySnapshot: (snapshot) => applyConversationSnapshot(workspace.state, snapshot),
    applyTrace: (record) => applyConversationTrace(workspace.state, record),
    setStreamCredentials: (token, expiresAt) =>
      setStreamCredentials(workspace.state, token, expiresAt),
  });

  return {
    workspace,
    pending,
    localError,
    resumeConversationId,
    legacyAskOpen,
    traceOpen,
    selectedTraceSeq,
    createForm,
    startConversation,
    resumeConversation,
    resumeConversationFromInput,
    submitMessage,
    pauseConversation,
    resumeActiveConversation,
    stopConversation,
    resolveApproval,
    cancelOperation,
    openTrace,
  };
}
