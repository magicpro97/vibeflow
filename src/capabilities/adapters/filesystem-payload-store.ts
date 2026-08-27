import type { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { ACTION_PLANNING_MODE } from "../../actions/public-action-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import type { ActionPlanningMode, PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { isCapabilityScope } from "../../core/capability-contract.js";
import { digestV1Bytes } from "../../durability/canonical.js";
import { canonicalJsonBytes, digestHex, digestV1, sha256Digest } from "../../durability/index.js";
import {
  CAPABILITY_OPERATION_RECOVERY_PHASE,
  type CapabilityOperationRecoveryPhaseV1,
} from "../wire/operation-state-contract.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  type CapabilityInternalCasFaultV1,
  boundedProjectionPath,
  bytesEqual,
  compareAndSwapProjectionFile,
  readProjectionFile,
} from "./filesystem-io.js";
import { hydratePrivateEffectPayload } from "./payload-preimage-authority.js";
import {
  privateEffectBinding,
  restorePrivateEffectOwnerBinding,
  validateAdapterPrivateDescriptor,
  validatePrivateEffectBinding,
  validatePrivateEffectPayload,
} from "./private-descriptors.js";
import type { ProjectionBuilderRootsV1 } from "./projection-builders.js";
import type {
  CapabilityActionRootResolverV1,
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityOwnedResourceV1,
  CapabilityPrivateEffectBindingV1,
  CapabilityPrivateEffectPayloadV1,
} from "./types.js";

function descriptorPath(digest: string): string {
  return `actions/v1/objects/${digestHex(digest)}.json`;
}

function blobPath(digest: string): string {
  return `actions/v1/blobs/${digestHex(digest)}.bin`;
}

function ownerPath(ownershipKey: string): string {
  return `owned-projections/v1/${digestHex(digestV1("VF-CAPABILITY-OWNERSHIP-KEY\0v1\0", ownershipKey))}.json`;
}

function ownerRecord(ownershipKey: string, binding: CapabilityPrivateEffectBindingV1): Uint8Array {
  return canonicalJsonBytes({
    schema_version: "1.0",
    ownership_key: ownershipKey,
    private_descriptor_binding: validatePrivateEffectBinding(binding),
  });
}

function parseDescriptor(bytes: Buffer, field: string): CapabilityAdapterPrivateDescriptorV1 {
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError("private descriptor JSON is corrupt", field);
  }
  const validated = validateAdapterPrivateDescriptor(value as CapabilityAdapterPrivateDescriptorV1);
  if (!bytesEqual(bytes, canonicalJsonBytes(validated, { maxBytes: 4 * 1024 * 1024 })))
    throw new CapabilityValidationError("private descriptor JSON is not canonical", field);
  return validated;
}

export interface FilesystemPayloadStoreRootsV1 {
  project: string;
  user: string;
}

export class FilesystemCapabilityPayloadStoreV1 {
  readonly #transient = new Map<
    string,
    {
      descriptor: CapabilityAdapterPrivateDescriptorV1;
      binding: CapabilityPrivateEffectBindingV1;
    }
  >();

  constructor(
    readonly roots: ProjectionBuilderRootsV1,
    readonly stateRoots: FilesystemPayloadStoreRootsV1,
    readonly actionRoots: CapabilityActionRootResolverV1,
    readonly fault: () => CapabilityInternalCasFaultV1 | null = () => null,
  ) {}

