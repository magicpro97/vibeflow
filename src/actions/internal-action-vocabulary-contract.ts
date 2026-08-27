import { ACTION_SCOPE, type ActionScope } from "./public-action-vocabulary-contract.js";

type ValueOf<Contract> = Contract[keyof Contract];

const values = <const Contract extends Readonly<Record<string, string>>>(contract: Contract) =>
  Object.freeze(Object.values(contract)) as readonly ValueOf<Contract>[];

const memberOf = <Value extends string>(items: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && items.some((candidate) => candidate === value);

export const ACTION_AUTHORITY_REPAIR_DOMAIN = Object.freeze({
  CONVERSATION_MANIFEST: "conversation-manifest",
  CONVERSATION_JOURNAL: "conversation-journal",
  CONVERSATION_CONTENT: "conversation-content",
  LINEAGE_HEAD: "lineage-head",
  LINEAGE_RESERVATION: "lineage-reservation",
  LINEAGE_ASSOCIATION: "lineage-association",
  REVISION_OPERATION: "revision-operation",
  ACTION_AUTHORITY: "action-authority",
  CAPABILITY_LOCK: "capability-lock",
  CAPABILITY_OPERATION: "capability-operation",
  CAPABILITY_OUTBOX: "capability-outbox",
  SCOPE_IDENTITY: "scope-identity",
  AUTHORITY_EPOCH: "authority-epoch",
  GRANT_AUTHORITY: "grant-authority",
  POLICY_AUTHORITY: "policy-authority",
  REGISTRY_TRUST: "registry-trust",
  SECRET_REVOCATION: "secret-revocation",
  AUTHORITY_REPAIR: "authority-repair",
} as const);
export type AuthorityRepairDomainV1 = ValueOf<typeof ACTION_AUTHORITY_REPAIR_DOMAIN>;
export const ACTION_AUTHORITY_REPAIR_DOMAINS = values(ACTION_AUTHORITY_REPAIR_DOMAIN);
export const ACTION_AUTHORITY_REPAIR_CONVERSATION_DOMAINS = Object.freeze([
  ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_MANIFEST,
  ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_JOURNAL,
  ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_CONTENT,
  ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_HEAD,
  ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_RESERVATION,
  ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_ASSOCIATION,
  ACTION_AUTHORITY_REPAIR_DOMAIN.REVISION_OPERATION,
] as const);
export const ACTION_AUTHORITY_REPAIR_CAPABILITY_DOMAINS = Object.freeze([
  ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_LOCK,
  ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_OPERATION,
  ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_OUTBOX,
  ACTION_AUTHORITY_REPAIR_DOMAIN.SCOPE_IDENTITY,
  ACTION_AUTHORITY_REPAIR_DOMAIN.AUTHORITY_EPOCH,
  ACTION_AUTHORITY_REPAIR_DOMAIN.GRANT_AUTHORITY,
  ACTION_AUTHORITY_REPAIR_DOMAIN.POLICY_AUTHORITY,
  ACTION_AUTHORITY_REPAIR_DOMAIN.REGISTRY_TRUST,
  ACTION_AUTHORITY_REPAIR_DOMAIN.SECRET_REVOCATION,
] as const);

export const ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND = Object.freeze({
  CONVERSATION_ONLY: "conversation-only",
  CAPABILITY_ONLY: "capability-only",
  ORIGIN_BOUND: "origin-bound",
} as const);
export type AuthorityRepairScopePolicyKind = ValueOf<
  typeof ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND
>;
type AuthorityRepairScopePolicy = Readonly<{
  kind: AuthorityRepairScopePolicyKind;
  allowed_scopes: readonly ActionScope[];
}>;
const conversationOnly = Object.freeze({
  kind: ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND.CONVERSATION_ONLY,
  allowed_scopes: Object.freeze([ACTION_SCOPE.CONVERSATION]),
} as const);
const capabilityOnly = Object.freeze({
  kind: ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND.CAPABILITY_ONLY,
  allowed_scopes: Object.freeze([ACTION_SCOPE.PROJECT, ACTION_SCOPE.USER]),
} as const);
const originBound = Object.freeze({
  kind: ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND.ORIGIN_BOUND,
  allowed_scopes: Object.freeze([
    ACTION_SCOPE.CONVERSATION,
    ACTION_SCOPE.PROJECT,
    ACTION_SCOPE.USER,
  ]),
} as const);

export const ACTION_AUTHORITY_REPAIR_SCOPE_POLICY = Object.freeze({
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_MANIFEST]: conversationOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_JOURNAL]: conversationOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_CONTENT]: conversationOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_HEAD]: conversationOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_RESERVATION]: conversationOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_ASSOCIATION]: conversationOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.REVISION_OPERATION]: conversationOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.ACTION_AUTHORITY]: originBound,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_LOCK]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_OPERATION]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_OUTBOX]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.SCOPE_IDENTITY]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.AUTHORITY_EPOCH]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.GRANT_AUTHORITY]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.POLICY_AUTHORITY]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.REGISTRY_TRUST]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.SECRET_REVOCATION]: capabilityOnly,
  [ACTION_AUTHORITY_REPAIR_DOMAIN.AUTHORITY_REPAIR]: originBound,
} as const satisfies Readonly<Record<AuthorityRepairDomainV1, AuthorityRepairScopePolicy>>);

export const isAuthorityRepairScopeAllowed = (
  domain: AuthorityRepairDomainV1,
  scope: unknown,
): scope is ActionScope =>
  ACTION_AUTHORITY_REPAIR_SCOPE_POLICY[domain].allowed_scopes.some(
    (candidate) => candidate === scope,
  );
export const isAuthorityRepairOriginBoundDomain = (domain: AuthorityRepairDomainV1): boolean =>
  ACTION_AUTHORITY_REPAIR_SCOPE_POLICY[domain].kind ===
  ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND.ORIGIN_BOUND;
export const isAuthorityRepairDomain = (value: unknown): value is AuthorityRepairDomainV1 =>
  memberOf(ACTION_AUTHORITY_REPAIR_DOMAINS, value);

export const ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE = Object.freeze({
  PRESENT: "present",
  ABSENT: "absent",
} as const);
export type AuthorityRepairTargetPreimagePresence = ValueOf<
  typeof ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE
>;
export const ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCES = values(
  ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE,
);
