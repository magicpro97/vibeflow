import { SIGNED_CURSOR_PATTERN } from "../../actions/public-action-contract.js";
import {
  compareUtf8Wire,
  hasExactWireFields,
  isBoundedWireIdentity,
  isBoundedWireText,
  isPlainWireRecord,
  isSha256WireDigest,
} from "../../actions/public-wire-primitives.js";

export {
  ACTION_APPROVAL_CHALLENGE_CLASSES,
  ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX,
  ACTION_APPROVAL_CHALLENGE_DISPLAY_SUFFIX_PATTERN,
  ACTION_APPROVAL_CHALLENGE_ID_PATTERN,
  ACTION_APPROVAL_ID_PATTERN,
  ACTION_AUTHORITY_BINDING_MODES,
  ACTION_CHALLENGE_CLASSES,
  ACTION_CONFIG_DIFF_MODES,
  ACTION_CORRELATION_ID_PATTERN,
  ACTION_DECISIONS,
  ACTION_DECISION,
  ACTION_DELIVERY,
  ACTION_DOMAIN,
  ACTION_DEPENDENCY_CHANGES,
  ACTION_DOMAINS,
  ACTION_EFFECT_CLASSES,
  ACTION_HEALTH_PLAN_KINDS,
  ACTION_HEALTH_PLAN_RETRIES,
  ACTION_OPERATION_ID_PATTERN,
  ACTION_PACKAGE_PIN_SOURCE_KINDS,
  ACTION_PACKAGE_PIN_TRUST,
  ACTION_PERMISSION_CHANGES,
  ACTION_PERMISSION_ENFORCEMENT,
  ACTION_PLANNING_MODES,
  ACTION_PLANNING_NETWORK_READ,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_PROPOSAL_ID_PATTERN,
  ACTION_RAW_SHA256_PATTERN,
  ACTION_REVERSIBILITY,
  ACTION_RISKS,
  ACTION_SCOPES,
  ACTION_TARGET_DISPOSITION_EXECUTION,
  ACTION_TARGET_DISPOSITION_EXECUTION_VALUE,
  ACTION_TARGET_MANUAL_REASON_CODES,
  ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES,
  ACTION_TIMELINE_ITEM_KIND,
  ACTION_TARGET_UNSUPPORTED_REASON_CODES,
  ACTOR_KINDS,
  CREDENTIAL_CLASSES,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../../actions/public-action-contract.js";

export type BoundaryRecord = Record<string, any>;

export const memberOf = <Value extends string>(
  values: readonly Value[],
  value: unknown,
): value is Value => typeof value === "string" && values.some((candidate) => candidate === value);

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertExactRecord(
  value: unknown,
  fields: readonly string[],
  message: string,
): BoundaryRecord {
  assert(isPlainWireRecord(value) && hasExactWireFields(value, fields), message);
  return value;
}

export function assertPattern(
  value: unknown,
  pattern: RegExp,
  message: string,
): asserts value is string {
  assert(typeof value === "string" && pattern.test(value), message);
}

export function nullableIdentity(value: unknown): value is string | null {
  return value === null || isBoundedWireIdentity(value);
}

export function nullableDigest(value: unknown): value is string | null {
  return value === null || isSha256WireDigest(value);
}

export function nullableCursor(value: unknown): value is string | null {
  return (
    value === null ||
    (isBoundedWireText(value, { maxBytes: 16 * 1024, ascii: true }) &&
      SIGNED_CURSOR_PATTERN.test(value))
  );
}

export function nullableShortText(value: unknown, maxBytes = 1024): value is string | null {
  return value === null || isBoundedWireText(value, { maxBytes });
}

export function assertStringArray(
  value: unknown,
  predicate: (item: unknown) => boolean,
  message: string,
): string[] {
  assert(Array.isArray(value), message);
  assert(value.every(predicate), message);
  return value as string[];
}

export function assertUniqueSorted(values: readonly string[], message: string): void {
  const sorted = [...values].sort(compareUtf8Wire);
  assert(
    new Set(values).size === values.length &&
      values.every((value, index) => value === sorted[index]),
    message,
  );
}
