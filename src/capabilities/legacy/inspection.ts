import { createHash } from "node:crypto";
import { validateLegacyCandidate } from "../../actions/internal-candidate-validation.js";
import type {
  LegacyManifestPermissionV1,
  LegacySourceV1,
  LegacySyntheticComponentV1,
  LegacySyntheticManifestV1,
  StrictLegacyAdoptCandidateV1,
} from "../../actions/legacy-adopt-types.js";
import { targetId } from "../../actions/proposal-content-validation.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import { parseCapabilityManifest } from "../manifest/validation.js";
import { issueLegacyInspectionEvidence } from "../source/legacy-adopt-closure.js";
import type { CapabilityPackageCachePublicationV1 } from "../source/package-cache-types.js";
import { createAuthenticityBinding, createLegacyAdoptPackagePin } from "../source/pins.js";
import { computePackageTree } from "../source/tree.js";
import type { PublicLegacyAdoptInspectionResponseV1 } from "../wire/cli.js";
import { CapabilityValidationError, bytewise } from "../wire/primitives.js";
import { projectLegacyAdoptInspection } from "./inspection-projection.js";
import type { LegacyAdoptMaterializedInspectionRequestV1, LegacyOwnedMarkerV1 } from "./types.js";

export { projectLegacyAdoptInspection } from "./inspection-projection.js";

const SOURCE_ORDER: LegacySourceV1[] = [
  "skill-lock",
  "tool-managed-evidence",
  "mcp-managed-sidecar",
  "hook-sentinel",
  "role-marker",
];

function rawSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function managedIdentifier(raw: string): string {
  const normalized = raw.normalize("NFC");
  const slug =
    normalized
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "item";
  const length = Buffer.alloc(8);
  const bytes = Buffer.from(normalized, "utf8");
  length.writeBigUInt64BE(BigInt(bytes.length));
  const hash = createHash("sha256")
    .update("VF-LEGACY-MANAGED-IDENTIFIER\0v1\0")
    .update(length)
    .update(bytes)
    .digest("hex");
  return `${slug}-${hash}`;
}

function packageId(marker: LegacyOwnedMarkerV1): string {
  const prefix =
    marker.source === "skill-lock"
      ? "legacy.skill."
      : marker.source === "tool-managed-evidence"
        ? "legacy.tool."
        : marker.source === "mcp-managed-sidecar"
          ? `legacy.mcp.${marker.engine}.`
          : marker.source === "hook-sentinel"
            ? `legacy.hook.${marker.engine}.`
            : `legacy.role.${marker.engine}.`;
  return `${prefix}${managedIdentifier(marker.raw_identifier)}`;
}

function component(marker: LegacyOwnedMarkerV1): LegacySyntheticComponentV1 {
  const base = { component_id: "legacy", targets: [marker.engine], required: true };
  const payloadSha = rawSha(marker.payload);
  switch (marker.source) {
    case "skill-lock":
      return { ...base, type: "skill", bundle_path: "payload/SKILL.md", bundle_sha256: payloadSha };
    case "tool-managed-evidence":
      return {
        ...base,
        type: "tool",
        installer: {
          kind: "download",
          coordinate: `legacy-managed:${managedIdentifier(marker.raw_identifier)}`,
          version: "0.0.0",
          artifact_sha256: payloadSha,
          lifecycle_scripts: "disabled",
        },
        expected_binary: "legacy-tool",
        version_constraint: "*",
      };
    case "mcp-managed-sidecar":
      return {
        ...base,
        type: "mcp",
        transport: "stdio",
        executable: { component_id: "legacy", relative_path: "payload/server", sha256: payloadSha },
        args: [],
        secret_slots: [],
      };
    case "hook-sentinel":
      return { ...base, type: "hook", event: "pre-tool", vf_handler_id: "legacy-handler" };
    case "role-marker":
      return {
        ...base,
        type: "role",
        role_spec_path: "payload/role.md",
        role_spec_sha256: payloadSha,
      };
  }
}

function permissions(marker: LegacyOwnedMarkerV1, id: string): LegacyManifestPermissionV1[] {
  return marker.owned_resources
    .map((resource, index): LegacyManifestPermissionV1 => {
      const permission_id = `${id}/owned-${index}`;
      if (marker.source === "hook-sentinel")
        return {
          permission_id,
          required_enforcement: "engine-enforced",
          kind: "hook",
          scope: { engine: marker.engine, hook_point: "pre-tool", participant_id: null },
        };
      if (marker.source === "skill-lock" || marker.source === "role-marker")
        return {
          permission_id,
          required_enforcement: "sandboxed",
          kind: "filesystem",
          scope: { root: "project", access: "write", path_prefix: ".vibeflow" },
        };
      if (marker.source === "tool-managed-evidence")
        return {
          permission_id,
          required_enforcement: "brokered",
          kind: "process",
          scope: { executable_class: "legacy-tool", argv_prefix: [], allow_additional_args: false },
        };
      return {
        permission_id,
        required_enforcement: "engine-enforced",
        kind: "config",
        scope: {
          engine: marker.engine,
          namespace: "legacy",
          access: "write",
          key_prefix: `managed.item${index}`,
        },
      };
    })
    .sort((left, right) => bytewise(left.permission_id, right.permission_id));
}

