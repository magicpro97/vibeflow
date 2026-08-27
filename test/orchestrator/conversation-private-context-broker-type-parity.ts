import type {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS,
  CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-contract.js";
import type {
  ConversationHomeCreateRequestV1,
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PrivateConversationContextDiscardBindingV1,
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
  PublicConversationPrivateContextPresenceV1,
  StageConversationDraftPrivateContextRequestV1,
  StageConversationMessagePrivateContextRequestV1,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-types.js";
import type { ConversationCreateParticipant } from "../../src/orchestrator/conversation/types.js";

type SameKeys<RecordType, Fields extends readonly PropertyKey[]> = Exclude<
  keyof RecordType,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof RecordType> extends never
    ? true
    : false
  : false;

type RequiredKeys<RecordType> = {
  [Key in keyof RecordType]-?: Record<string, never> extends Pick<RecordType, Key> ? never : Key;
}[keyof RecordType];

type OptionalKeys<RecordType> = Exclude<keyof RecordType, RequiredKeys<RecordType>>;
type RequiredFields<RecordType> = Pick<RecordType, RequiredKeys<RecordType>>;
type OptionalFields<RecordType> = Pick<RecordType, OptionalKeys<RecordType>>;

type ParticipantRequiredFieldTuple = readonly [
  typeof CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.ROLE_REF,
  typeof CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.ENGINE,
];

type ParticipantOptionalFieldTuple = readonly [
  typeof CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.MODEL,
  typeof CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.HOST_TOOLS,
];

export const exactBrokerFieldTypeParity = Object.freeze({
  PUBLIC_PRESENCE: true satisfies SameKeys<
    PublicConversationPrivateContextPresenceV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.PUBLIC_PRESENCE
  >,
  MESSAGE_STAGE_REQUEST: true satisfies SameKeys<
    StageConversationMessagePrivateContextRequestV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_STAGE_REQUEST
  >,
  DRAFT_STAGE_REQUEST: true satisfies SameKeys<
    StageConversationDraftPrivateContextRequestV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_STAGE_REQUEST
  >,
  MESSAGE_DISCARD_REQUEST: true satisfies SameKeys<
    DiscardConversationMessagePrivateContextRequestV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_DISCARD_REQUEST
  >,
  DRAFT_DISCARD_REQUEST: true satisfies SameKeys<
    DiscardConversationDraftPrivateContextRequestV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_DISCARD_REQUEST
  >,
  HOME_CREATE_REQUIRED: true satisfies SameKeys<
    RequiredFields<ConversationHomeCreateRequestV1>,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.HOME_CREATE_REQUIRED
  >,
  HOME_CREATE_OPTIONAL: true satisfies SameKeys<
    OptionalFields<ConversationHomeCreateRequestV1>,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.HOME_CREATE_OPTIONAL
  >,
  HOME_CREATE_PARTICIPANT: true satisfies SameKeys<
    ConversationCreateParticipant,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.HOME_CREATE_PARTICIPANT
  >,
  HOME_CREATE_PARTICIPANT_REQUIRED: true satisfies SameKeys<
    RequiredFields<ConversationCreateParticipant>,
    ParticipantRequiredFieldTuple
  >,
  HOME_CREATE_PARTICIPANT_OPTIONAL: true satisfies SameKeys<
    OptionalFields<ConversationCreateParticipant>,
    ParticipantOptionalFieldTuple
  >,
  MESSAGE_STAGE: true satisfies SameKeys<
    PrivateConversationMessageContextStageV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_STAGE
  >,
  DRAFT_STAGE: true satisfies SameKeys<
    PrivateConversationDraftContextStageV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_STAGE
  >,
  DISCARD_BINDING: true satisfies SameKeys<
    PrivateConversationContextDiscardBindingV1,
    typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DISCARD_BINDING
  >,
});
