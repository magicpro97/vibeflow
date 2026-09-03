import { isPublicRecoveryAction } from "../../actions/public-error-contract.js";
import {
  isBoundedJsonWireValue,
  isBoundedWireIdentity,
  isBoundedWireText,
  isNonnegativeSafeWireInteger,
  isSha256WireDigest,
} from "../../actions/public-wire-primitives.js";
import { isAgentEngine } from "../../core/agent-contract.js";
import {
  ACTION_CONFIG_DIFF_FIELDS,
  ACTION_DEPENDENCY_DELTA_FIELDS,
  ACTION_ENFORCEMENT_FIELDS,
  ACTION_HEALTH_PLAN_FIELDS,
  ACTION_PACKAGE_PIN_FIELDS,
  ACTION_PERMISSION_DELTA_FIELDS,
  ACTION_PLANNING_OPTIONS_FIELDS,
  ACTION_PREVIEW_FIELDS,
  ACTION_REVIEW_FIELD_FIELDS,
  ACTION_TARGET_DISPOSITION_FIELDS,
} from "./conversation-home-action-boundary-fields.js";
import {
  assert,
  ACTION_CONFIG_DIFF_MODES,
  ACTION_DEPENDENCY_CHANGES,
  ACTION_EFFECT_CLASSES,
  ACTION_HEALTH_PLAN_KINDS,
  ACTION_HEALTH_PLAN_RETRIES,
  ACTION_PACKAGE_PIN_SOURCE_KINDS,
  ACTION_PACKAGE_PIN_TRUST,
  ACTION_PERMISSION_CHANGES,
  ACTION_PERMISSION_ENFORCEMENT,
  ACTION_PLANNING_MODES,
  ACTION_PLANNING_NETWORK_READ,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_RAW_SHA256_PATTERN,
  ACTION_REVERSIBILITY,
  ACTION_TARGET_DISPOSITION_EXECUTION,
  ACTION_TARGET_DISPOSITION_EXECUTION_VALUE,
  ACTION_TARGET_MANUAL_REASON_CODES,
  ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES,
  ACTION_TARGET_UNSUPPORTED_REASON_CODES,
  assertExactRecord,
  assertStringArray,
  assertUniqueSorted,
  memberOf,
  nullableDigest,
  nullableShortText,
} from "./conversation-home-action-boundary-shared.js";
import { parseActionTargetBinding } from "./conversation-home-action-operation-boundary.js";
import type { HomeActionProposal } from "./conversation-home-types.js";

export function parsePackagePin(value: unknown): HomeActionProposal["package_pins"][number] {
  const row = assertExactRecord(value, ACTION_PACKAGE_PIN_FIELDS, "invalid action package pin");
  assert(isBoundedWireIdentity(row.id), "invalid package pin id");
  assert(isBoundedWireText(row.version, { maxBytes: 128 }), "invalid package pin version");
  assert(memberOf(ACTION_PACKAGE_PIN_SOURCE_KINDS, row.source_kind), "invalid package pin source");
  assert(
    typeof row.content_sha256 === "string" && ACTION_RAW_SHA256_PATTERN.test(row.content_sha256),
    "invalid package pin content sha256",
  );
  assert(memberOf(ACTION_PACKAGE_PIN_TRUST, row.trust), "invalid package pin trust");
  assert(typeof row.nonportable === "boolean", "invalid package pin nonportable flag");
  assert(isSha256WireDigest(row.pin_digest), "invalid package pin digest");
  return structuredClone(row) as HomeActionProposal["package_pins"][number];
}

function parseTargetDispositionReason(execution: unknown, reasonCode: unknown): void {
  assert(
    memberOf(ACTION_TARGET_DISPOSITION_EXECUTION, execution),
    "invalid preview target disposition execution",
  );
  if (execution === ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.HOST) {
    assert(reasonCode === null, "invalid preview target disposition reason");
    return;
  }
  if (execution === ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.MANUAL) {
    assert(
      memberOf(ACTION_TARGET_MANUAL_REASON_CODES, reasonCode),
      "invalid preview target disposition reason",
    );
    return;
  }
  if (execution === ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.REQUIRED_USER_ACTION) {
    assert(
      memberOf(ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES, reasonCode),
      "invalid preview target disposition reason",
    );
    return;
  }
  assert(
    memberOf(ACTION_TARGET_UNSUPPORTED_REASON_CODES, reasonCode),
    "invalid preview target disposition reason",
  );
}

