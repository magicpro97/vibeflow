import type { ActionTargetBindingV1 } from "../../actions/preview-types.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { ActionPlanningMode } from "../../actions/public-action-contract.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { privateEffectDescriptor } from "../adapters/private-descriptors.js";
import type {
  CapabilityAdapterIdentityV1,
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectBrokerV1,
  CapabilityEffectDescriptorV1,
  CapabilityOwnedResourceV1,
  CapabilityPreparedEffectV1,
  CapabilityPrivateEffectBindingV1,
} from "../adapters/types.js";
import type { CapabilityComponentV1 } from "../manifest/types.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { CapabilityPlanningRequestV1, ResolvedCapabilityPackageV1 } from "./types.js";

export interface CapabilityOwnedProjectionRecordV1 {
  ownership_key: string;
  target_ids: string[];
  expected_postimage_sha256: string | null;
  projection_digest: string;
}

export function ownedProjectionRecord(
  resource: CapabilityOwnedResourceV1,
  targetId: string,
): CapabilityOwnedProjectionRecordV1 {
  const draft = {
    ownership_key: resource.ownership_key,
    target_ids: [targetId],
    expected_postimage_sha256: resource.expected_postimage_sha256,
  };
  return {
    ...draft,
    projection_digest: digestV1("VF-OWNED-PROJECTION\0v1\0", draft),
  };
}

export function buildComponentResources(input: {
  request: CapabilityPlanningRequestV1;
  pkg: ResolvedCapabilityPackageV1;
  component: CapabilityComponentV1;
  target: ActionTargetBindingV1;
  broker: CapabilityEffectBrokerV1;
  now: string;
  persistence?: ActionPlanningMode;
}): CapabilityPreparedEffectV1[] {
  const { request, pkg, component, target, broker, now } = input;
  const operation =
    request.intent.kind === "adopt"
      ? ("claim" as const)
      : request.intent.kind === "remove"
        ? ("remove" as const)
        : ("ensure" as const);
  if (
    request.intent.kind === "adopt" &&
    request.adopt_candidate?.synthetic_pin.pin_digest === pkg.pin.pin_digest
  ) {
    const candidate = request.adopt_candidate;
    if (Date.parse(candidate.expires_at) <= Date.parse(now))
      throw new CapabilityValidationError(
        "adopt candidate expired before planning",
        "adopt_candidate",
      );
    if (!candidate.targets.some((row) => row.target_id === target.target_id))
      throw new CapabilityValidationError(
        "adopt candidate target binding changed",
        "adopt_candidate",
      );
    return candidate.owned_resources.map((resource) => {
      const prepared = broker.prepare(
        {
          schema_version: "1.0",
          request,
          package: pkg,
          component,
          target: {
            target_id: target.target_id,
            scope: target.target.scope,
            engine: target.target.engine as NonNullable<typeof target.target.engine>,
            participant_id: target.target.participant_id,
          },
          operation,
          adopt_resource: resource,
        },
        input.persistence,
      );
      if (prepared.resource.expected_preimage_sha256 !== resource.expected_preimage_sha256)
        throw new CapabilityValidationError("legacy adoption preimage changed", "adopt_candidate");
      return prepared;
    });
  }
  return [
    broker.prepare(
      {
        schema_version: "1.0",
        request,
        package: pkg,
        component,
        target: {
          target_id: target.target_id,
          scope: target.target.scope,
          engine: target.target.engine as NonNullable<typeof target.target.engine>,
          participant_id: target.target.participant_id,
        },
        operation,
      },
      input.persistence,
    ),
  ];
}

export interface CapabilityBuiltEffectDescriptorV1 {
  descriptor: CapabilityEffectDescriptorV1;
  private_descriptor: CapabilityAdapterPrivateDescriptorV1;
  private_preimage_bytes: Uint8Array | null;
}

export function buildEffectDescriptor(input: {
  adapter: CapabilityAdapterIdentityV1;
  pkg: ResolvedCapabilityPackageV1;
  componentId: string;
  targetId: string;
  prepared: CapabilityPreparedEffectV1;
  broker: CapabilityEffectBrokerV1;
  persistence: ActionPlanningMode;
  actionRootLocator: Exclude<
    import("../../actions/types.js").PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  ownerBinding?: CapabilityPrivateEffectBindingV1;
  descriptorKind: "intent" | "rollback";
  operation: CapabilityEffectDescriptorV1["operation"];
}): CapabilityBuiltEffectDescriptorV1 {
  const projection_digest = ownedProjectionRecord(
    input.prepared.resource,
    input.targetId,
  ).projection_digest;
  const privateDescriptor = privateEffectDescriptor(input.descriptorKind, {
    operation: input.operation,
    adapter: input.adapter,
    package_pin_digest: input.pkg.pin.pin_digest,
    component_id: input.componentId,
    target_id: input.targetId,
    resource: input.prepared.resource,
    projection_digest,
    private_payload: input.prepared.private_payload,
  });
  const binding = input.broker.retainPrivateDescriptor(
    privateDescriptor,
    input.persistence,
    input.actionRootLocator,
  );
  return {
    descriptor: {
      schema_version: "1.0",
      descriptor_kind: input.descriptorKind,
      descriptor_schema_id: privateDescriptor.descriptor_schema_id,
      operation: input.operation,
      adapter: input.adapter,
      package_pin_digest: input.pkg.pin.pin_digest,
      component_id: input.componentId,
      target_id: input.targetId,
      resource: input.prepared.resource,
      private_payload_binding: binding,
      owner_binding: input.ownerBinding ?? binding,
      projection_digest,
      descriptor_digest: privateDescriptor.descriptor_digest,
    },
    private_descriptor: privateDescriptor,
    private_preimage_bytes: input.prepared.private_preimage_bytes,
  };
}

export function buildExactRemovalResource(input: {
  resource: CapabilityOwnedResourceV1;
  broker: CapabilityEffectBrokerV1;
  request: CapabilityPlanningRequestV1;
  persistence?: ActionPlanningMode;
}): CapabilityPreparedEffectV1 {
  return input.broker.prepareRemoval(
    input.resource,
    input.persistence,
    input.request.action_root_locator ?? {
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: input.request.scope,
      scope_identity_digest: input.request.scope_identity_digest,
    },
  );
}
