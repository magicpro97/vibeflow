import { exactObject } from "../../actions/strict-json.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import {
  AUTHORITY_REPAIR_DIGEST_DOMAIN,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  RECOVERY_BOOTSTRAP_EMPTY_JOURNAL,
  RECOVERY_BOOTSTRAP_IDENTITY_KIND,
} from "./contract.js";
import { assertRecoveryBootstrapIdentity } from "./records.js";
import type { RecoveryBootstrapActivationReceiptV1, RecoveryBootstrapIdentityV1 } from "./types.js";
import { assertRawSha256 } from "./validation.js";

function fail(message: string): never {
  throw new Error(`invalid authority repair record: ${message}`);
}

export function materializeRecoveryBootstrapActivationReceipt(
  identity: RecoveryBootstrapIdentityV1,
): RecoveryBootstrapActivationReceiptV1 {
  assertRecoveryBootstrapIdentity(identity);
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    identity_kind: RECOVERY_BOOTSTRAP_IDENTITY_KIND,
    scope: null,
    scope_identity_digest: null,
    bootstrap_identity_digest: identity.content_digest,
    initial_authority_head_digest: null,
    initial_journal_byte_length: RECOVERY_BOOTSTRAP_EMPTY_JOURNAL.BYTE_LENGTH,
    initial_journal_sha256: RECOVERY_BOOTSTRAP_EMPTY_JOURNAL.SHA256,
    identity_created_at: identity.created_at,
  } as const;
  return {
    ...preimage,
    receipt_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.ACTIVATION_RECEIPT, preimage),
  };
}

export function assertRecoveryBootstrapActivationReceipt(
  value: RecoveryBootstrapActivationReceiptV1,
  identity: RecoveryBootstrapIdentityV1,
): void {
  exactObject(
    value,
    [
      "schema_version",
      "identity_kind",
      "scope",
      "scope_identity_digest",
      "bootstrap_identity_digest",
      "initial_authority_head_digest",
      "initial_journal_byte_length",
      "initial_journal_sha256",
      "identity_created_at",
      "receipt_digest",
    ],
    [],
    "$.bootstrap_activation",
  );
  assertRawSha256(value.initial_journal_sha256, "initial journal SHA-256");
  if (
    canonicalJson(value) !== canonicalJson(materializeRecoveryBootstrapActivationReceipt(identity))
  )
    fail("bootstrap activation receipt mismatch");
}
