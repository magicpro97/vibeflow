import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { BrowserHostActionRequestV1, HostActionV1 } from "../../actions/index.js";
import { ENGINE_SESSION_MODE } from "../../dispatch/session-contract.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { materializeConversationHostTools } from "./conversation-host-tool-policy.js";
import type { ConversationMessageQueueTargetParticipantsV1 } from "./conversation-message-queue-contract.js";
import { ConversationRevisionCandidateInvalidError } from "./revision-errors.js";
import type { ConversationBinding, ConversationManifest, MessageRequest } from "./types.js";

export type ConversationRevisionMutationV1 = Extract<
  BrowserHostActionRequestV1,
  { type: (typeof CONVERSATION_REVISION_MUTATION_KINDS)[number] }
>;

export const CONVERSATION_REVISION_MUTATION_KINDS = Object.freeze([
  HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS,
  HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE,
] as const);

export function isConversationRevisionMutation(
  action: BrowserHostActionRequestV1 | HostActionV1,
): action is ConversationRevisionMutationV1 {
  return CONVERSATION_REVISION_MUTATION_KINDS.some((kind) => kind === action.type);
}

function fresh(binding: ConversationBinding): ConversationBinding {
  return {
    ...structuredClone(binding),
    input: {
      ...structuredClone(binding.input),
      sessionMode: ENGINE_SESSION_MODE.FRESH,
    },
  };
}

function participantId(
  parent: ConversationManifest,
  action: Extract<
    ConversationRevisionMutationV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT }
  >,
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
  action: Extract<
    ConversationRevisionMutationV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT }
  >,
  idempotencyKey: string,
): ConversationBinding {
  const participant = action.participant;
  return {
    participant_id: participantId(parent, action, idempotencyKey),
    host_tools: materializeConversationHostTools({ roleRef: participant.role_ref }),
    input: {
      roleRef: participant.role_ref,
      engine: participant.engine,
      sessionMode: ENGINE_SESSION_MODE.FRESH,
      ...(participant.model === null ? {} : { modelOverride: participant.model }),
      additionalSkillRefs: [...participant.skill_refs],
    },
  };
}

function updatedBinding(
  binding: ConversationBinding,
  action: Extract<
    ConversationRevisionMutationV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT }
  >,
): ConversationBinding {
  if (binding.participant_id !== action.participant_id) return fresh(binding);
  const changes = action.changes;
  const priorInput = structuredClone(binding.input);
  const { modelOverride: _modelOverride, ...withoutModel } = priorInput;
  const input: ConversationBinding["input"] = {
    ...(changes.model === null ? withoutModel : priorInput),
    sessionMode: ENGINE_SESSION_MODE.FRESH,
  };
  if (changes.role_ref !== undefined) input.roleRef = changes.role_ref;
  if (changes.engine !== undefined) input.engine = changes.engine;
  if (changes.model !== null && changes.model !== undefined) input.modelOverride = changes.model;
  if (changes.skill_refs !== undefined) input.additionalSkillRefs = [...changes.skill_refs];
  return {
    participant_id: binding.participant_id,
    input,
    host_tools: materializeConversationHostTools({
      roleRef: input.roleRef,
      explicit: binding.host_tools ?? [],
    }),
  };
}

/** Materializes the complete immutable child manifest preimage for revision-owned actions. */
export function applyConversationRevisionMutation(input: {
  parent: ConversationManifest;
  action: ConversationRevisionMutationV1;
  idempotencyKey: string;
}): ConversationManifest {
  const manifest = structuredClone(input.parent);
  const action = input.action;
  if (action.type === HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT) {
    const addition = addedBinding(manifest, action, input.idempotencyKey);
    if (manifest.bindings.some((binding) => binding.participant_id === addition.participant_id))
      throw new ConversationRevisionCandidateInvalidError(
        "derived participant identity already exists",
      );
    manifest.bindings = [...manifest.bindings.map(fresh), addition];
  } else if (action.type === HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT) {
    if (!manifest.bindings.some((binding) => binding.participant_id === action.participant_id))
      throw new ConversationRevisionCandidateInvalidError("revision participant is absent");
    manifest.bindings = manifest.bindings
      .filter((binding) => binding.participant_id !== action.participant_id)
      .map(fresh);
    if (manifest.bindings.length === 0)
      throw new ConversationRevisionCandidateInvalidError(
        "conversation revision requires at least one participant",
      );
  } else if (action.type === HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT) {
    if (!manifest.bindings.some((binding) => binding.participant_id === action.participant_id))
      throw new ConversationRevisionCandidateInvalidError("revision participant is absent");
    manifest.bindings = manifest.bindings.map((binding) => updatedBinding(binding, action));
  } else {
    manifest.bindings = manifest.bindings.map(fresh);
    if (action.type === HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS) {
      if (action.changes.policy !== undefined) manifest.policy = action.changes.policy;
      if (action.changes.max_rounds !== undefined) manifest.max_rounds = action.changes.max_rounds;
      if (action.changes.baseline_enabled !== undefined)
        manifest.baseline_enabled = action.changes.baseline_enabled;
    }
  }
  return manifest;
}

export function revisionMessageRequest(action: ConversationRevisionMutationV1):
  | (MessageRequest & {
      target_participants: ConversationMessageQueueTargetParticipantsV1;
    })
  | null {
  return action.type === HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE
    ? {
        content: action.content,
        target_participants: action.target_participants,
        ...(action.quote_refs ? { quote_refs: structuredClone(action.quote_refs) } : {}),
      }
    : null;
}
