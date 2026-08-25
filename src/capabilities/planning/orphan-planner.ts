import type {
  ActionTargetBindingV1,
  CapabilityTargetDispositionV1,
} from "../../actions/preview-types.js";
import type { EngineName } from "../../actions/types.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { resolveCapabilityAdapter } from "../adapters/registry.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectBrokerV1,
  CapabilityEffectDescriptorV1,
  CapabilityOwnedResourceKindV1,
  CapabilityOwnedResourceV1,
} from "../adapters/types.js";
import type { CapabilityComponentV1 } from "../manifest/types.js";
import { bytewise } from "../wire/primitives.js";
import { adapterPlanDigest, adapterPlanIdentity, projectionSnapshotDigest } from "./digests.js";
import { buildEffectDescriptor, buildExactRemovalResource } from "./resource-planner.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityPlanningRequestV1,
  CapabilityProjectionSnapshotV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

export interface CapabilityOrphanRemovalPlansV1 {
  targets: ActionTargetBindingV1[];
  dispositions: CapabilityTargetDispositionV1[];
  plans: CapabilityAdapterPlanV1[];
  snapshots: CapabilityProjectionSnapshotV1[];
  descriptors: CapabilityEffectDescriptorV1[];
  private_descriptors: CapabilityAdapterPrivateDescriptorV1[];
  private_preimages: Array<{ resource: CapabilityOwnedResourceV1; bytes: Uint8Array }>;
}

function parseOwnershipKey(value: string): {
  engine: EngineName;
  componentType: CapabilityComponentV1["type"];
} | null {
  const parts = value.split(":");
  if (![6, 7].includes(parts.length) || parts[0] !== "vf") return null;
  const engine = parts[2] as EngineName;
  const componentType = parts[parts.length === 7 ? 4 : 3] as CapabilityComponentV1["type"];
  if (
    !["claude", "codex", "copilot", "opencode", "antigravity"].includes(engine) ||
    !["skill", "mcp", "tool", "hook", "role", "engine-setting"].includes(componentType)
  )
    return null;
  return { engine, componentType };
}

function resourceKind(componentType: CapabilityComponentV1["type"]): CapabilityOwnedResourceKindV1 {
  if (componentType === "skill" || componentType === "role") return "file";
  if (componentType === "tool") return "external-effect";
  return "config-key";
}

function baseTargetBinding(
  request: CapabilityPlanningRequestV1,
  pkg: ResolvedCapabilityPackageV1,
  target: NonNullable<
    CapabilityPlanningRequestV1["base_lock"]
  >["packages"][number]["targets"][number],
): ActionTargetBindingV1 {
  const targetPolicy = target.required
    ? {
        required: true as const,
        on_apply_failure: "abort-scope" as const,
        on_health_failure: "abort-scope" as const,
      }
    : {
        required: false as const,
        on_apply_failure: "omit-after-rollback" as const,
        on_health_failure: "omit-after-rollback" as const,
      };
  return {
    target_id: target.target_id,
    target: {
      scope: request.scope,
      engine: target.engine,
      participant_id: target.participant_id,
      ...targetPolicy,
    },
    subject: { kind: "capability", package_id: pkg.pin.id, component_id: target.component_id },
  };
}

