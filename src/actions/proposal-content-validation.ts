import { isAgentEngine } from "../core/agent-contract.js";
import { CAPABILITY_SCOPE, isCapabilityScope } from "../core/capability-contract.js";
import { digestHex, digestV1 } from "../durability/index.js";
import {
  type CapabilityHostActionKind,
  HOST_ACTION_KIND,
  type HostActionKind,
  isCapabilityHostActionKind,
} from "./host-action-contract.js";
import type { HostActionV1 } from "./internal-action-types.js";
import { validatePackagePin } from "./package-pin-validation.js";
import type { ActionTargetBindingV1, PackagePinV1 } from "./preview-types.js";
import { validateProposalPreview } from "./preview-validation.js";
import {
  ACTION_CONFIG_DIFF_MODE,
  ACTION_EFFECT_RISK_RANK,
  ACTION_PACKAGE_PIN_TRUST_VALUE,
  ACTION_PERMISSION_CHANGE,
  ACTION_PERMISSION_ENFORCEMENT_VALUE,
  ACTION_REVERSIBILITY_RISK_RANK,
  ACTION_RISK_BY_RANK,
  ACTION_RISK_RANK,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
} from "./public-operation-contract.js";
import { assertDigest, assertOpaqueId, assertPackageId, bytewise } from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";
import type { ActionProposalDraftV1, ActionRisk } from "./types.js";

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

export const EMPTY_ADAPTER_SET_DIGEST = digestV1("VF-ADAPTER-SET\0v1\0", {
  schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
  adapter_registry_digest: null,
  adapters: [],
});
export const EMPTY_PERMISSION_DIGEST = digestV1("VF-PERMISSION-BINDING\0v1\0", {
  schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
  permissions: [],
  secret_input_ids: [],
});
export const EMPTY_SOURCE_AUTHORITY_SET_DIGEST = digestV1(
  "VF-RESOLVED-SOURCE-AUTHORITY-SET\0v1\0",
  [],
);

export const AUTHORITY_HOST_ACTION_KINDS = Object.freeze([
  HOST_ACTION_KIND.GRANT_CREATE,
  HOST_ACTION_KIND.GRANT_RENEW,
  HOST_ACTION_KIND.GRANT_REVOKE,
  HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
  HOST_ACTION_KIND.SECRET_REVOKE,
  HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
] as const satisfies readonly HostActionKind[]);

export type AuthorityHostActionKind = Extract<
  HostActionKind,
  `grant.${string}` | `policy.${string}` | `secret.${string}` | `registry.${string}`
>;

const _authorityActionKindParity = true satisfies SameUnion<
  (typeof AUTHORITY_HOST_ACTION_KINDS)[number],
  AuthorityHostActionKind
>;
void _authorityActionKindParity;
export function isCapabilityAction(type: string): type is CapabilityHostActionKind {
  return isCapabilityHostActionKind(type);
}

export function isAuthorityAction(type: string): type is AuthorityHostActionKind {
  return AUTHORITY_HOST_ACTION_KINDS.some((candidate) => candidate === type);
}

export function validateProposalContent(draft: ActionProposalDraftV1): void {
  validateTargets(draft.target_set, draft.action);
  validatePins(draft.package_pins);
  validateProposalPreview(draft);
  validateDigests(draft);
  if (deriveRisk(draft) !== draft.risk) invalid("risk is not the exact host-derived floor");
}

export function targetId(binding: Omit<ActionTargetBindingV1, "target_id">): string {
  return `vf-target-${digestHex(
    digestV1("VF-ACTION-TARGET-ID\0v1\0", {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      ...binding,
    }),
  )}`;
}

function validateTargets(targets: ActionTargetBindingV1[], action: HostActionV1): void {
  if (!Array.isArray(targets) || targets.length > 64) invalid("target count exceeds 64");
  const ids: string[] = [];
  for (const [index, binding] of targets.entries()) {
    const path = `$.proposal.target_set[${index}]`;
    const row = exactObject(binding, ["target_id", "target", "subject"], [], path);
    const target = exactObject(
      row.target,
      ["scope", "engine", "participant_id", "required", "on_apply_failure", "on_health_failure"],
      [],
      `${path}.target`,
    );
    if (!isCapabilityScope(target.scope)) invalid("invalid target scope");
    if (target.engine !== null && !isAgentEngine(target.engine)) invalid("invalid target engine");
    if (target.participant_id !== null)
      assertOpaqueId(target.participant_id, `${path}.target.participant_id`);
    if (
      target.required === true &&
      (target.on_apply_failure !== PUBLIC_ACTION_TARGET_APPLY_FAILURE.ABORT_SCOPE ||
        target.on_health_failure !== PUBLIC_ACTION_TARGET_HEALTH_FAILURE.ABORT_SCOPE)
    )
      invalid("required target failure policy mismatch");
    if (
      target.required === false &&
      (target.on_apply_failure !== PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK ||
        (target.on_health_failure !== PUBLIC_ACTION_TARGET_HEALTH_FAILURE.OMIT_AFTER_ROLLBACK &&
          target.on_health_failure !== PUBLIC_ACTION_TARGET_HEALTH_FAILURE.COMMIT_DEGRADED))
    )
      invalid("optional target failure policy mismatch");
    if (typeof target.required !== "boolean") invalid("invalid target required flag");
    const subject = exactObject(
      row.subject,
      ["kind"],
      ["action_type", "participant_id", "package_id", "component_id"],
      `${path}.subject`,
    );
    if (subject.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION) {
      exactObject(row.subject, ["kind", "action_type", "participant_id"], [], `${path}.subject`);
      if (subject.action_type !== action.type) invalid("target subject action mismatch");
      if (subject.participant_id !== null)
        assertOpaqueId(subject.participant_id, `${path}.subject.participant_id`);
    } else if (subject.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY) {
      exactObject(row.subject, ["kind", "package_id", "component_id"], [], `${path}.subject`);
      assertPackageId(subject.package_id, `${path}.subject.package_id`);
      assertOpaqueId(subject.component_id, `${path}.subject.component_id`);
    } else invalid("invalid target subject");
    const expected = targetId({ target: binding.target, subject: binding.subject });
    if (binding.target_id !== expected) invalid("target ID does not match identity");
    ids.push(expected);
  }
  assertOrderedUnique(ids, "target set");
}