function candidate(
  request: LegacyAdoptMaterializedInspectionRequestV1,
  marker: LegacyOwnedMarkerV1,
  inspectedAt: string,
): LegacyAdoptCandidateMaterializationV1 {
  const id = packageId(marker);
  const owned_resources = marker.owned_resources
    .map(({ ownership_key, public_target, expected_preimage_sha256 }) => ({
      ownership_key,
      public_target,
      expected_preimage_sha256,
    }))
    .sort((left, right) =>
      bytewise(
        `${left.ownership_key}\0${left.public_target}\0${left.expected_preimage_sha256}`,
        `${right.ownership_key}\0${right.public_target}\0${right.expected_preimage_sha256}`,
      ),
    );
  const proof = marker.ownership_proof as NonNullable<LegacyOwnedMarkerV1["ownership_proof"]>;
  const recordKind = {
    "skill-lock": "lock",
    "tool-managed-evidence": "descriptor",
    "mcp-managed-sidecar": "managed-sidecar",
    "hook-sentinel": "sentinel",
    "role-marker": "renderer-marker",
  }[marker.source] as "lock" | "descriptor" | "managed-sidecar" | "sentinel" | "renderer-marker";
  const recordDraft = {
    record_kind: recordKind,
    logical_id: proof.logical_id,
    content_sha256: proof.content_sha256,
  };
  const record = {
    ...recordDraft,
    record_digest: digestV1("VF-LEGACY-INSPECTION-SOURCE-RECORD\0v1\0", recordDraft),
  };
  const evidenceDraft = {
    schema_version: "1.0" as const,
    legacy_source: marker.source,
    raw_identifier_nfc: marker.raw_identifier.normalize("NFC"),
    adapter_fingerprint: digestV1("VF-LEGACY-ADAPTER-FINGERPRINT\0v1\0", marker.source),
    owned_resources,
    source_records: [record],
  };
  const inspection_evidence_digest = digestV1("VF-LEGACY-INSPECTION-EVIDENCE\0v1\0", evidenceDraft);
  const inspectionEvidence = issueLegacyInspectionEvidence(marker, {
    ...evidenceDraft,
    evidence_digest: inspection_evidence_digest,
  });
  const syntheticComponent = component(marker);
  const syntheticPermissions = permissions(marker, id);
  const withoutVersion = {
    schema_version: "1.0" as const,
    id,
    metadata: {
      display_name: id,
      summary: "Imported VF-managed legacy capability",
      homepage_url: null,
      documentation_url: null,
      icon: null,
    },
    compatibility: { vf: "*", engines: { [marker.engine]: "*" } },
    components: [syntheticComponent],
    dependencies: [],
    conflicts: [] as [],
    permissions: syntheticPermissions,
    inputs: [] as [],
    health: [
      {
        probe_id: "legacy-health",
        component_ids: ["legacy"],
        kind:
          marker.source === "skill-lock"
            ? ("file-hash" as const)
            : marker.source === "tool-managed-evidence"
              ? ("binary-version" as const)
              : marker.source === "mcp-managed-sidecar"
                ? ("mcp-handshake" as const)
                : marker.source === "hook-sentinel"
                  ? ("hook-selftest" as const)
                  : ("role-parse" as const),
        required: true,
        timeout_ms: 5_000,
        retries: 0 as const,
      },
    ],
  };
  const versionDigest = digestV1("VF-LEGACY-ADOPT-VERSION\0v1\0", {
    legacy_source: marker.source,
    synthetic_manifest_without_version: withoutVersion,
    owned_resources,
    inspection_evidence_digest,
  });
  const version = `0.0.0-legacy.${digestHex(versionDigest).slice(0, 12)}`;
  const synthetic_manifest: LegacySyntheticManifestV1 = { ...withoutVersion, version };
  const evidenceBytes = canonicalJsonBytes({
    schema_version: "1.0",
    legacy_source: marker.source,
    owned_resources,
    inspection_evidence_digest,
  });
  const entries: Array<{ path: string; bytes: Uint8Array }> = [
    { path: "capability.json", bytes: canonicalJsonBytes(synthetic_manifest) },
    { path: "legacy-adopt-evidence.json", bytes: evidenceBytes },
  ];
  if (marker.source === "skill-lock")
    entries.push({ path: "payload/SKILL.md", bytes: marker.payload });
  if (marker.source === "mcp-managed-sidecar")
    entries.push({ path: "payload/server", bytes: marker.payload });
  if (marker.source === "role-marker")
    entries.push({ path: "payload/role.md", bytes: marker.payload });
  const tree = computePackageTree(entries);
  const parsedManifest = parseCapabilityManifest(
    tree.files.get("capability.json") as Uint8Array,
    tree.files,
  );
  const synthetic_pin = createLegacyAdoptPackagePin({
    manifest: parsedManifest,
    tree,
    evidence: inspectionEvidence,
  });
  const targetValue = {
    target: {
      scope: request.scope,
      engine: marker.engine,
      participant_id: null,
      required: true as const,
      on_apply_failure: "abort-scope" as const,
      on_health_failure: "abort-scope" as const,
    },
    subject: { kind: "capability" as const, package_id: id, component_id: "legacy" },
  };
  const draft = {
    schema_version: "1.0" as const,
    candidate_id: "",
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    legacy_source: marker.source,
    synthetic_manifest,
    synthetic_pin,
    permissions: syntheticPermissions,
    dependencies: [],
    targets: [{ target_id: targetId(targetValue), ...targetValue }],
    owned_resources,
    inspection_evidence_digest,
    inspected_at: inspectedAt,
    expires_at: new Date(Date.parse(inspectedAt) + 10 * 60_000).toISOString(),
    candidate_digest: "",
  };
  const {
    candidate_id: _candidateId,
    candidate_digest: _candidateDigest,
    ...candidatePreimage
  } = draft;
  const candidateDigest = digestV1("VF-LEGACY-ADOPT-CANDIDATE\0v1\0", candidatePreimage);
  const result = {
    ...draft,
    candidate_id: `vf-adopt-${digestHex(candidateDigest)}`,
    candidate_digest: candidateDigest,
  };
  validateLegacyCandidate(result, request.scope, "candidate");
  return {
    marker,
    candidate: result,
    publication: {
      pin: synthetic_pin,
      tree,
      manifest: parsedManifest,
      authenticity: createAuthenticityBinding(synthetic_pin, parsedManifest.manifest_digest, null),
      registry_envelope: null,
      legacy_inspection_evidence: inspectionEvidence,
    },
  };
}

