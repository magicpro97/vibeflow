import { digestV1 } from "../../durability/index.js";
import type {
  CapabilityHealthProbeRequestV1,
  CapabilityOwnedResourceV1,
  CapabilityProjectionObservationV1,
} from "./types.js";

export function filesystemCapabilityHealth(
  request: CapabilityHealthProbeRequestV1,
  inspect: (
    resource: Pick<CapabilityOwnedResourceV1, "ownership_key" | "public_target" | "kind">,
  ) => CapabilityProjectionObservationV1,
) {
  const resources = request.expected_resources.map((resource) => ({
    ownership_key: resource.ownership_key,
    expected_postimage_sha256: resource.expected_postimage_sha256,
    observed_content_sha256: inspect(resource).content_sha256,
  }));
  const exact = resources.every(
    (resource) => resource.observed_content_sha256 === resource.expected_postimage_sha256,
  );
  const unavailableLiveProbe =
    request.kind === "mcp-handshake" || request.kind === "binary-version";
  const outcome = !exact
    ? ("failed" as const)
    : unavailableLiveProbe
      ? ("unknown" as const)
      : ("ready" as const);
  const evidenceDraft = {
    schema_version: "1.0" as const,
    evidence_schema_id: "vf.adapter-health-filesystem/1" as const,
    target_id: request.target_id,
    probe_id: request.probe_id,
    kind: request.kind,
    outcome,
    resources,
  };
  const evidence = {
    ...evidenceDraft,
    evidence_digest: digestV1("VF-CAPABILITY-HEALTH-EVIDENCE\0v1\0", evidenceDraft),
  };
  return { outcome, evidence_digest: evidence.evidence_digest, evidence };
}
