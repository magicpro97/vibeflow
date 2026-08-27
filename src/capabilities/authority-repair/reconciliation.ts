import type { AuthorityRepairReasonCodeV1 } from "./contract.js";
import { AUTHORITY_REPAIR_REASON_CODE } from "./contract.js";

export const AUTHORITY_REPAIR_RECONCILIATION_DISPOSITION = Object.freeze({
  FAILED: "failed",
  NEEDS_RECOVERY: "needs_recovery",
  PREIMAGE_FSYNCED: "append-preimage_fsynced",
  RESTORE_IN_PROGRESS: "append-restore_in_progress",
  RETRY_TARGET_CAS: "retry-target-cas",
  RESTORED: "append-restored",
  RETRY_POINTER_CAS: "retry-pointer-cas",
  PREPARE_COMPOUND: "resume-compound-prepare-through-pointer-cas",
  RETRY_COMPOUND_HEAD_CAS: "retry-compound-head-cas",
  APPEND_AUTHORITY_EVENT: "append-authority-event-and-reobserve",
  COMMIT_AUTHORITY_HEAD: "commit-authority-head-and-reobserve",
  VERIFIED: "append-verified",
} as const);
export type AuthorityRepairReconciliationDispositionV1 =
  (typeof AUTHORITY_REPAIR_RECONCILIATION_DISPOSITION)[keyof typeof AUTHORITY_REPAIR_RECONCILIATION_DISPOSITION];

const D = AUTHORITY_REPAIR_RECONCILIATION_DISPOSITION;
const R = AUTHORITY_REPAIR_REASON_CODE;

export const AUTHORITY_REPAIR_RECONCILIATION_PREDICATE = Object.freeze({
  PREPARED_INVALID_CHECKPOINT_UNTOUCHED: "prepared-invalid-checkpoint-untouched",
  PREPARED_INVALID_CHECKPOINT_AFTER_EVIDENCE: "prepared-invalid-checkpoint-after-evidence",
  PREPARED_PREIMAGE_CHANGED: "prepared-preimage-changed",
  PREPARED_QUARANTINE_CLEAN_FAILURE: "prepared-quarantine-clean-failure",
  PREPARED_QUARANTINE_PARTIAL: "prepared-quarantine-partial",
  PREPARED_ABSENCE_MARKER_INVALID: "prepared-absence-marker-invalid",
  PREPARED_INPUTS_EXACT: "prepared-inputs-exact",
  LATER_QUARANTINE_INVALID: "later-quarantine-invalid",
  LATER_ABSENCE_MARKER_INVALID: "later-absence-marker-invalid",
  LATER_CHECKPOINT_INVALID: "later-checkpoint-invalid",
  PREIMAGE_FSYNCED_TARGET_CHANGED: "preimage-fsynced-target-changed",
  PREIMAGE_FSYNCED_CLEAN_WRITE_FAILURE: "preimage-fsynced-clean-write-failure",
  PREIMAGE_FSYNCED_PARTIAL_WRITE: "preimage-fsynced-partial-write",
  PREIMAGE_FSYNCED_REPLACEMENT_READY: "preimage-fsynced-replacement-ready",
  TARGET_OLD_REPLACEMENT_READY: "target-old-replacement-ready",
  TARGET_EXACT_RESTORED: "target-exact-restored",
  TARGET_HASH_SCHEMA_MISMATCH: "target-hash-schema-mismatch",
  TARGET_THIRD_STATE: "target-third-state",
  JOURNAL_OLD_REPLACEMENT_READY: "journal-old-replacement-ready",
  JOURNAL_EXACT_RESTORED: "journal-exact-restored",
  JOURNAL_CLAIM_INVALID: "journal-claim-invalid",
  JOURNAL_THIRD_STATE: "journal-third-state",
  COMPOUND_OLD_ARTIFACTS_READY: "compound-old-artifacts-ready",
  COMPOUND_POINTER_COMMITTED_HEAD_OLD: "compound-pointer-committed-head-old",
  COMPOUND_FINAL_COMMITTED: "compound-final-committed",
  COMPOUND_CLAIM_INVALID: "compound-claim-invalid",
  COMPOUND_THIRD_STATE: "compound-third-state",
  RESTORED_TARGET_DESCENDANT_BASE_JB: "restored-target-descendant-base-jb",
  RESTORED_TARGET_DESCENDANT_BASE_JE: "restored-target-descendant-base-je",
  RESTORED_TARGET_AND_HEAD_DESCENDANTS: "restored-target-and-head-descendants",
  RESTORED_NONCOMPOUND_CLAIM_INVALID: "restored-noncompound-claim-invalid",
  RESTORED_NONCOMPOUND_RESIDUAL: "restored-noncompound-residual",
  RESTORED_COMPOUND_FINAL_VALID: "restored-compound-final-valid",
  RESTORED_COMPOUND_CLAIM_INVALID: "restored-compound-claim-invalid",
  RESTORED_COMPOUND_RESIDUAL: "restored-compound-residual",
  RECONCILIATION_INCONCLUSIVE: "reconciliation-inconclusive",
} as const);
export type AuthorityRepairReconciliationPredicateV1 =
  (typeof AUTHORITY_REPAIR_RECONCILIATION_PREDICATE)[keyof typeof AUTHORITY_REPAIR_RECONCILIATION_PREDICATE];

