import { createHash } from "node:crypto";
import { CAPABILITY_MANIFEST_COMPONENT_TYPE } from "../../actions/capability-manifest-vocabulary-contract.js";
import type { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { ActionPlanningMode, PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { digestV1Bytes } from "../../durability/canonical.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import {
  CAPABILITY_HEALTH_OUTCOME,
  CAPABILITY_OPERATION_RECOVERY_PHASE,
  type CapabilityOperationRecoveryPhaseV1,
} from "../wire/operation-state-contract.js";
import {
  privateEffectBinding,
  privateEffectPayloadDigest,
  validateAdapterPrivateDescriptor,
  validatePrivateEffectBinding,
} from "./private-descriptors.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectBrokerV1,
  CapabilityEffectDescriptorV1,
  CapabilityEffectPreparationRequestV1,
  CapabilityHealthProbeRequestV1,
  CapabilityOwnedResourceV1,
  CapabilityPrivateEffectBindingV1,
  CapabilityPrivateEffectPayloadV1,
  CapabilityProjectionObservationV1,
} from "./types.js";

/** Test-only deterministic broker. Production composition must use the filesystem broker. */

export class InMemoryCapabilityEffectBrokerV1 implements CapabilityEffectBrokerV1 {
  readonly #values = new Map<string, string>();
  readonly #projectionBytes = new Map<string, Uint8Array>();
  readonly #descriptors = new Map<string, CapabilityAdapterPrivateDescriptorV1>();
  onEffect: ((descriptor: CapabilityEffectDescriptorV1) => void) | null = null;
  onHealth: ((request: CapabilityHealthProbeRequestV1) => void) | null = null;
  privateInspectionEvidenceBytes: Uint8Array | null = null;
  now = (): string => "2026-08-25T00:00:00.000Z";

