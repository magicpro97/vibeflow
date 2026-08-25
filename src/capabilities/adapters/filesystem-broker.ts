import { resolve } from "node:path";
import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { digestV1 } from "../../durability/index.js";
import { filesystemLegacyClaimPayload } from "../legacy/filesystem-reader.js";
import type { LegacyAdoptClaimAuthorityV1, LegacyOwnedMarkerV1 } from "../legacy/types.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { legacyClaimKey } from "./filesystem-broker-keys.js";
import { mutateFilesystemPayload, observeFilesystemPayload } from "./filesystem-effects.js";
import { filesystemCapabilityHealth } from "./filesystem-health.js";
import type { CapabilityInternalCasFaultV1 } from "./filesystem-io.js";
import { FilesystemCapabilityPayloadStoreV1 } from "./filesystem-payload-store.js";
import { assertPayloadPreimageBytes } from "./filesystem-preimage.js";
import { reconcileFilesystemPayload } from "./filesystem-reconcile.js";
import { buildFilesystemRemoval } from "./filesystem-removal.js";
import { bindResourcePreimage, privateEffectPreimageBytes } from "./payload-preimage-authority.js";
import {
  bindPrivateEffectOwnerPreimage,
  privateEffectPayloadDigest,
  validatePrivateEffectPayload,
} from "./private-descriptors.js";
import { type ProjectionBuilderRootsV1, buildFilesystemProjection } from "./projection-builders.js";
import type {
  CapabilityActionRootResolverV1,
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectBrokerV1,
  CapabilityEffectDescriptorV1,
  CapabilityEffectPreparationRequestV1,
  CapabilityHealthProbeRequestV1,
  CapabilityOwnedResourceV1,
  CapabilityPreparedEffectV1,
  CapabilityPrivateEffectBindingV1,
  CapabilityPrivateEffectPayloadV1,
  CapabilityProjectionObservationV1,
  FilesystemCapabilityEffectBrokerOptionsV1,
} from "./types.js";
export type { FilesystemCapabilityEffectBrokerOptionsV1 } from "./types.js";

