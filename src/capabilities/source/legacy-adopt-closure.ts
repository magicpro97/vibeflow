import { canonicalJson, canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import { assertFilesystemLegacyOwnedMarkerV1 } from "../legacy/filesystem-reader.js";
import type { LegacyOwnedMarkerV1 } from "../legacy/types.js";
import type { ValidatedCapabilityManifestV1 } from "../manifest/types.js";
import { assertValidatedCapabilityManifest } from "../manifest/validation.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  exactKeys,
  rawSha256,
  text,
} from "../wire/primitives.js";
import type { PackageTreeV1 } from "./tree.js";
import { assertValidatedPackageTree } from "./tree.js";
import type { LegacyInspectionEvidenceV1, ValidatedLegacyInspectionEvidenceV1 } from "./types.js";

const ISSUED_EVIDENCE = new WeakSet<object>();

function freezeEvidence(
  value: ValidatedLegacyInspectionEvidenceV1,
): ValidatedLegacyInspectionEvidenceV1 {
  for (const record of value.source_records) Object.freeze(record);
  for (const resource of value.owned_resources) Object.freeze(resource);
  Object.freeze(value.source_records);
  Object.freeze(value.owned_resources);
  return Object.freeze(value);
}

export function validateLegacyInspectionEvidence(
  value: LegacyInspectionEvidenceV1,
): ValidatedLegacyInspectionEvidenceV1 {
  exactKeys(
    value,
    [
      "schema_version",
      "legacy_source",
      "raw_identifier_nfc",
      "adapter_fingerprint",
      "source_records",
      "owned_resources",
      "evidence_digest",
    ],
    [],
    "legacy_evidence",
  );
  if (
    value.schema_version !== "1.0" ||
    ![
      "skill-lock",
      "tool-managed-evidence",
      "mcp-managed-sidecar",
      "hook-sentinel",
      "role-marker",
    ].includes(value.legacy_source)
  )
    throw new CapabilityValidationError("invalid legacy inspection evidence", "legacy_evidence");
  const rawIdentifier = text(value.raw_identifier_nfc, "legacy_evidence.raw_identifier_nfc", {
    min: 1,
    max: 512,
  });
  if (
    value.adapter_fingerprint !==
    digestV1("VF-LEGACY-ADAPTER-FINGERPRINT\0v1\0", value.legacy_source)
  )
    throw new CapabilityValidationError(
      "legacy adapter fingerprint mismatch",
      "legacy_evidence.adapter_fingerprint",
      "integrity_failure",
    );
  for (const [index, record] of value.source_records.entries()) {
    exactKeys(
      record,
      ["record_kind", "logical_id", "content_sha256", "record_digest"],
      [],
      `legacy_evidence.source_records[${index}]`,
    );
    if (
      !["lock", "managed-sidecar", "sentinel", "renderer-marker", "descriptor"].includes(
        record.record_kind,
      )
    )
      throw new CapabilityValidationError("invalid legacy source record kind", "legacy_evidence");
    text(record.logical_id, "legacy_evidence.logical_id", { min: 1, max: 512 });
    rawSha256(record.content_sha256, "legacy_evidence.content_sha256");
    const { record_digest: observed, ...preimage } = record;
    if (observed !== digestV1("VF-LEGACY-INSPECTION-SOURCE-RECORD\0v1\0", preimage))
      throw new CapabilityValidationError(
        "legacy source record digest mismatch",
        "legacy_evidence.record_digest",
        "integrity_failure",
      );
  }
  assertSortedUnique(
    value.source_records,
    (a, b) =>
      bytewise(
        `${a.record_kind}\0${a.logical_id}\0${a.content_sha256}\0${a.record_digest}`,
        `${b.record_kind}\0${b.logical_id}\0${b.content_sha256}\0${b.record_digest}`,
      ),
    "legacy_evidence.source_records",
  );
  for (const [index, resource] of value.owned_resources.entries()) {
    exactKeys(
      resource,
      ["ownership_key", "public_target", "expected_preimage_sha256"],
      [],
      `legacy_evidence.owned_resources[${index}]`,
    );
    text(resource.ownership_key, "legacy_evidence.ownership_key", { min: 1, max: 512 });
    text(resource.public_target, "legacy_evidence.public_target", { min: 1, max: 2048 });
    rawSha256(resource.expected_preimage_sha256, "legacy_evidence.expected_preimage_sha256");
  }
  assertSortedUnique(
    value.owned_resources,
    (a, b) =>
      bytewise(
        `${a.ownership_key}\0${a.public_target}\0${a.expected_preimage_sha256}`,
        `${b.ownership_key}\0${b.public_target}\0${b.expected_preimage_sha256}`,
      ),
    "legacy_evidence.owned_resources",
  );
  const { evidence_digest: observed, ...preimage } = value;
  if (observed !== digestV1("VF-LEGACY-INSPECTION-EVIDENCE\0v1\0", preimage))
    throw new CapabilityValidationError(
      "legacy inspection evidence digest mismatch",
      "legacy_evidence.evidence_digest",
      "integrity_failure",
    );
  const validated = structuredClone(value) as ValidatedLegacyInspectionEvidenceV1;
  return validated;
}

