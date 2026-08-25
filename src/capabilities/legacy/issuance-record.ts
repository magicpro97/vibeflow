import type { PrivateActionRootLocatorV1 } from "../../actions/index.js";
import { actionIdempotencyScopeDigest } from "../../actions/index.js";
import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import { canonicalJson, digestHex, digestV1 } from "../../durability/index.js";
import type { PublicLegacyAdoptInspectionResponseV1 } from "../wire/cli.js";
import {
  CapabilityValidationError,
  assertCanonicalSize,
  assertSortedUnique,
  bytewise,
  digest,
  enumeration,
  exactKeys,
  text,
  timestamp,
} from "../wire/primitives.js";
import { validateLegacyAdoptSources } from "./request-validation.js";
import type { LegacyAdoptInspectionRequestV1 } from "./types.js";

export type LegacyAdoptActionRootLocatorV1 = Exclude<
  PrivateActionRootLocatorV1,
  { kind: "recovery-bootstrap" }
>;

export interface LegacyAdoptInspectionAuthorityV1 {
  principal_digest: string;
  action_root_locator: LegacyAdoptActionRootLocatorV1;
}

export interface LegacyAdoptInspectionIssuanceV1 {
  schema_version: "1.0";
  principal_digest: string;
  issuance_scope_digest: string;
  idempotency_key_digest: string;
  request_digest: string;
  scope: "project" | "user";
  scope_identity_digest: string;
  legacy_sources: StrictLegacyAdoptCandidateV1["legacy_source"][];
  inspected_at: string;
  expires_at: string;
  candidate_set_digest: string;
  candidates: Array<{ candidate_id: string; candidate_digest: string }>;
  issuance_digest: string;
}

export interface LegacyAdoptInspectionResultV1 {
  created: boolean;
  response: PublicLegacyAdoptInspectionResponseV1;
}

export function legacyAdoptInspectionRequestDigest(
  request: LegacyAdoptInspectionRequestV1,
): string {
  return digestV1("VF-LEGACY-ADOPT-INSPECTION-REQUEST\0v1\0", {
    schema_version: "1.0",
    scope: request.scope,
    legacy_sources: request.legacy_sources,
  });
}

export function legacyAdoptIssuanceScopeDigest(
  locator: LegacyAdoptActionRootLocatorV1,
  scope: "project" | "user",
  scopeIdentityDigest: string,
): string {
  actionIdempotencyScopeDigest(locator);
  if (
    locator.kind === "capability" &&
    (locator.scope !== scope || locator.scope_identity_digest !== scopeIdentityDigest)
  )
    throw new CapabilityValidationError(
      "standalone adoption locator does not own the selected scope",
      "action_root_locator",
      "integrity_failure",
    );
  const value =
    locator.kind === "conversation"
      ? {
          kind: "conversation" as const,
          root_session_id: locator.root_session_id,
          scope,
          scope_identity_digest: scopeIdentityDigest,
        }
      : { kind: "standalone" as const, scope, scope_identity_digest: scopeIdentityDigest };
  return digestV1("VF-LEGACY-ADOPT-INSPECTION-ISSUANCE-SCOPE\0v1\0", value);
}

export function legacyAdoptIssuanceFileKey(input: {
  principal_digest: string;
  issuance_scope_digest: string;
  idempotency_key_digest: string;
}): string {
  return digestV1("VF-LEGACY-ADOPT-INSPECTION-ISSUANCE-FILE-KEY\0v1\0", {
    schema_version: "1.0",
    ...input,
  });
}

export function legacyAdoptInspectionIssuanceDigest(
  value: Omit<LegacyAdoptInspectionIssuanceV1, "issuance_digest">,
): string {
  return digestV1("VF-LEGACY-ADOPT-INSPECTION-ISSUANCE\0v1\0", value);
}

export function validateLegacyAdoptInspectionIssuance(
  value: unknown,
): LegacyAdoptInspectionIssuanceV1 {
  const row = exactKeys(
    value,
    [
      "schema_version",
      "principal_digest",
      "issuance_scope_digest",
      "idempotency_key_digest",
      "request_digest",
      "scope",
      "scope_identity_digest",
      "legacy_sources",
      "inspected_at",
      "expires_at",
      "candidate_set_digest",
      "candidates",
      "issuance_digest",
    ],
    [],
    "issuance",
  );
  if (row.schema_version !== "1.0")
    throw new CapabilityValidationError("unsupported issuance schema", "issuance.schema_version");
  const inspected = timestamp(row.inspected_at, "issuance.inspected_at");
  const expires = timestamp(row.expires_at, "issuance.expires_at");
  if (expires !== inspected + 10 * 60_000)
    throw new CapabilityValidationError(
      "issuance expiry is not exactly ten minutes",
      "issuance.expires_at",
    );
  if (!Array.isArray(row.candidates) || row.candidates.length > 1_024)
    throw new CapabilityValidationError("invalid issuance candidate array", "issuance.candidates");
  const candidates = row.candidates.map((item, index) => {
    const candidate = exactKeys(
      item,
      ["candidate_id", "candidate_digest"],
      [],
      `issuance.candidates[${index}]`,
    );
    const candidateDigest = digest(
      candidate.candidate_digest,
      `issuance.candidates[${index}].candidate_digest`,
    );
    const candidateId = text(candidate.candidate_id, `issuance.candidates[${index}].candidate_id`, {
      min: 73,
      max: 73,
      ascii: true,
    });
    if (candidateId !== `vf-adopt-${digestHex(candidateDigest)}`)
      throw new CapabilityValidationError(
        "candidate ID/digest mismatch",
        `issuance.candidates[${index}]`,
      );
    return { candidate_id: candidateId, candidate_digest: candidateDigest };
  });
  assertSortedUnique(
    candidates,
    (left, right) =>
      bytewise(
        `${left.candidate_id}\0${left.candidate_digest}`,
        `${right.candidate_id}\0${right.candidate_digest}`,
      ),
    "issuance.candidates",
  );
  const issuance = {
    schema_version: "1.0" as const,
    principal_digest: digest(row.principal_digest, "issuance.principal_digest"),
    issuance_scope_digest: digest(row.issuance_scope_digest, "issuance.issuance_scope_digest"),
    idempotency_key_digest: digest(row.idempotency_key_digest, "issuance.idempotency_key_digest"),
    request_digest: digest(row.request_digest, "issuance.request_digest"),
    scope: enumeration(row.scope, ["project", "user"] as const, "issuance.scope"),
    scope_identity_digest: digest(row.scope_identity_digest, "issuance.scope_identity_digest"),
    legacy_sources: validateLegacyAdoptSources(row.legacy_sources, "issuance.legacy_sources"),
    inspected_at: row.inspected_at as string,
    expires_at: row.expires_at as string,
    candidate_set_digest: digest(row.candidate_set_digest, "issuance.candidate_set_digest"),
    candidates,
    issuance_digest: digest(row.issuance_digest, "issuance.issuance_digest"),
  };
  const { issuance_digest: observed, ...preimage } = issuance;
  if (legacyAdoptInspectionIssuanceDigest(preimage) !== observed)
    throw new CapabilityValidationError(
      "issuance digest mismatch",
      "issuance.issuance_digest",
      "integrity_failure",
    );
  assertCanonicalSize(issuance, 2 * 1024 * 1024, "issuance");
  return Object.freeze(issuance);
}

export function exactLegacyAdoptIssuance(
  left: LegacyAdoptInspectionIssuanceV1,
  right: LegacyAdoptInspectionIssuanceV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
