import { createHash } from "node:crypto";
import { HOST_ACTION_KIND } from "../src/actions/host-action-contract.js";
import {
  ACTION_OPERATION_STATE,
  isActionOperationApprovalRequiredState,
  isActionOperationDispatchReplayState,
} from "../src/actions/protocol-contract.js";
import {
  ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX,
  ACTION_AUTHORITY_BINDING_MODE,
  ACTION_CHALLENGE_CLASS,
  ACTION_DECISION,
  ACTION_DELIVERY_VALUE,
  ACTION_DOMAIN,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_REVERSIBILITY_VALUE,
  ACTION_RISK,
  ACTION_SCOPE,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../src/actions/public-action-contract.js";
import type {
  ActionApprovalChallengeResponseV1,
  ActionOperationViewV1,
  PublicActionApprovalViewV1,
  PublicActionProposalViewV1,
} from "../src/actions/public-types.js";
import type { HomeActionView } from "../src/ui/src/conversation-home-types.js";

export const HOME_TS = "2026-08-25T00:00:00.000Z";
export const HOME_FUTURE_TS = "2099-12-31T23:59:59.000Z";
export const HOME_EXPIRED_TS = "2026-08-25T00:01:00.000Z";

export const HOME_ACTION_FIXTURE_STATES = Object.freeze([
  ACTION_OPERATION_STATE.PENDING_REVIEW,
  ACTION_OPERATION_STATE.APPROVED,
  ACTION_OPERATION_STATE.COMMITTING,
  ACTION_OPERATION_STATE.DENIED,
  ACTION_OPERATION_STATE.CANCELED,
  ACTION_OPERATION_STATE.EXPIRED,
  ACTION_OPERATION_STATE.STALE,
] as const);
export type HomeActionFixtureState = (typeof HOME_ACTION_FIXTURE_STATES)[number];

export function homeHex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function homeDigest(seed: string): string {
  return `sha256:${homeHex(seed)}`;
}

export function homeAuthorityId(
  kind: "proposal" | "approval" | "operation" | "operation-event",
  seed: string,
): string {
  return `vf-${kind}-${homeHex(`${kind}:${seed}`)}`;
}

export interface HomeActionFixtureOverrides {
  readonly proposal?: Partial<PublicActionProposalViewV1>;
  readonly approval?: Partial<PublicActionApprovalViewV1> | null;
  readonly operation?: Omit<Partial<ActionOperationViewV1>, "state"> & {
    readonly state?: HomeActionFixtureState;
  };
}

export function homeFreshUserChallenge(seed: string): ActionApprovalChallengeResponseV1 {
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    challenge_id: homeHex(`challenge:${seed}`).slice(0, 43),
    challenge_class: ACTION_CHALLENGE_CLASS.FRESH_USER_SCOPE,
    display_phrase: `${ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX[ACTION_CHALLENGE_CLASS.FRESH_USER_SCOPE]} ${homeHex(`challenge-phrase:${seed}`).slice(0, 12)}`,
    expires_at: HOME_FUTURE_TS,
  };
}

