import {
  type AuthorityRepairDomainV1,
  ACTION_AUTHORITY_REPAIR_DOMAIN as D,
} from "../../actions/internal-action-vocabulary-contract.js";

export const AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE = Object.freeze({
  REGISTERED: "registered",
  FAIL_CLOSED_NO_RESTORE_SOURCE: "fail-closed-no-restore-source",
  FAIL_CLOSED_PROTOCOL_INCOMPLETE: "fail-closed-protocol-incomplete",
} as const);

type SupportStateV1 =
  (typeof AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE)[keyof typeof AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE];

export interface AuthorityRepairBackendSupportV1 {
  state: SupportStateV1;
  repairable: boolean;
  reason: string;
}

const absent = (reason: string): AuthorityRepairBackendSupportV1 =>
  Object.freeze({
    state: AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE.FAIL_CLOSED_NO_RESTORE_SOURCE,
    repairable: false,
    reason,
  });

const incomplete = (reason: string): AuthorityRepairBackendSupportV1 =>
  Object.freeze({
    state: AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE.FAIL_CLOSED_PROTOCOL_INCOMPLETE,
    repairable: false,
    reason,
  });

/** Publicly inspectable capability matrix. Only registered rows can emit candidates. */
export const AUTHORITY_REPAIR_BACKEND_SUPPORT = Object.freeze({
  [D.CONVERSATION_MANIFEST]: absent("no immutable duplicate of the mutable manifest"),
  [D.CONVERSATION_JOURNAL]: incomplete("journal-generation overlay is not implemented"),
  [D.CONVERSATION_CONTENT]: absent("content-addressed bytes have no retained duplicate"),
  [D.LINEAGE_HEAD]: incomplete("checkpoint exists; action-transition proof is not integrated"),
  [D.LINEAGE_RESERVATION]: incomplete(
    "checkpoint exists; reservation-transition proof is not integrated",
  ),
  [D.LINEAGE_ASSOCIATION]: absent("immutable association has no retained duplicate"),
  [D.REVISION_OPERATION]: incomplete("operation journal-generation overlay is not implemented"),
  [D.ACTION_AUTHORITY]: incomplete("action journal-generation overlay is not implemented"),
  [D.CAPABILITY_LOCK]: Object.freeze({
    state: AUTHORITY_REPAIR_BACKEND_SUPPORT_STATE.REGISTERED,
    repairable: true,
    reason: "completed lock publication retains a validated immutable history generation",
  }),
  [D.CAPABILITY_OPERATION]: incomplete("operation journal-generation overlay is not implemented"),
  [D.CAPABILITY_OUTBOX]: absent("outbox payload store has no validated restore-source adapter"),
  [D.SCOPE_IDENTITY]: absent("identity digest cannot reconstruct the original identity bytes"),
  [D.AUTHORITY_EPOCH]: incomplete("compound head and event-generation repair is not integrated"),
  [D.GRANT_AUTHORITY]: incomplete("grant journal-generation overlay is not implemented"),
  [D.POLICY_AUTHORITY]: incomplete("policy journal-generation overlay is not implemented"),
  [D.REGISTRY_TRUST]: incomplete("trust journal-generation overlay is not implemented"),
  [D.SECRET_REVOCATION]: incomplete("revocation journal-generation overlay is not implemented"),
  [D.AUTHORITY_REPAIR]: incomplete("repair journal-generation overlay is not implemented"),
} as const satisfies Readonly<Record<AuthorityRepairDomainV1, AuthorityRepairBackendSupportV1>>);
