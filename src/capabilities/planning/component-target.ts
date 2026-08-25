import type {
  ActionTargetBindingV1,
  CapabilityTargetDispositionV1,
  PublicHealthPlanV1,
} from "../../actions/preview-types.js";
import { targetId } from "../../actions/proposal-content-validation.js";
import type { ActionEffectClass, EngineName } from "../../actions/types.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityAdapterRegistryEntryV1 } from "../adapters/types.js";
import type { CapabilityComponentV1, CapabilityPermissionV1 } from "../manifest/types.js";
import { bytewise } from "../wire/primitives.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

export function buildTargetBinding(
  pkg: ResolvedCapabilityPackageV1,
  component: CapabilityComponentV1,
  engine: EngineName,
  scope: "project" | "user",
  participantId: string | null = null,
): ActionTargetBindingV1 {
  const target = component.required
    ? {
        scope,
        engine,
        participant_id: participantId,
        required: true as const,
        on_apply_failure: "abort-scope" as const,
        on_health_failure: "abort-scope" as const,
      }
    : {
        scope,
        engine,
        participant_id: participantId,
        required: false as const,
        on_apply_failure: "omit-after-rollback" as const,
        on_health_failure: "omit-after-rollback" as const,
      };
  const subject = {
    kind: "capability" as const,
    package_id: pkg.pin.id,
    component_id: component.component_id,
  };
  return { target_id: targetId({ target, subject }), target, subject };
}

export function resolveTargetDisposition(
  entry: CapabilityAdapterRegistryEntryV1,
  target_id: string,
  component: CapabilityComponentV1,
  participantId: string | null = null,
  scope: "project" | "user" = "project",
): CapabilityTargetDispositionV1 {
  if (participantId !== null && component.type !== "skill" && component.type !== "role")
    return { target_id, execution: "unsupported", reason_code: "target-unsupported" };
  if (entry.support === "host") {
    if (component.type === "mcp" && component.transport === "sse" && entry.engine === "codex")
      return { target_id, execution: "unsupported", reason_code: "target-unsupported" };
    if (component.type === "mcp" && (component.secret_slots?.length ?? 0) > 0)
      return { target_id, execution: "unsupported", reason_code: "target-unsupported" };
    if (
      component.type === "hook" &&
      (component.vf_handler_id !== "vf-guardrail" ||
        !["pre-tool", "post-tool"].includes(component.event))
    )
      return { target_id, execution: "unsupported", reason_code: "target-unsupported" };
    if (component.type === "hook" && component.event === "post-tool" && entry.engine === "opencode")
      return { target_id, execution: "unsupported", reason_code: "target-unsupported" };
    if (component.type === "hook" && entry.engine === "codex" && scope !== "user")
      return { target_id, execution: "manual", reason_code: "manual-runtime-setup" };
    return { target_id, execution: "host", reason_code: null };
  }
  if (entry.support === "manual-runtime-setup")
    return { target_id, execution: "manual", reason_code: "manual-runtime-setup" };
  if (entry.support === "native-install-required")
    return {
      target_id,
      execution: "required-user-action",
      reason_code: "native-install-required",
    };
  if (entry.support === "external-confirmation-required")
    return {
      target_id,
      execution: "required-user-action",
      reason_code: "external-confirmation-required",
    };
  return { target_id, execution: "unsupported", reason_code: "adapter-unavailable" };
}

export function targetPermissions(
  permissions: readonly CapabilityPermissionV1[],
  target: ActionTargetBindingV1,
): CapabilityPermissionV1[] {
  return permissions.filter((permission) => {
    if (permission.kind === "config" || permission.kind === "hook")
      return permission.scope.engine === target.target.engine;
    return true;
  });
}

export function buildHealthPlans(
  pkg: ResolvedCapabilityPackageV1,
  component: CapabilityComponentV1,
  target: ActionTargetBindingV1,
): PublicHealthPlanV1[] {
  return pkg.manifest.health
    .filter((probe) => probe.component_ids.includes(component.component_id))
    .map((probe) => {
      const permissions = targetPermissions(pkg.manifest.permissions, target)
        .map((permission) => permission.permission_id)
        .sort(bytewise);
      const effect_classes: ActionEffectClass[] =
        probe.kind === "file-hash" || probe.kind === "role-parse" || probe.kind === "engine-config"
          ? ["pure-local-read"]
          : ["process-probe"];
      return {
        probe_id: probe.probe_id,
        kind: probe.kind,
        evidence_schema_id: `vf.${component.type}.${target.target.engine}.${probe.kind}.health/1`,
        target_ids: [target.target_id],
        required: probe.required || target.target.required,
        effect_classes,
        permission_ids: permissions,
        enforcement_digest: digestV1("VF-PROBE-ENFORCEMENT\0v1\0", {
          probe_id: probe.probe_id,
          target_id: target.target_id,
          permissions,
        }),
        timeout_ms: probe.timeout_ms,
        retries: probe.retries,
        evidence_valid_for_ms: 300_000,
      };
    });
}
