import { type ComputedRef, type Ref, ref } from "vue";
import { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { ConversationHomeApiError } from "./conversation-home-api.js";
import {
  HOME_CAPABILITY_TARGET_SELECTION_MODE,
  type HomeCapabilityTargetAuthority,
  type HomeCapabilityTargetRequest,
  canonicalHomeCapabilityParticipants,
  cloneHomeCapabilityTargetRequest,
  homeCapabilityInstallCandidate,
  homeCapabilityTargetAuthority,
  sameHomeCapabilityParticipants,
  sameHomeCapabilityTargetAuthority,
} from "./conversation-home-capability-target-authority.js";
import {
  captureHomeCommandToken,
  matchesHomeCommandToken,
  readableHomeError,
} from "./conversation-home-runtime.js";
import type {
  HomeActionView,
  HomeParticipant,
  HomeRevisionSummary,
} from "./conversation-home-types.js";

interface HomeCapabilityTargetRuntimeInput {
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
  composerError: Ref<string>;
  transportCandidate(
    authority: HomeCapabilityTargetAuthority,
    candidate: ReturnType<typeof homeCapabilityInstallCandidate>,
  ): Promise<HomeActionView | null>;
  publishCandidate(authority: HomeCapabilityTargetAuthority, view: HomeActionView): boolean;
  refreshActiveSelection(): Promise<boolean>;
}

export function createHomeCapabilityTargetRuntime(input: HomeCapabilityTargetRuntimeInput) {
  const request = ref<HomeCapabilityTargetRequest | null>(null);

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

  const ownsAuthority = (
    command: ReturnType<typeof captureHomeCommandToken>,
    authority: HomeCapabilityTargetAuthority,
  ): boolean => {
    const current = currentAuthority();
    return Boolean(
      isCurrent(command) && current && sameHomeCapabilityTargetAuthority(authority, current),
    );
  };

  const sameRequest = (
    left: HomeCapabilityTargetRequest,
    right: HomeCapabilityTargetRequest,
  ): boolean =>
    left.package_id === right.package_id &&
    left.scope === right.scope &&
    left.draft === right.draft &&
    left.selection_mode === right.selection_mode &&
    left.reselection_required === right.reselection_required &&
    sameHomeCapabilityTargetAuthority(left.authority, right.authority) &&
    sameHomeCapabilityParticipants(left.participants, right.participants) &&
    left.selected_participant_ids.length === right.selected_participant_ids.length &&
    left.selected_participant_ids.every(
      (participantId, index) => right.selected_participant_ids[index] === participantId,
    );

  const finishSubmitting = (command: ReturnType<typeof captureHomeCommandToken>) => {
    if (input.submittingToken.value !== command.command_id) return;
    input.submittingToken.value = null;
    input.submitting.value = false;
  };

  function prepareCapabilityInstall(
    intent: { packageId: string; scope: CapabilityScope },
    revision: HomeRevisionSummary,
    submittedDraft: string,
  ): boolean {
    const authority = currentAuthority();
    if (!authority || authority.conversation_id !== revision.conversation_id)
      throw new Error("Refresh this conversation before choosing capability targets.");
    const participants = canonicalHomeCapabilityParticipants(revision.participants);
    if (!participants.length)
      throw new Error("Add an AI participant before installing a capability.");

    const pending = request.value;
    if (
      pending?.draft === submittedDraft &&
      pending.package_id === intent.packageId &&
      pending.scope === intent.scope
    ) {
      reconcileCapabilityTargetSelection();
      return request.value?.selection_mode === HOME_CAPABILITY_TARGET_SELECTION_MODE.AUTOMATIC;
    }
    if (participants.length === 1) {
      const participant = participants[0];
      if (!participant) throw new Error("Add an AI participant before installing a capability.");
      request.value = {
        package_id: intent.packageId,
        scope: intent.scope,
        draft: submittedDraft,
        authority,
        participants,
        selected_participant_ids: [participant.participant_id],
        reselection_required: false,
        selection_mode: HOME_CAPABILITY_TARGET_SELECTION_MODE.AUTOMATIC,
      };
      return true;
    }
    request.value = {
      package_id: intent.packageId,
      scope: intent.scope,
      draft: submittedDraft,
      authority,
      participants,
      selected_participant_ids: [],
      reselection_required: false,
      selection_mode: HOME_CAPABILITY_TARGET_SELECTION_MODE.EXPLICIT,
    };
    input.composerError.value = "Choose one or more AI participants for this capability.";
    return false;
  }

  function reconcileCapabilityTargetSelection(forceReselection = false): void {
    const pending = request.value;
    if (!pending) return;
    const authority = currentAuthority();
    const revision = input.activeRevision.value;
    if (!authority || !revision) {
      request.value = {
        ...pending,
        participants: [],
        selected_participant_ids: [],
        reselection_required: true,
        selection_mode: HOME_CAPABILITY_TARGET_SELECTION_MODE.EXPLICIT,
      };
      input.composerError.value =
        "Conversation authority changed. Refresh, then choose capability targets again.";
      return;
    }
    let participants: HomeParticipant[];
    try {
      participants = canonicalHomeCapabilityParticipants(revision.participants);
    } catch (error) {
      request.value = {
        ...pending,
        authority,
        participants: [],
        selected_participant_ids: [],
        reselection_required: true,
        selection_mode: HOME_CAPABILITY_TARGET_SELECTION_MODE.EXPLICIT,
      };
      input.composerError.value = readableHomeError(error);
      return;
    }
    if (
      !forceReselection &&
      sameHomeCapabilityTargetAuthority(pending.authority, authority) &&
      sameHomeCapabilityParticipants(pending.participants, participants)
    )
      return;
    request.value = {
      ...pending,
      authority,
      participants,
      selected_participant_ids: [],
      reselection_required: true,
      selection_mode: HOME_CAPABILITY_TARGET_SELECTION_MODE.EXPLICIT,
    };
    input.composerError.value = participants.length
      ? "Conversation authority changed. Choose capability targets again before review."
      : "This conversation has no AI participant that can receive the capability.";
  }

  function reconcileCapabilityTargetDraft(): void {
    if (request.value && input.draft.value !== request.value.draft) {
      request.value = null;
      input.composerError.value = "";
    }
  }

  function toggleCapabilityTarget(participantId: string): void {
    const pending = request.value;
    if (!pending || input.submitting.value) return;
    if (!pending.participants.some((participant) => participant.participant_id === participantId))
      return;
    const selected = new Set(pending.selected_participant_ids);
    if (selected.has(participantId)) selected.delete(participantId);
    else selected.add(participantId);
    request.value = {
      ...pending,
      selected_participant_ids: pending.participants
        .filter((participant) => selected.has(participant.participant_id))
        .map((participant) => participant.participant_id),
      reselection_required: selected.size === 0,
      selection_mode: HOME_CAPABILITY_TARGET_SELECTION_MODE.EXPLICIT,
    };
    input.composerError.value = "";
  }

  function toggleAllCapabilityTargets(): void {
    const pending = request.value;
    if (!pending || input.submitting.value || !pending.participants.length) return;
    const allSelected = pending.selected_participant_ids.length === pending.participants.length;
    request.value = {
      ...pending,
      selected_participant_ids: allSelected
        ? []
        : pending.participants.map((participant) => participant.participant_id),
      reselection_required: allSelected,
      selection_mode: HOME_CAPABILITY_TARGET_SELECTION_MODE.EXPLICIT,
    };
    input.composerError.value = "";
  }

  function clearCapabilityTargetSelection(): void {
    request.value = null;
  }

  function cancelCapabilityTargetSelection(): void {
    if (input.submitting.value) return;
    clearCapabilityTargetSelection();
    input.composerError.value = "";
  }

  async function confirmCapabilityTargets(): Promise<boolean> {
    const currentRequest = request.value;
    const pending = currentRequest ? cloneHomeCapabilityTargetRequest(currentRequest) : null;
    if (!pending || input.submitting.value || !input.online.value) return false;
    if (input.draft.value !== pending.draft) {
      request.value = null;
      input.composerError.value = "The install command changed. Send it again to choose targets.";
      return false;
    }
    const authority = currentAuthority();
    const revision = input.activeRevision.value;
    if (
      !authority ||
      !revision ||
      !sameHomeCapabilityTargetAuthority(pending.authority, authority)
    ) {
      reconcileCapabilityTargetSelection(true);
      return false;
    }
    let currentParticipants: HomeParticipant[];
    try {
      currentParticipants = canonicalHomeCapabilityParticipants(revision.participants);
    } catch {
      reconcileCapabilityTargetSelection(true);
      return false;
    }
    if (!currentParticipants.length) {
      input.composerError.value =
        "This conversation has no AI participant that can receive the capability.";
      return false;
    }
    if (!sameHomeCapabilityParticipants(pending.participants, currentParticipants)) {
      reconcileCapabilityTargetSelection(true);
      return false;
    }
    const selected = new Set(pending.selected_participant_ids);
    const targets = currentParticipants.filter((participant) =>
      selected.has(participant.participant_id),
    );
    if (!targets.length) {
      input.composerError.value = "Choose at least one AI participant before review.";
      return false;
    }
    if (targets.length !== selected.size) {
      reconcileCapabilityTargetSelection(true);
      return false;
    }

    const command = captureHomeCommandToken(
      input.activation,
      authority.root_session_id,
      authority.conversation_id,
    );
    input.submittingToken.value = command.command_id;
    input.submitting.value = true;
    input.composerError.value = "";
    try {
      const view = await input.transportCandidate(
        pending.authority,
        homeCapabilityInstallCandidate(pending, targets),
      );
      if (!view || !ownsAuthority(command, pending.authority)) return false;
      let refreshed = false;
      let refreshError: unknown = null;
      try {
        refreshed = await input.refreshActiveSelection();
        if (!ownsAuthority(command, pending.authority)) return false;
      } catch (error) {
        if (!ownsAuthority(command, pending.authority)) return false;
        refreshError = error;
      }
      const settledAuthority = currentAuthority();
      const settledRevision = input.activeRevision.value;
      let settledParticipants: HomeParticipant[] = [];
      try {
        if (settledRevision)
          settledParticipants = canonicalHomeCapabilityParticipants(settledRevision.participants);
      } catch {
        // Reconciliation below owns the public-safe degraded state.
      }
      if (
        !settledAuthority ||
        !settledRevision ||
        !sameHomeCapabilityTargetAuthority(pending.authority, settledAuthority)
      )
        return false;
      if (!sameHomeCapabilityParticipants(pending.participants, settledParticipants)) {
        reconcileCapabilityTargetSelection(true);
        return false;
      }
      const settledRequest = request.value;
      if (!settledRequest || !sameRequest(settledRequest, pending)) return false;
      if (!refreshed && !input.publishCandidate(pending.authority, view)) return false;
      if (refreshError)
        input.composerError.value = `The proposal was created, but Home could not refresh it. ${readableHomeError(refreshError)}`;
      request.value = null;
      if (input.draft.value === pending.draft) input.draft.value = "";
      return true;
    } catch (error) {
      if (!ownsAuthority(command, pending.authority)) return false;
      if (
        error instanceof ConversationHomeApiError &&
        error.publicError.code === PUBLIC_ERROR_CODE.STALE_CONVERSATION
      ) {
        await input.refreshActiveSelection().catch(() => false);
        if (!ownsAuthority(command, pending.authority)) return false;
        const latest = request.value;
        if (!latest || !sameRequest(latest, pending)) return false;
        reconcileCapabilityTargetSelection(true);
      } else {
        const latest = request.value;
        if (!latest || !sameRequest(latest, pending)) return false;
        if (
          pending.selection_mode === HOME_CAPABILITY_TARGET_SELECTION_MODE.AUTOMATIC &&
          latest?.selection_mode === HOME_CAPABILITY_TARGET_SELECTION_MODE.AUTOMATIC &&
          sameHomeCapabilityTargetAuthority(latest.authority, pending.authority)
        )
          request.value = null;
        input.composerError.value = readableHomeError(error);
      }
      return false;
    } finally {
      finishSubmitting(command);
    }
  }

  return {
    capabilityTargetRequest: request,
    prepareCapabilityInstall,
    reconcileCapabilityTargetSelection,
    reconcileCapabilityTargetDraft,
    toggleCapabilityTarget,
    toggleAllCapabilityTargets,
    clearCapabilityTargetSelection,
    cancelCapabilityTargetSelection,
    confirmCapabilityTargets,
  };
}
