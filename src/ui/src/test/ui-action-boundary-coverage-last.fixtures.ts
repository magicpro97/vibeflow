import { ACTION_OPERATION_STATE } from "../../../actions/protocol-contract.js";
import { ACTION_DELIVERY_VALUE } from "../../../actions/public-action-vocabulary-contract.js";
import {
  PUBLIC_ERROR_CANONICAL_MESSAGE,
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
} from "../../../actions/public-error-contract.js";
import {
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PROGRESS_STATUS,
  type PublicOperationPhaseV1,
  type PublicOperationProgressStatusV1,
} from "../../../actions/public-operation-contract.js";

export const at = (minute: number) => `2026-08-26T00:${String(minute).padStart(2, "0")}:00.000Z`;
export const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
export const id = (kind: string, seed: string) => `vf-${kind}-${seed.repeat(64).slice(0, 64)}`;
export const cursor = (seed: string) => `vf-operation-event-${seed.repeat(64).slice(0, 64)}`;
export const target = (required = true) => ({
  target_id: "target-a",
  target: {
    scope: "project",
    engine: null,
    participant_id: null,
    required,
    on_apply_failure: required ? "abort-scope" : "omit-after-rollback",
    on_health_failure: required ? "abort-scope" : "commit-degraded",
  },
  subject: { kind: "capability", package_id: "acme/tool", component_id: "component-a" },
});
const pin = {
  id: "acme/tool",
  version: "1.2.3",
  source_kind: "registry",
  content_sha256: "a".repeat(64),
  trust: "verified",
  nonportable: false,
  pin_digest: digest("b"),
};
export function preview(actionType = "capability.install", targets: unknown[] = [target()]) {
  return {
    title: "Install capability",
    summary: "Apply the reviewed capability plan.",
    action_type: actionType,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    review_fields: [
      {
        json_pointer: "/package/version",
        label: "Version",
        before: null,
        after: { version: "1.2.3" },
        private_binding_digest: digest("1"),
      },
    ],
    targets,
    target_dispositions: [
      { target_id: "target-a", execution: "host", reason_code: null },
      { target_id: "target-a", execution: "manual", reason_code: "manual-config-change" },
      {
        target_id: "target-a",
        execution: "required-user-action",
        reason_code: "native-install-required",
      },
      { target_id: "target-a", execution: "unsupported", reason_code: "adapter-unavailable" },
    ],
    package_pins: actionType === "capability.install" ? [pin] : [],
    permission_delta: [
      {
        permission_id: "capabilities/install",
        change: "add",
        public_scope: "project",
        enforcement: "brokered",
      },
    ],
    dependency_delta: [
      { package_id: "acme/runtime", change: "update", from_version: null, to_version: "2.0.0" },
    ],
    config_diffs: [
      {
        target: ".vibeflow/config.json",
        target_ids: ["target-a", "target-b"],
        mode: "surgical",
        before_digest: digest("2"),
        after_digest: digest("3"),
        bounded_before: null,
        bounded_after: "enabled=true",
      },
    ],
    effect_classes: ["project-write"],
    enforcement: [
      {
        permission_id: "capabilities/install",
        engine: "codex",
        enforcement: "brokered",
        explanation: "VibeFlow brokers this write.",
      },
    ],
    reversibility: "reversible",
    health_plan: [
      {
        probe_id: "probe-a",
        kind: "binary-version",
        evidence_schema_id: "vf.health/1",
        target_ids: ["target-a"],
        required: true,
        effect_classes: ["project-write"],
        permission_ids: ["capabilities/install"],
        enforcement_digest: digest("4"),
        timeout_ms: 1_000,
        retries: 1,
        evidence_valid_for_ms: 60_000,
      },
    ],
    recovery_actions: ["retry"],
    projector_version: "vf-public-projector/1",
    rules_digest: digest("5"),
    redaction_manifest_digest: digest("6"),
  };
}
export function proposal(seed = "a", actionType = "capability.install", domain = "capability") {
  const targets =
    domain === "conversation"
      ? [
          {
            ...target(),
            subject: { kind: "conversation", action_type: actionType, participant_id: "agent-a" },
          },
        ]
      : [target()];
  return {
    schema_version: "1.0",
    proposal_id: id("proposal", seed),
    proposal_digest: digest(seed),
    origin_event_id: "event-origin",
    action_type: actionType,
    domain,
    scope: "project",
    authority_binding_mode: "current",
    risk: "medium",
    effect_classes: ["project-write"],
    targets,
    package_pins: domain === "capability" ? [pin] : [],
    adapter_set_digest: digest("7"),
    plan_digest: digest("8"),
    policy_digest: digest("9"),
    permission_digest: digest("a"),
    reversibility: "reversible",
    preview: preview(actionType, targets),
    created_at: at(0),
    expires_at: at(59),
  };
}
export function approval(seed: string, decision: "approved" | "denied") {
  return {
    schema_version: "1.0",
    approval_id: id("approval", seed),
    approval_digest: digest(`d${seed}`),
    proposal_id: id("proposal", seed),
    proposal_digest: digest(seed),
    decision,
    challenge_class: "fresh-user-scope",
    decided_by: {
      kind: "human-browser",
      public_actor_id: "user-a",
      credential_class: "loopback-session",
    },
    decided_at: at(1),
    expires_at: at(30),
  };
}
export const progress = (
  sequence: number,
  phase: PublicOperationPhaseV1,
  status: PublicOperationProgressStatusV1,
) => ({
  sequence,
  phase,
  status,
  message_code: `operation.${phase}`,
  at: at(sequence + 2),
});
export function succeededOperation(seed = "a") {
  const binding = target();
  return {
    schema_version: "1.0",
    operation_id: id("operation", seed),
    proposal_id: id("proposal", seed),
    proposal_digest: digest(seed),
    approval_id: id("approval", seed),
    approval_digest: digest(`d${seed}`),
    correlation_id: id("correlation", seed),
    domain: "capability",
    state: "succeeded",
    phase_sequence: 2,
    latest_event_cursor: cursor(seed),
    progress: [
      progress(
        0,
        PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
        PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
      ),
      progress(
        1,
        PUBLIC_OPERATION_FIXED_PHASE.TARGET_APPLIED,
        PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
      ),
      progress(
        2,
        PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
        PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
      ),
    ],
    targets: [{ ...binding, outcome: "applied", health: "ready", evidence_digest: digest("e") }],
    delivery: "delivered",
    result_ref: null,
    error: null,
    recovery_actions: [],
    created_at: at(0),
    updated_at: at(4),
  };
}
export function needsRecoveryOperation(seed = "c") {
  const operation = succeededOperation(seed);
  return {
    ...operation,
    state: ACTION_OPERATION_STATE.NEEDS_RECOVERY,
    phase_sequence: 1,
    progress: [
      progress(
        0,
        PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
        PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
      ),
      progress(
        1,
        PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY,
        PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
      ),
    ],
    targets: [],
    delivery: ACTION_DELIVERY_VALUE.FAILED,
    error: {
      code: PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      message: PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY],
      correlation_id: operation.correlation_id,
      retryable: false,
      recovery_action: PUBLIC_RECOVERY_ACTION.REPAIR,
      details: { operation_id: operation.operation_id },
    },
    recovery_actions: [PUBLIC_RECOVERY_ACTION.REPAIR],
    updated_at: at(3),
  };
}
export function deniedOperation(seed = "b") {
  return {
    ...succeededOperation(seed),
    operation_id: null,
    state: "denied",
    phase_sequence: null,
    latest_event_cursor: null,
    progress: [],
    targets: [],
    delivery: "not-applicable",
    created_at: at(0),
    updated_at: at(1),
  };
}
