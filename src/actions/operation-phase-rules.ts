import type { PublicOperationProgressV1 } from "./public-types.js";
import type { ActionAuthoritySnapshotV1, ActionOperationState } from "./types.js";

const FIXED_PHASES = new Set([
  "dispatch",
  "operation-started",
  "target-applied",
  "target-omitted",
  "target-reversed",
  "target-degraded",
  "target-failed",
  "target-blocked",
  "target-needs-recovery",
  "operation-succeeded",
  "operation-failed",
  "operation-needs-recovery",
  "lineage-head:committed",
  "lineage-association:committed",
  "context-compaction:committed",
  "public-literal:published",
]);
const PREFIX_PHASES: Record<string, Set<string>> = {
  revision: new Set([
    "preparing",
    "prepared",
    "published",
    "starting",
    "started",
    "abandoned",
    "start_failed",
    "needs_recovery",
  ]),
  "participant-start": new Set([
    "prepared",
    "effect_in_progress",
    "observed",
    "accepted",
    "cancel_in_progress",
    "canceled",
    "failed",
    "uncertain",
  ]),
  "authority-change": new Set([
    "prepared",
    "effect_in_progress",
    "observed",
    "epoch-committed",
    "failed",
    "needs-recovery",
  ]),
  "authority-repair": new Set([
    "prepared",
    "preimage_fsynced",
    "restore_in_progress",
    "restored",
    "verified",
    "failed",
    "needs_recovery",
  ]),
  "conversation-receipt": new Set(["succeeded", "failed", "needs_recovery"]),
};

const REVISION_ACTIONS = new Set([
  "conversation.add_participant",
  "conversation.remove_participant",
  "conversation.update_participant",
  "conversation.update_settings",
  "conversation.abandon_revision_operation",
  "conversation.retry_revision_operation",
  "conversation.reconcile_revision_operation",
]);
const RECEIPT_ACTIONS = new Set([
  "conversation.select_lineage_head",
  "conversation.associate_lineages",
  "conversation.publish_suspected_literal",
  "conversation.stop_operation",
  "context.compact",
]);
const AUTHORITY_ACTIONS = new Set([
  "grant.create",
  "grant.renew",
  "grant.revoke",
  "policy.update_authority",
  "secret.revoke",
  "registry.trust_key",
]);

const FIXED_STATUS: Record<string, PublicOperationProgressV1["status"]> = {
  dispatch: "running",
  "operation-started": "running",
  "target-applied": "succeeded",
  "target-omitted": "reversed",
  "target-reversed": "reversed",
  "target-degraded": "failed",
  "target-failed": "failed",
  "target-blocked": "failed",
  "target-needs-recovery": "failed",
  "operation-succeeded": "succeeded",
  "operation-failed": "failed",
  "operation-needs-recovery": "failed",
  "participant-start:prepared": "pending",
  "participant-start:effect_in_progress": "running",
  "participant-start:observed": "running",
  "participant-start:cancel_in_progress": "running",
  "participant-start:accepted": "succeeded",
  "participant-start:failed": "failed",
  "participant-start:canceled": "reversed",
  "participant-start:uncertain": "failed",
  "authority-change:prepared": "pending",
  "authority-change:effect_in_progress": "running",
  "authority-change:observed": "succeeded",
  "authority-change:epoch-committed": "succeeded",
  "authority-change:failed": "failed",
  "authority-change:needs-recovery": "failed",
  "authority-repair:prepared": "pending",
  "authority-repair:preimage_fsynced": "succeeded",
  "authority-repair:restore_in_progress": "running",
  "authority-repair:restored": "succeeded",
  "authority-repair:verified": "succeeded",
  "authority-repair:failed": "failed",
  "authority-repair:needs_recovery": "failed",
  "conversation-receipt:succeeded": "succeeded",
  "conversation-receipt:failed": "failed",
  "conversation-receipt:needs_recovery": "failed",
  "lineage-head:committed": "succeeded",
  "lineage-association:committed": "succeeded",
  "context-compaction:committed": "succeeded",
  "public-literal:published": "succeeded",
  "revision:preparing": "running",
  "revision:starting": "running",
  "revision:prepared": "succeeded",
  "revision:published": "succeeded",
};

export function isOperationPhase(value: unknown): value is PublicOperationProgressV1["phase"] {
  if (typeof value !== "string") return false;
  if (FIXED_PHASES.has(value)) return true;
  const separator = value.indexOf(":");
  if (separator < 1) return false;
  return PREFIX_PHASES[value.slice(0, separator)]?.has(value.slice(separator + 1)) ?? false;
}

export function expectedOperationStatus(
  phase: PublicOperationProgressV1["phase"],
  state: ActionOperationState,
): PublicOperationProgressV1["status"] {
  const fixed = FIXED_STATUS[phase];
  if (fixed) return fixed;
  if (/^revision:(?:started|start_failed|needs_recovery|abandoned)$/.test(phase)) {
    if (state === "succeeded") return "succeeded";
    if (state === "failed" || state === "needs_recovery") return "failed";
  }
  throw new Error("operation phase has no exact progress-status mapping");
}

export function terminalStateForPhase(
  phase: PublicOperationProgressV1["phase"],
): "succeeded" | "failed" | "needs_recovery" | null {
  if (
    /^(?:operation-succeeded|lineage-head:committed|lineage-association:committed|context-compaction:committed|public-literal:published|conversation-receipt:succeeded|authority-change:epoch-committed|authority-repair:verified)$/.test(
      phase,
    )
  )
    return "succeeded";
  if (
    /^(?:operation-failed|conversation-receipt:failed|authority-change:failed|authority-repair:failed)$/.test(
      phase,
    )
  )
    return "failed";
  if (
    /^(?:operation-needs-recovery|conversation-receipt:needs_recovery|authority-change:needs-recovery|authority-repair:needs_recovery)$/.test(
      phase,
    )
  )
    return "needs_recovery";
  return null;
}

export function assertPhaseOwner(
  snapshot: ActionAuthoritySnapshotV1,
  phase: PublicOperationProgressV1["phase"],
  index: number,
): void {
  const action = snapshot.proposal.action.type;
  const capability = action.startsWith("capability.");
  if (index === 0) {
    const expected = capability ? "operation-started" : "dispatch";
    if (snapshot.proposal.action_root_locator.kind === "capability" && capability)
      throw new Error("standalone capability WAL has no public phase");
    if (phase !== expected) throw new Error("operation phase zero does not match its action owner");
    return;
  }
  const valid = capability
    ? phase.startsWith("target-") || phase.startsWith("operation-")
    : REVISION_ACTIONS.has(action)
      ? phase.startsWith("revision:") || phase.startsWith("participant-start:")
      : RECEIPT_ACTIONS.has(action)
        ? receiptPhaseMatches(action, phase)
        : AUTHORITY_ACTIONS.has(action)
          ? phase.startsWith("authority-change:")
          : action === "authority.repair"
            ? phase.startsWith("authority-repair:")
            : false;
  if (!valid) throw new Error("operation phase does not match its action owner");
}

function receiptPhaseMatches(action: string, phase: string): boolean {
  if (phase === "conversation-receipt:failed" || phase === "conversation-receipt:needs_recovery")
    return true;
  const success: Record<string, string> = {
    "conversation.select_lineage_head": "lineage-head:committed",
    "conversation.associate_lineages": "lineage-association:committed",
    "conversation.publish_suspected_literal": "public-literal:published",
    "conversation.stop_operation": "conversation-receipt:succeeded",
    "context.compact": "context-compaction:committed",
  };
  return phase === success[action];
}
