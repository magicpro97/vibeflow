import { DIGEST, PACKAGE_ID } from "../../actions/record-primitives.js";
import { digestV1 } from "../../durability/index.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { PublicPrivateInputBindingV1 } from "../wire/cli.js";
import { bytewise } from "../wire/primitives.js";
import type {
  CliBindingRecordV1,
  CliBindingRowV1,
  CliCurrentHeadRecordV1,
  HeadIdentity,
  Scope,
} from "./types.js";

export function headIdentity(head: CliCurrentHeadRecordV1): HeadIdentity {
  return {
    scope: head.scope,
    scope_identity_digest: head.scope_identity_digest,
    package_id: head.package_id,
    package_pin_digest: head.package_pin_digest,
    manifest_digest: head.manifest_digest,
    input_id: head.input_id,
  };
}

export function headFileKey(identity: HeadIdentity): string {
  return digestV1("VF-CLI-PRIVATE-INPUT-CURRENT-HEAD-KEY\0v1\0", identity).slice(7);
}

export function createHeadRecord(
  record: CliBindingRecordV1,
  row: CliBindingRowV1,
  updatedAt: string,
): CliCurrentHeadRecordV1 {
  const preimage = {
    schema_version: "1.0" as const,
    scope: record.scope,
    scope_identity_digest: record.scope_identity_digest,
    package_id: record.package_id,
    package_pin_digest: record.package_pin_digest,
    manifest_digest: record.manifest_digest,
    input_id: row.input_id,
    private_binding_id: record.private_binding_id,
    binding_digest: record.binding_digest,
    expires_at: record.expires_at,
    updated_at: updatedAt,
  };
  return {
    ...preimage,
    head_digest: digestV1("VF-CLI-PRIVATE-INPUT-CURRENT-HEAD\0v1\0", preimage),
  };
}

export function publicBinding(record: CliBindingRecordV1): PublicPrivateInputBindingV1 {
  return {
    schema_version: "1.0",
    private_binding_id: record.private_binding_id,
    binding_digest: record.binding_digest,
    scope: record.scope,
    package_id: record.package_id,
    package_pin_digest: record.package_pin_digest,
    manifest_digest: record.manifest_digest,
    input_ids: record.bindings.map((row) => row.input_id).sort(bytewise),
    expires_at: record.expires_at,
  };
}

export function parseInputId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value))
    throw new CapabilityRuntimeError(
      `invalid input identifier ${JSON.stringify(value)}`,
      "invalid-plan",
    );
  return value;
}

export function uniqueSortedInputIds(values: readonly string[]): string[] {
  const parsed = values.map((value) => parseInputId(value)).sort(bytewise);
  if (new Set(parsed).size !== parsed.length)
    throw new CapabilityRuntimeError("duplicate private input identifier", "invalid-plan");
  return parsed;
}

export function assertPackageIdentity(
  packageId: string,
  packagePinDigest: string,
  manifestDigest: string,
): void {
  if (!PACKAGE_ID.test(packageId))
    throw new CapabilityRuntimeError("invalid capability package identifier", "invalid-plan");
  if (!DIGEST.test(packagePinDigest) || !DIGEST.test(manifestDigest))
    throw new CapabilityRuntimeError("invalid capability package digest identity", "invalid-plan");
}

export function emptyBindingDigest(identity: {
  scope: Scope;
  scope_identity_digest: string;
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
}): string {
  return digestV1("VF-PRIVATE-INPUT-BINDING-EMPTY\0v1\0", {
    schema_version: "1.0",
    scope: identity.scope,
    scope_identity_digest: identity.scope_identity_digest,
    package_id: identity.package_id,
    package_pin_digest: identity.package_pin_digest,
    manifest_digest: identity.manifest_digest,
  });
}

export function minimumTimestamp(values: readonly string[]): string {
  const sorted = [...values].sort((left, right) => Date.parse(left) - Date.parse(right));
  const first = sorted[0];
  if (!first)
    throw new CapabilityRuntimeError("missing timestamp for private-input binding", "fault");
  return first;
}

export function objectFromEntries<T>(
  entries: ReadonlyArray<readonly [string, T]>,
): Record<string, T> {
  return Object.fromEntries(entries) as Record<string, T>;
}