export interface AuthorityRepairReconciliationRowV1 {
  priority: number;
  predicate: AuthorityRepairReconciliationPredicateV1;
  strategy_class:
    | "all"
    | "present"
    | "absent-json-content"
    | "json-content"
    | "journal"
    | "compound"
    | "noncompound";
  anchor:
    | "prepared"
    | "preimage_fsynced"
    | "restore_in_progress"
    | "restored"
    | "needs_recovery"
    | "any-later";
  disposition: AuthorityRepairReconciliationDispositionV1;
  reason_code: AuthorityRepairReasonCodeV1 | null;
}

const P = AUTHORITY_REPAIR_RECONCILIATION_PREDICATE;
const row = (
  predicate: AuthorityRepairReconciliationPredicateV1,
  strategy_class: AuthorityRepairReconciliationRowV1["strategy_class"],
  anchor: AuthorityRepairReconciliationRowV1["anchor"],
  disposition: AuthorityRepairReconciliationDispositionV1,
  reason_code: AuthorityRepairReasonCodeV1 | null,
) => ({ predicate, strategy_class, anchor, disposition, reason_code });

const ORDERED_ROWS = [
  row(P.PREPARED_INVALID_CHECKPOINT_UNTOUCHED, "all", "prepared", D.FAILED, R.CHECKPOINT_INVALID),
  row(
    P.PREPARED_INVALID_CHECKPOINT_AFTER_EVIDENCE,
    "all",
    "prepared",
    D.NEEDS_RECOVERY,
    R.CHECKPOINT_INVALID,
  ),
  row(P.PREPARED_PREIMAGE_CHANGED, "all", "prepared", D.FAILED, R.PREIMAGE_CHANGED),
  row(
    P.PREPARED_QUARANTINE_CLEAN_FAILURE,
    "present",
    "prepared",
    D.FAILED,
    R.QUARANTINE_WRITE_FAILED,
  ),
  row(
    P.PREPARED_QUARANTINE_PARTIAL,
    "present",
    "prepared",
    D.NEEDS_RECOVERY,
    R.QUARANTINE_WRITE_FAILED,
  ),
  row(
    P.PREPARED_ABSENCE_MARKER_INVALID,
    "absent-json-content",
    "prepared",
    D.NEEDS_RECOVERY,
    R.ABSENCE_EVIDENCE_WRITE_FAILED,
  ),
  row(P.PREPARED_INPUTS_EXACT, "all", "prepared", D.PREIMAGE_FSYNCED, null),
  row(
    P.LATER_QUARANTINE_INVALID,
    "present",
    "any-later",
    D.NEEDS_RECOVERY,
    R.QUARANTINE_WRITE_FAILED,
  ),
  row(
    P.LATER_ABSENCE_MARKER_INVALID,
    "absent-json-content",
    "any-later",
    D.NEEDS_RECOVERY,
    R.ABSENCE_EVIDENCE_WRITE_FAILED,
  ),
  row(P.LATER_CHECKPOINT_INVALID, "all", "any-later", D.NEEDS_RECOVERY, R.CHECKPOINT_INVALID),
  row(
    P.PREIMAGE_FSYNCED_TARGET_CHANGED,
    "all",
    "preimage_fsynced",
    D.NEEDS_RECOVERY,
    R.PREIMAGE_CHANGED,
  ),
  row(
    P.PREIMAGE_FSYNCED_CLEAN_WRITE_FAILURE,
    "all",
    "preimage_fsynced",
    D.FAILED,
    R.RESTORE_WRITE_FAILED,
  ),
  row(
    P.PREIMAGE_FSYNCED_PARTIAL_WRITE,
    "all",
    "preimage_fsynced",
    D.NEEDS_RECOVERY,
    R.RESTORE_WRITE_FAILED,
  ),
  row(P.PREIMAGE_FSYNCED_REPLACEMENT_READY, "all", "preimage_fsynced", D.RESTORE_IN_PROGRESS, null),
  row(
    P.TARGET_OLD_REPLACEMENT_READY,
    "json-content",
    "restore_in_progress",
    D.RETRY_TARGET_CAS,
    null,
  ),
  row(P.TARGET_EXACT_RESTORED, "json-content", "restore_in_progress", D.RESTORED, null),
  row(
    P.TARGET_HASH_SCHEMA_MISMATCH,
    "json-content",
    "restore_in_progress",
    D.NEEDS_RECOVERY,
    R.POST_RESTORE_MISMATCH,
  ),
  row(
    P.TARGET_THIRD_STATE,
    "json-content",
    "restore_in_progress",
    D.NEEDS_RECOVERY,
    R.CURRENT_STATE_AMBIGUOUS,
  ),
  row(P.JOURNAL_OLD_REPLACEMENT_READY, "journal", "restore_in_progress", D.RETRY_POINTER_CAS, null),
  row(P.JOURNAL_EXACT_RESTORED, "journal", "restore_in_progress", D.RESTORED, null),
  row(
    P.JOURNAL_CLAIM_INVALID,
    "journal",
    "restore_in_progress",
    D.NEEDS_RECOVERY,
    R.POST_RESTORE_MISMATCH,
  ),
  row(
    P.JOURNAL_THIRD_STATE,
    "journal",
    "restore_in_progress",
    D.NEEDS_RECOVERY,
    R.CURRENT_STATE_AMBIGUOUS,
  ),
  row(P.COMPOUND_OLD_ARTIFACTS_READY, "compound", "restore_in_progress", D.PREPARE_COMPOUND, null),
  row(
    P.COMPOUND_POINTER_COMMITTED_HEAD_OLD,
    "compound",
    "restore_in_progress",
    D.RETRY_COMPOUND_HEAD_CAS,
    null,
  ),
  row(P.COMPOUND_FINAL_COMMITTED, "compound", "restore_in_progress", D.RESTORED, null),
  row(
    P.COMPOUND_CLAIM_INVALID,
    "compound",
    "restore_in_progress",
    D.NEEDS_RECOVERY,
    R.POST_RESTORE_MISMATCH,
  ),
  row(
    P.COMPOUND_THIRD_STATE,
    "compound",
    "restore_in_progress",
    D.NEEDS_RECOVERY,
    R.CURRENT_STATE_AMBIGUOUS,
  ),
  row(
    P.RESTORED_TARGET_DESCENDANT_BASE_JB,
    "noncompound",
    "restored",
    D.APPEND_AUTHORITY_EVENT,
    null,
  ),
  row(
    P.RESTORED_TARGET_DESCENDANT_BASE_JE,
    "noncompound",
    "restored",
    D.COMMIT_AUTHORITY_HEAD,
    null,
  ),
  row(P.RESTORED_TARGET_AND_HEAD_DESCENDANTS, "noncompound", "restored", D.VERIFIED, null),
  row(
    P.RESTORED_NONCOMPOUND_CLAIM_INVALID,
    "noncompound",
    "restored",
    D.NEEDS_RECOVERY,
    R.POST_RESTORE_MISMATCH,
  ),
  row(
    P.RESTORED_NONCOMPOUND_RESIDUAL,
    "noncompound",
    "restored",
    D.NEEDS_RECOVERY,
    R.CURRENT_STATE_AMBIGUOUS,
  ),
  row(P.RESTORED_COMPOUND_FINAL_VALID, "compound", "restored", D.VERIFIED, null),
  row(
    P.RESTORED_COMPOUND_CLAIM_INVALID,
    "compound",
    "restored",
    D.NEEDS_RECOVERY,
    R.POST_RESTORE_MISMATCH,
  ),
  row(
    P.RESTORED_COMPOUND_RESIDUAL,
    "compound",
    "restored",
    D.NEEDS_RECOVERY,
    R.CURRENT_STATE_AMBIGUOUS,
  ),
  row(
    P.RECONCILIATION_INCONCLUSIVE,
    "all",
    "needs_recovery",
    D.NEEDS_RECOVERY,
    R.RECONCILIATION_INCONCLUSIVE,
  ),
] as const;

