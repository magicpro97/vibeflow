import type { ActionTargetBindingV1 } from "../../actions/preview-types.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import {
  ACTION_EFFECT_CLASS,
  ACTION_PLANNING_MODE,
  ACTION_REVERSIBILITY_VALUE,
} from "../../actions/public-action-contract.js";
import type { ActionEffectClass, ActionPlanningMode } from "../../actions/types.js";
import { CAPABILITY_SCOPE, CAPABILITY_STATUS } from "../../core/capability-contract.js";
import { digestV1Bytes } from "../../durability/canonical.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import type {
  CapabilityAdapterIdentityV1,
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectBrokerV1,
  CapabilityEffectDescriptorV1,
} from "../adapters/types.js";
import type { CapabilityComponentV1 } from "../manifest/types.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import { buildHealthPlans, targetPermissions } from "./component-target.js";
import { adapterPlanDigest, adapterPlanIdentity, projectionSnapshotDigest } from "./digests.js";
import { buildComponentResources, buildEffectDescriptor } from "./resource-planner.js";
import { ownedProjectionRecord } from "./resource-planner.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityAdapterStepV1,
  CapabilityPlanningRequestV1,
  CapabilityProjectionSnapshotV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

export { buildTargetBinding, resolveTargetDisposition } from "./component-target.js";