export function issueLegacyInspectionEvidence(
  markerValue: LegacyOwnedMarkerV1,
  value: LegacyInspectionEvidenceV1,
): ValidatedLegacyInspectionEvidenceV1 {
  const marker = assertFilesystemLegacyOwnedMarkerV1(markerValue);
  const evidence = validateLegacyInspectionEvidence(value);
  const proof = marker.ownership_proof;
  const expectedRecordKind = {
    "skill-lock": "lock",
    "tool-managed-evidence": "descriptor",
    "mcp-managed-sidecar": "managed-sidecar",
    "hook-sentinel": "sentinel",
    "role-marker": "renderer-marker",
  }[marker.source];
  const resources = marker.owned_resources.map(
    ({ ownership_key, public_target, expected_preimage_sha256 }) => ({
      ownership_key,
      public_target,
      expected_preimage_sha256,
    }),
  );
  if (
    marker.vf_owned !== true ||
    !proof ||
    evidence.legacy_source !== marker.source ||
    evidence.raw_identifier_nfc !== marker.raw_identifier.normalize("NFC") ||
    evidence.source_records.length !== 1 ||
    evidence.source_records[0]?.record_kind !== expectedRecordKind ||
    evidence.source_records[0]?.logical_id !== proof.logical_id ||
    evidence.source_records[0]?.content_sha256 !== proof.content_sha256 ||
    canonicalJson(evidence.owned_resources) !== canonicalJson(resources)
  )
    throw new CapabilityValidationError(
      "legacy inspection evidence differs from concrete observed ownership bytes",
      "legacy_evidence",
      "integrity_failure",
    );
  ISSUED_EVIDENCE.add(evidence);
  return freezeEvidence(evidence);
}

export function validateLegacyAdoptClosure(
  input: {
    manifest: ValidatedCapabilityManifestV1;
    tree: PackageTreeV1;
    evidence: LegacyInspectionEvidenceV1;
  },
  options: { requireIssuedEvidence: boolean },
) {
  const manifest = assertValidatedCapabilityManifest(input.manifest);
  const tree = assertValidatedPackageTree(input.tree);
  const inspectorIssued = ISSUED_EVIDENCE.has(input.evidence);
  const evidence = validateLegacyInspectionEvidence(input.evidence);
  if (options.requireIssuedEvidence && !inspectorIssued)
    throw new CapabilityValidationError(
      "legacy closure evidence was not issued by the concrete host inspector",
      "legacy_evidence",
      "integrity_failure",
    );
  const manifestBytes = tree.files.get("capability.json");
  const evidenceBytes = tree.files.get("legacy-adopt-evidence.json");
  const expectedEvidenceBytes = canonicalJsonBytes({
    schema_version: "1.0",
    legacy_source: evidence.legacy_source,
    owned_resources: evidence.owned_resources,
    inspection_evidence_digest: evidence.evidence_digest,
  });
  if (
    !manifestBytes ||
    !Buffer.from(manifestBytes).equals(manifest.source_bytes) ||
    !evidenceBytes ||
    !Buffer.from(evidenceBytes).equals(expectedEvidenceBytes)
  )
    throw new CapabilityValidationError(
      "legacy synthetic tree does not retain its exact manifest/evidence closure",
      "legacy_evidence",
      "integrity_failure",
    );
  const { version: _, ...withoutVersion } = manifest.manifest;
  const expectedVersion = `0.0.0-legacy.${digestV1("VF-LEGACY-ADOPT-VERSION\0v1\0", {
    legacy_source: evidence.legacy_source,
    synthetic_manifest_without_version: withoutVersion,
    owned_resources: evidence.owned_resources,
    inspection_evidence_digest: evidence.evidence_digest,
  }).slice(7, 19)}`;
  if (manifest.manifest.version !== expectedVersion)
    throw new CapabilityValidationError(
      "legacy synthetic manifest version does not bind inspection evidence",
      "legacy_evidence",
      "integrity_failure",
    );
  return { manifest, tree, evidence };
}