export class FilesystemCapabilityEffectBrokerV1
  implements CapabilityEffectBrokerV1, LegacyAdoptClaimAuthorityV1
{
  readonly roots: ProjectionBuilderRootsV1;
  readonly payloads: FilesystemCapabilityPayloadStoreV1;
  readonly #now: () => string;
  readonly #legacyClaims = new Map<string, CapabilityPrivateEffectPayloadV1>();
  fault: CapabilityInternalCasFaultV1 | null = null;

  constructor(options: FilesystemCapabilityEffectBrokerOptionsV1) {
    this.roots = { project: resolve(options.projectRoot), user: resolve(options.userRoot) };
    const stateRoots = {
      project: resolve(options.projectStateRoot),
      user: resolve(options.userStateRoot),
    };
    const actionRoots = options.actionRoots ?? {
      resolve: (locator: Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }>) => {
        if (locator.kind !== "capability")
          throw new CapabilityValidationError(
            "conversation action-root resolver is unavailable",
            "action_root_locator",
          );
        return stateRoots[locator.scope];
      },
    };
    this.payloads = new FilesystemCapabilityPayloadStoreV1(
      this.roots,
      {
        project: stateRoots.project,
        user: stateRoots.user,
      },
      actionRoots,
      () => this.fault,
    );
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  prepare(
    request: CapabilityEffectPreparationRequestV1,
    persistence: "transient" | "durable" = "transient",
  ): CapabilityPreparedEffectV1 {
    if (request.operation === "claim") return this.prepareClaim(request, persistence);
    const built = buildFilesystemProjection(request, this.roots);
    const privatePayload = this.bindOwnerPreimage(built.private_payload);
    const privatePreimageBytes = privateEffectPreimageBytes(privatePayload);
    const resource = bindResourcePreimage(built.resource, privatePreimageBytes);
    const locator = request.request.action_root_locator ?? {
      kind: "capability" as const,
      scope: request.request.scope,
      scope_identity_digest: request.request.scope_identity_digest,
    };
    this.payloads.putPreimage(resource, privatePreimageBytes, persistence, locator);
    return {
      resource,
      private_payload: privatePayload,
      private_preimage_bytes: privatePreimageBytes,
    };
  }

  prepareRemoval(
    resource: CapabilityOwnedResourceV1,
    persistence: "transient" | "durable" = "transient",
    actionRootLocator?: Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }>,
  ): CapabilityPreparedEffectV1 {
    if (!actionRootLocator)
      throw new CapabilityValidationError("removal action root is absent", "action_root_locator");
    const original = this.payloads.resolveOwner(resource.ownership_key);
    if (!original)
      throw new CapabilityValidationError(
        "owned projection has no private descriptor",
        resource.ownership_key,
      );
    const built = buildFilesystemRemoval(resource, original, this.roots);
    const privatePayload = this.bindOwnerPreimage(built.private_payload);
    const privatePreimageBytes = privateEffectPreimageBytes(privatePayload);
    const boundResource = bindResourcePreimage(built.resource, privatePreimageBytes);
    this.payloads.putPreimage(boundResource, privatePreimageBytes, persistence, actionRootLocator);
    return {
      resource: boundResource,
      private_payload: privatePayload,
      private_preimage_bytes: privatePreimageBytes,
    };
  }

  retainPrivateDescriptor(
    descriptor: CapabilityAdapterPrivateDescriptorV1,
    persistence: "transient" | "durable",
    actionRootLocator: Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }>,
  ) {
    return this.payloads.put(descriptor, persistence, actionRootLocator);
  }

  resolvePrivatePayload(
    binding: CapabilityPrivateEffectBindingV1,
  ): CapabilityPrivateEffectPayloadV1 {
    return this.payloads.resolve(binding);
  }

  clearTransientPayloads(): void {
    this.payloads.clearTransient();
    this.#legacyClaims.clear();
  }

  stage(marker: LegacyOwnedMarkerV1, candidate: StrictLegacyAdoptCandidateV1): void {
    if (
      candidate.legacy_source !== marker.source ||
      candidate.synthetic_pin.source.kind !== "legacy-adopt" ||
      candidate.synthetic_pin.source.inspection_evidence_digest !==
        candidate.inspection_evidence_digest
    )
      throw new CapabilityValidationError(
        "legacy claim staging differs from its scanner-issued candidate",
        candidate.candidate_id,
        "integrity_failure",
      );
    for (const resource of candidate.owned_resources) {
      if (!marker.owned_resources.some((row) => row.ownership_key === resource.ownership_key))
        continue;
      const payload = filesystemLegacyClaimPayload(
        marker,
        candidate.inspection_evidence_digest,
        resource,
      );
      const key = legacyClaimKey(candidate.inspection_evidence_digest, resource.ownership_key);
      const prior = this.#legacyClaims.get(key);
      if (prior && prior.payload_digest !== payload.payload_digest)
        throw new CapabilityValidationError(
          "legacy claim staging changed within one inspection closure",
          resource.ownership_key,
          "integrity_failure",
        );
      this.#legacyClaims.set(key, payload);
    }
  }

  inspect(
    resource: Pick<CapabilityOwnedResourceV1, "ownership_key">,
    privatePayload?: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1 {
    const payload = privatePayload ?? this.payloads.resolveOwner(resource.ownership_key);
    const content = payload ? observeFilesystemPayload(payload, this.roots) : null;
    return {
      schema_version: "1.0",
      ownership_key: resource.ownership_key,
      state: content === null ? "absent" : "present",
      content_sha256: content,
      observed_at: this.#now(),
    };
  }

  apply(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1 {
    const payload = this.assertDescriptorPayload(descriptor, privatePayload);
    const before = this.inspect(descriptor.resource, payload).content_sha256;
    if (before !== descriptor.resource.expected_preimage_sha256)
      throw new CapabilityValidationError(
        "owned projection preimage changed before apply",
        descriptor.resource.ownership_key,
      );
    assertPayloadPreimageBytes(payload, this.roots);
    if (descriptor.operation === "claim") {
      if (before !== descriptor.resource.expected_postimage_sha256)
        throw new CapabilityValidationError(
          "legacy claim bytes changed",
          descriptor.resource.ownership_key,
        );
    } else mutateFilesystemPayload(payload, this.roots, "forward", this.fault ?? undefined);
    const after = this.inspect(descriptor.resource, payload);
    if (after.content_sha256 !== descriptor.resource.expected_postimage_sha256)
      throw new CapabilityValidationError(
        "adapter did not create the exact postimage",
        descriptor.resource.ownership_key,
      );
    this.payloads.publishOwner(payload, descriptor.owner_binding, "forward");
    return after;
  }

  rollback(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1 {
    const payload = this.assertDescriptorPayload(descriptor, privatePayload);
    if (
      this.inspect(descriptor.resource, payload).content_sha256 !==
      descriptor.resource.expected_postimage_sha256
    )
      throw new CapabilityValidationError(
        "owned projection postimage changed before rollback",
        descriptor.resource.ownership_key,
      );
    mutateFilesystemPayload(payload, this.roots, "rollback", this.fault ?? undefined);
    const restored = this.inspect(descriptor.resource, payload);
    if (restored.content_sha256 !== descriptor.resource.expected_preimage_sha256)
      throw new CapabilityValidationError(
        "rollback did not restore exact preimage",
        descriptor.resource.ownership_key,
      );
    this.payloads.publishOwner(payload, descriptor.owner_binding, "rollback");
    return restored;
  }

  reconcile(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
    direction: "forward" | "rollback",
  ): CapabilityProjectionObservationV1 {
    const payload = this.assertDescriptorPayload(descriptor, privatePayload);
    reconcileFilesystemPayload(payload, this.roots, direction);
    this.payloads.reconcileOwner(payload, descriptor.owner_binding, direction);
    const observation = this.inspect(descriptor.resource, payload);
    const expected =
      direction === "forward"
        ? descriptor.resource.expected_postimage_sha256
        : descriptor.resource.expected_preimage_sha256;
    if (observation.content_sha256 !== expected)
      throw new CapabilityValidationError(
        "repaired projection does not match the approved terminal state",
        descriptor.resource.ownership_key,
      );
    return observation;
  }

  health(request: CapabilityHealthProbeRequestV1) {
    return filesystemCapabilityHealth(request, (resource) => this.inspect(resource));
  }

  private assertDescriptorPayload(
    descriptor: CapabilityEffectDescriptorV1,
    value: CapabilityPrivateEffectPayloadV1,
  ): CapabilityPrivateEffectPayloadV1 {
    const payload = validatePrivateEffectPayload(value);
    const retained = this.payloads.resolveDescriptor(descriptor.private_payload_binding);
    if (
      payload.payload_digest !== privateEffectPayloadDigest(payload) ||
      retained.descriptor_digest !== descriptor.descriptor_digest ||
      retained.value.private_payload.payload_digest !== payload.payload_digest ||
      payload.ownership_key !== descriptor.resource.ownership_key ||
      payload.expected_preimage_sha256 !== descriptor.resource.expected_preimage_sha256 ||
      payload.expected_postimage_sha256 !== descriptor.resource.expected_postimage_sha256
    )
      throw new CapabilityValidationError(
        "private descriptor is outside the approved closure",
        descriptor.resource.ownership_key,
      );
    return payload;
  }

  private bindOwnerPreimage(
    payload: CapabilityPrivateEffectPayloadV1,
  ): CapabilityPrivateEffectPayloadV1 {
    if (payload.payload_kind === "memory-test-only")
      throw new CapabilityValidationError(
        "production projection has no capability scope",
        payload.ownership_key,
      );
    const prior = this.payloads.ownerBinding(payload.ownership_key, payload.root);
    if (payload.payload_kind === "legacy-claim") {
      if (prior !== null)
        throw new CapabilityValidationError(
          "legacy projection is already claimed by Capability Fabric",
          payload.ownership_key,
        );
      return bindPrivateEffectOwnerPreimage(payload, null);
    }
    if ((payload.expected_preimage_sha256 === null) !== (prior === null))
      throw new CapabilityValidationError(
        "projection bytes and owner registry do not share one exact preimage",
        payload.ownership_key,
      );
    if (prior !== null) {
      const priorPayload = this.payloads.resolve(prior);
      if (
        priorPayload.ownership_key !== payload.ownership_key ||
        priorPayload.expected_postimage_sha256 !== payload.expected_preimage_sha256
      )
        throw new CapabilityValidationError(
          "owner registry does not bind the live projection preimage",
          payload.ownership_key,
        );
    }
    return bindPrivateEffectOwnerPreimage(payload, prior);
  }

  private prepareClaim(
    request: CapabilityEffectPreparationRequestV1,
    persistence: "transient" | "durable",
  ): CapabilityPreparedEffectV1 {
    const adopted = request.adopt_resource;
    if (!adopted)
      throw new CapabilityValidationError("legacy claim resource is absent", "adopt_resource");
    const candidate = request.request.adopt_candidate;
    const source = request.package.pin.source;
    if (
      !candidate ||
      source.kind !== "legacy-adopt" ||
      candidate.synthetic_pin.pin_digest !== request.package.pin.pin_digest ||
      candidate.inspection_evidence_digest !== source.inspection_evidence_digest
    )
      throw new CapabilityValidationError(
        "legacy claim lacks its exact inspection/package closure",
        adopted.ownership_key,
        "integrity_failure",
      );
    const staged = this.#legacyClaims.get(
      legacyClaimKey(candidate.inspection_evidence_digest, adopted.ownership_key),
    );
    const payload = staged ? this.bindOwnerPreimage(staged) : null;
    if (!payload)
      throw new CapabilityValidationError(
        "legacy claim lacks fixed-root VF ownership evidence",
        adopted.ownership_key,
      );
    const observed = observeFilesystemPayload(payload, this.roots);
    if (observed !== adopted.expected_preimage_sha256)
      throw new CapabilityValidationError("legacy claim preimage changed", adopted.ownership_key);
    if (payload.payload_kind !== "legacy-claim")
      throw new CapabilityValidationError(
        "legacy claim staging resolved another descriptor kind",
        adopted.ownership_key,
        "integrity_failure",
      );
    const privatePreimageBytes = privateEffectPreimageBytes(payload);
    const resource = bindResourcePreimage(
      {
        ...adopted,
        kind:
          request.component.type === "skill" || request.component.type === "role"
            ? "file"
            : "managed-registration",
        expected_postimage_sha256: observed,
        private_preimage_digest: null,
        private_preimage_ref: null,
      },
      privatePreimageBytes,
    );
    const locator = request.request.action_root_locator ?? {
      kind: "capability" as const,
      scope: request.request.scope,
      scope_identity_digest: request.request.scope_identity_digest,
    };
    this.payloads.putPreimage(resource, privatePreimageBytes, persistence, locator);
    return {
      resource,
      private_payload: payload,
      private_preimage_bytes: privatePreimageBytes,
    };
  }
}
