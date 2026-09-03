import { actionIdempotencyScopeDigest } from "../../actions/idempotency.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { CAPABILITY_SCOPE } from "../../core/capability-contract.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import { CapabilityValidationError, DIGEST_PATTERN } from "../wire/primitives.js";
import {
  assertPersistedPrivateEffectPayload,
  persistedPrivateEffectPayload,
} from "./payload-preimage-authority.js";
import { assertPrivateEffectPayloadShape } from "./private-payload-shape.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityPrivateEffectBindingV1,
  CapabilityPrivateEffectDescriptorValueV1,
  CapabilityPrivateEffectOwnerPreimageBindingV1,
  CapabilityPrivateEffectPayloadV1,
} from "./types.js";

const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*\\)[^/]+(?:\/[^/]+)*$/u;

function assertExactRecord(value: unknown, keys: readonly string[], field: string): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    throw new CapabilityValidationError("private descriptor record keys are not exact", field);
}

function assertRelative(value: string, field: string): void {
  if (
    !RELATIVE_PATH.test(value) ||
    [...value].some((part) => part.charCodeAt(0) <= 0x1f) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    throw new CapabilityValidationError("private descriptor path is not canonical", field);
}

export function privateEffectPayloadDigest(value: CapabilityPrivateEffectPayloadV1): string {
  const persisted = persistedPrivateEffectPayload(value);
  const { payload_digest: _, ...preimage } = persisted;
  return digestV1("VF-ADAPTER-PRIVATE-PAYLOAD\0v1\0", preimage);
}

export function privateEffectDescriptor(
  descriptorKind: "intent" | "rollback",
  value: CapabilityPrivateEffectDescriptorValueV1,
): CapabilityAdapterPrivateDescriptorV1 {
  const persistedValue = {
    ...structuredClone(value),
    private_payload: persistedPrivateEffectPayload(value.private_payload),
  };
  const draft = {
    schema_version: "1.0" as const,
    descriptor_kind: descriptorKind,
    descriptor_schema_id: "vf.adapter-owned-projection/1" as const,
    value: persistedValue,
  };
  return {
    ...draft,
    descriptor_digest: digestV1("VF-ADAPTER-PRIVATE-DESCRIPTOR\0v1\0", draft),
  };
}

export function validateAdapterPrivateDescriptor(
  value: CapabilityAdapterPrivateDescriptorV1,
): CapabilityAdapterPrivateDescriptorV1 {
  assertExactRecord(
    value,
    ["schema_version", "descriptor_kind", "descriptor_schema_id", "value", "descriptor_digest"],
    "private_descriptor",
  );
  assertExactRecord(
    value.value,
    [
      "operation",
      "adapter",
      "package_pin_digest",
      "component_id",
      "target_id",
      "resource",
      "projection_digest",
      "private_payload",
    ],
    "private_descriptor.value",
  );
  assertExactRecord(
    value.value.adapter,
    ["adapter_id", "adapter_version", "fingerprint"],
    "private_descriptor.value.adapter",
  );
  assertExactRecord(
    value.value.resource,
    [
      "ownership_key",
      "kind",
      "public_target",
      "expected_preimage_sha256",
      "expected_postimage_sha256",
      "private_preimage_digest",
      "private_preimage_ref",
    ],
    "private_descriptor.value.resource",
  );
  if (
    value.schema_version !== "1.0" ||
    !["intent", "rollback"].includes(value.descriptor_kind) ||
    value.descriptor_schema_id !== "vf.adapter-owned-projection/1" ||
    value.descriptor_digest !==
      digestV1("VF-ADAPTER-PRIVATE-DESCRIPTOR\0v1\0", {
        schema_version: value.schema_version,
        descriptor_kind: value.descriptor_kind,
        descriptor_schema_id: value.descriptor_schema_id,
        value: value.value,
      })
  )
    throw new CapabilityValidationError(
      "private descriptor identity mismatch",
      "private_descriptor",
    );
  validatePrivateEffectPayload(value.value.private_payload);
  if (
    value.value.private_payload.payload_kind === "hook-config-slice" &&
    (value.value.private_payload.codex_feature !== null) !==
      (value.value.adapter.adapter_id === "vf.hook.codex")
  )
    throw new CapabilityValidationError(
      "Codex hook feature is not bound to the Codex hook adapter",
      "private_descriptor.value.private_payload.codex_feature",
    );
  assertPersistedPrivateEffectPayload(value.value.private_payload);
  canonicalJsonBytes(value, { maxBytes: 4 * 1024 * 1024 });
  return structuredClone(value);
}

export function bindPrivateEffectOwnerPreimage(
  value: CapabilityPrivateEffectPayloadV1,
  ownerBinding: CapabilityPrivateEffectBindingV1 | null,
): CapabilityPrivateEffectPayloadV1 {
  const { payload_digest: _, ...draft } = value;
  const provisional = {
    ...draft,
    preimage_owner_binding:
      ownerBinding === null ? null : privateEffectOwnerPreimageBinding(ownerBinding),
    payload_digest: "",
  } as CapabilityPrivateEffectPayloadV1;
  return {
    ...provisional,
    payload_digest: privateEffectPayloadDigest(provisional),
  };
}

export function privateEffectOwnerPreimageBinding(
  value: CapabilityPrivateEffectBindingV1,
): CapabilityPrivateEffectOwnerPreimageBindingV1 {
  const binding = validatePrivateEffectBinding(value);
  return {
    schema_version: binding.schema_version,
    descriptor_schema_id: binding.descriptor_schema_id,
    action_root_locator: structuredClone(binding.action_root_locator),
    action_root_binding_digest: binding.action_root_binding_digest,
    descriptor_digest: binding.descriptor_digest,
  };
}

export function restorePrivateEffectOwnerBinding(
  value: CapabilityPrivateEffectOwnerPreimageBindingV1,
): CapabilityPrivateEffectBindingV1 {
  const binding = validatePrivateEffectOwnerPreimageBinding(value);
  return validatePrivateEffectBinding({
    ...binding,
    private_descriptor_ref: `actions/v1/objects/${digestHex(binding.descriptor_digest)}.json`,
  });
}

export function privateEffectBinding(
  descriptor: CapabilityAdapterPrivateDescriptorV1,
  actionRootLocator: Exclude<
    PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >,
): CapabilityPrivateEffectBindingV1 {
  const validated = validateAdapterPrivateDescriptor(descriptor);
  const action_root_locator = structuredClone(actionRootLocator);
  actionIdempotencyScopeDigest(action_root_locator);
  return {
    schema_version: "1.0",
    descriptor_schema_id: "vf.adapter-owned-projection/1",
    action_root_locator,
    action_root_binding_digest: digestV1(
      "VF-CAPABILITY-PRIVATE-ACTION-ROOT\0v1\0",
      action_root_locator,
    ),
    descriptor_digest: validated.descriptor_digest,
    private_descriptor_ref: `actions/v1/objects/${digestHex(validated.descriptor_digest)}.json`,
  };
}

export function validatePrivateEffectBinding(
  value: CapabilityPrivateEffectBindingV1,
): CapabilityPrivateEffectBindingV1 {
  assertExactRecord(
    value,
    [
      "schema_version",
      "descriptor_schema_id",
      "action_root_locator",
      "action_root_binding_digest",
      "descriptor_digest",
      "private_descriptor_ref",
    ],
    "private_payload_binding",
  );
  const rawLocator = (value as { action_root_locator?: PrivateActionRootLocatorV1 })
    .action_root_locator;
  if (!rawLocator || rawLocator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
    throw new CapabilityValidationError(
      "private descriptor action root is invalid",
      "private_payload_binding",
    );
  const locator = rawLocator as Exclude<
    PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  try {
    actionIdempotencyScopeDigest(locator);
  } catch {
    throw new CapabilityValidationError(
      "private descriptor action root is invalid",
      "private_payload_binding",
    );
  }
  if (
    value.schema_version !== "1.0" ||
    value.descriptor_schema_id !== "vf.adapter-owned-projection/1" ||
    value.action_root_binding_digest !==
      digestV1("VF-CAPABILITY-PRIVATE-ACTION-ROOT\0v1\0", locator) ||
    !DIGEST_PATTERN.test(value.descriptor_digest) ||
    value.private_descriptor_ref !== `actions/v1/objects/${digestHex(value.descriptor_digest)}.json`
  )
    throw new CapabilityValidationError(
      "private descriptor binding is invalid",
      "private_payload_binding",
    );
  canonicalJsonBytes(value, { maxBytes: 16 * 1024 });
  return structuredClone(value);
}

export function validatePrivateEffectOwnerPreimageBinding(
  value: CapabilityPrivateEffectOwnerPreimageBindingV1,
): CapabilityPrivateEffectOwnerPreimageBindingV1 {
  const locator = value.action_root_locator;
  try {
    actionIdempotencyScopeDigest(locator);
  } catch {
    throw new CapabilityValidationError(
      "owner preimage action root is invalid",
      "private_payload.preimage_owner_binding",
    );
  }
  if (
    value.schema_version !== "1.0" ||
    value.descriptor_schema_id !== "vf.adapter-owned-projection/1" ||
    value.action_root_binding_digest !==
      digestV1("VF-CAPABILITY-PRIVATE-ACTION-ROOT\0v1\0", locator) ||
    !DIGEST_PATTERN.test(value.descriptor_digest) ||
    Object.keys(value).sort().join("\0") !==
      [
        "action_root_binding_digest",
        "action_root_locator",
        "descriptor_digest",
        "descriptor_schema_id",
        "schema_version",
      ].join("\0")
  )
    throw new CapabilityValidationError(
      "owner preimage binding is invalid",
      "private_payload.preimage_owner_binding",
    );
  canonicalJsonBytes(value, { maxBytes: 16 * 1024 });
  return structuredClone(value);
}

export function validatePrivateEffectPayload(
  value: CapabilityPrivateEffectPayloadV1,
): CapabilityPrivateEffectPayloadV1 {
  assertPrivateEffectPayloadShape(value);
  const ownedPrefix =
    value.ownership_key.startsWith("vf:") ||
    (["legacy-claim", "memory-test-only"].includes(value.payload_kind) &&
      value.ownership_key.startsWith("legacy:"));
  if (
    value.schema_version !== "1.0" ||
    !ownedPrefix ||
    value.payload_digest !== privateEffectPayloadDigest(value)
  )
    throw new CapabilityValidationError("private descriptor identity mismatch", "private_payload");
  if (value.payload_kind !== "memory-test-only") {
    const ownerBinding = value.preimage_owner_binding;
    if (ownerBinding) validatePrivateEffectOwnerPreimageBinding(ownerBinding);
  }
  if (value.payload_kind === "owned-file") {
    assertRelative(value.canonical_relative_path, "private_payload.canonical_relative_path");
    assertRelative(value.marker_relative_path, "private_payload.marker_relative_path");
  } else if (
    value.payload_kind === "json-key-slice" ||
    value.payload_kind === "hook-config-slice"
  ) {
    assertRelative(value.canonical_relative_path, "private_payload.canonical_relative_path");
    assertRelative(value.marker_relative_path, "private_payload.marker_relative_path");
    if (
      value.key_path.length === 0 ||
      value.key_path.some((part) => !/^[A-Za-z0-9_.-]{1,128}$/.test(part))
    )
      throw new CapabilityValidationError(
        "private descriptor key path is invalid",
        "private_payload.key_path",
      );
    if (value.payload_kind === "json-key-slice") {
      for (const file of value.auxiliary_files)
        assertRelative(file.canonical_relative_path, "private_payload.auxiliary_files");
    } else if (value.codex_feature !== null) {
      assertRelative(
        value.codex_feature.canonical_relative_path,
        "private_payload.codex_feature.canonical_relative_path",
      );
      if (
        value.root !== CAPABILITY_SCOPE.USER ||
        value.codex_feature.block_id !== "codex-hooks-feature"
      )
        throw new CapabilityValidationError(
          "Codex hook feature payload is not bound to the user adapter",
          "private_payload.codex_feature",
        );
      if (!["append", "after-features-header"].includes(value.codex_feature.placement))
        throw new CapabilityValidationError(
          "Codex hook feature placement is invalid",
          "private_payload.codex_feature.placement",
        );
    }
  } else if (value.payload_kind === "toml-owned-block") {
    assertRelative(value.canonical_relative_path, "private_payload.canonical_relative_path");
    assertRelative(value.marker_relative_path, "private_payload.marker_relative_path");
    if (!/^[a-z][a-z0-9_-]{0,127}$/.test(value.block_id))
      throw new CapabilityValidationError(
        "private descriptor TOML block ID is invalid",
        "private_payload.block_id",
      );
  } else if (value.payload_kind === "legacy-claim") {
    if (!DIGEST_PATTERN.test(value.inspection_evidence_digest))
      throw new CapabilityValidationError(
        "legacy claim inspection evidence digest is invalid",
        "private_payload.inspection_evidence_digest",
      );
    if (!DIGEST_PATTERN.test(value.evidence_record_digest))
      throw new CapabilityValidationError(
        "legacy claim source record digest is invalid",
        "private_payload.evidence_record_digest",
      );
    assertRelative(
      value.projection.canonical_relative_path,
      "private_payload.projection.canonical_relative_path",
    );
    if (value.projection.kind === "json-key-slice") {
      if (
        value.projection.key_path.length === 0 ||
        value.projection.key_path.some((part) => !/^[A-Za-z0-9_.-]{1,128}$/u.test(part))
      )
        throw new CapabilityValidationError(
          "legacy claim key path is invalid",
          "private_payload.projection.key_path",
        );
    }
  }
  canonicalJsonBytes(value, { maxBytes: 4 * 1024 * 1024 });
  return structuredClone(value);
}
