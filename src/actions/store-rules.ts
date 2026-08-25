import { type ProcessLock, canonicalJsonBytes, digestV1 } from "../durability/index.js";
import { ActionConflictError } from "./errors.js";
import {
  actionIdempotencyFileKey,
  actionIdempotencyKeyDigest,
  actionIdempotencyScopeDigest,
} from "./idempotency.js";
import type { ActionFilePersistence, ActionIdempotencyBindingV1 } from "./persistence.js";
import { assertActor, assertDigest } from "./record-primitives.js";
import { materializeAuthorityEvent } from "./records.js";
import { exactObject } from "./strict-json.js";
import type {
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
      materializeAuthorityEvent(proposal, 0, null, { kind: "proposal-created", proposal }),
    );
  } else if (!equalCanonical(events[0]?.payload, { kind: "proposal-created", proposal })) {
    throw new Error("proposal sequence zero conflicts with idempotency binding");
  }
  fault?.("after-authority-sequence-zero");
  if (bindings.length === 2) {
    const visible = bindings[1];
    if (
      !visible ||
      visible.state !== "visible" ||
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
    state: "visible" as const,
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
  if (snapshot.state !== "pending_review")
    throw new ActionConflictError("stale_proposal", "Proposal is not pending review.", proposalId);
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
      "stale_proposal",
      "Proposal authority was not found.",
      proposalId,
    );
  const derivedScopeDigest = actionIdempotencyScopeDigest(snapshot.proposal.action_root_locator);
  if (authority.authority_scope_digest !== derivedScopeDigest)
    throw new ActionConflictError(
      "stale_proposal",
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
  const owned =
    latest?.state === "visible" &&
    latest.proposal_id === proposalId &&
    latest.proposal_digest === proposalDigest &&
    sameAuthority(latest, authority);
  if (!owned)
    throw new ActionConflictError(
      "stale_proposal",
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
    decision: "approved" | "denied";
    challenge_class: ChallengeClass;
    challenge_id?: string | null;
    challenge_digest: string | null;
    decided_at: string;
    expires_at: string;
  },
): void {
  if (input.decision === "denied") {
    if (input.challenge_class !== "normal-confirm" || input.challenge_digest !== null)
      throw new Error("denial must use normal confirmation");
    return;
  }
  if (input.authority.actor.kind === "agent") throw new Error("agent cannot approve host actions");
  if (input.authority.actor.kind === "system-recovery")
    throw new Error("system recovery cannot approve new intent");
  const userScope =
    proposal.base.capability_scope === "user" ||
    proposal.target_set.some((target) => target.target.scope === "user");
  const required =
    proposal.action.type === "conversation.publish_suspected_literal"
      ? "public-literal"
      : input.authority.actor.credential_class === "automation-grant"
        ? "automation-grant"
        : userScope
          ? "fresh-user-scope"
          : "normal-confirm";
  if (input.challenge_class !== required) throw new Error(`approval requires ${required}`);
  if (required !== "fresh-user-scope" && required !== "public-literal") return;
  if (!input.challenge_id) throw new Error("consumed approval challenge ID is required");
  const frame = files.readChallenge(input.challenge_id).at(-1);
  const valid =
    frame?.state === "consumed" &&
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
  const revision = new Set([
    "conversation.add_participant",
    "conversation.remove_participant",
    "conversation.update_participant",
    "conversation.update_settings",
    "conversation.abandon_revision_operation",
    "conversation.retry_revision_operation",
    "conversation.reconcile_revision_operation",
  ]).has(proposal.action.type);
  const required =
    proposal.domain === "capability" || revision || proposal.action.type === "authority.repair";
  if (required !== (header !== null))
    throw new Error("dispatch domain header nullability mismatch");
}

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
  if (authority.schema_version !== "1.0") throw new Error("invalid authenticated action authority");
  for (const field of [
    "principal_digest",
    "authority_scope_digest",
    "control_session_digest",
    "csrf_epoch_digest",
  ] as const)
    assertDigest(authority[field], `$.authority.${field}`);
  assertActor(authority.actor, "$.authority.actor");
  const credential = authority.actor.credential_class;
  if (authority.actor.kind === "human-browser" && credential !== "loopback-session")
    throw new Error("browser actor requires loopback session credential");
  if (
    authority.actor.kind === "agent" &&
    !["loopback-session", "automation-grant"].includes(credential)
  )
    throw new Error("agent request credential is not admitted");
  if (authority.actor.kind === "system-recovery" && credential !== "recovery")
    throw new Error("system recovery requires recovery credential");
}
