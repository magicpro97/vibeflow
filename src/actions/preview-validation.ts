import { canonicalJsonBytes } from "../durability/index.js";
import type { HostRenderedPreviewV1 } from "./preview-types.js";
import { assertPublicProjectionSafe } from "./public-safety.js";
import {
  assertDigest,
  assertOpaqueId,
  assertRawSha256,
  assertStringArray,
  bytewise,
} from "./record-primitives.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";
import type { ActionProposalDraftV1 } from "./types.js";

const EFFECTS = [
  "pure-local-read",
  "local-read-with-cache",
  "network-read",
  "process-probe",
  "project-write",
  "user-write",
  "external-compensatable",
  "external-irreversible",
] as const;
const RECOVERY = [
  "retry",
  "edit",
  "refresh-proposal",
  "restart-pagination",
  "complete-challenge",
  "select-lineage-head",
  "rebuild-catalog",
  "resume-by-id",
  "inspect-trace",
  "resolve-again",
  "rollback",
  "repair",
  "repair-authority",
  "verified-abandon",
  "reconcile-revision",
  "adopt",
  "renew-grant",
  "authorize-source",
  "disable",
  "retarget",
  "complete-manual-step",
  "export-redacted-diagnostics",
] as const;
const HEALTH_KINDS = new Set([
  "binary-version",
  "file-hash",
  "mcp-handshake",
  "hook-selftest",
  "role-parse",
  "engine-config",
]);

export function validateProposalPreview(draft: ActionProposalDraftV1): void {
  const preview = exactObject(
    draft.preview,
    [
      "title",
      "summary",
      "action_type",
      "planning_options",
      "review_fields",
      "targets",
      "target_dispositions",
      "package_pins",
      "permission_delta",
      "dependency_delta",
      "config_diffs",
      "effect_classes",
      "enforcement",
      "reversibility",
      "health_plan",
      "recovery_actions",
      "projector_version",
      "rules_digest",
      "redaction_manifest_digest",
    ],
    [],
    "$.proposal.preview",
  ) as unknown as HostRenderedPreviewV1;
  boundedString(preview.title, "$.proposal.preview.title", { max: 256 });
  boundedString(preview.summary, "$.proposal.preview.summary", { max: 8_192 });
  if (
    preview.projector_version !== "vf-public-projector/1" ||
    preview.action_type !== draft.action.type
  )
    invalid("preview identity mismatch");
  for (const key of ["rules_digest", "redaction_manifest_digest"] as const)
    assertDigest(preview[key], `$.proposal.preview.${key}`);
  if (!canonicalJsonBytes(preview.targets).equals(canonicalJsonBytes(draft.target_set)))
    invalid("preview targets mismatch");
  const publicPins = draft.package_pins.map((pin) => ({
    id: pin.id,
    version: pin.version,
    source_kind: pin.source.kind,
    content_sha256: pin.content_sha256,
    trust: pin.trust,
    nonportable: pin.nonportable,
    pin_digest: pin.pin_digest,
  }));
  if (!canonicalJsonBytes(preview.package_pins).equals(canonicalJsonBytes(publicPins)))
    invalid("preview package pins mismatch");
  if (!canonicalJsonBytes(preview.effect_classes).equals(canonicalJsonBytes(draft.effect_classes)))
    invalid("preview effects mismatch");
  if (
    preview.reversibility !== draft.reversibility ||
    !canonicalJsonBytes(preview.planning_options).equals(canonicalJsonBytes(draft.planning_options))
  )
    invalid("preview authority mismatch");
  validateReviewFields(preview.review_fields);
  validateDispositions(
    preview.target_dispositions,
    draft.target_set.map((row) => row.target_id),
  );
  validatePermissions(preview.permission_delta);
  validateDependencies(preview.dependency_delta);
  validateConfigDiffs(
    preview.config_diffs,
    draft.target_set.map((row) => row.target_id),
  );
  orderedEnum(preview.effect_classes, EFFECTS, "effect classes");
  validateEnforcement(preview.enforcement);
  validateHealth(
    preview.health_plan,
    draft.target_set.map((row) => row.target_id),
  );
  orderedEnum(preview.recovery_actions, RECOVERY, "recovery actions");
  assertPublicProjectionSafe(preview, "$.proposal.preview");
}

