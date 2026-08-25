import type { CapabilityAdapterPrivateDescriptorV1 } from "../adapters/types.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import type {
  CapabilityExecutionJsonObjectValueV1,
  CapabilityPlanningJsonObjectV1,
} from "./execution-types.js";
import type { CapabilityAdapterPlanV1 } from "./types.js";

const OBJECT_REF = /^actions\/v1\/objects\/[a-f0-9]{64}\.json$/u;
const BLOB_REF = /^actions\/v1\/blobs\/[a-f0-9]{64}\.bin$/u;

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

function embeddedRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === "string") {
    if (OBJECT_REF.test(value) || BLOB_REF.test(value)) refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const row of value) embeddedRefs(row, refs);
    return;
  }
  if (typeof value === "object" && value !== null)
    for (const row of Object.values(value)) embeddedRefs(row, refs);
}

function expectedRefs(row: CapabilityPlanningJsonObjectV1): string[] {
  if (row.binding.object_schema_id === "vf.adapter-plan/1") {
    const plan = row.value as CapabilityAdapterPlanV1;
    return plan.steps.flatMap((step) => [
      step.intent.private_descriptor_ref,
      ...(step.rollback.private_descriptor_ref ? [step.rollback.private_descriptor_ref] : []),
      ...step.owned_resources.flatMap((resource) =>
        resource.private_preimage_ref ? [resource.private_preimage_ref] : [],
      ),
    ]);
  }
  if (row.binding.object_schema_id === "vf.adapter-private-descriptor/1") {
    const descriptor = row.value as CapabilityAdapterPrivateDescriptorV1;
    return descriptor.value.resource.private_preimage_ref
      ? [descriptor.value.resource.private_preimage_ref]
      : [];
  }
  if (row.binding.object_schema_id === "vf.projection-snapshot/1") {
    const snapshot = row.value as import("./types.js").CapabilityProjectionSnapshotV1;
    return snapshot.owned_resources.flatMap((resource) =>
      resource.private_preimage_ref ? [resource.private_preimage_ref] : [],
    );
  }
  return [];
}

/** Rejects hidden implementation-private refs, including self/cyclic edges. */
export function assertCapabilityExecutionObjectReferences(
  rows: readonly CapabilityPlanningJsonObjectV1[],
): void {
  for (const row of rows) {
    const observed = new Set<string>();
    embeddedRefs(row.value as CapabilityExecutionJsonObjectValueV1, observed);
    const expected = [...new Set(expectedRefs(row))].sort(bytewise);
    const actual = [...observed].sort(bytewise);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      fail(
        `execution object ${row.binding.object_digest} contains an untyped object reference (${actual.join(",")} != ${expected.join(",")})`,
      );
    if (actual.includes(row.binding.object_ref)) fail("execution object contains a self reference");
  }
}