function validatePins(pins: PackagePinV1[]): void {
  if (!Array.isArray(pins) || pins.length > 256) invalid("package pin count exceeds 256");
  const identities: string[] = [];
  for (const [index, pin] of pins.entries()) {
    const path = `$.proposal.package_pins[${index}]`;
    exactObject(
      pin,
      ["id", "version", "source", "content_sha256", "trust", "nonportable", "pin_digest"],
      [],
      path,
    );
    validatePackagePin(pin, path);
    identities.push(`${pin.id}\0${pin.version}\0${pin.source.kind}\0${pin.pin_digest}`);
  }
  assertOrderedUnique(identities, "package pins");
}

function validateDigests(draft: ActionProposalDraftV1): void {
  for (const key of [
    "source_authority_set_digest",
    "adapter_set_digest",
    "plan_digest",
    "policy_digest",
    "grant_digest",
    "permission_digest",
  ] as const)
    assertDigest(draft[key], `$.proposal.${key}`);
  if (draft.handoff_selection_digest !== null)
    assertDigest(draft.handoff_selection_digest, "$.proposal.handoff_selection_digest");
  if (
    !isCapabilityAction(draft.action.type) &&
    (draft.adapter_set_digest !== EMPTY_ADAPTER_SET_DIGEST ||
      draft.permission_digest !== EMPTY_PERMISSION_DIGEST ||
      draft.source_authority_set_digest !== EMPTY_SOURCE_AUTHORITY_SET_DIGEST)
  )
    invalid("non-capability proposal lacks canonical empty bindings");
}

function deriveRisk(draft: ActionProposalDraftV1): ActionRisk {
  let rank: number =
    draft.action.type === HOST_ACTION_KIND.AUTHORITY_REPAIR ||
    draft.action.type === HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL
      ? ACTION_RISK_RANK.CRITICAL
      : isAuthorityAction(draft.action.type) ||
          draft.action.type === HOST_ACTION_KIND.CAPABILITY_ADOPT
        ? ACTION_RISK_RANK.HIGH
        : ACTION_RISK_RANK.MEDIUM;
  for (const effect of draft.effect_classes)
    rank = Math.max(rank, ACTION_EFFECT_RISK_RANK[effect] ?? ACTION_RISK_RANK.UNKNOWN);
  rank = Math.max(
    rank,
    ACTION_REVERSIBILITY_RISK_RANK[draft.reversibility] ?? ACTION_RISK_RANK.UNKNOWN,
  );
  if (
    draft.base.capability_scope === CAPABILITY_SCOPE.USER ||
    draft.target_set.some((row) => row.target.scope === CAPABILITY_SCOPE.USER) ||
    draft.package_pins.some(
      (pin) =>
        pin.trust === ACTION_PACKAGE_PIN_TRUST_VALUE.DEV_UNVERIFIED ||
        pin.trust === ACTION_PACKAGE_PIN_TRUST_VALUE.LEGACY_VERIFIED,
    ) ||
    draft.preview.permission_delta.some(
      (row) =>
        row.change === ACTION_PERMISSION_CHANGE.ADD ||
        row.change === ACTION_PERMISSION_CHANGE.EXPAND,
    ) ||
    draft.preview.enforcement.some(
      (row) => row.enforcement === ACTION_PERMISSION_ENFORCEMENT_VALUE.DISCLOSED_NOT_ENFORCED,
    ) ||
    draft.preview.config_diffs.some(
      (row) =>
        row.mode === ACTION_CONFIG_DIFF_MODE.FULL_FILE ||
        row.mode === ACTION_CONFIG_DIFF_MODE.MANUAL,
    )
  )
    rank = Math.max(rank, ACTION_RISK_RANK.HIGH);
  if (rank >= ACTION_RISK_RANK.UNKNOWN) invalid("unknown effect class");
  return ACTION_RISK_BY_RANK[rank] as ActionRisk;
}

function assertOrderedUnique(values: string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== [...values].sort(bytewise)[index])
  )
    invalid(`${label} is duplicated or not canonically ordered`);
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.proposal");
}