function validateReviewFields(value: HostRenderedPreviewV1["review_fields"]): void {
  boundedArray(value, 256, "review fields");
  const identities = value.map((field, index) => {
    const path = `$.proposal.preview.review_fields[${index}]`;
    exactObject(
      field,
      ["json_pointer", "label", "before", "after", "private_binding_digest"],
      [],
      path,
    );
    const pointer = boundedString(field.json_pointer, `${path}.json_pointer`, { max: 1_024 });
    if (pointer !== "" && !pointer.startsWith("/")) invalid("invalid review JSON pointer");
    boundedString(field.label, `${path}.label`, { max: 256 });
    canonicalJsonBytes(field.before, { maxBytes: 32 * 1024 });
    canonicalJsonBytes(field.after, { maxBytes: 32 * 1024 });
    if (field.private_binding_digest !== null)
      assertDigest(field.private_binding_digest, `${path}.private_binding_digest`);
    return pointer;
  });
  ordered(identities, "review fields");
}

function validateDispositions(
  value: HostRenderedPreviewV1["target_dispositions"],
  targetIds: string[],
): void {
  boundedArray(value, 64, "target dispositions");
  const identities = value.map((row, index) => {
    const path = `$.proposal.preview.target_dispositions[${index}]`;
    exactObject(row, ["target_id", "execution", "reason_code"], [], path);
    assertOpaqueId(row.target_id, `${path}.target_id`);
    const matrix: Record<string, readonly unknown[]> = {
      host: [null],
      manual: ["manual-config-change", "manual-runtime-setup", "disclosed-not-enforced"],
      "required-user-action": ["native-install-required", "external-confirmation-required"],
      unsupported: ["adapter-unavailable", "enforcement-unavailable", "target-unsupported"],
    };
    if (!matrix[row.execution]?.includes(row.reason_code)) invalid("invalid target disposition");
    return row.target_id;
  });
  ordered(identities, "target dispositions");
  if (!canonicalJsonBytes(identities).equals(canonicalJsonBytes(targetIds)))
    invalid("target dispositions do not cover the exact target set");
}

function validatePermissions(value: HostRenderedPreviewV1["permission_delta"]): void {
  boundedArray(value, 512, "permission deltas");
  const identities = value.map((row, index) => {
    const path = `$.proposal.preview.permission_delta[${index}]`;
    exactObject(row, ["permission_id", "change", "public_scope", "enforcement"], [], path);
    assertOpaqueId(row.permission_id, `${path}.permission_id`);
    boundedString(row.public_scope, `${path}.public_scope`, { max: 512 });
    if (!new Set(["add", "remove", "expand", "narrow", "unchanged"]).has(row.change))
      invalid("invalid permission change");
    if (
      !new Set(["brokered", "sandboxed", "engine-enforced", "disclosed-not-enforced"]).has(
        row.enforcement,
      )
    )
      invalid("invalid permission enforcement");
    return [row.permission_id, row.public_scope, row.enforcement, row.change].join("\0");
  });
  ordered(identities, "permission deltas");
}

function validateDependencies(value: HostRenderedPreviewV1["dependency_delta"]): void {
  boundedArray(value, 512, "dependency deltas");
  const identities = value.map((row, index) => {
    const path = `$.proposal.preview.dependency_delta[${index}]`;
    exactObject(row, ["package_id", "change", "from_version", "to_version"], [], path);
    assertOpaqueId(row.package_id, `${path}.package_id`);
    if (!new Set(["add", "remove", "update", "unchanged"]).has(row.change))
      invalid("invalid dependency change");
    for (const key of ["from_version", "to_version"] as const)
      if (row[key] !== null) assertOpaqueId(row[key], `${path}.${key}`, 128);
    return [row.package_id, row.change, row.from_version ?? "", row.to_version ?? ""].join("\0");
  });
  ordered(identities, "dependency deltas");
}

