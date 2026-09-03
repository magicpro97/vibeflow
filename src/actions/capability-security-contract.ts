import {
  ACTION_PACKAGE_PIN_SOURCE_KIND,
  ACTION_PACKAGE_PIN_SOURCE_KINDS,
  ACTION_PACKAGE_PIN_TRUST,
  ACTION_PACKAGE_PIN_TRUST_VALUE,
  type ActionPackagePinSourceKind,
  type ActionPackagePinTrust,
} from "./public-action-vocabulary-contract.js";

type ValueOf<Contract> = Contract[keyof Contract];
const values = <const Contract extends Readonly<Record<string, string>>>(contract: Contract) =>
  Object.freeze(Object.values(contract)) as readonly ValueOf<Contract>[];
const memberOf = <Value extends string>(items: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && items.some((candidate) => candidate === value);

export const CAPABILITY_SOURCE_KIND = ACTION_PACKAGE_PIN_SOURCE_KIND;
export type CapabilitySourceKind = ActionPackagePinSourceKind;
export const CAPABILITY_SOURCE_KINDS = ACTION_PACKAGE_PIN_SOURCE_KINDS;
export const isCapabilitySourceKind = (value: unknown): value is CapabilitySourceKind =>
  memberOf(CAPABILITY_SOURCE_KINDS, value);

export const CAPABILITY_PACKAGE_PIN_TRUST = ACTION_PACKAGE_PIN_TRUST_VALUE;
export type CapabilityPackagePinTrust = ActionPackagePinTrust;
export const CAPABILITY_PACKAGE_PIN_TRUST_VALUES = ACTION_PACKAGE_PIN_TRUST;
export const isCapabilityPackagePinTrust = (value: unknown): value is CapabilityPackagePinTrust =>
  memberOf(CAPABILITY_PACKAGE_PIN_TRUST_VALUES, value);

const pinPolicy = <Trust extends CapabilityPackagePinTrust, Portable extends boolean>(
  trust: Trust,
  nonportable: Portable,
) => Object.freeze({ trust, nonportable });
export const CAPABILITY_PACKAGE_PIN_POLICY_BY_SOURCE = Object.freeze({
  [CAPABILITY_SOURCE_KIND.REGISTRY]: pinPolicy(CAPABILITY_PACKAGE_PIN_TRUST.VERIFIED, false),
  [CAPABILITY_SOURCE_KIND.GIT]: pinPolicy(CAPABILITY_PACKAGE_PIN_TRUST.SOURCE_PINNED, false),
  [CAPABILITY_SOURCE_KIND.LOCAL_DEV]: pinPolicy(CAPABILITY_PACKAGE_PIN_TRUST.DEV_UNVERIFIED, true),
  [CAPABILITY_SOURCE_KIND.LEGACY_ADOPT]: pinPolicy(
    CAPABILITY_PACKAGE_PIN_TRUST.LEGACY_VERIFIED,
    false,
  ),
} as const satisfies Readonly<
  Record<CapabilitySourceKind, Readonly<{ trust: CapabilityPackagePinTrust; nonportable: boolean }>>
>);

export const CAPABILITY_REGISTRY_TRUST_KEY_STATE = Object.freeze({
  ACTIVE: "active",
  DEPRECATED: "deprecated",
  REVOKED: "revoked",
} as const);
export type CapabilityRegistryTrustKeyState = ValueOf<typeof CAPABILITY_REGISTRY_TRUST_KEY_STATE>;
export const CAPABILITY_REGISTRY_TRUST_KEY_STATES = values(CAPABILITY_REGISTRY_TRUST_KEY_STATE);
export const isCapabilityRegistryTrustKeyState = (
  value: unknown,
): value is CapabilityRegistryTrustKeyState =>
  memberOf(CAPABILITY_REGISTRY_TRUST_KEY_STATES, value);

export const CAPABILITY_REGISTRY_ENVELOPE_STATUS = Object.freeze({
  VERIFIED: "verified",
  STALE: "stale",
  BLOCKED: "blocked",
} as const);
export type CapabilityRegistryEnvelopeStatus = ValueOf<typeof CAPABILITY_REGISTRY_ENVELOPE_STATUS>;
export const CAPABILITY_REGISTRY_ENVELOPE_STATUSES = values(CAPABILITY_REGISTRY_ENVELOPE_STATUS);
export const isCapabilityRegistryEnvelopeStatus = (
  value: unknown,
): value is CapabilityRegistryEnvelopeStatus =>
  memberOf(CAPABILITY_REGISTRY_ENVELOPE_STATUSES, value);

export const CAPABILITY_SIGNATURE_ALGORITHM = Object.freeze({ ED25519: "Ed25519" } as const);
export type CapabilitySignatureAlgorithm = ValueOf<typeof CAPABILITY_SIGNATURE_ALGORITHM>;
export const CAPABILITY_SIGNATURE_ALGORITHMS = values(CAPABILITY_SIGNATURE_ALGORITHM);
export const isCapabilitySignatureAlgorithm = (
  value: unknown,
): value is CapabilitySignatureAlgorithm => memberOf(CAPABILITY_SIGNATURE_ALGORITHMS, value);

export const CAPABILITY_AUTHORITY_CHANGE = Object.freeze({
  GRANT_CHANGED: "grant-changed",
  POLICY_CHANGED: "policy-changed",
  SECRET_REVOKED: "secret-revoked",
  REGISTRY_TRUST_CHANGED: "registry-trust-changed",
  AUTHORITY_REPAIRED: "authority-repaired",
} as const);
export type CapabilityAuthorityChange = ValueOf<typeof CAPABILITY_AUTHORITY_CHANGE>;
export const CAPABILITY_AUTHORITY_CHANGES = values(CAPABILITY_AUTHORITY_CHANGE);
export const isCapabilityAuthorityChange = (value: unknown): value is CapabilityAuthorityChange =>
  memberOf(CAPABILITY_AUTHORITY_CHANGES, value);

export const CAPABILITY_GRANT_TRANSITION = Object.freeze({
  ISSUED: "issued",
  RENEWED: "renewed",
  REVOKED: "revoked",
} as const);
export type CapabilityGrantTransition = ValueOf<typeof CAPABILITY_GRANT_TRANSITION>;
export const CAPABILITY_GRANT_TRANSITIONS = values(CAPABILITY_GRANT_TRANSITION);
export const isCapabilityGrantTransition = (value: unknown): value is CapabilityGrantTransition =>
  memberOf(CAPABILITY_GRANT_TRANSITIONS, value);

export const CAPABILITY_TRUST_TRANSITION = Object.freeze({
  ADDED: "added",
  RESCOPED: "rescoped",
  DEPRECATED: "deprecated",
  REVOKED: "revoked",
} as const);
export type CapabilityTrustTransition = ValueOf<typeof CAPABILITY_TRUST_TRANSITION>;
export const CAPABILITY_TRUST_TRANSITIONS = values(CAPABILITY_TRUST_TRANSITION);
export const isCapabilityTrustTransition = (value: unknown): value is CapabilityTrustTransition =>
  memberOf(CAPABILITY_TRUST_TRANSITIONS, value);
export const CAPABILITY_TRUST_KEY_STATE_BY_TRANSITION = Object.freeze({
  [CAPABILITY_TRUST_TRANSITION.ADDED]: CAPABILITY_REGISTRY_TRUST_KEY_STATE.ACTIVE,
  [CAPABILITY_TRUST_TRANSITION.RESCOPED]: CAPABILITY_REGISTRY_TRUST_KEY_STATE.ACTIVE,
  [CAPABILITY_TRUST_TRANSITION.DEPRECATED]: CAPABILITY_REGISTRY_TRUST_KEY_STATE.DEPRECATED,
  [CAPABILITY_TRUST_TRANSITION.REVOKED]: CAPABILITY_REGISTRY_TRUST_KEY_STATE.REVOKED,
} as const satisfies Readonly<Record<CapabilityTrustTransition, CapabilityRegistryTrustKeyState>>);
