import type { VffrDomain } from "./frame-contract.js";

export interface VffrDomainRule {
  readonly sequence: string;
  readonly selfDigest: string;
  readonly previousDigest: string;
  readonly timestamp: readonly string[];
}

function rule(
  sequence: string,
  selfDigest: string,
  previousDigest: string,
  ...timestamp: string[]
): VffrDomainRule {
  return Object.freeze({
    sequence,
    selfDigest,
    previousDigest,
    timestamp: Object.freeze([...timestamp]),
  });
}

const RULES: Readonly<Record<VffrDomain, VffrDomainRule>> = Object.freeze({
  "action-authority": rule("sequence", "event_digest", "previous_event_digest", "recorded_at"),
  "action-idempotency": rule(
    "sequence",
    "binding_digest",
    "previous_frame_digest",
    "visible_at",
    "created_at",
  ),
  "approval-challenge": rule(
    "sequence",
    "frame_digest",
    "previous_frame_digest",
    "consumed_at",
    "issued_at",
  ),
  "revision-operation": rule("sequence", "event_digest", "previous_event_digest", "recorded_at"),
  "capability-operation": rule("sequence", "event_digest", "previous_event_digest", "recorded_at"),
  "authority-epoch": rule(
    "authority_epoch",
    "event_digest",
    "previous_event_digest",
    "recorded_at",
  ),
  "grant-authority": rule("grant_sequence", "frame_digest", "previous_frame_digest", "recorded_at"),
  "policy-authority": rule("sequence", "frame_digest", "previous_frame_digest", "recorded_at"),
  "registry-trust": rule("trust_epoch", "frame_digest", "previous_frame_digest", "recorded_at"),
  "secret-revocation": rule("sequence", "frame_digest", "previous_frame_digest", "revoked_at"),
  "literal-staging": rule("sequence", "frame_digest", "previous_frame_digest", "recorded_at"),
  "private-file-range-staging": rule(
    "sequence",
    "frame_digest",
    "previous_frame_digest",
    "recorded_at",
  ),
  "conversation-action-receipt": rule(
    "sequence",
    "receipt_digest",
    "previous_receipt_digest",
    "recorded_at",
  ),
  "authority-change-terminal": rule(
    "sequence",
    "receipt_digest",
    "previous_receipt_digest",
    "recorded_at",
  ),
  "authority-repair": rule("sequence", "event_digest", "previous_event_digest", "recorded_at"),
  "recovery-bootstrap": rule("sequence", "event_digest", "previous_event_digest", "recorded_at"),
  "catalog-delta": rule("sequence", "event_digest", "previous_event_digest", "recorded_at"),
  "oversized-handoff-issuance": rule(
    "sequence",
    "frame_digest",
    "previous_frame_digest",
    "visible_at",
    "created_at",
  ),
});

/** Internal codec selector. Rules are immutable and are not re-exported by the public barrel. */
export function vffrRuleFor(domain: VffrDomain): VffrDomainRule {
  return RULES[domain];
}
