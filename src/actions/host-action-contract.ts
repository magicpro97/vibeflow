/** Dependency-free closed vocabulary for every durable host action. */
export const HOST_ACTION_KIND = Object.freeze({
  CONVERSATION_ADD_PARTICIPANT: "conversation.add_participant",
  CONVERSATION_REMOVE_PARTICIPANT: "conversation.remove_participant",
  CONVERSATION_UPDATE_PARTICIPANT: "conversation.update_participant",
  CONVERSATION_UPDATE_SETTINGS: "conversation.update_settings",
  CONVERSATION_CONTINUE_MESSAGE: "conversation.continue_message",
  CONVERSATION_SELECT_LINEAGE_HEAD: "conversation.select_lineage_head",
  CONVERSATION_ASSOCIATE_LINEAGES: "conversation.associate_lineages",
  CONVERSATION_PUBLISH_SUSPECTED_LITERAL: "conversation.publish_suspected_literal",
  CONVERSATION_STOP_OPERATION: "conversation.stop_operation",
  CONVERSATION_ABANDON_REVISION_OPERATION: "conversation.abandon_revision_operation",
  CONVERSATION_RETRY_REVISION_OPERATION: "conversation.retry_revision_operation",
  CONVERSATION_RECONCILE_REVISION_OPERATION: "conversation.reconcile_revision_operation",
  CONTEXT_COMPACT: "context.compact",
  CAPABILITY_INSTALL: "capability.install",
  CAPABILITY_UPDATE: "capability.update",
  CAPABILITY_CONFIGURE: "capability.configure",
  CAPABILITY_RETARGET: "capability.retarget",
  CAPABILITY_REMOVE: "capability.remove",
  CAPABILITY_ROLLBACK_SCOPE: "capability.rollback_scope",
  CAPABILITY_RESTORE_PACKAGE: "capability.restore_package",
  CAPABILITY_REPAIR: "capability.repair",
  CAPABILITY_ADOPT: "capability.adopt",
  GRANT_CREATE: "grant.create",
  GRANT_RENEW: "grant.renew",
  GRANT_REVOKE: "grant.revoke",
  POLICY_UPDATE_AUTHORITY: "policy.update_authority",
  SECRET_REVOKE: "secret.revoke",
  REGISTRY_TRUST_KEY: "registry.trust_key",
  AUTHORITY_REPAIR: "authority.repair",
} as const);

export type HostActionKind = (typeof HOST_ACTION_KIND)[keyof typeof HOST_ACTION_KIND];

export const HOST_ACTION_KIND_VALUES = Object.freeze(Object.values(HOST_ACTION_KIND));

/** Read-only authorization verbs which are not themselves executable host actions. */
export const CAPABILITY_AUTHORIZATION_ACTION_KIND = Object.freeze({
  DISCOVER: "capability.discover",
} as const);
export type CapabilityAuthorizationActionKind =
  (typeof CAPABILITY_AUTHORIZATION_ACTION_KIND)[keyof typeof CAPABILITY_AUTHORIZATION_ACTION_KIND];
export const CAPABILITY_AUTHORIZATION_ACTION_KINDS = Object.freeze(
  Object.values(CAPABILITY_AUTHORIZATION_ACTION_KIND),
);
export type AuthorizableActionKind = HostActionKind | CapabilityAuthorizationActionKind;
export const AUTHORIZABLE_ACTION_KINDS = Object.freeze([
  ...HOST_ACTION_KIND_VALUES,
  ...CAPABILITY_AUTHORIZATION_ACTION_KINDS,
] as const);

export const HOST_ACTION_NAMESPACE = Object.freeze({
  CONVERSATION: "conversation.",
  CAPABILITY: "capability.",
} as const);

export type ConversationHostActionKind =
  | Extract<HostActionKind, `conversation.${string}`>
  | typeof HOST_ACTION_KIND.CONTEXT_COMPACT;
export const CONVERSATION_HOST_ACTION_KINDS = Object.freeze(
  HOST_ACTION_KIND_VALUES.filter(
    (value): value is ConversationHostActionKind =>
      value.startsWith(HOST_ACTION_NAMESPACE.CONVERSATION) ||
      value === HOST_ACTION_KIND.CONTEXT_COMPACT,
  ),
);

export type CapabilityHostActionKind = Extract<HostActionKind, `capability.${string}`>;
export const CAPABILITY_HOST_ACTION_KINDS = Object.freeze(
  HOST_ACTION_KIND_VALUES.filter((value): value is CapabilityHostActionKind =>
    value.startsWith(HOST_ACTION_NAMESPACE.CAPABILITY),
  ),
);

export const isHostActionKind = (value: unknown): value is HostActionKind =>
  typeof value === "string" && HOST_ACTION_KIND_VALUES.some((candidate) => candidate === value);

export const isAuthorizableActionKind = (value: unknown): value is AuthorizableActionKind =>
  typeof value === "string" && AUTHORIZABLE_ACTION_KINDS.some((candidate) => candidate === value);

export const isCapabilityHostActionKind = (value: unknown): value is CapabilityHostActionKind =>
  typeof value === "string" &&
  CAPABILITY_HOST_ACTION_KINDS.some((candidate) => candidate === value);

export const isConversationHostActionKind = (value: unknown): value is ConversationHostActionKind =>
  typeof value === "string" &&
  CONVERSATION_HOST_ACTION_KINDS.some((candidate) => candidate === value);