export interface LegacyAdoptCandidateMaterializationV1 {
  marker: LegacyOwnedMarkerV1;
  candidate: StrictLegacyAdoptCandidateV1;
  publication: CapabilityPackageCachePublicationV1;
}

export function inspectLegacyAdoptCandidates(
  request: LegacyAdoptMaterializedInspectionRequestV1,
  inspectedAt: string,
): PublicLegacyAdoptInspectionResponseV1 {
  const candidates = inspectLegacyAdoptCandidateClosures(request, inspectedAt);
  return projectLegacyAdoptInspection(request, inspectedAt, candidates);
}

export function inspectLegacyAdoptCandidateClosures(
  request: LegacyAdoptMaterializedInspectionRequestV1,
  inspectedAt: string,
): StrictLegacyAdoptCandidateV1[] {
  return inspectLegacyAdoptCandidateMaterializations(request, inspectedAt).map(
    (item) => item.candidate,
  );
}

export function inspectLegacyAdoptCandidateMaterializations(
  request: LegacyAdoptMaterializedInspectionRequestV1,
  inspectedAt: string,
): LegacyAdoptCandidateMaterializationV1[] {
  if (request.schema_version !== "1.0" || request.sources.length === 0)
    throw new CapabilityValidationError(
      "legacy inspection request is invalid",
      "legacy_inspection",
    );
  const sourcePositions = request.sources.map((source) => SOURCE_ORDER.indexOf(source));
  if (
    sourcePositions.some((index) => index < 0) ||
    new Set(request.sources).size !== request.sources.length ||
    sourcePositions.some(
      (value, index) => index > 0 && value <= (sourcePositions[index - 1] as number),
    )
  )
    throw new CapabilityValidationError(
      "legacy sources must be canonical and unique",
      "legacy_inspection.sources",
    );
  const candidates = request.markers
    .filter(
      (marker) =>
        request.sources.includes(marker.source) &&
        marker.vf_owned === true &&
        marker.ownership_proof !== null &&
        marker.ownership_proof.record_kind === marker.source,
    )
    .map((marker) => candidate(request, marker, inspectedAt))
    .sort((left, right) => bytewise(left.candidate.candidate_id, right.candidate.candidate_id));
  return candidates;
}