function parseConfigDiff(value: unknown): void {
  const diff = assertExactRecord(value, ACTION_CONFIG_DIFF_FIELDS, "invalid preview config diff");
  assert(isBoundedWireText(diff.target, { maxBytes: 512 }), "invalid preview config target");
  const ids = assertStringArray(
    diff.target_ids,
    isBoundedWireIdentity,
    "invalid preview config target ids",
  );
  assertUniqueSorted(ids, "invalid preview config target ids ordering");
  assert(memberOf(ACTION_CONFIG_DIFF_MODES, diff.mode), "invalid preview config diff mode");
  assert(isSha256WireDigest(diff.before_digest), "invalid preview config diff before digest");
  assert(isSha256WireDigest(diff.after_digest), "invalid preview config diff after digest");
  assert(nullableShortText(diff.bounded_before, 16 * 1024), "invalid preview bounded_before");
  assert(nullableShortText(diff.bounded_after, 16 * 1024), "invalid preview bounded_after");
}

function parseEnforcementRule(value: unknown): void {
  const row = assertExactRecord(
    value,
    ACTION_ENFORCEMENT_FIELDS,
    "invalid preview enforcement entry",
  );
  assert(isBoundedWireIdentity(row.permission_id), "invalid preview enforcement permission");
  assert(isAgentEngine(row.engine), "invalid preview enforcement engine");
  assert(
    memberOf(ACTION_PERMISSION_ENFORCEMENT, row.enforcement),
    "invalid preview enforcement mode",
  );
  assert(
    isBoundedWireText(row.explanation, { maxBytes: 4_096 }),
    "invalid preview enforcement explanation",
  );
}

function parseHealthProbe(value: unknown): void {
  const row = assertExactRecord(
    value,
    ACTION_HEALTH_PLAN_FIELDS,
    "invalid preview health plan entry",
  );
  assert(isBoundedWireIdentity(row.probe_id), "invalid preview health probe id");
  assert(memberOf(ACTION_HEALTH_PLAN_KINDS, row.kind), "invalid preview health probe kind");
  assert(
    isBoundedWireText(row.evidence_schema_id, { maxBytes: 256 }),
    "invalid preview evidence schema id",
  );
  assertStringArray(row.target_ids, isBoundedWireIdentity, "invalid preview health target ids");
  assert(typeof row.required === "boolean", "invalid preview health required flag");
  assertStringArray(
    row.effect_classes,
    (item) => memberOf(ACTION_EFFECT_CLASSES, item),
    "invalid preview health effect classes",
  );
  assertStringArray(
    row.permission_ids,
    isBoundedWireIdentity,
    "invalid preview health permission ids",
  );
  assert(isSha256WireDigest(row.enforcement_digest), "invalid preview health enforcement digest");
  assert(isNonnegativeSafeWireInteger(row.timeout_ms), "invalid preview health timeout");
  assert(
    ACTION_HEALTH_PLAN_RETRIES.some((item) => item === row.retries),
    "invalid preview health retries",
  );
  assert(
    isNonnegativeSafeWireInteger(row.evidence_valid_for_ms),
    "invalid preview health evidence window",
  );
}

