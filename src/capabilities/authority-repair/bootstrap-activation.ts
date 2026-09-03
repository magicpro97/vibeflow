import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import type { ProcessLock } from "../../durability/index.js";
import { withLockedParent } from "../../durability/lock.js";
import { assertPinnedDirectory, renameAt, unlinkAt } from "../../durability/native.js";
import { readPrivateFileAt } from "../../durability/path.js";
import { readRecoveryBootstrapJournalBytes } from "./bootstrap-journal.js";
import { AUTHORITY_REPAIR_LIMIT, RECOVERY_BOOTSTRAP_ID_PREFIX } from "./contract.js";
import { recoveryBootstrapPaths } from "./paths.js";
import {
  assertRecoveryBootstrapActivationReceipt,
  assertRecoveryBootstrapIdentity,
  materializeRecoveryBootstrapActivationReceipt,
  materializeRecoveryBootstrapIdentity,
} from "./records.js";
import type { RecoveryBootstrapActivationReceiptV1, RecoveryBootstrapIdentityV1 } from "./types.js";

export const RECOVERY_BOOTSTRAP_ACTIVATION_FAULT = Object.freeze({
  AFTER_IDENTITY_FSYNC: "after-identity-fsync",
  AFTER_PENDING_FSYNC: "after-pending-fsync",
  AFTER_RECEIPT_FSYNC: "after-receipt-fsync",
  AFTER_JOURNAL_RENAME: "after-journal-rename",
} as const);

export type RecoveryBootstrapActivationFaultPointV1 =
  (typeof RECOVERY_BOOTSTRAP_ACTIVATION_FAULT)[keyof typeof RECOVERY_BOOTSTRAP_ACTIVATION_FAULT];

export interface RecoveryBootstrapActivationV1 {
  identity: RecoveryBootstrapIdentityV1;
  receipt: RecoveryBootstrapActivationReceiptV1;
  disposition: "created" | "resumed" | "existing";
}

export interface RecoveryBootstrapActivationOptionsV1 {
  now?: () => string;
  random_bytes?: (size: number) => Uint8Array;
  fault?: (point: RecoveryBootstrapActivationFaultPointV1) => void;
}

function fail(message: string): never {
  throw new Error(`recovery bootstrap activation failed: ${message}`);
}

