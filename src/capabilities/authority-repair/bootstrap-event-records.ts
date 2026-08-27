import { assertDigest, assertTimestamp } from "../../actions/record-primitives.js";
import { exactObject } from "../../actions/strict-json.js";
import { digestV1 } from "../../durability/index.js";
import {
  AUTHORITY_REPAIR_DIGEST_DOMAIN,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_TERMINAL_STATE,
  RECOVERY_BOOTSTRAP_PAYLOAD_KIND,
} from "./contract.js";
import { assertRecoveryBootstrapIdentity } from "./records.js";
import type { RecoveryBootstrapEventV1, RecoveryBootstrapIdentityV1 } from "./types.js";

function fail(message: string): never {
  throw new Error(`invalid authority repair record: ${message}`);
}

export function materializeRecoveryBootstrapEvent(
  identity: RecoveryBootstrapIdentityV1,
  input: Omit<
    RecoveryBootstrapEventV1,
    "schema_version" | "bootstrap_identity_digest" | "event_digest"
  >,
): RecoveryBootstrapEventV1 {
  assertRecoveryBootstrapIdentity(identity);
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    bootstrap_identity_digest: identity.content_digest,
    ...input,
  };
  const event = {
    ...preimage,
    event_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.BOOTSTRAP_EVENT, preimage),
  };
  assertRecoveryBootstrapEvent(event);
  return event;
}

export function assertRecoveryBootstrapEvent(value: RecoveryBootstrapEventV1): void {
  exactObject(
    value,
    [
      "schema_version",
      "bootstrap_identity_digest",
      "sequence",
      "previous_event_digest",
      "payload",
      "recorded_at",
      "event_digest",
    ],
    [],
    "$.bootstrap_event",
  );
  assertDigest(value.bootstrap_identity_digest, "$.bootstrap_event.bootstrap_identity_digest");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0)
    fail("bootstrap event sequence is invalid");
  if (value.previous_event_digest !== null)
    assertDigest(value.previous_event_digest, "$.bootstrap_event.previous_event_digest");
  assertTimestamp(value.recorded_at, "$.bootstrap_event.recorded_at");
  const payload = exactObject(
    value.payload,
    ["kind"],
    [
      "proposal",
      "repair_plan_digest",
      "proposal_id",
      "from",
      "to",
      "approval",
      "operation",
      "repair_id",
      "operation_id",
      "header_digest",
      "outcome",
      "authority_repair_event_digest",
      "previous_mirrored_event_digest",
    ],
  );
  if (
    !Object.values(RECOVERY_BOOTSTRAP_PAYLOAD_KIND).some((candidate) => candidate === payload.kind)
  )
    fail("bootstrap payload kind is invalid");
  if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.PROPOSAL_CREATED) {
    exactObject(
      payload,
      ["kind", "proposal", "repair_plan_digest"],
      [],
      "$.bootstrap_event.payload",
    );
    assertDigest(payload.repair_plan_digest, "$.bootstrap_event.payload.repair_plan_digest");
  } else if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.APPROVAL_DECISION) {
    exactObject(
      payload,
      ["kind", "proposal_id", "from", "to", "approval"],
      [],
      "$.bootstrap_event.payload",
    );
    if (payload.from !== "pending_review" || (payload.to !== "approved" && payload.to !== "denied"))
      fail("bootstrap approval transition is invalid");
  } else if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.REPAIR_DISPATCH) {
    exactObject(payload, ["kind", "proposal_id", "operation"], [], "$.bootstrap_event.payload");
  } else if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.TERMINAL_MIRROR) {
    exactObject(
      payload,
      [
        "kind",
        "proposal_id",
        "repair_id",
        "operation_id",
        "header_digest",
        "outcome",
        "authority_repair_event_digest",
        "previous_mirrored_event_digest",
      ],
      [],
      "$.bootstrap_event.payload",
    );
    assertDigest(payload.header_digest, "$.bootstrap_event.payload.header_digest");
    assertDigest(
      payload.authority_repair_event_digest,
      "$.bootstrap_event.payload.authority_repair_event_digest",
    );
    if (payload.previous_mirrored_event_digest !== null)
      assertDigest(
        payload.previous_mirrored_event_digest,
        "$.bootstrap_event.payload.previous_mirrored_event_digest",
      );
    if (!Object.values(AUTHORITY_REPAIR_TERMINAL_STATE).some((state) => state === payload.outcome))
      fail("bootstrap terminal mirror outcome is invalid");
  }
  const { event_digest: observed, ...preimage } = value;
  if (observed !== digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.BOOTSTRAP_EVENT, preimage))
    fail("bootstrap event digest mismatch");
}
