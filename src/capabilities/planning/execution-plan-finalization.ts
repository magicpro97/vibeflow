import { digestV1Bytes } from "../../durability/canonical.js";
import { digestV1 } from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import type { PermissionBindingV1 } from "../permissions/types.js";
import { bytewise } from "../wire/primitives.js";
import { adapterPlanDigest, adapterPlanIdentity, projectionSnapshotDigest } from "./digests.js";
import type {
  CapabilityAdapterBoundedEvidenceV1,
  CapabilityProbeEnforcementBindingV1,
  CapabilityStepEnforcementBindingV1,
} from "./execution-types.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityPlanningRequestV1,
  CapabilityProjectionSnapshotV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

function targetPermissions(
  permissionBinding: PermissionBindingV1,
  targetId: string,
): CapabilityStepEnforcementBindingV1["targets"][number]["permissions"] {
  return permissionBinding.permissions
    .filter((row) => row.target_ids.includes(targetId))
    .map(({ target_ids: _, ...row }) => structuredClone(row));
}

function inspectionEvidence(input: {
  request: CapabilityPlanningRequestV1;
  pkg: ResolvedCapabilityPackageV1;
  plan: CapabilityAdapterPlanV1;
  snapshot: CapabilityProjectionSnapshotV1;
  now: string;
  privateEvidenceBytes: Uint8Array | null;
}): CapabilityAdapterBoundedEvidenceV1 {
  const { request, pkg, plan, snapshot, now } = input;
  const first = snapshot.owned_resources[0];
  const draft = {
    schema_version: "1.0" as const,
    evidence_schema_id: `${plan.adapter.adapter_id}.inspection/1`,
    evidence_kind: "inspection" as const,
    adapter_fingerprint: plan.adapter.fingerprint,
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    package_pin_digest: pkg.pin.pin_digest,
    manifest_digest: pkg.manifest_digest,
    component_id: plan.component_id,
    source_authority_binding_digest: pkg.source_authority_binding_digest,
    private_input_binding_digest:
      pkg.secret_input_ids.length === 0 ? null : pkg.private_input_binding_digest,
    authority_epoch: request.authority.authority_epoch,
    authority_head_digest: request.authority.authority_head_digest,
    policy_digest: request.authority.policy_digest,
    grant_digest: request.authority.grant_digest,
    permission_digest: plan.authority.permission_digest,
    operation_id: null,
    plan_id: null,
    step_id: null,
    probe_id: null,
    observed_receipt_state: null,
    receipt_attempt: null,
    observed_preimage_sha256: first?.expected_preimage_sha256 ?? null,
    observed_postimage_sha256: null,
    error_code: null,
    health_probe_kind: null,
    health_timeout_ms: null,
    health_attempt_count: null,
    health_outcome: null,
    target_ids: plan.targets.map((row) => row.target_id).sort(bytewise),
    facts: snapshot.owned_resources
      .map((resource) => ({
        fact_id: `projection-${resource.ownership_key}`,
        outcome:
          resource.expected_preimage_sha256 === null ? ("absent" as const) : ("present" as const),
        value: resource.public_target,
      }))
      .sort((a, b) => bytewise(a.fact_id, b.fact_id)),
    native_identifier_producer_receipt_digests: [] as string[],
    private_payload_content_digest:
      input.privateEvidenceBytes === null
        ? null
        : digestV1Bytes("VF-ADAPTER-PRIVATE-EVIDENCE\0v1\0", input.privateEvidenceBytes),
    observed_at: now,
    expires_at: null,
  };
  return {
    ...draft,
    evidence_digest: digestV1("VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", draft),
  };
}

export function finalizeCapabilityExecutionPlans(input: {
  request: CapabilityPlanningRequestV1;
  plans: CapabilityAdapterPlanV1[];
  snapshots: CapabilityProjectionSnapshotV1[];
  packages: ResolvedCapabilityPackageV1[];
  permissionBinding: PermissionBindingV1;
  now: string;
  privateInspectionEvidence: ReadonlyMap<string, Uint8Array>;
}) {
  const snapshotsByDigest = new Map(input.snapshots.map((row) => [row.snapshot_digest, row]));
  const evidence: CapabilityAdapterBoundedEvidenceV1[] = [];
  const privateEvidence: Array<{ content_digest: string; bytes: Uint8Array }> = [];
  const stepEnforcement: CapabilityStepEnforcementBindingV1[] = [];
  const probeEnforcement: CapabilityProbeEnforcementBindingV1[] = [];
  const snapshots: CapabilityProjectionSnapshotV1[] = [];
  const plans = input.plans.map((rawPlan) => {
    const rawSnapshot = snapshotsByDigest.get(rawPlan.inspection_snapshot_digest);
    const pkg = input.packages.find((row) => row.pin.pin_digest === rawPlan.package_pin.pin_digest);
    if (!rawSnapshot || !pkg)
      throw new CapabilityRuntimeError(
        "adapter plan lacks its exact package inspection closure",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    const bounded = inspectionEvidence({
      request: input.request,
      pkg,
      plan: rawPlan,
      snapshot: rawSnapshot,
      now: input.now,
      privateEvidenceBytes:
        input.privateInspectionEvidence.get(rawSnapshot.snapshot_digest) ?? null,
    });
    evidence.push(bounded);
    const privateBytes = input.privateInspectionEvidence.get(rawSnapshot.snapshot_digest);
    if (privateBytes && bounded.private_payload_content_digest)
      privateEvidence.push({
        content_digest: bounded.private_payload_content_digest,
        bytes: privateBytes,
      });
    const snapshotDraft = {
      ...structuredClone(rawSnapshot),
      ownership_evidence_digest: bounded.evidence_digest,
      snapshot_digest: "",
    };
    const snapshot = {
      ...snapshotDraft,
      snapshot_digest: projectionSnapshotDigest(snapshotDraft),
    };
    snapshots.push(snapshot);
    const steps = rawPlan.steps.map((step) => {
      const targets = step.target_ids.map((target_id) => ({
        target_id,
        permissions: targetPermissions(input.permissionBinding, target_id),
      }));
      const enforcementDraft = { schema_version: "1.0" as const, targets };
      const enforcement = {
        ...enforcementDraft,
        enforcement_digest: digestV1("VF-STEP-ENFORCEMENT\0v1\0", enforcementDraft),
      };
      stepEnforcement.push(enforcement);
      return { ...step, enforcement_digest: enforcement.enforcement_digest };
    });
    const health_plan = rawPlan.health_plan.map((probe) => {
      const targets = probe.target_ids.map((target_id) => ({
        target_id,
        permissions: targetPermissions(input.permissionBinding, target_id),
      }));
      const enforcementDraft = {
        schema_version: "1.0" as const,
        probe_id: probe.probe_id,
        targets,
      };
      const enforcement = {
        ...enforcementDraft,
        enforcement_digest: digestV1("VF-PROBE-ENFORCEMENT\0v1\0", enforcementDraft),
      };
      probeEnforcement.push(enforcement);
      return { ...probe, enforcement_digest: enforcement.enforcement_digest };
    });
    const draft = {
      ...structuredClone(rawPlan),
      plan_id: "",
      plan_digest: "",
      inspection_snapshot_digest: snapshot.snapshot_digest,
      steps,
      health_plan,
    };
    const digest = adapterPlanDigest(draft);
    return { ...draft, plan_id: adapterPlanIdentity(digest), plan_digest: digest };
  });
  return { plans, snapshots, evidence, privateEvidence, stepEnforcement, probeEnforcement };
}
