import type { BrowserHostActionRequestV1, HostActionV1 } from "../../actions/index.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import type { ConversationBinding, ConversationManifest, MessageRequest } from "./types.js";

export type ConversationRevisionMutationV1 = Extract<
  BrowserHostActionRequestV1,
  {
    type:
      | "conversation.add_participant"
      | "conversation.remove_participant"
      | "conversation.update_participant"
      | "conversation.update_settings"
      | "conversation.continue_message";
  }
>;

export function isConversationRevisionMutation(
  action: BrowserHostActionRequestV1 | HostActionV1,
): action is ConversationRevisionMutationV1 {
  return [
    "conversation.add_participant",
    "conversation.remove_participant",
    "conversation.update_participant",
    "conversation.update_settings",
    "conversation.continue_message",
  ].includes(action.type);
}

function fresh(binding: ConversationBinding): ConversationBinding {
  return {
    ...structuredClone(binding),
    input: { ...structuredClone(binding.input), sessionMode: "fresh" },
  };
}

function participantId(
  parent: ConversationManifest,
  action: Extract<ConversationRevisionMutationV1, { type: "conversation.add_participant" }>,
  idempotencyKey: string,
): string {
  const digest = digestV1("VF-CONVERSATION-REVISION-PARTICIPANT\0v1\0", {
    schema_version: "1.0",
    conversation_id: parent.conversation_id,
    revision_id: parent.revision_id,
    idempotency_key: idempotencyKey,
    participant: action.participant,
  });
  return `participant-${digestHex(digest).slice(0, 32)}`;
}

function addedBinding(
  parent: ConversationManifest,
  action: Extract<ConversationRevisionMutationV1, { type: "conversation.add_participant" }>,
  idempotencyKey: string,
): ConversationBinding {
  const participant = action.participant;
  return {
    participant_id: participantId(parent, action, idempotencyKey),
    input: {
      roleRef: participant.role_ref,
      engine: participant.engine,
      sessionMode: "fresh",
      ...(participant.model === null ? {} : { modelOverride: participant.model }),
      additionalSkillRefs: [...participant.skill_refs],
    },
  };
}

function updatedBinding(
  binding: ConversationBinding,
  action: Extract<ConversationRevisionMutationV1, { type: "conversation.update_participant" }>,
): ConversationBinding {
  if (binding.participant_id !== action.participant_id) return fresh(binding);
  const changes = action.changes;
  const priorInput = structuredClone(binding.input);
  const { modelOverride: _modelOverride, ...withoutModel } = priorInput;
  const input: ConversationBinding["input"] = {
    ...(changes.model === null ? withoutModel : priorInput),
    sessionMode: "fresh" as const,
  };
  if (changes.role_ref !== undefined) input.roleRef = changes.role_ref;
  if (changes.engine !== undefined) input.engine = changes.engine;
  if (changes.model !== null && changes.model !== undefined) input.modelOverride = changes.model;
  if (changes.skill_refs !== undefined) input.additionalSkillRefs = [...changes.skill_refs];
  return { participant_id: binding.participant_id, input };
}

/** Materializes the complete immutable child manifest preimage for revision-owned actions. */
export function applyConversationRevisionMutation(input: {
  parent: ConversationManifest;
  action: ConversationRevisionMutationV1;
  idempotencyKey: string;
}): ConversationManifest {
  const manifest = structuredClone(input.parent);
  const action = input.action;
  if (action.type === "conversation.add_participant") {
    const addition = addedBinding(manifest, action, input.idempotencyKey);
    if (manifest.bindings.some((binding) => binding.participant_id === addition.participant_id))
      throw new Error("derived participant identity already exists");
    manifest.bindings = [...manifest.bindings.map(fresh), addition];
  } else if (action.type === "conversation.remove_participant") {
    if (!manifest.bindings.some((binding) => binding.participant_id === action.participant_id))
      throw new Error("revision participant is absent");
    manifest.bindings = manifest.bindings
      .filter((binding) => binding.participant_id !== action.participant_id)
      .map(fresh);
    if (manifest.bindings.length === 0)
      throw new Error("conversation revision requires at least one participant");
  } else if (action.type === "conversation.update_participant") {
    if (!manifest.bindings.some((binding) => binding.participant_id === action.participant_id))
      throw new Error("revision participant is absent");
    manifest.bindings = manifest.bindings.map((binding) => updatedBinding(binding, action));
  } else {
    manifest.bindings = manifest.bindings.map(fresh);
    if (action.type === "conversation.update_settings") {
      if (action.changes.policy !== undefined) manifest.policy = action.changes.policy;
      if (action.changes.max_rounds !== undefined) manifest.max_rounds = action.changes.max_rounds;
      if (action.changes.baseline_enabled !== undefined)
        manifest.baseline_enabled = action.changes.baseline_enabled;
    }
  }
  return manifest;
}

export function revisionMessageRequest(
  action: ConversationRevisionMutationV1,
): (MessageRequest & { target_participants: "all" | string[] }) | null {
  return action.type === "conversation.continue_message"
    ? {
        content: action.content,
        target_participants: action.target_participants,
        ...(action.quote_refs ? { quote_refs: structuredClone(action.quote_refs) } : {}),
      }
    : null;
}
