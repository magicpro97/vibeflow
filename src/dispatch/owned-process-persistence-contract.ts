/** Dependency-free persisted vocabulary for owned CLI runtime records and release proofs. */
export const OWNED_PROCESS_RECORD_FIELD = Object.freeze({
  SCHEMA_VERSION: "schema_version",
  ATTEMPT_ID: "attempt_id",
  ENGINE: "engine",
  HOST: "host",
  PLATFORM: "platform",
  STRATEGY: "strategy",
  QUIESCENCE_SCOPE: "quiescence_scope",
  PROOF_STRENGTH: "proof_strength",
  OWNER_PID: "owner_pid",
  OWNER_IDENTITY: "owner_identity",
  SUPERVISOR_PID: "supervisor_pid",
  SUPERVISOR_IDENTITY: "supervisor_identity",
  CLI_PID: "cli_pid",
  CLI_IDENTITY: "cli_identity",
  TERMINAL_KIND: "terminal_kind",
  STATE: "state",
  RELEASE_REASON: "release_reason",
  EXIT_CODE: "exit_code",
  PROCESS_QUIESCENT: "process_quiescent",
  PRIOR_RECORD_DIGEST: "prior_record_digest",
  RECORDED_AT: "recorded_at",
  UPDATED_AT: "updated_at",
  RECORD_DIGEST: "record_digest",
} as const);

export type OwnedProcessRecordField =
  (typeof OWNED_PROCESS_RECORD_FIELD)[keyof typeof OWNED_PROCESS_RECORD_FIELD];

export const OWNED_PROCESS_RECORD_FIELDS = Object.freeze(
  Object.values(OWNED_PROCESS_RECORD_FIELD),
) as readonly OwnedProcessRecordField[];

export const OWNED_PROCESS_LEGACY_OPTIONAL_RECORD_FIELDS = Object.freeze([
  OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE,
  OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH,
  OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST,
] as const);

const OWNED_PROCESS_RECORD_FIELD_SET = new Set<string>(OWNED_PROCESS_RECORD_FIELDS);
const OWNED_PROCESS_LEGACY_OPTIONAL_RECORD_FIELD_SET = new Set<string>(
  OWNED_PROCESS_LEGACY_OPTIONAL_RECORD_FIELDS,
);

export function hasExactOwnedProcessRecordFields(row: Record<string, unknown>): boolean {
  return (
    Object.keys(row).every((field) => OWNED_PROCESS_RECORD_FIELD_SET.has(field)) &&
    OWNED_PROCESS_RECORD_FIELDS.every(
      (field) =>
        OWNED_PROCESS_LEGACY_OPTIONAL_RECORD_FIELD_SET.has(field) || Object.hasOwn(row, field),
    )
  );
}

export const OWNED_PROCESS_RELEASE_PROOF_FIELD = Object.freeze({
  PROCESS_QUIESCENT: "process_quiescent",
  STRATEGY: "strategy",
  QUIESCENCE_SCOPE: "quiescence_scope",
  PROOF_STRENGTH: "proof_strength",
  RUNTIME_RECORD_DIGEST: "runtime_record_digest",
  RELEASED_RECORD_DIGEST: "released_record_digest",
  RELEASE_VERIFIER: "release_verifier",
  TERMINAL_KIND: "terminal_kind",
  EXIT_CODE: "exit_code",
  RELEASED_AT: "released_at",
} as const);

export type OwnedProcessReleaseProofField =
  (typeof OWNED_PROCESS_RELEASE_PROOF_FIELD)[keyof typeof OWNED_PROCESS_RELEASE_PROOF_FIELD];

export const OWNED_PROCESS_RELEASE_PROOF_FIELDS = Object.freeze(
  Object.values(OWNED_PROCESS_RELEASE_PROOF_FIELD),
) as readonly OwnedProcessReleaseProofField[];

export const OWNED_PROCESS_DIGEST_DOMAIN = Object.freeze({
  RECORD_STORAGE_KEY: "VF-OWNED-CLI-RUNTIME-KEY\0v1\0",
  RECORD: "VF-OWNED-CLI-RUNTIME\0v1\0",
  RELEASE_PROOF: "VF-OWNED-CLI-RELEASE-PROOF\0v1\0",
} as const);

export const OWNED_PROCESS_DIGEST_PREFIX = "sha256:" as const;

export const OWNED_PROCESS_STORAGE_NAME = Object.freeze({
  RECORD_DIRECTORY: "process-runtime",
  WRITER_LOCK_FILE: "writer.lock",
  RECORD_FILE_EXTENSION: ".json",
  BIND_ACK_PREFIX: "bind-",
  RECEIPT_PREFIX: "receipt-",
  STATUS_PREFIX: "status-",
  LOCK_OPERATION_PREFIX: "owned-process:",
} as const);

const OWNED_PROCESS_STORAGE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function ownedProcessJsonFileName(stem: string): string {
  return `${stem}${OWNED_PROCESS_STORAGE_NAME.RECORD_FILE_EXTENSION}`;
}

export function isOwnedProcessRecordFileName(entry: string): boolean {
  const extension = OWNED_PROCESS_STORAGE_NAME.RECORD_FILE_EXTENSION;
  return (
    entry.endsWith(extension) &&
    OWNED_PROCESS_STORAGE_KEY_PATTERN.test(entry.slice(0, -extension.length))
  );
}

export function ownedProcessRuntimeFileNames(nonce: string) {
  return Object.freeze({
    bindAck: ownedProcessJsonFileName(`${OWNED_PROCESS_STORAGE_NAME.BIND_ACK_PREFIX}${nonce}`),
    receipt: ownedProcessJsonFileName(`${OWNED_PROCESS_STORAGE_NAME.RECEIPT_PREFIX}${nonce}`),
    status: ownedProcessJsonFileName(`${OWNED_PROCESS_STORAGE_NAME.STATUS_PREFIX}${nonce}`),
  });
}
