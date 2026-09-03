import { digestV1 } from "../durability/index.js";
import {
  OWNED_PROCESS_DIGEST_DOMAIN,
  OWNED_PROCESS_DIGEST_PREFIX,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_RELEASE_PROOF_FIELD,
  OWNED_PROCESS_RELEASE_PROOF_FIELDS,
  OWNED_PROCESS_STATE,
  isOwnedProcessProofStrength,
  isOwnedProcessQuiescenceScope,
  isOwnedProcessStrategy,
  isOwnedProcessTerminalKind,
} from "./owned-process-contract.js";
import { type OwnedProcessReleaseProof, assertOwnedProcessRecord } from "./owned-process-record.js";

const DIGEST = new RegExp(`^${OWNED_PROCESS_DIGEST_PREFIX}[0-9a-f]{64}$`);
const RELEASE_PROOF_FIELD_SET = new Set<string>(OWNED_PROCESS_RELEASE_PROOF_FIELDS);
const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function releaseProofVerifier(
  value: Omit<OwnedProcessReleaseProof, typeof OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER>,
): string {
  return digestV1(OWNED_PROCESS_DIGEST_DOMAIN.RELEASE_PROOF, value);
}

export function isOwnedProcessReleaseProof(value: unknown): value is OwnedProcessReleaseProof {
  if (!isUnknownRecord(value)) return false;
  const row = value;
  const field = OWNED_PROCESS_RELEASE_PROOF_FIELD;
  const fields = Object.keys(row);
  const strategy = row[field.STRATEGY];
  const quiescenceScope = row[field.QUIESCENCE_SCOPE];
  const proofStrength = row[field.PROOF_STRENGTH];
  const runtimeRecordDigest = row[field.RUNTIME_RECORD_DIGEST];
  const releasedRecordDigest = row[field.RELEASED_RECORD_DIGEST];
  const releaseVerifier = row[field.RELEASE_VERIFIER];
  const terminalKind = row[field.TERMINAL_KIND];
  const exitCode = row[field.EXIT_CODE];
  const releasedAt = row[field.RELEASED_AT];
  return (
    fields.length === OWNED_PROCESS_RELEASE_PROOF_FIELDS.length &&
    fields.every((field) => RELEASE_PROOF_FIELD_SET.has(field)) &&
    row[field.PROCESS_QUIESCENT] === true &&
    isOwnedProcessStrategy(strategy) &&
    isOwnedProcessQuiescenceScope(quiescenceScope) &&
    isOwnedProcessProofStrength(proofStrength) &&
    typeof runtimeRecordDigest === "string" &&
    DIGEST.test(runtimeRecordDigest) &&
    typeof releasedRecordDigest === "string" &&
    DIGEST.test(releasedRecordDigest) &&
    typeof releaseVerifier === "string" &&
    DIGEST.test(releaseVerifier) &&
    (terminalKind === null || isOwnedProcessTerminalKind(terminalKind)) &&
    (exitCode === null || (typeof exitCode === "number" && Number.isSafeInteger(exitCode))) &&
    typeof releasedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(releasedAt)
  );
}

export function createOwnedProcessReleaseProof(
  value: Omit<OwnedProcessReleaseProof, typeof OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER>,
): OwnedProcessReleaseProof {
  return {
    ...value,
    [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER]: releaseProofVerifier(value),
  };
}

export function verifyOwnedProcessReleaseProof(proof: unknown, released: unknown): boolean {
  if (!isOwnedProcessReleaseProof(proof)) return false;
  try {
    assertOwnedProcessRecord(released);
  } catch {
    return false;
  }
  if (
    released[OWNED_PROCESS_RECORD_FIELD.STATE] !== OWNED_PROCESS_STATE.RELEASED ||
    released[OWNED_PROCESS_RECORD_FIELD.PROCESS_QUIESCENT] !== true ||
    released[OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST] !==
      proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.RUNTIME_RECORD_DIGEST] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.QUIESCENCE_SCOPE] ===
      OWNED_PROCESS_QUIESCENCE_SCOPE.LEGACY_UNSCOPED ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.PROOF_STRENGTH] ===
      OWNED_PROCESS_PROOF_STRENGTH.LEGACY_UNQUALIFIED ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.STRATEGY] !==
      released[OWNED_PROCESS_RECORD_FIELD.STRATEGY] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.QUIESCENCE_SCOPE] !==
      released[OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.PROOF_STRENGTH] !==
      released[OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.TERMINAL_KIND] !==
      released[OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.EXIT_CODE] !==
      released[OWNED_PROCESS_RECORD_FIELD.EXIT_CODE] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_AT] !==
      released[OWNED_PROCESS_RECORD_FIELD.UPDATED_AT] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.RUNTIME_RECORD_DIGEST] ===
      released[OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST] ||
    proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASED_RECORD_DIGEST] !==
      released[OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]
  ) {
    return false;
  }
  const { [OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER]: _ignored, ...preimage } = proof;
  return (
    releaseProofVerifier(preimage) === proof[OWNED_PROCESS_RELEASE_PROOF_FIELD.RELEASE_VERIFIER]
  );
}
