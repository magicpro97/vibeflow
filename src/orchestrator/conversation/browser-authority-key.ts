import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  createOrVerifyPrivateFile,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";

const KEY_BYTES = 32;

/** Loads or creates the one stable private key used by browser cursors and challenges. */
export function conversationBrowserAuthorityKey(root: string): Buffer {
  const directory = ensurePrivateDirectory(join(resolve(root), "browser", "v1"));
  const path = join(directory, "authority.key");
  const lock = acquireProcessLock(join(directory, "authority-key.writer.lock"), {
    operation: "conversation-browser-authority-key",
  });
  try {
    const existing = privateFileBytes(path, KEY_BYTES);
    if (existing !== null) {
      if (existing.byteLength !== KEY_BYTES) throw new Error("invalid browser authority key");
      return Buffer.from(existing);
    }
    const created = randomBytes(KEY_BYTES);
    createOrVerifyPrivateFile(path, created, { lock, maxBytes: KEY_BYTES });
    return created;
  } finally {
    lock.release();
  }
}

export function deriveConversationBrowserKey(rootKey: Uint8Array, purpose: string): Buffer {
  if (rootKey.byteLength !== KEY_BYTES || !/^[a-z][a-z0-9-]{0,63}$/.test(purpose))
    throw new Error("invalid browser authority key derivation");
  return createHash("sha256")
    .update("VF-CONVERSATION-BROWSER-KEY\0v1\0", "utf8")
    .update(purpose, "utf8")
    .update(rootKey)
    .digest();
}