  prepare(input: CapabilityEffectPreparationRequestV1) {
    const { package: pkg, component, target } = input;
    const adopted = input.adopt_resource;
    const ownership_key =
      adopted?.ownership_key ??
      `vf:${target.scope}:${target.engine}:${target.participant_id ?? "global"}:${component.type}:${pkg.pin.id}:${component.component_id}`;
    const preimage = this.#values.get(ownership_key) ?? null;
    const desiredBytes = canonicalJsonBytes({
      schema_version: "1.0",
      value: {
        package_pin_digest: pkg.pin.pin_digest,
        manifest_digest: pkg.manifest_digest,
        component,
        target_id: target.target_id,
        public_inputs: pkg.public_inputs,
        secret_input_ids: pkg.secret_input_ids,
        private_input_binding_digest: pkg.private_input_binding_digest,
      },
      marker: null,
      auxiliary: [],
    });
    const desired = createHash("sha256").update(desiredBytes).digest("hex");
    this.#projectionBytes.set(desired, desiredBytes);
    const postimage =
      input.operation === "remove" ? null : input.operation === "claim" ? preimage : desired;
    const kind =
      component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.SKILL ||
      component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.ROLE
        ? ("file" as const)
        : component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP ||
            component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK ||
            component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.ENGINE_SETTING
          ? ("config-key" as const)
          : ("external-effect" as const);
    const preimageBytes = preimage === null ? null : (this.#projectionBytes.get(preimage) ?? null);
    if (preimage !== null && preimageBytes === null)
      throw new Error("memory broker lacks the exact retained preimage bytes");
    const privatePreimageDigest =
      preimageBytes === null
        ? null
        : digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", preimageBytes);
    const resource = {
      ownership_key: adopted?.ownership_key ?? ownership_key,
      kind,
      public_target:
        adopted?.public_target ??
        `${target.engine} ${component.type} ${pkg.pin.id}/${component.component_id}`,
      expected_preimage_sha256: adopted?.expected_preimage_sha256 ?? preimage,
      expected_postimage_sha256:
        input.operation === "claim" ? (adopted?.expected_preimage_sha256 ?? preimage) : postimage,
      private_preimage_digest: privatePreimageDigest,
      private_preimage_ref:
        privatePreimageDigest === null
          ? null
          : `actions/v1/blobs/${digestHex(privatePreimageDigest)}.bin`,
    };
    const draft = {
      schema_version: "1.0" as const,
      payload_kind: "memory-test-only" as const,
      ownership_key: resource.ownership_key,
      expected_preimage_sha256: resource.expected_preimage_sha256,
      expected_postimage_sha256: resource.expected_postimage_sha256,
    };
    const payload = { ...draft, payload_digest: "" };
    payload.payload_digest = privateEffectPayloadDigest(payload);
    return {
      resource,
      private_payload: payload,
      private_preimage_bytes: preimageBytes,
      private_inspection_evidence_bytes: this.privateInspectionEvidenceBytes,
    };
  }

  prepareRemoval(
    resource: CapabilityOwnedResourceV1,
    _persistence?: ActionPlanningMode,
    actionRootLocator?: Exclude<
      PrivateActionRootLocatorV1,
      { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
    >,
  ) {
    if (!actionRootLocator) throw new Error("memory removal requires its logical action root");
    const observed = this.inspect(resource).content_sha256;
    const preimageBytes = observed === null ? null : (this.#projectionBytes.get(observed) ?? null);
    if (observed !== null && preimageBytes === null)
      throw new Error("memory broker lacks the exact removal preimage bytes");
    const privatePreimageDigest =
      preimageBytes === null
        ? null
        : digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", preimageBytes);
    const next = {
      ...resource,
      expected_preimage_sha256: observed,
      expected_postimage_sha256: null,
      private_preimage_digest: privatePreimageDigest,
      private_preimage_ref:
        privatePreimageDigest === null
          ? null
          : `actions/v1/blobs/${digestHex(privatePreimageDigest)}.bin`,
    };
    const draft = {
      schema_version: "1.0" as const,
      payload_kind: "memory-test-only" as const,
      ownership_key: resource.ownership_key,
      expected_preimage_sha256: observed,
      expected_postimage_sha256: null,
    };
    const payload = { ...draft, payload_digest: "" };
    payload.payload_digest = privateEffectPayloadDigest(payload);
    return {
      resource: next,
      private_payload: payload,
      private_preimage_bytes: preimageBytes,
      private_inspection_evidence_bytes: this.privateInspectionEvidenceBytes,
    };
  }

  retainPrivateDescriptor(
    descriptor: CapabilityAdapterPrivateDescriptorV1,
    _persistence: ActionPlanningMode,
    actionRootLocator: Exclude<
      PrivateActionRootLocatorV1,
      { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
    >,
  ): CapabilityPrivateEffectBindingV1 {
    const validated = validateAdapterPrivateDescriptor(descriptor);
    const prior = this.#descriptors.get(validated.descriptor_digest);
    if (prior && JSON.stringify(prior) !== JSON.stringify(validated))
      throw new Error("memory private descriptor digest collision");
    this.#descriptors.set(validated.descriptor_digest, validated);
    return privateEffectBinding(validated, actionRootLocator);
  }

  resolvePrivatePayload(
    binding: CapabilityPrivateEffectBindingV1,
  ): CapabilityPrivateEffectPayloadV1 {
    const validated = validatePrivateEffectBinding(binding);
    const descriptor = this.#descriptors.get(validated.descriptor_digest);
    if (!descriptor) throw new Error("private adapter descriptor is unavailable");
    return structuredClone(descriptor.value.private_payload);
  }

  clearTransientPayloads(): void {
    // Deliberate no-op: this class is test-only and lifecycle tests execute inspected plans in-process.
  }

  inspect(
    resource: Pick<CapabilityOwnedResourceV1, "ownership_key">,
  ): CapabilityProjectionObservationV1 {
    const content = this.#values.get(resource.ownership_key) ?? null;
    return {
      schema_version: "1.0",
      ownership_key: resource.ownership_key,
      state: content === null ? "absent" : "present",
      content_sha256: content,
      observed_at: this.now(),
    };
  }

  apply(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1 {
    this.assertPrivatePayload(descriptor, privatePayload);
    const current = this.#values.get(descriptor.resource.ownership_key) ?? null;
    if (current !== descriptor.resource.expected_preimage_sha256)
      throw new Error("owned preimage changed before effect");
    if (descriptor.operation === "claim") {
      if (current !== descriptor.resource.expected_postimage_sha256)
        throw new Error("legacy claim no longer matches inspected bytes");
    } else if (descriptor.resource.expected_postimage_sha256 === null) {
      this.#values.delete(descriptor.resource.ownership_key);
    } else {
      this.#values.set(
        descriptor.resource.ownership_key,
        descriptor.resource.expected_postimage_sha256,
      );
      const bytes = this.#projectionBytes.get(descriptor.resource.expected_postimage_sha256);
      if (!bytes) throw new Error("memory broker lacks the exact postimage bytes");
    }
    this.onEffect?.(descriptor);
    return this.inspect(descriptor.resource);
  }

  rollback(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1 {
    this.assertPrivatePayload(descriptor, privatePayload);
    const current = this.#values.get(descriptor.resource.ownership_key) ?? null;
    if (current !== descriptor.resource.expected_postimage_sha256)
      throw new Error("owned postimage changed before rollback");
    if (descriptor.resource.expected_preimage_sha256 === null)
      this.#values.delete(descriptor.resource.ownership_key);
    else
      this.#values.set(
        descriptor.resource.ownership_key,
        descriptor.resource.expected_preimage_sha256,
      );
    return this.inspect(descriptor.resource);
  }

  reconcile(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
    direction: CapabilityOperationRecoveryPhaseV1,
  ): CapabilityProjectionObservationV1 {
    this.assertPrivatePayload(descriptor, privatePayload);
    const current = this.#values.get(descriptor.resource.ownership_key) ?? null;
    const preimage = descriptor.resource.expected_preimage_sha256;
    const postimage = descriptor.resource.expected_postimage_sha256;
    if (current !== preimage && current !== postimage)
      throw new Error("memory repair encountered an unapproved state");
    const desired =
      direction === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD ? postimage : preimage;
    if (desired === null) this.#values.delete(descriptor.resource.ownership_key);
    else this.#values.set(descriptor.resource.ownership_key, desired);
    return this.inspect(descriptor.resource);
  }

  health(request: CapabilityHealthProbeRequestV1) {
    this.onHealth?.(request);
    const resources = request.expected_resources.map((resource) => ({
      ownership_key: resource.ownership_key,
      expected_postimage_sha256: resource.expected_postimage_sha256,
      observed_content_sha256: this.#values.get(resource.ownership_key) ?? null,
    }));
    const ready = resources.every(
      (resource) => resource.observed_content_sha256 === resource.expected_postimage_sha256,
    );
    const outcome = ready ? CAPABILITY_HEALTH_OUTCOME.READY : CAPABILITY_HEALTH_OUTCOME.FAILED;
    const evidenceDraft = {
      schema_version: "1.0" as const,
      evidence_schema_id: "vf.adapter-health-memory-test/1" as const,
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
    return {
      outcome,
      evidence_digest: evidence.evidence_digest,
      evidence,
    };
  }

  force(ownershipKey: string, contentSha256: string | null): void {
    if (contentSha256 === null) this.#values.delete(ownershipKey);
    else this.#values.set(ownershipKey, contentSha256);
  }

  forceBytes(ownershipKey: string, bytes: Uint8Array): string {
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    this.#projectionBytes.set(contentSha256, Buffer.from(bytes));
    this.#values.set(ownershipKey, contentSha256);
    return contentSha256;
  }

  resources(): Array<{ ownership_key: string; content_sha256: string }> {
    return [...this.#values]
      .map(([ownership_key, content_sha256]) => ({ ownership_key, content_sha256 }))
      .sort((left, right) =>
        Buffer.from(left.ownership_key).compare(Buffer.from(right.ownership_key)),
      );
  }

  private assertPrivatePayload(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
  ): void {
    const retained = this.#descriptors.get(descriptor.private_payload_binding.descriptor_digest);
    if (
      !retained ||
      retained.descriptor_digest !== descriptor.descriptor_digest ||
      retained.value.private_payload.payload_digest !== privatePayload.payload_digest
    )
      throw new Error("private descriptor binding mismatch");
  }
}
