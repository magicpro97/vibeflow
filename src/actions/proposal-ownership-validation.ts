import type { HostActionV1 } from "./internal-action-types.js";
import {
  EMPTY_PERMISSION_DIGEST,
  isAuthorityAction,
  isCapabilityAction,
} from "./proposal-content-validation.js";
import {
  validateCapabilityGeneration,
  validateUserPrerequisites,
} from "./proposal-prerequisite-validation.js";
import {
  assertDigest,
  assertOpaqueId,
  assertSafeInteger,
  assertStringArray,
} from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";
import type { ActionProposalDraftV1 } from "./types.js";

const BASE_FIELDS = [
  "root_session_id",
  "conversation_id",
  "revision_id",
  "last_seq",
  "conversation_lock_digest",
  "lineage_head_digest",
  "lineage_head_epoch",
  "capability_scope",
  "capability_generation_ordinal",
  "capability_generation_id",
  "capability_lock_digest",
  "capability_parent_generation_digests",
  "user_prerequisites",
  "authority_binding_mode",
  "authority_epoch",
  "authority_head_digest",
  "repair_authorization_binding_digest",
] as const;

export function validateProposalOwnership(draft: ActionProposalDraftV1): void {
  const locator = validateLocator(draft);
  const base = exactObject(draft.base, BASE_FIELDS, [], "$.proposal.base");
  validateProducerBinding(draft);
  validateAuthorityBase(draft, base);
  const conversationAction =
    draft.action.type.startsWith("conversation.") || draft.action.type === "context.compact";
  if (conversationAction) validateConversationOwner(draft, locator, base);
  else if (isCapabilityAction(draft.action.type)) validateCapabilityOwner(draft, locator, base);
  else if (isAuthorityAction(draft.action.type)) validateAuthorityOwner(draft, locator, base);
  else if (draft.action.type === "authority.repair") validateRepairOwner(draft, locator, base);
  else invalid("action has no closed owner matrix row");
  const capabilityAction = isCapabilityAction(draft.action.type);
  if (capabilityAction !== (draft.execution_object_closure_digest !== null))
    invalid("capability execution closure nullability mismatch");
  if (draft.execution_object_closure_digest !== null)
    assertDigest(
      draft.execution_object_closure_digest,
      "$.proposal.execution_object_closure_digest",
    );
}

function validateLocator(draft: ActionProposalDraftV1): Record<string, unknown> {
  const locator = exactObject(
    draft.action_root_locator,
    ["kind"],
    ["root_session_id", "scope", "scope_identity_digest", "bootstrap_identity_digest"],
    "$.proposal.action_root_locator",
  );
  if (locator.kind === "conversation") {
    exactObject(
      draft.action_root_locator,
      ["kind", "root_session_id"],
      [],
      "$.proposal.action_root_locator",
    );
    assertOpaqueId(locator.root_session_id, "$.proposal.action_root_locator.root_session_id");
  } else if (locator.kind === "capability") {
    exactObject(
      draft.action_root_locator,
      ["kind", "scope", "scope_identity_digest"],
      [],
      "$.proposal.action_root_locator",
    );
    assertScope(locator.scope, "$.proposal.action_root_locator.scope");
    assertDigest(
      locator.scope_identity_digest,
      "$.proposal.action_root_locator.scope_identity_digest",
    );
  } else if (locator.kind === "recovery-bootstrap") {
    exactObject(
      draft.action_root_locator,
      ["kind", "bootstrap_identity_digest"],
      [],
      "$.proposal.action_root_locator",
    );
    assertDigest(
      locator.bootstrap_identity_digest,
      "$.proposal.action_root_locator.bootstrap_identity_digest",
    );
  } else invalid("unknown action-root locator");
  return locator;
}

function validateProducerBinding(draft: ActionProposalDraftV1): void {
  const binding = exactObject(
    draft.producer_request_binding,
    ["kind", "digest"],
    [],
    "$.proposal.producer_request_binding",
  );
  if (
    !["canonical-action-request", "recovery-bootstrap-repair-plan"].includes(binding.kind as string)
  )
    invalid("unknown producer request binding");
  assertDigest(binding.digest, "$.proposal.producer_request_binding.digest");
  if (draft.origin_event_id !== null)
    assertOpaqueId(draft.origin_event_id, "$.proposal.origin_event_id");
  const bootstrap = draft.action_root_locator.kind === "recovery-bootstrap";
  if (bootstrap !== (binding.kind === "recovery-bootstrap-repair-plan"))
    invalid("producer binding and action root disagree");
  if (bootstrap) {
    if (draft.origin_event_id !== null || draft.action.type !== "authority.repair")
      invalid("recovery bootstrap cannot carry conversation origin");
    if (binding.digest !== draft.action.plan.plan_digest)
      invalid("recovery bootstrap producer does not bind the repair plan");
  }
}