export function buildOrphanRemovalPlans(input: {
  request: CapabilityPlanningRequestV1;
  effectPackages: readonly ResolvedCapabilityPackageV1[];
  plannedSnapshots: readonly CapabilityProjectionSnapshotV1[];
  broker: CapabilityEffectBrokerV1;
  now: string;
  persistence?: "transient" | "durable";
}): CapabilityOrphanRemovalPlansV1 {
  const output: CapabilityOrphanRemovalPlansV1 = {
    targets: [],
    dispositions: [],
    plans: [],
    snapshots: [],
    descriptors: [],
    private_descriptors: [],
    private_preimages: [],
  };
  if (!input.request.base_lock) return output;
  const plannedResources = input.plannedSnapshots.flatMap((snapshot) => snapshot.owned_resources);
  const desiredKeys = new Set(
    plannedResources
      .filter((resource) => resource.expected_postimage_sha256 !== null)
      .map((resource) => resource.ownership_key),
  );
  const removedKeys = new Set(
    plannedResources
      .filter((resource) => resource.expected_postimage_sha256 === null)
      .map((resource) => resource.ownership_key),
  );
  for (const basePackage of input.request.base_lock.packages) {
    const pkg = input.effectPackages.find((item) => item.pin.id === basePackage.package_id);
    if (!pkg) continue;
    for (const baseTarget of basePackage.targets) {
      for (const projection of baseTarget.projections) {
        if (desiredKeys.has(projection.ownership_key) || removedKeys.has(projection.ownership_key))
          continue;
        const parsed = parseOwnershipKey(projection.ownership_key);
        if (!parsed) continue;
        const entry = resolveCapabilityAdapter(parsed.componentType, parsed.engine);
        const target = baseTargetBinding(input.request, pkg, baseTarget);
        if (!output.targets.some((row) => row.target_id === target.target_id))
          output.targets.push(target);
        if (!output.dispositions.some((row) => row.target_id === target.target_id)) {
          output.dispositions.push(
            entry.support === "host"
              ? { target_id: target.target_id, execution: "host", reason_code: null }
              : entry.support === "manual-runtime-setup"
                ? {
                    target_id: target.target_id,
                    execution: "manual",
                    reason_code: "manual-runtime-setup",
                  }
                : entry.support === "unsupported"
                  ? {
                      target_id: target.target_id,
                      execution: "unsupported",
                      reason_code: "adapter-unavailable",
                    }
                  : {
                      target_id: target.target_id,
                      execution: "required-user-action",
                      reason_code: entry.support,
                    },
          );
        }
        if (entry.support !== "host" || entry.adapter === null) continue;
        const prepared = buildExactRemovalResource({
          resource: {
            ownership_key: projection.ownership_key,
            public_target: projection.ownership_key,
            kind: resourceKind(parsed.componentType),
            expected_preimage_sha256: null,
            expected_postimage_sha256: null,
            private_preimage_digest: null,
            private_preimage_ref: null,
          },
          broker: input.broker,
          request: input.request,
          persistence: input.persistence,
        });
        const resource = prepared.resource;
        const actionRootLocator = input.request.action_root_locator ?? {
          kind: "capability" as const,
          scope: input.request.scope,
          scope_identity_digest: input.request.scope_identity_digest,
        };
        const intent = buildEffectDescriptor({
          adapter: entry.adapter,
          pkg,
          componentId: baseTarget.component_id,
          targetId: target.target_id,
          prepared,
          broker: input.broker,
          persistence: input.persistence ?? "transient",
          actionRootLocator,
          descriptorKind: "intent",
          operation: "remove",
        });
        const rollback = buildEffectDescriptor({
          adapter: entry.adapter,
          pkg,
          componentId: baseTarget.component_id,
          targetId: target.target_id,
          prepared,
          broker: input.broker,
          persistence: input.persistence ?? "transient",
          actionRootLocator,
          ownerBinding: intent.descriptor.private_payload_binding,
          descriptorKind: "rollback",
          operation: "remove",
        });
        const snapshotDraft = {
          schema_version: "1.0" as const,
          target_states: [
            {
              target_id: target.target_id,
              state: "orphaned" as const,
              live_projection_digests: resource.expected_preimage_sha256
                ? [resource.expected_preimage_sha256]
                : [],
            },
          ],
          owned_resources: [resource],
          ownership_evidence_digest: digestV1("VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", {
            adapter_fingerprint: entry.adapter.fingerprint,
            target_id: target.target_id,
            ownership_key: resource.ownership_key,
            observed_content_sha256: resource.expected_preimage_sha256,
            observed_at: input.now,
          }),
          observed_at: input.now,
          snapshot_digest: "",
        };
        const snapshot = {
          ...snapshotDraft,
          snapshot_digest: projectionSnapshotDigest(snapshotDraft),
        };
        const step = {
          step_id: `vf-adapter-step-${digestHex(digestV1("VF-ADAPTER-STEP-ID\0v1\0", { descriptor: intent.descriptor.descriptor_digest }))}`,
          order: 0,
          evidence_schema_id: `vf.${parsed.componentType}.${parsed.engine}.receipt/1`,
          target_ids: [target.target_id],
          required: target.target.required,
          effect_classes: [
            input.request.scope === "project"
              ? ("project-write" as const)
              : ("user-write" as const),
          ],
          permission_ids: [],
          enforcement_digest: digestV1("VF-STEP-ENFORCEMENT\0v1\0", {
            target_id: target.target_id,
            permissions: [],
          }),
          intent: {
            schema_id: intent.descriptor.descriptor_schema_id,
            descriptor_digest: intent.descriptor.descriptor_digest,
            private_descriptor_ref: `actions/v1/objects/${digestHex(intent.descriptor.descriptor_digest)}.json`,
          },
          owned_resources: [resource],
          rollback: {
            class: "reversible" as const,
            schema_id: rollback.descriptor.descriptor_schema_id,
            descriptor_digest: rollback.descriptor.descriptor_digest,
            private_descriptor_ref: `actions/v1/objects/${digestHex(rollback.descriptor.descriptor_digest)}.json`,
          },
          timeout_ms: 30_000,
        };
        const planDraft = {
          schema_version: "1.0" as const,
          plan_id: "",
          package_pin: pkg.pin,
          component_id: baseTarget.component_id,
          targets: [target],
          source_authority_binding_digest: pkg.source_authority_binding_digest,
          adapter: entry.adapter,
          scope: input.request.scope,
          base_generation_id: input.request.base_lock.generation_id,
          inspection_snapshot_digest: snapshot.snapshot_digest,
          user_prerequisites: input.request.user_prerequisites ?? [],
          portable_input_digest: digestV1("VF-CAPABILITY-PORTABLE-INPUTS\0v1\0", {
            schema_version: "1.0",
            public_inputs: pkg.public_inputs,
            secret_input_ids: pkg.secret_input_ids,
          }),
          private_input_binding_digest: pkg.private_input_binding_digest,
          authority: {
            policy_digest: input.request.authority.policy_digest,
            grant_digest: input.request.authority.grant_digest,
            permission_digest: "",
            authority_epoch: input.request.authority.authority_epoch,
            authority_head_digest: input.request.authority.authority_head_digest,
            trust_epoch: 0,
          },
          steps: [step],
          health_plan: [],
          reversibility: "reversible" as const,
          plan_digest: "",
        };
        const digest = adapterPlanDigest(planDraft);
        output.plans.push({
          ...planDraft,
          plan_id: adapterPlanIdentity(digest),
          plan_digest: digest,
        });
        output.snapshots.push(snapshot);
        output.descriptors.push(intent.descriptor, rollback.descriptor);
        output.private_descriptors.push(intent.private_descriptor, rollback.private_descriptor);
        if (prepared.private_preimage_bytes !== null)
          output.private_preimages.push({
            resource: prepared.resource,
            bytes: prepared.private_preimage_bytes,
          });
        removedKeys.add(projection.ownership_key);
      }
    }
  }
  output.targets.sort((left, right) => bytewise(left.target_id, right.target_id));
  return output;
}
