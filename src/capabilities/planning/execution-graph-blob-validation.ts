import { digestV1Bytes } from "../../durability/canonical.js";
import { canonicalJson, sha256Digest } from "../../durability/index.js";
import {
  hydratePrivateEffectPayload,
  privateEffectPreimageBytes,
} from "../adapters/payload-preimage-authority.js";
import { validatePrivateEffectPayload } from "../adapters/private-descriptors.js";
import type { CapabilityAdapterPrivateDescriptorV1 } from "../adapters/types.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import { CAPABILITY_RAW_BLOB_KIND_ORDER, actionBlobRef } from "./execution-objects.js";
import type { CapabilityAdapterBoundedEvidenceV1 } from "./execution-types.js";
import type { CapabilityDurablePlanningGraphV1 } from "./types.js";

type ClosedBlobKind = "owned-resource-preimage" | "inspection-private-evidence";

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE);
}

function assertOrder(graph: CapabilityDurablePlanningGraphV1): void {
  const sorted = [...graph.ledger.raw_blobs].sort((left, right) => {
    const kind =
      CAPABILITY_RAW_BLOB_KIND_ORDER.indexOf(left.binding.blob_kind) -
      CAPABILITY_RAW_BLOB_KIND_ORDER.indexOf(right.binding.blob_kind);
    return kind || bytewise(left.binding.content_digest, right.binding.content_digest);
  });
  if (
    canonicalJson(graph.ledger.raw_blobs.map((row) => row.binding)) !==
    canonicalJson(sorted.map((row) => row.binding))
  )
    fail("execution raw blob bindings are not canonically ordered");
}

export function assertCapabilityExecutionBlobs(
  graph: CapabilityDurablePlanningGraphV1,
  descriptors: CapabilityAdapterPrivateDescriptorV1[],
  evidence: CapabilityAdapterBoundedEvidenceV1[],
): void {
  assertOrder(graph);
  if (
    canonicalJson(graph.execution_closure.raw_blobs) !==
    canonicalJson(graph.ledger.raw_blobs.map((row) => row.binding))
  )
    fail("execution closure blob membership differs from its ledger");
  const expected = new Map<string, ClosedBlobKind>();
  const preimageDescriptors = new Map<string, CapabilityAdapterPrivateDescriptorV1[]>();
  const expectBlob = (digest: string, kind: ClosedBlobKind): void => {
    const prior = expected.get(digest);
    if (prior && prior !== kind) fail("one private blob digest has conflicting closure roles");
    expected.set(digest, kind);
  };
  for (const descriptor of descriptors) {
    const resource = descriptor.value.resource;
    if (!resource.private_preimage_digest || !resource.private_preimage_ref) {
      if (resource.expected_preimage_sha256 !== null)
        fail("owned resource lacks its private preimage authority");
      continue;
    }
    expectBlob(resource.private_preimage_digest, "owned-resource-preimage");
    const owners = preimageDescriptors.get(resource.private_preimage_digest) ?? [];
    owners.push(descriptor);
    preimageDescriptors.set(resource.private_preimage_digest, owners);
  }
  for (const row of evidence)
    if (row.private_payload_content_digest)
      expectBlob(row.private_payload_content_digest, "inspection-private-evidence");
  const observed = new Set<string>();
  for (const row of graph.ledger.raw_blobs) {
    const bytes = Buffer.from(row.bytes_base64, "base64");
    if (bytes.toString("base64") !== row.bytes_base64)
      fail("execution raw blob bytes are not canonical base64");
    const expectedKind = expected.get(row.binding.content_digest);
    if (!expectedKind || row.binding.blob_kind !== expectedKind)
      fail("execution closure contains an unsupported raw blob kind");
    const domain =
      expectedKind === "owned-resource-preimage"
        ? "VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0"
        : "VF-ADAPTER-PRIVATE-EVIDENCE\0v1\0";
    const digest = digestV1Bytes(domain, bytes);
    if (
      digest !== row.binding.content_digest ||
      row.binding.raw_sha256 !== sha256Digest(bytes).slice("sha256:".length) ||
      row.binding.byte_length !== bytes.length ||
      row.binding.blob_ref !== actionBlobRef(digest) ||
      observed.has(digest)
    )
      fail("execution raw blob binding mismatch");
    if (expectedKind === "owned-resource-preimage") {
      const descriptorsForBlob = preimageDescriptors.get(row.binding.content_digest) ?? [];
      if (descriptorsForBlob.length === 0) fail("owned preimage blob has no descriptor authority");
      for (const descriptor of descriptorsForBlob) {
        if (descriptor.value.private_payload.payload_kind === "memory-test-only") continue;
        if (descriptor.value.resource.expected_preimage_sha256 !== row.binding.raw_sha256)
          fail("owned preimage raw SHA-256 differs from its resource preimage");
        const payload = validatePrivateEffectPayload(
          hydratePrivateEffectPayload(descriptor.value.private_payload, bytes),
        );
        const rebound = privateEffectPreimageBytes(payload);
        if (
          rebound === null ||
          !Buffer.from(rebound).equals(bytes) ||
          payload.ownership_key !== descriptor.value.resource.ownership_key ||
          payload.expected_preimage_sha256 !== descriptor.value.resource.expected_preimage_sha256
        )
          fail("owned preimage blob is not the sole exact descriptor preimage authority");
      }
    }
    observed.add(digest);
  }
  if (
    canonicalJson([...observed].sort(bytewise)) !==
    canonicalJson([...expected.keys()].sort(bytewise))
  )
    fail("execution raw blob set is not exactly reachable");
}