function validateAuthorityBase(draft: ActionProposalDraftV1, base: Record<string, unknown>): void {
  if (
    base.authority_binding_mode !== "current" &&
    base.authority_binding_mode !== "recovery-checkpoint"
  )
    invalid("invalid authority binding mode");
  const repair = draft.action.type === "authority.repair";
  const bootstrap = draft.action_root_locator.kind === "recovery-bootstrap";
  if (bootstrap !== (repair && base.authority_binding_mode === "recovery-checkpoint"))
    invalid("recovery-bootstrap is restricted to checkpoint authority repair");
  if (!bootstrap && base.authority_binding_mode !== "current")
    invalid("ordinary proposal must bind current authority");
  if (repair !== (base.repair_authorization_binding_digest !== null))
    invalid("repair authorization nullability mismatch");
  if (base.repair_authorization_binding_digest !== null)
    assertDigest(
      base.repair_authorization_binding_digest,
      "$.proposal.base.repair_authorization_binding_digest",
    );
  assertSafeInteger(base.authority_epoch, "$.proposal.base.authority_epoch");
  assertDigest(base.authority_head_digest, "$.proposal.base.authority_head_digest");
  assertStringArray(
    base.capability_parent_generation_digests,
    "$.proposal.base.capability_parent_generation_digests",
    { sorted: true, digest: true },
  );
  validateCapabilityGeneration(base);
  validateUserPrerequisites(draft, base.user_prerequisites);
}

function validateConversationOwner(
  draft: ActionProposalDraftV1,
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (draft.domain !== "conversation" || locator.kind !== "conversation")
    invalid("conversation action has wrong owner");
  requireConversationBase(base, locator);
  nullCapabilityGeneration(base, false);
}

function validateCapabilityOwner(
  draft: ActionProposalDraftV1,
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (draft.domain !== "capability") invalid("capability action has wrong domain");
  const scope = actionScope(draft.action);
  if (!scope || base.capability_scope !== scope) invalid("capability action/body scope mismatch");
  requireOrdinaryLocatorBase(locator, base);
  if (
    base.user_prerequisites &&
    (base.user_prerequisites as unknown[]).length &&
    scope !== "project"
  )
    invalid("user prerequisites are valid only for project capability actions");
}

function validateAuthorityOwner(
  draft: ActionProposalDraftV1,
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (draft.domain !== "capability") invalid("authority action has wrong domain");
  const scope = actionScope(draft.action);
  if (!scope || base.capability_scope !== scope) invalid("authority action/body scope mismatch");
  requireOrdinaryLocatorBase(locator, base);
  nullCapabilityGeneration(base, true);
}

function validateRepairOwner(
  draft: ActionProposalDraftV1,
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (draft.action.type !== "authority.repair") invalid("repair owner called for another action");
  const plan = draft.action.plan;
  if (
    plan.repair_authorization_binding_digest !== base.repair_authorization_binding_digest ||
    plan.permission_digest !== draft.permission_digest ||
    draft.permission_digest !== EMPTY_PERMISSION_DIGEST
  )
    invalid("repair authority or permission binding mismatch");
  const conversation = plan.authority_scope === "conversation";
  if (draft.domain !== (conversation ? "conversation" : "capability"))
    invalid("repair domain does not match target authority origin");
  if (base.capability_scope !== (conversation ? null : plan.authority_scope))
    invalid("repair base does not match target authority scope");
  if (locator.kind !== "recovery-bootstrap") {
    if (conversation && locator.kind !== "conversation")
      invalid("conversation repair has wrong root");
    if (!conversation && locator.kind !== "capability") invalid("capability repair has wrong root");
    if (locator.kind === "capability" && locator.scope !== plan.authority_scope)
      invalid("repair locator scope mismatch");
  }
  nullConversationBase(base);
  nullCapabilityGeneration(base, !conversation);
}

function requireOrdinaryLocatorBase(
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (locator.kind === "conversation") requireConversationBase(base, locator);
  else if (locator.kind === "capability") {
    if (locator.scope !== base.capability_scope) invalid("locator and base scope disagree");
    nullConversationBase(base);
  } else invalid("ordinary action cannot use recovery-bootstrap root");
}

function requireConversationBase(
  base: Record<string, unknown>,
  locator: Record<string, unknown>,
): void {
  for (const key of ["root_session_id", "conversation_id", "revision_id"])
    assertOpaqueId(base[key], `$.proposal.base.${key}`);
  assertSafeInteger(base.last_seq, "$.proposal.base.last_seq");
  assertDigest(base.conversation_lock_digest, "$.proposal.base.conversation_lock_digest");
  assertDigest(base.lineage_head_digest, "$.proposal.base.lineage_head_digest");
  assertSafeInteger(base.lineage_head_epoch, "$.proposal.base.lineage_head_epoch");
  if (locator.root_session_id !== base.root_session_id)
    invalid("conversation locator root mismatch");
}

function nullConversationBase(base: Record<string, unknown>): void {
  for (const key of [
    "root_session_id",
    "conversation_id",
    "revision_id",
    "last_seq",
    "conversation_lock_digest",
    "lineage_head_digest",
    "lineage_head_epoch",
  ])
    if (base[key] !== null) invalid("standalone base contains conversation authority");
}

function nullCapabilityGeneration(base: Record<string, unknown>, keepScope: boolean): void {
  if (!keepScope && base.capability_scope !== null)
    invalid("non-capability action contains capability scope");
  if (
    base.capability_generation_ordinal !== null ||
    base.capability_generation_id !== null ||
    base.capability_lock_digest !== null ||
    (base.capability_parent_generation_digests as unknown[]).length ||
    (base.user_prerequisites as unknown[]).length
  )
    invalid("non-capability action contains capability generation authority");
}

function actionScope(action: HostActionV1): "project" | "user" | null {
  if ("scope" in action && (action.scope === "project" || action.scope === "user"))
    return action.scope;
  if ((action.type === "grant.create" || action.type === "grant.renew") && action.grant)
    return action.grant.scope;
  return null;
}

function assertScope(value: unknown, path: string): void {
  if (value !== "project" && value !== "user")
    throw new ActionValidationError("invalid capability scope", path);
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.proposal");
}
