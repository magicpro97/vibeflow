import { canonicalJsonBytes, digestHex, digestV1, sha256Digest } from "../../durability/index.js";
import { validateAdapterPrivateDescriptor } from "../adapters/private-descriptors.js";
import { adapterRegistryDigest, validateCapabilityAdapterRegistry } from "../adapters/registry.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityAdapterRegistryV1,
} from "../adapters/types.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { permissionBindingDigest } from "../permissions/index.js";
import type { PermissionBindingV1 } from "../permissions/types.js";
import type { PackageAuthenticityBindingV1 } from "../source/types.js";
import { adapterPlanDigest, projectionSnapshotDigest } from "./digests.js";
import type {
  ActionRootJsonObjectBindingV1,
  ActionRootRawBlobBindingV1,
  CapabilityAdapterBoundedEvidenceV1,
  CapabilityControlCredentialBindingV1,
  CapabilityExecutionJsonObjectValueV1,
  CapabilityExecutionObjectSchemaIdV1,
  CapabilityExecutionRawBlobKindV1,
  CapabilityPlanningJsonObjectV1,
  CapabilityPlanningRawBlobV1,
  CapabilityProbeEnforcementBindingV1,
  CapabilityResolvedSourceAuthorityBindingV1,
  CapabilitySourceAccessAuthorityBindingV1,
  CapabilitySourceAccessDescriptorV1,
  CapabilityStepEnforcementBindingV1,
} from "./execution-types.js";
import type { CapabilityAdapterPlanV1, CapabilityProjectionSnapshotV1 } from "./types.js";

export const CAPABILITY_EXECUTION_SCHEMA_ORDER: readonly CapabilityExecutionObjectSchemaIdV1[] = [
  "vf.capability-adapter-registry/1",
  "vf.adapter-plan/1",
  "vf.projection-snapshot/1",
  "vf.adapter-bounded-evidence/1",
  "vf.adapter-private-descriptor/1",
  "vf.step-enforcement-binding/1",
  "vf.probe-enforcement-binding/1",
  "vf.permission-binding/1",
  "vf.adapter-set-binding/1",
  "vf.source-access-descriptor/1",
  "vf.source-access-authority-binding/1",
  "vf.package-authenticity-binding/1",
  "vf.resolved-source-authority-binding/1",
  "vf.control-credential-binding/1",
];

export const CAPABILITY_RAW_BLOB_KIND_ORDER: readonly CapabilityExecutionRawBlobKindV1[] = [
  "owned-resource-preimage",
  "inspection-private-evidence",
  "suspected-literal-content",
  "policy-settings-preimage",
  "policy-settings-replacement",
];

export function actionJsonRef(digest: string): string {
  return `actions/v1/objects/${digestHex(digest)}.json`;
}

export function actionBlobRef(digest: string): string {
  return `actions/v1/blobs/${digestHex(digest)}.bin`;
}