function validateConfigDiffs(
  value: HostRenderedPreviewV1["config_diffs"],
  targetIds: string[],
): void {
  boundedArray(value, 256, "config diffs");
  const identities = value.map((row, index) => {
    const path = `$.proposal.preview.config_diffs[${index}]`;
    exactObject(
      row,
      [
        "target",
        "target_ids",
        "mode",
        "before_digest",
        "after_digest",
        "bounded_before",
        "bounded_after",
      ],
      [],
      path,
    );
    boundedString(row.target, `${path}.target`, { max: 512 });
    const ids = assertStringArray(row.target_ids, `${path}.target_ids`, { max: 64, sorted: true });
    if (ids.some((id) => !targetIds.includes(id))) invalid("config diff names an unknown target");
    if (!new Set(["surgical", "full-file", "manual"]).has(row.mode))
      invalid("invalid config diff mode");
    assertDigest(row.before_digest, `${path}.before_digest`);
    assertDigest(row.after_digest, `${path}.after_digest`);
    for (const key of ["bounded_before", "bounded_after"] as const)
      if (row[key] !== null) boundedString(row[key], `${path}.${key}`, { max: 16 * 1024 });
    return `${row.target}\0${row.mode}`;
  });
  ordered(identities, "config diffs");
}

function validateEnforcement(value: HostRenderedPreviewV1["enforcement"]): void {
  boundedArray(value, 512, "enforcement disclosures");
  const identities = value.map((row, index) => {
    const path = `$.proposal.preview.enforcement[${index}]`;
    exactObject(row, ["permission_id", "engine", "enforcement", "explanation"], [], path);
    assertOpaqueId(row.permission_id, `${path}.permission_id`);
    if (!new Set(["claude", "codex", "copilot", "opencode", "antigravity"]).has(row.engine))
      invalid("invalid enforcement engine");
    if (
      !new Set(["brokered", "sandboxed", "engine-enforced", "disclosed-not-enforced"]).has(
        row.enforcement,
      )
    )
      invalid("invalid enforcement mode");
    boundedString(row.explanation, `${path}.explanation`, { max: 2_048 });
    return `${row.permission_id}\0${row.engine}\0${row.enforcement}`;
  });
  ordered(identities, "enforcement disclosures");
}

function validateHealth(value: HostRenderedPreviewV1["health_plan"], targetIds: string[]): void {
  boundedArray(value, 256, "health plans");
  const identities = value.map((row, index) => {
    const path = `$.proposal.preview.health_plan[${index}]`;
    exactObject(
      row,
      [
        "probe_id",
        "kind",
        "evidence_schema_id",
        "target_ids",
        "required",
        "effect_classes",
        "permission_ids",
        "enforcement_digest",
        "timeout_ms",
        "retries",
        "evidence_valid_for_ms",
      ],
      [],
      path,
    );
    assertOpaqueId(row.probe_id, `${path}.probe_id`);
    if (!HEALTH_KINDS.has(row.kind)) invalid("invalid health probe kind");
    assertOpaqueId(row.evidence_schema_id, `${path}.evidence_schema_id`);
    const ids = assertStringArray(row.target_ids, `${path}.target_ids`, { max: 64, sorted: true });
    if (ids.some((id) => !targetIds.includes(id))) invalid("health plan names an unknown target");
    assertStringArray(row.permission_ids, `${path}.permission_ids`, { max: 512, sorted: true });
    orderedEnum(row.effect_classes, EFFECTS, "health effect classes");
    assertDigest(row.enforcement_digest, `${path}.enforcement_digest`);
    if (typeof row.required !== "boolean") invalid("invalid health required flag");
    const timeout = safeInteger(row.timeout_ms, `${path}.timeout_ms`);
    const validFor = safeInteger(row.evidence_valid_for_ms, `${path}.evidence_valid_for_ms`);
    if (timeout < 1 || timeout > 300_000 || validFor < 1 || validFor > 86_400_000)
      invalid("health timing exceeds bound");
    if (![0, 1, 2].includes(row.retries)) invalid("invalid health retry count");
    return `${row.probe_id}\0${ids.join("\0")}`;
  });
  ordered(identities, "health plans");
}

function boundedArray(value: unknown[], max: number, label: string): void {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} exceed bound`);
}

function ordered(values: string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((v, i) => v !== [...values].sort(bytewise)[i])
  )
    invalid(`${label} are duplicated or not canonically ordered`);
}

function orderedEnum(values: readonly string[], order: readonly string[], label: string): void {
  if (
    values.length > order.length ||
    new Set(values).size !== values.length ||
    values.some(
      (value, index) =>
        !order.includes(value) ||
        (index > 0 && order.indexOf(value) <= order.indexOf(values[index - 1] ?? "")),
    )
  )
    invalid(`${label} are invalid, duplicated, or unordered`);
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.proposal.preview");
}