function parseCanonical<T>(bytes: Uint8Array | null, label: string): T | null {
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} is corrupt`);
  }
  const canonical = canonicalJsonBytes(value, { maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES });
  if (!Buffer.from(bytes).equals(canonical)) return fail(`${label} is not canonical`);
  return value as T;
}

function journalBytes(path: string): Buffer | null {
  return privateFileBytes(path, AUTHORITY_REPAIR_LIMIT.JOURNAL_BYTES);
}

function assertEmptyPending(bytes: Buffer | null): void {
  if (bytes === null || bytes.byteLength !== 0) fail("bootstrap pending journal is not zero bytes");
}

function removePending(lock: ProcessLock, pendingPath: string): void {
  withLockedParent(lock, pendingPath, false, (directory, name) => {
    const bytes = readPrivateFileAt(directory, name, 1);
    if (bytes === null) return;
    if (bytes.byteLength !== 0) fail("stale pending journal is not byte-identical empty state");
    unlinkAt(directory, name);
    fs.fsyncSync(directory.fd);
    assertPinnedDirectory(directory);
  });
}

function publishPendingJournal(lock: ProcessLock, pendingPath: string, finalPath: string): void {
  withLockedParent(lock, finalPath, false, (directory, finalName) => {
    const pendingName = basename(pendingPath);
    const pending = readPrivateFileAt(directory, pendingName, 1);
    if (pending === null || pending.byteLength !== 0)
      fail("bootstrap pending journal is missing or non-empty");
    const final = readPrivateFileAt(directory, finalName, AUTHORITY_REPAIR_LIMIT.JOURNAL_BYTES);
    if (final !== null) fail("bootstrap final journal appeared before pending rename");
    renameAt(directory, pendingName, finalName);
    fs.fsyncSync(directory.fd);
    assertPinnedDirectory(directory);
  });
}

function dependentStateExists(paths: ReturnType<typeof recoveryBootstrapPaths>): boolean {
  return (
    privateFileBytes(paths.activation, AUTHORITY_REPAIR_LIMIT.JSON_BYTES) !== null ||
    journalBytes(paths.pendingJournal) !== null ||
    journalBytes(paths.journal) !== null ||
    fs.existsSync(paths.actionRoots)
  );
}

/** Trusted install/init activation. Ordinary readers never create or regenerate this identity. */
export function activateRecoveryBootstrapForTrustedInstall(
  userVibeflowRoot: string,
  options: RecoveryBootstrapActivationOptionsV1 = {},
): RecoveryBootstrapActivationV1 {
  const paths = recoveryBootstrapPaths(userVibeflowRoot);
  ensurePrivateDirectory(paths.root);
  ensurePrivateDirectory(paths.versionRoot);
  const lock = acquireProcessLock(paths.writerLock, {
    operation: "recovery-bootstrap-activation",
    coverageRoot: paths.root,
  });
  let writes = 0;
  let created = false;
  try {
    let identityBytes = privateFileBytes(paths.identity, AUTHORITY_REPAIR_LIMIT.JSON_BYTES);
    if (identityBytes === null) {
      if (dependentStateExists(paths)) fail("identity is absent while dependent state exists");
      const entropy = Buffer.from((options.random_bytes ?? randomBytes)(32));
      if (entropy.byteLength !== 32) fail("identity entropy is not 256-bit");
      const identity = materializeRecoveryBootstrapIdentity({
        bootstrap_id: `${RECOVERY_BOOTSTRAP_ID_PREFIX}${entropy.toString("hex")}`,
        created_at: (options.now ?? (() => new Date().toISOString()))(),
      });
      createOrVerifyPrivateFile(paths.identity, canonicalJsonBytes(identity), { lock });
      options.fault?.(RECOVERY_BOOTSTRAP_ACTIVATION_FAULT.AFTER_IDENTITY_FSYNC);
      identityBytes = canonicalJsonBytes(identity);
      created = true;
      writes += 1;
    }
    const identity = parseCanonical<RecoveryBootstrapIdentityV1>(
      identityBytes,
      "bootstrap identity",
    );
    if (!identity) return fail("bootstrap identity is absent after publication");
    assertRecoveryBootstrapIdentity(identity);

    let receiptBytes = privateFileBytes(paths.activation, AUTHORITY_REPAIR_LIMIT.JSON_BYTES);
    let receipt = parseCanonical<RecoveryBootstrapActivationReceiptV1>(
      receiptBytes,
      "bootstrap activation receipt",
    );
    if (receipt) assertRecoveryBootstrapActivationReceipt(receipt, identity);
    let pending = journalBytes(paths.pendingJournal);
    let journal = journalBytes(paths.journal);

    if (journal !== null) readRecoveryBootstrapJournalBytes(identity, journal);
    if (pending !== null) assertEmptyPending(pending);
    if (receipt && journal === null && pending === null)
      return fail("receipt exists without final or pending journal");

    if (!receipt && journal !== null) {
      receipt = materializeRecoveryBootstrapActivationReceipt(identity);
      receiptBytes = canonicalJsonBytes(receipt);
      createOrVerifyPrivateFile(paths.activation, receiptBytes, { lock });
      options.fault?.(RECOVERY_BOOTSTRAP_ACTIVATION_FAULT.AFTER_RECEIPT_FSYNC);
      writes += 1;
    }

    if (journal === null && pending === null) {
      createOrVerifyPrivateFile(paths.pendingJournal, Buffer.alloc(0), { lock, maxBytes: 1 });
      options.fault?.(RECOVERY_BOOTSTRAP_ACTIVATION_FAULT.AFTER_PENDING_FSYNC);
      pending = Buffer.alloc(0);
      writes += 1;
    }

    if (!receipt) {
      receipt = materializeRecoveryBootstrapActivationReceipt(identity);
      createOrVerifyPrivateFile(paths.activation, canonicalJsonBytes(receipt), { lock });
      options.fault?.(RECOVERY_BOOTSTRAP_ACTIVATION_FAULT.AFTER_RECEIPT_FSYNC);
      writes += 1;
    }

    if (journal === null) {
      assertEmptyPending(pending);
      publishPendingJournal(lock, paths.pendingJournal, paths.journal);
      options.fault?.(RECOVERY_BOOTSTRAP_ACTIVATION_FAULT.AFTER_JOURNAL_RENAME);
      journal = Buffer.alloc(0);
      pending = null;
      writes += 1;
    } else if (pending !== null) {
      removePending(lock, paths.pendingJournal);
      pending = null;
      writes += 1;
    }

    readRecoveryBootstrapJournalBytes(identity, journal);
    assertRecoveryBootstrapActivationReceipt(receipt, identity);
    return Object.freeze({
      identity: Object.freeze(structuredClone(identity)),
      receipt: Object.freeze(structuredClone(receipt)),
      disposition: created ? "created" : writes > 0 ? "resumed" : "existing",
    });
  } finally {
    lock.release();
  }
}

/** Read-only validator used by repair execution; it never activates missing state. */
export function readActivatedRecoveryBootstrap(
  userVibeflowRoot: string,
): RecoveryBootstrapActivationV1 {
  const paths = recoveryBootstrapPaths(userVibeflowRoot);
  const identity = parseCanonical<RecoveryBootstrapIdentityV1>(
    privateFileBytes(paths.identity, AUTHORITY_REPAIR_LIMIT.JSON_BYTES),
    "bootstrap identity",
  );
  if (!identity) return fail("bootstrap identity is missing");
  assertRecoveryBootstrapIdentity(identity);
  const receipt = parseCanonical<RecoveryBootstrapActivationReceiptV1>(
    privateFileBytes(paths.activation, AUTHORITY_REPAIR_LIMIT.JSON_BYTES),
    "bootstrap activation receipt",
  );
  if (!receipt) return fail("bootstrap activation receipt is missing");
  assertRecoveryBootstrapActivationReceipt(receipt, identity);
  if (journalBytes(paths.pendingJournal) !== null)
    return fail("bootstrap journal has unresolved pending activation state");
  const journal = journalBytes(paths.journal);
  if (journal === null) return fail("bootstrap journal is missing");
  readRecoveryBootstrapJournalBytes(identity, journal);
  return Object.freeze({
    identity: Object.freeze(structuredClone(identity)),
    receipt: Object.freeze(structuredClone(receipt)),
    disposition: "existing",
  });
}
