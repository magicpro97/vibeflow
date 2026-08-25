import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import { digestV1 } from "../../durability/index.js";
import type { PublicLegacyAdoptInspectionResponseV1 } from "../wire/cli.js";
import type { LegacyAdoptMaterializedInspectionRequestV1 } from "./types.js";

export function projectLegacyAdoptInspection(
  request: Pick<
    LegacyAdoptMaterializedInspectionRequestV1,
    "scope" | "scope_identity_digest" | "sources"
  >,
  inspectedAt: string,
  candidates: readonly StrictLegacyAdoptCandidateV1[],
): PublicLegacyAdoptInspectionResponseV1 {
  const candidate_set_digest = digestV1("VF-LEGACY-ADOPT-CANDIDATE-SET\0v1\0", {
    schema_version: "1.0",
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    legacy_sources: request.sources,
    candidates: candidates.map((item) => ({
      candidate_id: item.candidate_id,
      candidate_digest: item.candidate_digest,
    })),
  });
  return {
    schema_version: "1.0",
    scope: request.scope,
    legacy_sources: request.sources,
    inspected_at: inspectedAt,
    expires_at: new Date(Date.parse(inspectedAt) + 10 * 60_000).toISOString(),
    candidates: candidates.map((item) => ({
      schema_version: "1.0",
      candidate_id: item.candidate_id,
      candidate_digest: item.candidate_digest,
      scope: item.scope,
      legacy_source: item.legacy_source,
      package_pin: {
        id: item.synthetic_pin.id,
        version: item.synthetic_pin.version,
        source_kind: item.synthetic_pin.source.kind,
        content_sha256: item.synthetic_pin.content_sha256,
        trust: item.synthetic_pin.trust,
        nonportable: item.synthetic_pin.nonportable,
        pin_digest: item.synthetic_pin.pin_digest,
      },
      permission_ids: item.permissions.map((permission) => permission.permission_id),
      target_ids: item.targets.map((target) => target.target_id),
      owned_resource_count: item.owned_resources.length,
      inspected_at: item.inspected_at,
      expires_at: item.expires_at,
    })),
    candidate_set_digest,
  };
}