export function capabilityExecutionObjectDigest(
  schema: CapabilityExecutionObjectSchemaIdV1,
  value: CapabilityExecutionJsonObjectValueV1,
): string {
  switch (schema) {
    case "vf.capability-adapter-registry/1":
      return adapterRegistryDigest(
        validateCapabilityAdapterRegistry(value as CapabilityAdapterRegistryV1),
      );
    case "vf.adapter-plan/1":
      return adapterPlanDigest(value as CapabilityAdapterPlanV1);
    case "vf.projection-snapshot/1":
      return projectionSnapshotDigest(value as CapabilityProjectionSnapshotV1);
    case "vf.adapter-bounded-evidence/1": {
      const { evidence_digest: _, ...draft } = value as CapabilityAdapterBoundedEvidenceV1;
      return digestV1("VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", draft);
    }
    case "vf.adapter-private-descriptor/1":
      return validateAdapterPrivateDescriptor(value as CapabilityAdapterPrivateDescriptorV1)
        .descriptor_digest;
    case "vf.step-enforcement-binding/1": {
      const { enforcement_digest: _, ...draft } = value as CapabilityStepEnforcementBindingV1;
      return digestV1("VF-STEP-ENFORCEMENT\0v1\0", draft);
    }
    case "vf.probe-enforcement-binding/1": {
      const { enforcement_digest: _, ...draft } = value as CapabilityProbeEnforcementBindingV1;
      return digestV1("VF-PROBE-ENFORCEMENT\0v1\0", draft);
    }
    case "vf.permission-binding/1":
      return permissionBindingDigest(value as PermissionBindingV1);
    case "vf.adapter-set-binding/1":
      return digestV1("VF-ADAPTER-SET\0v1\0", value);
    case "vf.source-access-descriptor/1": {
      const { descriptor_digest: _, ...draft } = value as CapabilitySourceAccessDescriptorV1;
      return digestV1("VF-SOURCE-ACCESS-DESCRIPTOR\0v1\0", draft);
    }
    case "vf.source-access-authority-binding/1": {
      const { binding_digest: _, ...draft } = value as CapabilitySourceAccessAuthorityBindingV1;
      return digestV1("VF-SOURCE-ACCESS-AUTHORITY\0v1\0", draft);
    }
    case "vf.package-authenticity-binding/1": {
      const { authenticity_digest: _, ...draft } = value as PackageAuthenticityBindingV1;
      return digestV1("VF-PACKAGE-AUTHENTICITY-BINDING\0v1\0", draft);
    }
    case "vf.resolved-source-authority-binding/1": {
      const { binding_digest: _, ...draft } = value as CapabilityResolvedSourceAuthorityBindingV1;
      return digestV1("VF-RESOLVED-SOURCE-AUTHORITY\0v1\0", draft);
    }
    case "vf.control-credential-binding/1": {
      const { binding_digest: _, ...draft } = value as CapabilityControlCredentialBindingV1;
      return digestV1("VF-CONTROL-CREDENTIAL-BINDING\0v1\0", draft);
    }
  }
}

const STRATA: Record<CapabilityExecutionObjectSchemaIdV1, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7> = {
  "vf.capability-adapter-registry/1": 0,
  "vf.adapter-plan/1": 7,
  "vf.projection-snapshot/1": 6,
  "vf.adapter-bounded-evidence/1": 5,
  "vf.adapter-private-descriptor/1": 1,
  "vf.step-enforcement-binding/1": 5,
  "vf.probe-enforcement-binding/1": 5,
  "vf.permission-binding/1": 1,
  "vf.adapter-set-binding/1": 1,
  "vf.source-access-descriptor/1": 2,
  "vf.source-access-authority-binding/1": 3,
  "vf.package-authenticity-binding/1": 1,
  "vf.resolved-source-authority-binding/1": 4,
  "vf.control-credential-binding/1": 1,
};

export function planningJsonObject(
  schema: CapabilityExecutionObjectSchemaIdV1,
  value: CapabilityExecutionJsonObjectValueV1,
): CapabilityPlanningJsonObjectV1 {
  const objectDigest = capabilityExecutionObjectDigest(schema, value);
  const bytes = canonicalJsonBytes(value, { maxBytes: 8 * 1024 * 1024 });
  return {
    stratum: STRATA[schema],
    binding: {
      object_schema_id: schema,
      object_digest: objectDigest,
      object_ref: actionJsonRef(objectDigest),
      canonical_byte_length: bytes.length,
    },
    value: structuredClone(value),
  };
}

export function planningRawBlob(
  kind: CapabilityExecutionRawBlobKindV1,
  contentDigest: string,
  bytes: Uint8Array,
): CapabilityPlanningRawBlobV1 {
  const binding: ActionRootRawBlobBindingV1 = {
    blob_kind: kind,
    content_digest: contentDigest,
    raw_sha256: sha256Digest(bytes).slice("sha256:".length),
    byte_length: bytes.length,
    blob_ref: actionBlobRef(contentDigest),
  };
  return { stratum: 1, binding, bytes_base64: Buffer.from(bytes).toString("base64") };
}

export function assertExecutionObjectBinding(
  binding: ActionRootJsonObjectBindingV1,
  value: CapabilityExecutionJsonObjectValueV1,
): void {
  const digest = capabilityExecutionObjectDigest(binding.object_schema_id, value);
  if (
    digest !== binding.object_digest ||
    binding.object_ref !== actionJsonRef(digest) ||
    binding.canonical_byte_length !== canonicalJsonBytes(value).length
  )
    throw new CapabilityRuntimeError(
      "execution object binding mismatch",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
}
