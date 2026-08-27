import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  acquireProcessLock,
  createOrVerifyPrivateFile,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";

const AUTHORITY_CHALLENGE_KEY_BYTES = 32;

export function capabilityAuthorityApprovalChallengeKey(privateRoot: string): Buffer {
  const directory = ensurePrivateDirectory(join(privateRoot, "actions", "v1"));
  const path = join(directory, "approval-challenge.key");
  const lock = acquireProcessLock(join(directory, "approval-challenge-key.writer.lock"), {
    operation: "capability-authority-approval-challenge-key",
    coverageRoot: privateRoot,
  });
  try {
    const existing = privateFileBytes(path, AUTHORITY_CHALLENGE_KEY_BYTES);
    if (existing !== null) {
      if (existing.byteLength !== AUTHORITY_CHALLENGE_KEY_BYTES)
        throw new Error("invalid capability authority approval challenge key");
      return Buffer.from(existing);
    }
    const created = randomBytes(AUTHORITY_CHALLENGE_KEY_BYTES);
    createOrVerifyPrivateFile(path, created, {
      lock,
      maxBytes: AUTHORITY_CHALLENGE_KEY_BYTES,
    });
    return created;
  } finally {
    lock.release();
  }
}
