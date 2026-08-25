import { validateIdempotencyKey } from "../../actions/index.js";
import type { LegacySourceV1 } from "../../actions/legacy-adopt-types.js";
import { CapabilityValidationError, digest, enumeration, exactKeys } from "../wire/primitives.js";
import type { LegacyAdoptInspectionRequestV1, LegacyAdoptScanRequestV1 } from "./types.js";

const SOURCES: LegacySourceV1[] = [
  "skill-lock",
  "tool-managed-evidence",
  "mcp-managed-sidecar",
  "hook-sentinel",
  "role-marker",
];

export function validateLegacyAdoptSources(value: unknown, path: string): LegacySourceV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SOURCES.length)
    throw new CapabilityValidationError(
      "legacy adoption sources must be a bounded non-empty array",
      path,
    );
  const output = value.map((source, index) => enumeration(source, SOURCES, `${path}[${index}]`));
  const positions = output.map((source) => SOURCES.indexOf(source));
  if (
    new Set(output).size !== output.length ||
    positions.some((position, index) => index > 0 && position <= (positions[index - 1] as number))
  )
    throw new CapabilityValidationError(
      "legacy adoption sources must be unique and canonically ordered",
      path,
    );
  return output;
}

export function validateLegacyAdoptInspectionRequest(
  value: unknown,
): LegacyAdoptInspectionRequestV1 {
  const row = exactKeys(
    value,
    ["schema_version", "idempotency_key", "scope", "legacy_sources"],
    [],
    "$",
  );
  if (row.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported legacy adoption inspection schema",
      "$.schema_version",
      "unsupported_schema_version",
    );
  return {
    schema_version: "1.0",
    idempotency_key: validateIdempotencyKey(row.idempotency_key),
    scope: enumeration(row.scope, ["project", "user"] as const, "$.scope"),
    legacy_sources: validateLegacyAdoptSources(row.legacy_sources, "$.legacy_sources"),
  };
}

export function validateLegacyAdoptScanRequest(value: unknown): LegacyAdoptScanRequestV1 {
  const row = exactKeys(
    value,
    ["schema_version", "scope", "scope_identity_digest", "sources"],
    [],
    "$",
  );
  if (row.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported legacy adoption inspection schema",
      "$.schema_version",
      "unsupported_schema_version",
    );
  const scope = enumeration(row.scope, ["project", "user"] as const, "$.scope");
  const scopeIdentityDigest = digest(row.scope_identity_digest, "$.scope_identity_digest");
  return {
    schema_version: "1.0",
    scope,
    scope_identity_digest: scopeIdentityDigest,
    sources: validateLegacyAdoptSources(row.sources, "$.sources"),
  };
}