export function parsePreview(value: unknown, actionType: string): HomeActionProposal["preview"] {
  const row = assertExactRecord(value, ACTION_PREVIEW_FIELDS, "invalid action preview");
  assert(isBoundedWireText(row.title, { maxBytes: 256 }), "invalid preview title");
  assert(isBoundedWireText(row.summary, { maxBytes: 8_192 }), "invalid preview summary");
  assert(row.action_type === actionType, "invalid preview action identity");

  const planning = assertExactRecord(
    row.planning_options,
    ACTION_PLANNING_OPTIONS_FIELDS,
    "invalid preview planning options",
  );
  assert(memberOf(ACTION_PLANNING_MODES, planning.mode), "invalid preview planning mode");
  assert(
    memberOf(ACTION_PLANNING_NETWORK_READ, planning.network_read),
    "invalid preview planning network policy",
  );

  assert(Array.isArray(row.review_fields), "invalid preview review fields");
  for (const field of row.review_fields) {
    const review = assertExactRecord(
      field,
      ACTION_REVIEW_FIELD_FIELDS,
      "invalid preview review field",
    );
    assert(
      isBoundedWireText(review.json_pointer, { maxBytes: 1_024, minBytes: 0 }),
      "invalid preview json pointer",
    );
    assert(isBoundedWireText(review.label, { maxBytes: 256 }), "invalid preview review label");
    assert(isBoundedJsonWireValue(review.before, 32 * 1024), "invalid preview before value");
    assert(isBoundedJsonWireValue(review.after, 32 * 1024), "invalid preview after value");
    assert(nullableDigest(review.private_binding_digest), "invalid preview binding digest");
  }

  assert(Array.isArray(row.targets), "invalid preview targets");
  for (const target of row.targets) parseActionTargetBinding(target);

  const targetDispositions = Array.isArray(row.target_dispositions)
    ? row.target_dispositions
    : null;
  assert(targetDispositions !== null, "invalid preview target dispositions");
  for (const value of targetDispositions) {
    const disposition = assertExactRecord(
      value,
      ACTION_TARGET_DISPOSITION_FIELDS,
      "invalid preview target disposition",
    );
    assert(isBoundedWireIdentity(disposition.target_id), "invalid preview target disposition id");
    parseTargetDispositionReason(disposition.execution, disposition.reason_code);
  }

  assert(Array.isArray(row.package_pins), "invalid preview package pins");
  for (const pin of row.package_pins) parsePackagePin(pin);

  const permissionDelta = Array.isArray(row.permission_delta) ? row.permission_delta : null;
  assert(permissionDelta !== null, "invalid preview permission delta");
  for (const value of permissionDelta) {
    const permission = assertExactRecord(
      value,
      ACTION_PERMISSION_DELTA_FIELDS,
      "invalid preview permission delta entry",
    );
    assert(isBoundedWireIdentity(permission.permission_id), "invalid preview permission id");
    assert(
      memberOf(ACTION_PERMISSION_CHANGES, permission.change),
      "invalid preview permission change",
    );
    assert(
      isBoundedWireText(permission.public_scope, { maxBytes: 512 }),
      "invalid preview permission scope",
    );
    assert(
      memberOf(ACTION_PERMISSION_ENFORCEMENT, permission.enforcement),
      "invalid preview permission enforcement",
    );
  }

  assert(Array.isArray(row.dependency_delta), "invalid preview dependency delta");
  for (const value of row.dependency_delta) {
    const dependency = assertExactRecord(
      value,
      ACTION_DEPENDENCY_DELTA_FIELDS,
      "invalid preview dependency delta entry",
    );
    assert(isBoundedWireIdentity(dependency.package_id), "invalid preview dependency id");
    assert(
      memberOf(ACTION_DEPENDENCY_CHANGES, dependency.change),
      "invalid preview dependency change",
    );
    assert(
      nullableShortText(dependency.from_version, 128),
      "invalid preview dependency from_version",
    );
    assert(nullableShortText(dependency.to_version, 128), "invalid preview dependency to_version");
  }

  assert(Array.isArray(row.config_diffs), "invalid preview config diffs");
  for (const value of row.config_diffs) parseConfigDiff(value);

  assertStringArray(
    row.effect_classes,
    (item) => memberOf(ACTION_EFFECT_CLASSES, item),
    "invalid preview effect classes",
  );

  const enforcement = Array.isArray(row.enforcement) ? row.enforcement : null;
  assert(enforcement !== null, "invalid preview enforcement");
  for (const value of enforcement) parseEnforcementRule(value);

  assert(memberOf(ACTION_REVERSIBILITY, row.reversibility), "invalid preview reversibility");

  const healthPlan = Array.isArray(row.health_plan) ? row.health_plan : null;
  assert(healthPlan !== null, "invalid preview health plan");
  for (const value of healthPlan) parseHealthProbe(value);

  const recoveryActions = assertStringArray(
    row.recovery_actions,
    isPublicRecoveryAction,
    "invalid preview recovery actions",
  );
  assert(
    row.projector_version === ACTION_PREVIEW_PROJECTOR_VERSION,
    "invalid preview projector version",
  );
  assert(isSha256WireDigest(row.rules_digest), "invalid preview rules digest");
  assert(
    isSha256WireDigest(row.redaction_manifest_digest),
    "invalid preview redaction manifest digest",
  );

  return structuredClone(row) as HomeActionProposal["preview"];
}
