import { CAPABILITY_SCOPE } from "../core/capability-contract.js";
import { type ProcessLock, canonicalJsonBytes, digestHex, digestV1 } from "../durability/index.js";
import { ActionConflictError } from "./errors.js";
import { HOST_ACTION_KIND, type HostActionKind } from "./host-action-contract.js";
import {
  actionIdempotencyFileKey,
  actionIdempotencyKeyDigest,
  actionIdempotencyScopeDigest,
} from "./idempotency.js";
import {
  ACTION_APPROVAL_CHALLENGE_STATE,
  ACTION_IDEMPOTENCY_BINDING_STATE,
} from "./persistence-contract.js";
import type { ActionFilePersistence, ActionIdempotencyBindingV1 } from "./persistence.js";
import { ACTION_AUTHORITY_EVENT_KIND, ACTION_OPERATION_STATE } from "./protocol-contract.js";
import {
  ACTION_APPROVAL_CHALLENGE_CLASSES,
  ACTION_CHALLENGE_CLASS,
  ACTION_DECISION,
  ACTION_DOMAIN,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import { PUBLIC_ERROR_CODE } from "./public-error-contract.js";
import { assertActor, assertDigest } from "./record-primitives.js";
import { materializeAuthorityEvent } from "./records.js";
import { exactObject } from "./strict-json.js";
import type {
  ActionApprovalV1,
  ActionAuthoritySnapshotV1,
  ActionProposalV1,
  ActionRequestAuthorityV1,
  ChallengeClass,
} from "./types.js";

export function equalCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

export function sameAuthority(
  binding: ActionIdempotencyBindingV1,
  authority: ActionRequestAuthorityV1,
): boolean {
  return (
    binding.principal_digest === authority.principal_digest &&
    binding.authority_scope_digest === authority.authority_scope_digest
  );
}

export function isBoundHumanBrowserController(input: {
  principal_digest: string;
  control_session_digest: string;
  actor: ActionRequestAuthorityV1["actor"];
}): boolean {
  if (
    input.actor.kind !== ACTOR_KIND.HUMAN_BROWSER ||
    input.actor.credential_class !== CREDENTIAL_CLASS.LOOPBACK_SESSION
  )
    return false;
  const expectedPrincipal = digestV1("VF-BROWSER-ACTION-PRINCIPAL\0v1\0", {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    control_session_digest: input.control_session_digest,
  });
  return (
    input.principal_digest === expectedPrincipal &&
    input.actor.public_actor_id === `browser-${digestHex(expectedPrincipal)}`
  );
}

export function isAgentProposalBrowserController(
  proposal: ActionProposalV1,
  authority: ActionRequestAuthorityV1,
): boolean {
  return (
    proposal.requested_by.kind === ACTOR_KIND.AGENT &&
    authority.authority_scope_digest ===
      actionIdempotencyScopeDigest(proposal.action_root_locator) &&
    isBoundHumanBrowserController(authority)
  );
}

export function idempotencyBindingDigest(
  binding: Omit<ActionIdempotencyBindingV1, "binding_digest">,
): string {
  return digestV1("VF-ACTION-IDEMPOTENCY-BINDING\0v1\0", binding);
}

export function completePrepared(
  files: ActionFilePersistence,
  lock: ProcessLock,
  path: string,
  bindings: ActionIdempotencyBindingV1[],
  proposal: ActionProposalV1,
  visibleAt: string,
  fault?: (point: "after-authority-sequence-zero") => void,
): void {
  if (bindings.length < 1 || bindings.length > 2)
    throw new Error("invalid idempotency authority chain");
  const stored = files.readProposal(proposal.proposal_id);
  if (!stored || !equalCanonical(stored, proposal))
    throw new Error("idempotency proposal bytes mismatch");
  const events = files.readAuthority(proposal.proposal_id);
  if (!events.length) {
    files.appendAuthority(
      lock,
      materializeAuthorityEvent(proposal, 0, null, {
        kind: ACTION_AUTHORITY_EVENT_KIND.PROPOSAL_CREATED,
        proposal,
      }),
    );
  } else if (
    !equalCanonical(events[0]?.payload, {
      kind: ACTION_AUTHORITY_EVENT_KIND.PROPOSAL_CREATED,
      proposal,
    })
  ) {
    throw new Error("proposal sequence zero conflicts with idempotency binding");
  }
  fault?.("after-authority-sequence-zero");
  if (bindings.length === 2) {
    const visible = bindings[1];
    if (
      !visible ||
      visible.state !== ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE ||
      visible.previous_frame_digest !== bindings[0]?.binding_digest
    )
      throw new Error("invalid visible idempotency binding");
    return;
  }
  const prepared = bindings[0];
  if (!prepared) throw new Error("prepared idempotency binding is missing");
  const { binding_digest: _old, ...withoutOldDigest } = prepared;
  const preimage = {
    ...withoutOldDigest,
    sequence: 1 as const,
    previous_frame_digest: prepared.binding_digest,
    state: ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE,
    visible_at: visibleAt,
  };
  files.appendIdempotency(lock, path, {
    ...preimage,
    binding_digest: idempotencyBindingDigest(preimage),
  });
}

export function requireOwnedPending(
  files: ActionFilePersistence,
  get: (proposalId: string) => ActionAuthoritySnapshotV1 | null,
  proposalId: string,
  proposalDigest: string,
  authority: ActionRequestAuthorityV1,
): ActionAuthoritySnapshotV1 {
  const snapshot = requireOwnedSnapshot(files, get, proposalId, proposalDigest, authority);
  if (snapshot.state !== ACTION_OPERATION_STATE.PENDING_REVIEW)
    throw new ActionConflictError(
      PUBLIC_ERROR_CODE.STALE_PROPOSAL,
      "Proposal is not pending review.",
      proposalId,
    );
  return snapshot;
}

export function requireOwnedSnapshot(
  files: ActionFilePersistence,
  get: (proposalId: string) => ActionAuthoritySnapshotV1 | null,
  proposalId: string,
  proposalDigest: string,
  authority: ActionRequestAuthorityV1,
): ActionAuthoritySnapshotV1 {
  const snapshot = get(proposalId);
  if (!snapshot || snapshot.proposal.proposal_digest !== proposalDigest)
    throw new ActionConflictError(
      PUBLIC_ERROR_CODE.STALE_PROPOSAL,
      "Proposal authority was not found.",
      proposalId,
    );
  const derivedScopeDigest = actionIdempotencyScopeDigest(snapshot.proposal.action_root_locator);
  if (authority.authority_scope_digest !== derivedScopeDigest)
    throw new ActionConflictError(
      PUBLIC_ERROR_CODE.STALE_PROPOSAL,
      "Proposal authority scope binding changed.",
      proposalId,
    );
  const path = files.idempotencyPath(
    actionIdempotencyFileKey(
      authority.principal_digest,
      derivedScopeDigest,
      actionIdempotencyKeyDigest(snapshot.proposal.idempotency_key),
    ),
  );
  const latest = files.readIdempotency(path).at(-1);
  const directlyOwned =
    latest?.state === ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE &&
    latest.proposal_id === proposalId &&
    latest.proposal_digest === proposalDigest &&
    sameAuthority(latest, authority);
  if (directlyOwned) return snapshot;
  const producerChain = files.idempotencyChainsForProposal(proposalId);
  const producerVisible = producerChain[0]?.at(-1);
  const controlled =
    isAgentProposalBrowserController(snapshot.proposal, authority) &&
    producerChain.length === 1 &&
    producerChain[0]?.length === 2 &&
    producerVisible?.state === ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE &&
    producerVisible.proposal_id === proposalId &&
    producerVisible.proposal_digest === proposalDigest &&
    producerVisible.authority_scope_digest === derivedScopeDigest &&
    producerVisible.idempotency_key_digest ===
      actionIdempotencyKeyDigest(snapshot.proposal.idempotency_key);
  if (!controlled)
    throw new ActionConflictError(
      PUBLIC_ERROR_CODE.STALE_PROPOSAL,
      "Proposal authority binding changed.",
      proposalId,
    );
  return snapshot;
}

export function assertRequiredChallenge(
  files: ActionFilePersistence,
  proposal: ActionProposalV1,
  input: {
    authority: ActionRequestAuthorityV1;
    decision: ActionApprovalV1["decision"];
    challenge_class: ChallengeClass;
    challenge_id?: string | null;
    challenge_digest: string | null;
    decided_at: string;
    expires_at: string;
  },
): void {
  if (input.decision === ACTION_DECISION.DENIED) {
    if (
      input.challenge_class !== ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM ||
      input.challenge_digest !== null
    )
      throw new Error("denial must use normal confirmation");
    return;
  }
  if (input.authority.actor.kind === ACTOR_KIND.AGENT)
    throw new Error("agent cannot approve host actions");
  if (input.authority.actor.kind === ACTOR_KIND.SYSTEM_RECOVERY)
    throw new Error("system recovery cannot approve new intent");
  const userScope =
    proposal.base.capability_scope === CAPABILITY_SCOPE.USER ||
    proposal.target_set.some((target) => target.target.scope === CAPABILITY_SCOPE.USER);
  const required =
    proposal.action.type === HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL
      ? ACTION_CHALLENGE_CLASS.PUBLIC_LITERAL
      : input.authority.actor.credential_class === CREDENTIAL_CLASS.AUTOMATION_GRANT
        ? ACTION_CHALLENGE_CLASS.AUTOMATION_GRANT
        : userScope
          ? ACTION_CHALLENGE_CLASS.FRESH_USER_SCOPE
          : ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM;
  if (input.challenge_class !== required) throw new Error(`approval requires ${required}`);
  if (!ACTION_APPROVAL_CHALLENGE_CLASSES.some((challengeClass) => challengeClass === required))
    return;
  if (!input.challenge_id) throw new Error("consumed approval challenge ID is required");
  const frame = files.readChallenge(input.challenge_id).at(-1);
  const valid =
    frame?.state === ACTION_APPROVAL_CHALLENGE_STATE.CONSUMED &&
    frame.frame_digest === input.challenge_digest &&
    frame.challenge_class === required &&
    frame.proposal_id === proposal.proposal_id &&
    frame.proposal_digest === proposal.proposal_digest &&
    frame.principal_digest === input.authority.principal_digest &&
    frame.control_session_digest === input.authority.control_session_digest &&
    frame.csrf_epoch_digest === input.authority.csrf_epoch_digest &&
    frame.approval_expires_at === input.expires_at &&
    frame.consumed_at === input.decided_at &&
    equalCanonical(frame.approval_decided_by, input.authority.actor);
  if (!valid) throw new Error("consumed approval challenge is missing or stale");
}

export function assertDispatchHeaderRule(proposal: ActionProposalV1, header: string | null): void {
  const revision = REVISION_HEADER_ACTION_KINDS.has(proposal.action.type);
  const required =
    proposal.domain === ACTION_DOMAIN.CAPABILITY ||
    revision ||
    proposal.action.type === HOST_ACTION_KIND.AUTHORITY_REPAIR;
  if (required !== (header !== null))
    throw new Error("dispatch domain header nullability mismatch");
}

const REVISION_HEADER_ACTION_KINDS: ReadonlySet<HostActionKind> = new Set([
  HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS,
  HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE,
  HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
  HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
  HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
]);

export function assertRequestAuthority(authority: ActionRequestAuthorityV1): void {
  exactObject(
    authority,
    [
      "schema_version",
      "principal_digest",
      "authority_scope_digest",
      "control_session_digest",
      "csrf_epoch_digest",
      "actor",
    ],
    [],
    "$.authority",
  );
  if (authority.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION)
    throw new Error("invalid authenticated action authority");
  for (const field of [
    "principal_digest",
    "authority_scope_digest",
    "control_session_digest",
    "csrf_epoch_digest",
  ] as const)
    assertDigest(authority[field], `$.authority.${field}`);
  assertActor(authority.actor, "$.authority.actor");
  const credential = authority.actor.credential_class;
  if (
    authority.actor.kind === ACTOR_KIND.HUMAN_BROWSER &&
    credential !== CREDENTIAL_CLASS.LOOPBACK_SESSION
  )
    throw new Error("browser actor requires loopback session credential");
  if (
    authority.actor.kind === ACTOR_KIND.AGENT &&
    ![CREDENTIAL_CLASS.LOOPBACK_SESSION, CREDENTIAL_CLASS.AUTOMATION_GRANT].some(
      (credentialClass) => credentialClass === credential,
    )
  )
    throw new Error("agent request credential is not admitted");
  if (
    authority.actor.kind === ACTOR_KIND.SYSTEM_RECOVERY &&
    credential !== CREDENTIAL_CLASS.RECOVERY
  )
    throw new Error("system recovery requires recovery credential");
}
