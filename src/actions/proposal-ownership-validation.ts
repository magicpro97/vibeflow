import { HOST_ACTION_KIND, isConversationHostActionKind } from "./host-action-contract.js";
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
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
  isActionProducerRequestBindingKind,
} from "./protocol-contract.js";
import {
  ACTION_AUTHORITY_BINDING_MODE,
  ACTION_DOMAIN,
  ACTION_SCOPE,
} from "./public-action-contract.js";
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
  if (isConversationHostActionKind(draft.action.type))
    validateConversationOwner(draft, locator, base);
  else if (isCapabilityAction(draft.action.type)) validateCapabilityOwner(draft, locator, base);
  else if (isAuthorityAction(draft.action.type)) validateAuthorityOwner(draft, locator, base);
  else if (draft.action.type === HOST_ACTION_KIND.AUTHORITY_REPAIR)
    validateRepairOwner(draft, locator, base);
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
  if (locator.kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION) {
    exactObject(
      draft.action_root_locator,
      ["kind", "root_session_id"],
      [],
      "$.proposal.action_root_locator",
    );
    assertOpaqueId(locator.root_session_id, "$.proposal.action_root_locator.root_session_id");
  } else if (locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY) {
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
  } else if (locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP) {
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
  if (!isActionProducerRequestBindingKind(binding.kind))
    invalid("unknown producer request binding");
  assertDigest(binding.digest, "$.proposal.producer_request_binding.digest");
  if (draft.origin_event_id !== null)
    assertOpaqueId(draft.origin_event_id, "$.proposal.origin_event_id");
  const bootstrap = draft.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP;
  if (
    bootstrap !==
    (binding.kind === ACTION_PRODUCER_REQUEST_BINDING_KIND.RECOVERY_BOOTSTRAP_REPAIR_PLAN)
  )
    invalid("producer binding and action root disagree");
  if (bootstrap) {
    if (draft.origin_event_id !== null || draft.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR)
      invalid("recovery bootstrap cannot carry conversation origin");
    if (binding.digest !== draft.action.plan.plan_digest)
      invalid("recovery bootstrap producer does not bind the repair plan");
  }
}

function validateAuthorityBase(draft: ActionProposalDraftV1, base: Record<string, unknown>): void {
  if (
    base.authority_binding_mode !== ACTION_AUTHORITY_BINDING_MODE.CURRENT &&
    base.authority_binding_mode !== ACTION_AUTHORITY_BINDING_MODE.RECOVERY_CHECKPOINT
  )
    invalid("invalid authority binding mode");
  const repair = draft.action.type === HOST_ACTION_KIND.AUTHORITY_REPAIR;
  const bootstrap = draft.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP;
  if (
    bootstrap !==
    (repair && base.authority_binding_mode === ACTION_AUTHORITY_BINDING_MODE.RECOVERY_CHECKPOINT)
  )
    invalid("recovery-bootstrap is restricted to checkpoint authority repair");
  if (!bootstrap && base.authority_binding_mode !== ACTION_AUTHORITY_BINDING_MODE.CURRENT)
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
  if (
    draft.domain !== ACTION_DOMAIN.CONVERSATION ||
    locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION
  )
    invalid("conversation action has wrong owner");
  requireConversationBase(base, locator);
  nullCapabilityGeneration(base, false);
}

function validateCapabilityOwner(
  draft: ActionProposalDraftV1,
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (draft.domain !== ACTION_DOMAIN.CAPABILITY) invalid("capability action has wrong domain");
  const scope = actionScope(draft.action);
  if (!scope || base.capability_scope !== scope) invalid("capability action/body scope mismatch");
  requireOrdinaryLocatorBase(locator, base);
  if (
    base.user_prerequisites &&
    (base.user_prerequisites as unknown[]).length &&
    scope !== ACTION_SCOPE.PROJECT
  )
    invalid("user prerequisites are valid only for project capability actions");
}

function validateAuthorityOwner(
  draft: ActionProposalDraftV1,
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (draft.domain !== ACTION_DOMAIN.CAPABILITY) invalid("authority action has wrong domain");
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
  if (draft.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR)
    invalid("repair owner called for another action");
  const plan = draft.action.plan;
  if (
    plan.repair_authorization_binding_digest !== base.repair_authorization_binding_digest ||
    plan.permission_digest !== draft.permission_digest ||
    draft.permission_digest !== EMPTY_PERMISSION_DIGEST
  )
    invalid("repair authority or permission binding mismatch");
  const conversation = plan.authority_scope === ACTION_SCOPE.CONVERSATION;
  if (draft.domain !== (conversation ? ACTION_DOMAIN.CONVERSATION : ACTION_DOMAIN.CAPABILITY))
    invalid("repair domain does not match target authority origin");
  if (base.capability_scope !== (conversation ? null : plan.authority_scope))
    invalid("repair base does not match target authority scope");
  if (locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP) {
    if (
      conversation &&
      (locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION ||
        locator.root_session_id !== plan.scope_id)
    )
      invalid("conversation repair escaped its immutable target origin");
    if (
      !conversation &&
      (locator.kind !== ACTION_ROOT_LOCATOR_KIND.CAPABILITY ||
        locator.scope !== plan.authority_scope ||
        locator.scope_identity_digest !== plan.scope_id)
    )
      invalid("capability repair escaped its immutable target origin");
  }
  if (conversation && locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
    requireConversationBase(base, locator);
  else nullConversationBase(base);
  nullCapabilityGeneration(base, !conversation);
}

function requireOrdinaryLocatorBase(
  locator: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  if (locator.kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION)
    requireConversationBase(base, locator);
  else if (locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY) {
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

function actionScope(
  action: HostActionV1,
): typeof ACTION_SCOPE.PROJECT | typeof ACTION_SCOPE.USER | null {
  if (
    "scope" in action &&
    (action.scope === ACTION_SCOPE.PROJECT || action.scope === ACTION_SCOPE.USER)
  )
    return action.scope;
  if (
    (action.type === HOST_ACTION_KIND.GRANT_CREATE ||
      action.type === HOST_ACTION_KIND.GRANT_RENEW) &&
    action.grant
  )
    return action.grant.scope;
  return null;
}

function assertScope(value: unknown, path: string): void {
  if (value !== ACTION_SCOPE.PROJECT && value !== ACTION_SCOPE.USER)
    throw new ActionValidationError("invalid capability scope", path);
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.proposal");
}