export function buildHostAdapterPlan(input: {
  request: CapabilityPlanningRequestV1;
  pkg: ResolvedCapabilityPackageV1;
  component: CapabilityComponentV1;
  target: ActionTargetBindingV1;
  adapter: CapabilityAdapterIdentityV1;
  broker: CapabilityEffectBrokerV1;
  now: string;
  persistence?: ActionPlanningMode;
}): {
  snapshot: CapabilityProjectionSnapshotV1;
  descriptors: CapabilityEffectDescriptorV1[];
  private_descriptors: CapabilityAdapterPrivateDescriptorV1[];
  private_preimages: Array<{
    resource: import("../adapters/types.js").CapabilityOwnedResourceV1;
    bytes: Uint8Array;
  }>;
  private_inspection_evidence_bytes: Uint8Array | null;
  plan: CapabilityAdapterPlanV1;
} {
  const { request, pkg, component, target, adapter, broker, now, persistence } = input;
  const prepared = buildComponentResources({
    request,
    pkg,
    component,
    target,
    broker,
    now,
    persistence,
  });
  const resources = prepared.map((item) => item.resource);
  const privateEvidence = prepared.flatMap((item) =>
    item.private_inspection_evidence_bytes ? [item.private_inspection_evidence_bytes] : [],
  );
  const evidenceDigests = new Set(
    privateEvidence.map((bytes) => digestV1Bytes("VF-ADAPTER-PRIVATE-EVIDENCE\0v1\0", bytes)),
  );
  if (evidenceDigests.size > 1)
    throw new CapabilityRuntimeError(
      "one adapter plan produced conflicting private inspection evidence",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  const live = resources.map((resource) => resource.expected_preimage_sha256);
  const adoptingPackage =
    request.intent.kind === "adopt" &&
    request.adopt_candidate?.synthetic_pin.pin_digest === pkg.pin.pin_digest;
  const alreadyDesired =
    !adoptingPackage &&
    resources.every(
      (resource) => resource.expected_preimage_sha256 === resource.expected_postimage_sha256,
    );
  const ownership_evidence_digest = digestV1("VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", {
    schema_version: "1.0",
    evidence_kind: "inspection",
    adapter_fingerprint: adapter.fingerprint,
    target_id: target.target_id,
    ownership_keys: resources.map((resource) => resource.ownership_key),
    observed_content_sha256: live,
    observed_at: now,
  });
  const snapshotDraft = {
    schema_version: "1.0" as const,
    target_states: [
      {
        target_id: target.target_id,
        state: (alreadyDesired
          ? "owned"
          : live.every((value) => value === null)
            ? CAPABILITY_STATUS.ABSENT
            : CAPABILITY_STATUS.UNMANAGED) as
          | "owned"
          | typeof CAPABILITY_STATUS.ABSENT
          | typeof CAPABILITY_STATUS.UNMANAGED,
        live_projection_digests: alreadyDesired
          ? resources
              .map(
                (resource) => ownedProjectionRecord(resource, target.target_id).projection_digest,
              )
              .sort(bytewise)
          : [],
      },
    ],
    owned_resources: resources,
    ownership_evidence_digest,
    observed_at: now,
    snapshot_digest: "",
  };
  const snapshot: CapabilityProjectionSnapshotV1 = {
    ...snapshotDraft,
    snapshot_digest: projectionSnapshotDigest(snapshotDraft),
  };
  const operation = adoptingPackage
    ? "claim"
    : request.intent.kind === "remove"
      ? "remove"
      : "ensure";
  const actionRootLocator = request.action_root_locator ?? {
    kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
  };
  const descriptorPairs = alreadyDesired
    ? []
    : prepared.map((preparedEffect) => {
        const intent = buildEffectDescriptor({
          adapter,
          pkg,
          componentId: component.component_id,
          targetId: target.target_id,
          prepared: preparedEffect,
          broker,
          persistence: persistence ?? ACTION_PLANNING_MODE.TRANSIENT,
          actionRootLocator,
          descriptorKind: "intent",
          operation,
        });
        return {
          intent,
          rollback: buildEffectDescriptor({
            adapter,
            pkg,
            componentId: component.component_id,
            targetId: target.target_id,
            prepared: preparedEffect,
            broker,
            persistence: persistence ?? ACTION_PLANNING_MODE.TRANSIENT,
            actionRootLocator,
            ownerBinding: intent.descriptor.private_payload_binding,
            descriptorKind: "rollback",
            operation,
          }),
        };
      });
  const permissions = targetPermissions(pkg.manifest.permissions, target)
    .map((permission) => permission.permission_id)
    .sort(bytewise);
  const effect: ActionEffectClass =
    request.scope === CAPABILITY_SCOPE.PROJECT
      ? ACTION_EFFECT_CLASS.PROJECT_WRITE
      : ACTION_EFFECT_CLASS.USER_WRITE;
  const steps: CapabilityAdapterStepV1[] = alreadyDesired
    ? []
    : descriptorPairs.map(({ intent, rollback }, order) => {
        const intentDescriptor = intent.descriptor;
        const rollbackDescriptor = rollback.descriptor;
        return {
          step_id: `vf-adapter-step-${digestHex(digestV1("VF-ADAPTER-STEP-ID\0v1\0", { descriptor: intentDescriptor.descriptor_digest }))}`,
          order,
          evidence_schema_id: `vf.${component.type}.${target.target.engine}.receipt/1`,
          target_ids: [target.target_id],
          required: target.target.required,
          effect_classes: [effect],
          permission_ids: permissions,
          enforcement_digest: digestV1("VF-STEP-ENFORCEMENT\0v1\0", {
            target_id: target.target_id,
            permissions,
          }),
          intent: {
            schema_id: intentDescriptor.descriptor_schema_id,
            descriptor_digest: intentDescriptor.descriptor_digest,
            private_descriptor_ref: `actions/v1/objects/${digestHex(intentDescriptor.descriptor_digest)}.json`,
          },
          owned_resources: [resources[order] as (typeof resources)[number]],
          rollback: {
            class: ACTION_REVERSIBILITY_VALUE.REVERSIBLE,
            schema_id: rollbackDescriptor.descriptor_schema_id,
            descriptor_digest: rollbackDescriptor.descriptor_digest,
            private_descriptor_ref: `actions/v1/objects/${digestHex(rollbackDescriptor.descriptor_digest)}.json`,
          },
          timeout_ms: 30_000,
        };
      });
  const portable_input_digest = digestV1("VF-CAPABILITY-PORTABLE-INPUTS\0v1\0", {
    schema_version: "1.0",
    public_inputs: pkg.public_inputs,
    secret_input_ids: pkg.secret_input_ids,
  });
  const draft = {
    schema_version: "1.0" as const,
    plan_id: "",
    package_pin: pkg.pin,
    component_id: component.component_id,
    targets: [target],
    source_authority_binding_digest: pkg.source_authority_binding_digest,
    adapter,
    scope: request.scope,
    base_generation_id: request.base_lock?.generation_id ?? null,
    inspection_snapshot_digest: snapshot.snapshot_digest,
    user_prerequisites: request.user_prerequisites ?? [],
    portable_input_digest,
    private_input_binding_digest: pkg.private_input_binding_digest,
    authority: {
      policy_digest: request.authority.policy_digest,
      grant_digest: request.authority.grant_digest,
      permission_digest: "",
      authority_epoch: request.authority.authority_epoch,
      authority_head_digest: request.authority.authority_head_digest,
      trust_epoch: 0,
    },
    steps,
    health_plan: buildHealthPlans(pkg, component, target),
    reversibility: ACTION_REVERSIBILITY_VALUE.REVERSIBLE,
    plan_digest: "",
  };
  const provisional = adapterPlanDigest(draft);
  return {
    snapshot,
    descriptors: descriptorPairs.flatMap((pair) => [
      pair.intent.descriptor,
      pair.rollback.descriptor,
    ]),
    private_descriptors: descriptorPairs.flatMap((pair) => [
      pair.intent.private_descriptor,
      pair.rollback.private_descriptor,
    ]),
    private_preimages: descriptorPairs.flatMap((_pair, index) =>
      prepared[index]?.private_preimage_bytes === null || !prepared[index]
        ? []
        : [
            {
              resource: prepared[index].resource,
              bytes: prepared[index].private_preimage_bytes as Uint8Array,
            },
          ],
    ),
    private_inspection_evidence_bytes: privateEvidence[0] ?? null,
    plan: {
      ...draft,
      plan_id: adapterPlanIdentity(provisional),
      plan_digest: provisional,
    },
  };
}

export function buildNonHostAdapterPlan(input: {
  request: CapabilityPlanningRequestV1;
  pkg: ResolvedCapabilityPackageV1;
  component: CapabilityComponentV1;
  target: ActionTargetBindingV1;
  adapter: CapabilityAdapterIdentityV1;
  now: string;
}): { snapshot: CapabilityProjectionSnapshotV1; plan: CapabilityAdapterPlanV1 } {
  const { request, pkg, component, target, adapter, now } = input;
  const snapshotDraft = {
    schema_version: "1.0" as const,
    target_states: [
      {
        target_id: target.target_id,
        state: CAPABILITY_STATUS.ABSENT,
        live_projection_digests: [],
      },
    ],
    owned_resources: [],
    ownership_evidence_digest: digestV1("VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", {
      schema_version: "1.0",
      evidence_kind: "non-host-disposition",
      adapter_fingerprint: adapter.fingerprint,
      target_id: target.target_id,
      observed_at: now,
    }),
    observed_at: now,
    snapshot_digest: "",
  };
  const snapshot = {
    ...snapshotDraft,
    snapshot_digest: projectionSnapshotDigest(snapshotDraft),
  };
  const draft = {
    schema_version: "1.0" as const,
    plan_id: "",
    package_pin: pkg.pin,
    component_id: component.component_id,
    targets: [target],
    source_authority_binding_digest: pkg.source_authority_binding_digest,
    adapter,
    scope: request.scope,
    base_generation_id: request.base_lock?.generation_id ?? null,
    inspection_snapshot_digest: snapshot.snapshot_digest,
    user_prerequisites: request.user_prerequisites ?? [],
    portable_input_digest: digestV1("VF-CAPABILITY-PORTABLE-INPUTS\0v1\0", {
      schema_version: "1.0",
      public_inputs: pkg.public_inputs,
      secret_input_ids: pkg.secret_input_ids,
    }),
    private_input_binding_digest: pkg.private_input_binding_digest,
    authority: {
      policy_digest: request.authority.policy_digest,
      grant_digest: request.authority.grant_digest,
      permission_digest: "",
      authority_epoch: request.authority.authority_epoch,
      authority_head_digest: request.authority.authority_head_digest,
      trust_epoch: 0,
    },
    steps: [],
    health_plan: [],
    reversibility: ACTION_REVERSIBILITY_VALUE.MANUAL,
    plan_digest: "",
  };
  const digest = adapterPlanDigest(draft);
  return {
    snapshot,
    plan: { ...draft, plan_id: adapterPlanIdentity(digest), plan_digest: digest },
  };
}
