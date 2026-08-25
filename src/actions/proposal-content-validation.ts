import { digestHex, digestV1 } from "../durability/index.js";
import type { HostActionV1 } from "./internal-action-types.js";
import { validatePackagePin } from "./package-pin-validation.js";
import type { ActionTargetBindingV1, PackagePinV1 } from "./preview-types.js";
import { validateProposalPreview } from "./preview-validation.js";
import { assertDigest, assertOpaqueId, assertPackageId, bytewise } from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";
import type { ActionProposalDraftV1, ActionRisk } from "./types.js";

export const EMPTY_ADAPTER_SET_DIGEST = digestV1("VF-ADAPTER-SET\0v1\0", {
  schema_version: "1.0",
  adapter_registry_digest: null,
  adapters: [],
});
export const EMPTY_PERMISSION_DIGEST = digestV1("VF-PERMISSION-BINDING\0v1\0", {
  schema_version: "1.0",
  permissions: [],
  secret_input_ids: [],
});
export const EMPTY_SOURCE_AUTHORITY_SET_DIGEST = digestV1(
  "VF-RESOLVED-SOURCE-AUTHORITY-SET\0v1\0",
  [],
);

const CAPABILITY_ACTIONS = new Set([
  "capability.install",
  "capability.update",
  "capability.configure",
  "capability.retarget",
  "capability.remove",
  "capability.rollback_scope",
  "capability.restore_package",
  "capability.repair",
  "capability.adopt",
]);
const AUTHORITY_ACTIONS = new Set([
  "grant.create",
  "grant.renew",
  "grant.revoke",
  "policy.update_authority",
  "secret.revoke",
  "registry.trust_key",
]);
const EFFECT_RANK = new Map([
  ["pure-local-read", 0],
  ["local-read-with-cache", 0],
  ["network-read", 0],
  ["process-probe", 0],
  ["project-write", 1],
  ["user-write", 2],
  ["external-compensatable", 2],
  ["external-irreversible", 3],
]);
const RISKS: ActionRisk[] = ["low", "medium", "high", "critical"];
const ENGINES = new Set(["claude", "codex", "copilot", "opencode", "antigravity"]);

export function isCapabilityAction(type: string): boolean {
  return CAPABILITY_ACTIONS.has(type);
}

export function isAuthorityAction(type: string): boolean {
  return AUTHORITY_ACTIONS.has(type);
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
    digestV1("VF-ACTION-TARGET-ID\0v1\0", { schema_version: "1.0", ...binding }),
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
    if (!["project", "user"].includes(target.scope as string)) invalid("invalid target scope");
    if (target.engine !== null && !ENGINES.has(target.engine as string))
      invalid("invalid target engine");
    if (target.participant_id !== null)
      assertOpaqueId(target.participant_id, `${path}.target.participant_id`);
    if (
      target.required === true &&
      (target.on_apply_failure !== "abort-scope" || target.on_health_failure !== "abort-scope")
    )
      invalid("required target failure policy mismatch");
    if (
      target.required === false &&
      (target.on_apply_failure !== "omit-after-rollback" ||
        !["omit-after-rollback", "commit-degraded"].includes(target.on_health_failure as string))
    )
      invalid("optional target failure policy mismatch");
    if (typeof target.required !== "boolean") invalid("invalid target required flag");
    const subject = exactObject(
      row.subject,
      ["kind"],
      ["action_type", "participant_id", "package_id", "component_id"],
      `${path}.subject`,
    );
    if (subject.kind === "conversation") {
      exactObject(row.subject, ["kind", "action_type", "participant_id"], [], `${path}.subject`);
      if (subject.action_type !== action.type) invalid("target subject action mismatch");
      if (subject.participant_id !== null)
        assertOpaqueId(subject.participant_id, `${path}.subject.participant_id`);
    } else if (subject.kind === "capability") {
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
  let rank =
    draft.action.type === "authority.repair" ||
    draft.action.type === "conversation.publish_suspected_literal"
      ? 3
      : isAuthorityAction(draft.action.type) || draft.action.type === "capability.adopt"
        ? 2
        : 1;
  for (const effect of draft.effect_classes) rank = Math.max(rank, EFFECT_RANK.get(effect) ?? 4);
  rank = Math.max(
    rank,
    { reversible: 0, compensatable: 1, manual: 2, irreversible: 3 }[draft.reversibility],
  );
  if (
    draft.base.capability_scope === "user" ||
    draft.target_set.some((row) => row.target.scope === "user") ||
    draft.package_pins.some((pin) => ["dev-unverified", "legacy-verified"].includes(pin.trust)) ||
    draft.preview.permission_delta.some((row) => ["add", "expand"].includes(row.change)) ||
    draft.preview.enforcement.some((row) => row.enforcement === "disclosed-not-enforced") ||
    draft.preview.config_diffs.some((row) => ["full-file", "manual"].includes(row.mode))
  )
    rank = Math.max(rank, 2);
  if (rank > 3) invalid("unknown effect class");
  return RISKS[rank] as ActionRisk;
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