export function homePendingAction(
  proposalSeed: string,
  title: string,
  overrides: HomeActionFixtureOverrides = {},
): HomeActionView {
  const proposalId = /^vf-proposal-[0-9a-f]{64}$/u.test(proposalSeed)
    ? proposalSeed
    : homeAuthorityId("proposal", proposalSeed);
  const proposalDigest = homeDigest(`proposal:${proposalId}`);
  const proposalOverrides = overrides.proposal ?? {};
  const actionType = proposalOverrides.action_type ?? HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS;
  const domain = proposalOverrides.domain ?? ACTION_DOMAIN.CONVERSATION;
  const scope = proposalOverrides.scope ?? ACTION_SCOPE.CONVERSATION;
  const effectClasses = proposalOverrides.effect_classes ?? [];
  const targets = proposalOverrides.targets ?? [];
  const packagePins = proposalOverrides.package_pins ?? [];
  const reversibility = proposalOverrides.reversibility ?? ACTION_REVERSIBILITY_VALUE.REVERSIBLE;
  const preview: PublicActionProposalViewV1["preview"] = {
    title,
    summary: title,
    action_type: actionType,
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    review_fields: [],
    targets,
    target_dispositions: [],
    package_pins: packagePins,
    permission_delta: [],
    dependency_delta: [],
    config_diffs: [],
    effect_classes: effectClasses,
    enforcement: [],
    reversibility,
    health_plan: [],
    recovery_actions: [],
    projector_version: ACTION_PREVIEW_PROJECTOR_VERSION,
    rules_digest: homeDigest(`rules:${proposalId}`),
    redaction_manifest_digest: homeDigest(`redaction:${proposalId}`),
    ...proposalOverrides.preview,
  };
  const proposal: PublicActionProposalViewV1 = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    proposal_id: proposalId,
    proposal_digest: proposalDigest,
    origin_event_id: null,
    action_type: actionType,
    domain,
    scope,
    authority_binding_mode: ACTION_AUTHORITY_BINDING_MODE.CURRENT,
    risk: proposalOverrides.risk ?? ACTION_RISK.LOW,
    effect_classes: effectClasses,
    targets,
    package_pins: packagePins,
    adapter_set_digest: homeDigest(`adapters:${proposalId}`),
    plan_digest: homeDigest(`plan:${proposalId}`),
    policy_digest: homeDigest(`policy:${proposalId}`),
    permission_digest: homeDigest(`permissions:${proposalId}`),
    reversibility,
    preview,
    created_at: HOME_TS,
    expires_at: HOME_FUTURE_TS,
    ...proposalOverrides,
  };
  const operationOverrides = overrides.operation ?? {};
  const state = operationOverrides.state ?? ACTION_OPERATION_STATE.PENDING_REVIEW;
  const approvalRequired = isActionOperationApprovalRequiredState(state);
  const approvalId = homeAuthorityId("approval", proposalId);
  const approvalDigest = homeDigest(`approval:${proposalId}`);
  const defaultApproval: PublicActionApprovalViewV1 | null = approvalRequired
    ? {
        schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
        approval_id: approvalId,
        approval_digest: approvalDigest,
        proposal_id: proposalId,
        proposal_digest: proposalDigest,
        decision:
          state === ACTION_OPERATION_STATE.DENIED
            ? ACTION_DECISION.DENIED
            : ACTION_DECISION.APPROVED,
        challenge_class: ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM,
        decided_by: {
          kind: ACTOR_KIND.HUMAN_BROWSER,
          public_actor_id: "e2e-user",
          credential_class: CREDENTIAL_CLASS.LOOPBACK_SESSION,
        },
        decided_at: HOME_TS,
        expires_at: proposal.expires_at,
      }
    : null;
  const approval =
    overrides.approval === null
      ? null
      : defaultApproval
        ? ({ ...defaultApproval, ...overrides.approval } as PublicActionApprovalViewV1)
        : null;
  const operationId = isActionOperationDispatchReplayState(state)
    ? homeAuthorityId("operation", proposalId)
    : null;
  const operation: ActionOperationViewV1 = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    operation_id: operationId,
    proposal_id: proposalId,
    proposal_digest: proposalDigest,
    approval_id: approval?.approval_id ?? null,
    approval_digest: approval?.approval_digest ?? null,
    correlation_id: `vf-correlation-${homeHex(`correlation:${proposalId}`)}`,
    domain,
    state,
    phase_sequence: null,
    latest_event_cursor: null,
    progress: [],
    targets: [],
    delivery:
      state === ACTION_OPERATION_STATE.COMMITTING
        ? ACTION_DELIVERY_VALUE.PENDING
        : ACTION_DELIVERY_VALUE.NOT_APPLICABLE,
    result_ref: null,
    error: null,
    recovery_actions: [],
    created_at: proposal.created_at,
    updated_at: proposal.created_at,
    ...operationOverrides,
  };

  return { schema_version: PUBLIC_ACTION_SCHEMA_VERSION, proposal, approval, operation };
}
