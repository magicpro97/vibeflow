import { digestHex, digestV1 } from "../../durability/index.js";
import type { CapabilityEffectDescriptorV1 } from "../adapters/types.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityExecutionObjectClosureV1,
  CapabilityFabricPlanV1,
  CapabilityProjectionSnapshotV1,
} from "./types.js";

export function effectDescriptorDigest(
  value: Omit<CapabilityEffectDescriptorV1, "descriptor_digest">,
): string {
  return digestV1("VF-ADAPTER-PRIVATE-DESCRIPTOR\0v1\0", value);
}

export function projectionSnapshotDigest(value: CapabilityProjectionSnapshotV1): string {
  const { snapshot_digest: _, ...preimage } = value;
  return digestV1("VF-PROJECTION-SNAPSHOT\0v1\0", preimage);
}

export function adapterPlanDigest(value: CapabilityAdapterPlanV1): string {
  const { plan_id: _, plan_digest: __, ...preimage } = value;
  return digestV1("VF-ADAPTER-PLAN\0v1\0", preimage);
}

export function adapterPlanIdentity(digest: string): string {
  return `vf-adapter-plan-${digestHex(digest)}`;
}

export function executionClosureDigest(value: CapabilityExecutionObjectClosureV1): string {
  const { closure_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-EXECUTION-OBJECT-CLOSURE\0v1\0", preimage);
}

export function capabilityFabricPlanDigest(value: CapabilityFabricPlanV1): string {
  const { plan_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-FABRIC-PLAN\0v1\0", preimage);
}