  put(
    descriptor: CapabilityAdapterPrivateDescriptorV1,
    persistence: ActionPlanningMode,
    actionRootLocator: Exclude<
      PrivateActionRootLocatorV1,
      { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
    >,
  ): CapabilityPrivateEffectBindingV1 {
    const validated = validateAdapterPrivateDescriptor(descriptor);
    const binding = privateEffectBinding(validated, actionRootLocator);
    if (persistence === ACTION_PLANNING_MODE.TRANSIENT)
      this.#transient.set(validated.descriptor_digest, { descriptor: validated, binding });
    else {
      if (validated.value.private_payload.payload_kind === "memory-test-only")
        throw new CapabilityValidationError(
          "private descriptor has no durable scope",
          "private_payload",
        );
      const path = boundedProjectionPath(
        this.actionRoots.resolve(binding.action_root_locator),
        descriptorPath(validated.descriptor_digest),
      );
      const bytes = canonicalJsonBytes(validated, { maxBytes: 4 * 1024 * 1024 });
      const current = readProjectionFile(path);
      if (current !== null && !bytesEqual(current, bytes))
        throw new CapabilityValidationError(
          "private descriptor digest collision",
          validated.descriptor_digest,
        );
      if (current === null) {
        compareAndSwapProjectionFile(path, null, bytes, 0o600);
        this.fault()?.({ phase: "after-cas", absolute_path: path, surface: "private-descriptor" });
      }
    }
    return binding;
  }

  putPreimage(
    resource: CapabilityOwnedResourceV1,
    bytes: Uint8Array | null,
    persistence: ActionPlanningMode,
    actionRootLocator: Exclude<
      PrivateActionRootLocatorV1,
      { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
    >,
  ): void {
    if (bytes === null || persistence === ACTION_PLANNING_MODE.TRANSIENT) return;
    const digest = digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", bytes);
    if (
      resource.expected_preimage_sha256 !== sha256Digest(bytes).slice("sha256:".length) ||
      resource.private_preimage_digest !== digest ||
      resource.private_preimage_ref !== blobPath(digest)
    )
      throw new CapabilityValidationError(
        "private preimage staging differs from its resource binding",
        resource.ownership_key,
      );
    const path = boundedProjectionPath(
      this.actionRoots.resolve(actionRootLocator),
      resource.private_preimage_ref,
    );
    const expected = Buffer.from(bytes);
    const current = readProjectionFile(path);
    if (current !== null && !bytesEqual(current, expected))
      throw new CapabilityValidationError(
        "private preimage digest collision",
        resource.ownership_key,
      );
    if (current === null) compareAndSwapProjectionFile(path, null, expected, 0o600);
  }

  resolve(binding: CapabilityPrivateEffectBindingV1): CapabilityPrivateEffectPayloadV1 {
    const descriptor = this.resolveDescriptor(binding);
    const resource = descriptor.value.resource;
    let bytes: Buffer | null = null;
    if (resource.private_preimage_digest !== null) {
      if (resource.private_preimage_ref !== blobPath(resource.private_preimage_digest))
        throw new CapabilityValidationError(
          "private preimage ref differs from its resource digest",
          resource.ownership_key,
        );
      bytes = readProjectionFile(
        boundedProjectionPath(
          this.actionRoots.resolve(binding.action_root_locator),
          resource.private_preimage_ref,
        ),
      );
      if (
        bytes === null ||
        digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", bytes) !==
          resource.private_preimage_digest
      )
        throw new CapabilityValidationError(
          "private preimage blob is missing or digest-mismatched",
          resource.ownership_key,
        );
    } else if (resource.private_preimage_ref !== null)
      throw new CapabilityValidationError(
        "private preimage ref has no resource digest",
        resource.ownership_key,
      );
    return validatePrivateEffectPayload(
      hydratePrivateEffectPayload(descriptor.value.private_payload, bytes),
    );
  }

  resolveDescriptor(
    binding: CapabilityPrivateEffectBindingV1,
  ): CapabilityAdapterPrivateDescriptorV1 {
    const validated = validatePrivateEffectBinding(binding);
    const transient = this.#transient.get(validated.descriptor_digest);
    if (transient) {
      if (JSON.stringify(transient.binding) !== JSON.stringify(validated))
        throw new CapabilityValidationError(
          "transient private descriptor belongs to another action root",
          validated.descriptor_digest,
        );
      return structuredClone(transient.descriptor);
    }
    const bytes = readProjectionFile(
      boundedProjectionPath(
        this.actionRoots.resolve(validated.action_root_locator),
        descriptorPath(validated.descriptor_digest),
      ),
    );
    if (bytes === null)
      throw new CapabilityValidationError(
        "private descriptor is missing",
        validated.descriptor_digest,
      );
    const descriptor = parseDescriptor(bytes, validated.descriptor_digest);
    if (descriptor.descriptor_digest !== validated.descriptor_digest)
      throw new CapabilityValidationError(
        "private descriptor path identity mismatch",
        validated.descriptor_digest,
      );
    return structuredClone(descriptor);
  }

  clearTransient(): void {
    this.#transient.clear();
  }

  publishOwner(
    payload: CapabilityPrivateEffectPayloadV1,
    binding: CapabilityPrivateEffectBindingV1,
    direction: CapabilityOperationRecoveryPhaseV1,
  ): void {
    if (payload.payload_kind === "memory-test-only") return;
    const path = boundedProjectionPath(
      this.stateRoots[payload.root],
      ownerPath(payload.ownership_key),
    );
    const currentBytes = readProjectionFile(path);
    const preimageBytes = decodeOwnerPreimage(payload);
    const postimageBytes =
      payload.expected_postimage_sha256 === null
        ? null
        : ownerRecord(payload.ownership_key, binding);
    const expectedBytes =
      direction === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD ? preimageBytes : postimageBytes;
    if (!bytesEqual(currentBytes, expectedBytes))
      throw new CapabilityValidationError(
        "owned projection registry CAS preimage mismatch",
        payload.ownership_key,
      );
    const replacementBytes =
      direction === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD ? postimageBytes : preimageBytes;
    compareAndSwapProjectionFile(path, currentBytes, replacementBytes, 0o600);
    this.fault()?.({ phase: "after-cas", absolute_path: path, surface: "owner-binding" });
  }

  reconcileOwner(
    payload: CapabilityPrivateEffectPayloadV1,
    binding: CapabilityPrivateEffectBindingV1,
    direction: CapabilityOperationRecoveryPhaseV1,
  ): void {
    if (payload.payload_kind === "memory-test-only") return;
    const path = boundedProjectionPath(
      this.stateRoots[payload.root],
      ownerPath(payload.ownership_key),
    );
    const currentBytes = readProjectionFile(path);
    const preimageBytes = decodeOwnerPreimage(payload);
    const postimageBytes =
      payload.expected_postimage_sha256 === null
        ? null
        : ownerRecord(payload.ownership_key, binding);
    if (!bytesEqual(currentBytes, preimageBytes) && !bytesEqual(currentBytes, postimageBytes))
      throw new CapabilityValidationError(
        "owner repair encountered an unapproved binding",
        payload.ownership_key,
      );
    const desiredBytes =
      direction === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD ? postimageBytes : preimageBytes;
    if (bytesEqual(currentBytes, desiredBytes)) return;
    compareAndSwapProjectionFile(path, currentBytes, desiredBytes, 0o600);
  }

  ownerBinding(
    ownershipKey: string,
    scope: keyof FilesystemPayloadStoreRootsV1 = this.scopeFromOwnershipKey(ownershipKey),
  ): CapabilityPrivateEffectBindingV1 | null {
    const bytes = readProjectionFile(
      boundedProjectionPath(this.stateRoots[scope], ownerPath(ownershipKey)),
    );
    return bytes === null ? null : this.bindingFromOwnerBytes(bytes, ownershipKey);
  }

  resolveOwner(ownershipKey: string): CapabilityPrivateEffectPayloadV1 | null {
    const binding = this.ownerBinding(ownershipKey);
    return binding === null ? null : this.resolve(binding);
  }

  private bindingFromOwnerBytes(
    bytes: Buffer | null,
    ownershipKey: string,
  ): CapabilityPrivateEffectBindingV1 | null {
    if (bytes === null) return null;
    const parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      ownership_key?: unknown;
      private_descriptor_binding?: CapabilityPrivateEffectBindingV1;
    };
    if (
      parsed.ownership_key !== ownershipKey ||
      !parsed.private_descriptor_binding ||
      !bytesEqual(bytes, ownerRecord(ownershipKey, parsed.private_descriptor_binding))
    )
      throw new CapabilityValidationError("owned projection registry is corrupt", ownershipKey);
    return validatePrivateEffectBinding(parsed.private_descriptor_binding);
  }

  private scopeFromOwnershipKey(ownershipKey: string): keyof FilesystemPayloadStoreRootsV1 {
    const scope = ownershipKey.split(":")[1];
    if (!isCapabilityScope(scope))
      throw new CapabilityValidationError("ownership key has no capability scope", ownershipKey);
    return scope;
  }
}

function decodeOwnerPreimage(payload: CapabilityPrivateEffectPayloadV1): Buffer | null {
  const binding = payload.preimage_owner_binding;
  if (binding === undefined)
    throw new CapabilityValidationError(
      "private descriptor lacks its owner CAS preimage",
      payload.ownership_key,
    );
  return binding === null
    ? null
    : Buffer.from(ownerRecord(payload.ownership_key, restorePrivateEffectOwnerBinding(binding)));
}
