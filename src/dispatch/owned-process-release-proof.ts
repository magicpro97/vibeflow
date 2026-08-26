import { digestV1 } from "../durability/index.js";
import {
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_STATE,
} from "./owned-process-contract.js";
import type {
  OwnedAttemptProcessRecordV1,
  OwnedProcessReleaseProof,
} from "./owned-process-record.js";

function releaseProofVerifier(value: Omit<OwnedProcessReleaseProof, "release_verifier">): string {
  return digestV1("VF-OWNED-CLI-RELEASE-PROOF\0v1\0", value);
}

export function createOwnedProcessReleaseProof(
  value: Omit<OwnedProcessReleaseProof, "release_verifier">,
): OwnedProcessReleaseProof {
  return { ...value, release_verifier: releaseProofVerifier(value) };
}

export function verifyOwnedProcessReleaseProof(
  proof: OwnedProcessReleaseProof,
  released: OwnedAttemptProcessRecordV1,
): boolean {
  if (
    released.state !== OWNED_PROCESS_STATE.RELEASED ||
    released.process_quiescent !== true ||
    released.prior_record_digest !== proof.runtime_record_digest ||
    proof.process_quiescent !== true ||
    proof.quiescence_scope === OWNED_PROCESS_QUIESCENCE_SCOPE.LEGACY_UNSCOPED ||
    proof.proof_strength === OWNED_PROCESS_PROOF_STRENGTH.LEGACY_UNQUALIFIED ||
    proof.strategy !== released.strategy ||
    proof.quiescence_scope !== released.quiescence_scope ||
    proof.proof_strength !== released.proof_strength ||
    proof.terminal_kind !== released.terminal_kind ||
    proof.exit_code !== released.exit_code ||
    proof.released_at !== released.updated_at ||
    proof.runtime_record_digest === released.record_digest ||
    proof.released_record_digest !== released.record_digest
  ) {
    return false;
  }
  const { release_verifier: _ignored, ...preimage } = proof;
  return releaseProofVerifier(preimage) === proof.release_verifier;
}