export const AUTHORITY_REPAIR_RECONCILIATION_TABLE = Object.freeze(
  ORDERED_ROWS.map((value, priority) => Object.freeze({ priority, ...value })),
) satisfies readonly AuthorityRepairReconciliationRowV1[];

export type AuthorityRepairReconciliationClaimsV1 = Readonly<
  Record<AuthorityRepairReconciliationPredicateV1, boolean>
>;

export interface AuthorityRepairReconciliationContextV1 {
  claims: AuthorityRepairReconciliationClaimsV1;
  strategy: "json-content" | "journal" | "compound";
  preimage: "present" | "absent";
  resume_anchor: "prepared" | "preimage_fsynced" | "restore_in_progress" | "restored";
  reconciling: boolean;
}

function applies(
  row: AuthorityRepairReconciliationRowV1,
  context: AuthorityRepairReconciliationContextV1,
): boolean {
  const strategy =
    row.strategy_class === "all" ||
    (row.strategy_class === "present" && context.preimage === "present") ||
    (row.strategy_class === "absent-json-content" &&
      context.preimage === "absent" &&
      context.strategy === "json-content") ||
    (row.strategy_class === "json-content" && context.strategy === "json-content") ||
    (row.strategy_class === "journal" && context.strategy === "journal") ||
    (row.strategy_class === "compound" && context.strategy === "compound") ||
    (row.strategy_class === "noncompound" && context.strategy !== "compound");
  const anchor =
    row.anchor === context.resume_anchor ||
    (row.anchor === "any-later" && context.resume_anchor !== "prepared") ||
    (row.anchor === "needs_recovery" && context.reconciling);
  return strategy && anchor;
}

/** First-match dispatcher. IO adapters classify facts; they cannot choose a disposition. */
export function dispatchAuthorityRepairReconciliation(
  context: AuthorityRepairReconciliationContextV1,
): AuthorityRepairReconciliationRowV1 {
  const claimed = AUTHORITY_REPAIR_RECONCILIATION_TABLE.filter(
    (candidate) => context.claims[candidate.predicate],
  );
  if (claimed.some((candidate) => !applies(candidate, context)))
    throw new Error(
      "authority repair observation claims a predicate outside its strategy or anchor",
    );
  const match = claimed.find((candidate) => applies(candidate, context));
  if (!match) throw new Error("authority repair observation has no exhaustive reconciliation row");
  return match;
}
