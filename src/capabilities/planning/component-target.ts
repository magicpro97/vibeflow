import {
  CAPABILITY_MANIFEST_COMPONENT_TYPE,
  CAPABILITY_MANIFEST_HEALTH_PROBE_KIND,
  CAPABILITY_MANIFEST_HOOK_EVENT,
  CAPABILITY_MANIFEST_MCP_TRANSPORT,
  CAPABILITY_MANIFEST_PERMISSION_KIND,
} from "../../actions/capability-manifest-vocabulary-contract.js";
import type {
  ActionTargetBindingV1,
  CapabilityTargetDispositionV1,
  PublicHealthPlanV1,
} from "../../actions/preview-types.js";
import { targetId } from "../../actions/proposal-content-validation.js";
import {
  ACTION_EFFECT_CLASS,
  ACTION_TARGET_DISPOSITION_EXECUTION_VALUE,
  ACTION_TARGET_MANUAL_REASON,
  ACTION_TARGET_REQUIRED_USER_ACTION_REASON,
  ACTION_TARGET_UNSUPPORTED_REASON,
} from "../../actions/public-action-contract.js";
import {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
} from "../../actions/public-operation-contract.js";
import type { ActionEffectClass, EngineName } from "../../actions/types.js";
import { AGENT_ENGINE } from "../../core/agent-contract.js";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityAdapterRegistryEntryV1 } from "../adapters/types.js";
import type { CapabilityComponentV1, CapabilityPermissionV1 } from "../manifest/types.js";
import { bytewise } from "../wire/primitives.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

export function buildTargetBinding(
  pkg: ResolvedCapabilityPackageV1,
  component: CapabilityComponentV1,
  engine: EngineName,
  scope: CapabilityScope,
  participantId: string | null = null,
): ActionTargetBindingV1 {
  const target = component.required
    ? {
        scope,
        engine,
        participant_id: participantId,
        required: true as const,
        on_apply_failure: PUBLIC_ACTION_TARGET_APPLY_FAILURE.ABORT_SCOPE,
        on_health_failure: PUBLIC_ACTION_TARGET_HEALTH_FAILURE.ABORT_SCOPE,
      }
    : {
        scope,
        engine,
        participant_id: participantId,
        required: false as const,
        on_apply_failure: PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK,
        on_health_failure: PUBLIC_ACTION_TARGET_HEALTH_FAILURE.OMIT_AFTER_ROLLBACK,
      };
  const subject = {
    kind: PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY,
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
  scope: CapabilityScope = CAPABILITY_SCOPE.PROJECT,
): CapabilityTargetDispositionV1 {
  if (
    participantId !== null &&
    component.type !== CAPABILITY_MANIFEST_COMPONENT_TYPE.SKILL &&
    component.type !== CAPABILITY_MANIFEST_COMPONENT_TYPE.ROLE
  )
    return {
      target_id,
      execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED,
      reason_code: ACTION_TARGET_UNSUPPORTED_REASON.TARGET_UNSUPPORTED,
    };
  if (entry.support === ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.HOST) {
    if (
      component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP &&
      component.transport === CAPABILITY_MANIFEST_MCP_TRANSPORT.SSE &&
      entry.engine === AGENT_ENGINE.CODEX
    )
      return {
        target_id,
        execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED,
        reason_code: ACTION_TARGET_UNSUPPORTED_REASON.TARGET_UNSUPPORTED,
      };
    if (
      component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP &&
      (component.secret_slots?.length ?? 0) > 0
    )
      return {
        target_id,
        execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED,
        reason_code: ACTION_TARGET_UNSUPPORTED_REASON.TARGET_UNSUPPORTED,
      };
    if (
      component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK &&
      (component.vf_handler_id !== "vf-guardrail" ||
        (component.event !== CAPABILITY_MANIFEST_HOOK_EVENT.PRE_TOOL &&
          component.event !== CAPABILITY_MANIFEST_HOOK_EVENT.POST_TOOL))
    )
      return {
        target_id,
        execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED,
        reason_code: ACTION_TARGET_UNSUPPORTED_REASON.TARGET_UNSUPPORTED,
      };
    if (
      component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK &&
      component.event === CAPABILITY_MANIFEST_HOOK_EVENT.POST_TOOL &&
      entry.engine === AGENT_ENGINE.OPENCODE
    )
      return {
        target_id,
        execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED,
        reason_code: ACTION_TARGET_UNSUPPORTED_REASON.TARGET_UNSUPPORTED,
      };
    if (
      component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK &&
      entry.engine === AGENT_ENGINE.CODEX &&
      scope !== CAPABILITY_SCOPE.USER
    )
      return {
        target_id,
        execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.MANUAL,
        reason_code: ACTION_TARGET_MANUAL_REASON.MANUAL_RUNTIME_SETUP,
      };
    return {
      target_id,
      execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.HOST,
      reason_code: null,
    };
  }
  if (entry.support === ACTION_TARGET_MANUAL_REASON.MANUAL_RUNTIME_SETUP)
    return {
      target_id,
      execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.MANUAL,
      reason_code: ACTION_TARGET_MANUAL_REASON.MANUAL_RUNTIME_SETUP,
    };
  if (entry.support === ACTION_TARGET_REQUIRED_USER_ACTION_REASON.NATIVE_INSTALL_REQUIRED)
    return {
      target_id,
      execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.REQUIRED_USER_ACTION,
      reason_code: ACTION_TARGET_REQUIRED_USER_ACTION_REASON.NATIVE_INSTALL_REQUIRED,
    };
  if (entry.support === ACTION_TARGET_REQUIRED_USER_ACTION_REASON.EXTERNAL_CONFIRMATION_REQUIRED)
    return {
      target_id,
      execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.REQUIRED_USER_ACTION,
      reason_code: ACTION_TARGET_REQUIRED_USER_ACTION_REASON.EXTERNAL_CONFIRMATION_REQUIRED,
    };
  return {
    target_id,
    execution: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED,
    reason_code: ACTION_TARGET_UNSUPPORTED_REASON.ADAPTER_UNAVAILABLE,
  };
}

export function targetPermissions(
  permissions: readonly CapabilityPermissionV1[],
  target: ActionTargetBindingV1,
): CapabilityPermissionV1[] {
  return permissions.filter((permission) => {
    if (
      permission.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.CONFIG ||
      permission.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.HOOK
    )
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
        probe.kind === CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.FILE_HASH ||
        probe.kind === CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.ROLE_PARSE ||
        probe.kind === CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.ENGINE_CONFIG
          ? [ACTION_EFFECT_CLASS.PURE_LOCAL_READ]
          : [ACTION_EFFECT_CLASS.PROCESS_PROBE];
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
