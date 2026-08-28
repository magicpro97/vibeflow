import { basename, dirname, join } from "node:path";
import { canonicalJsonBytes } from "../durability/canonical.js";
import { cleanupThenThrow, withCleanup } from "../durability/cleanup.js";
import { durabilityError } from "../durability/errors.js";
import {
  type ProcessLockOwnerV1,
  boundedOwnerAscii,
  parseProcessLockOwner,
} from "../durability/lock-owner.js";
import {
  OWNED_PROCESS_STORAGE_NAME,
  isOwnedProcessRecordFileName,
} from "./owned-process-persistence-contract.js";
import type { WindowsKernelLock } from "./owned-process-record-windows-native.js";
import {
  type WindowsDirectoryIdentity,
  type WindowsRecordRuntime,
  assertWindowsDirectory,
  createWindowsRecordRuntime,
  ensureWindowsRecordDirectory,
  exactWindowsBytes,
  readWindowsRecordPath,
  resolveWindowsRecordPath,
  safeWindowsRecordLeaf,
  windowsDirectoryIdentity,
  windowsRecordLimit,
  writeWindowsRecordFile,
} from "./owned-process-record-windows-storage.js";

export type { WindowsRecordRuntime } from "./owned-process-record-windows-storage.js";

export const WINDOWS_RECORD_STORAGE = Object.freeze({
  OWNER_SUFFIX: ".owner.json",
  RELEASE_MARKER: ".release-",
  CAS_STAGE_PREFIX: ".vf-owned-cas-",
  CAS_STAGE_SUFFIX: ".stage",
  MAX_OWNER_BYTES: 4 * 1024,
  DEFAULT_MAX_BYTES: 8 * 1024 * 1024,
  DEFAULT_TIMEOUT_MS: 5_000,
  DEFAULT_POLL_MS: 10,
} as const);

export type WindowsRecordFaultPoint =
  | "after-stage-sync"
  | "before-publication"
  | "after-publication"
  | "after-postimage";

export interface WindowsRecordBackendOptions {
  recordsRoot?: string;
  lockPath?: string;
  maxBytes?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  runtime?: Partial<WindowsRecordRuntime>;
}

export interface WindowsOwnedProcessLock {
  readonly owner: ProcessLockOwnerV1;
  assertHeld(): void;
  release(): void;
}

export class WindowsOwnedProcessRecordBackend {
  readonly root: string;
  readonly recordsRoot: string;
  readonly lockPath: string;
  private readonly runtime: WindowsRecordRuntime;
  private readonly recordsIdentity: WindowsDirectoryIdentity;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private processIdentity: string | null | undefined;

  constructor(root: string, options: WindowsRecordBackendOptions = {}) {
    this.runtime = createWindowsRecordRuntime(options.runtime ?? {});
    this.root = ensureWindowsRecordDirectory(root, this.runtime);
    this.recordsRoot = ensureWindowsRecordDirectory(
      options.recordsRoot ?? join(this.root, OWNED_PROCESS_STORAGE_NAME.RECORD_DIRECTORY),
      this.runtime,
    );
    if (dirname(this.recordsRoot) !== this.root)
      durabilityError("unsafe_path", "Windows record directory must be an immediate root child");
    this.lockPath = resolveWindowsRecordPath(
      options.lockPath ?? join(this.recordsRoot, OWNED_PROCESS_STORAGE_NAME.WRITER_LOCK_FILE),
      this.runtime,
    );
    if (dirname(this.lockPath) !== this.recordsRoot)
      durabilityError("unsafe_path", "unsafe lock path");
    safeWindowsRecordLeaf(basename(this.lockPath));
    this.recordsIdentity = windowsDirectoryIdentity(this.recordsRoot, this.runtime);
    this.maxBytes = windowsRecordLimit(
      options.maxBytes,
      WINDOWS_RECORD_STORAGE.DEFAULT_MAX_BYTES,
      "record limit",
    );
    this.timeoutMs = windowsRecordLimit(
      options.timeoutMs,
      WINDOWS_RECORD_STORAGE.DEFAULT_TIMEOUT_MS,
      "lock timeout",
    );
    this.pollIntervalMs = windowsRecordLimit(
      options.pollIntervalMs,
      WINDOWS_RECORD_STORAGE.DEFAULT_POLL_MS,
      "poll interval",
    );
  }

  read(entry: string, maxBytes = this.maxBytes): Buffer | null {
    safeWindowsRecordLeaf(entry);
    return readWindowsRecordPath(
      join(this.recordsRoot, entry),
      windowsRecordLimit(maxBytes, this.maxBytes, "read limit"),
      this.recordsIdentity,
      this.runtime,
    );
  }

  entries(): string[] {
    assertWindowsDirectory(this.recordsRoot, this.recordsIdentity, this.runtime);
    const entries = this.runtime.files
      .readdirSync(this.recordsRoot, { withFileTypes: true })
      .filter((entry) => isOwnedProcessRecordFileName(entry.name))
      .map((entry) => {
        safeWindowsRecordLeaf(entry.name);
        if (!entry.isFile() || entry.isSymbolicLink())
          durabilityError("unsafe_path", `unsafe Windows record entry: ${entry.name}`);
        return entry.name;
      })
      .sort();
    assertWindowsDirectory(this.recordsRoot, this.recordsIdentity, this.runtime);
    return entries;
  }

  private ownerBytes(): Buffer | null {
    return readWindowsRecordPath(
      `${this.lockPath}${WINDOWS_RECORD_STORAGE.OWNER_SUFFIX}`,
      WINDOWS_RECORD_STORAGE.MAX_OWNER_BYTES,
      this.recordsIdentity,
      this.runtime,
    );
  }

  private assertDeadOwner(bytes: Buffer, label: string): ProcessLockOwnerV1 {
    const owner = parseProcessLockOwner(bytes);
    const alive = this.runtime.ownerAlive(owner);
    if (alive !== false)
      durabilityError(
        "lock_busy",
        alive ? `${label} names a live owner` : `${label} owner death is unprovable`,
      );
    return owner;
  }

  private recoverReleaseTombs(): void {
    const prefix = `${basename(this.lockPath)}${WINDOWS_RECORD_STORAGE.OWNER_SUFFIX}${WINDOWS_RECORD_STORAGE.RELEASE_MARKER}`;
    for (const entry of this.runtime.files.readdirSync(this.recordsRoot)) {
      if (!entry.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(entry.slice(prefix.length)))
        continue;
      safeWindowsRecordLeaf(entry);
      const path = join(this.recordsRoot, entry);
      const bytes =
        readWindowsRecordPath(
          path,
          WINDOWS_RECORD_STORAGE.MAX_OWNER_BYTES,
          this.recordsIdentity,
          this.runtime,
        ) ?? durabilityError("lock_lost", "Windows release tomb disappeared");
      const owner = this.assertDeadOwner(bytes, "Windows release tomb");
      if (entry !== `${prefix}${owner.nonce}`)
        durabilityError("lock_lost", "Windows release tomb owner binding changed");
      this.runtime.files.unlinkSync(path);
    }
  }

  private publishOwner(prior: Buffer | null, replacement: Buffer): void {
    const ownerPath = `${this.lockPath}${WINDOWS_RECORD_STORAGE.OWNER_SUFFIX}`;
    const stage = `${ownerPath}${WINDOWS_RECORD_STORAGE.CAS_STAGE_SUFFIX}`;
    const staged = readWindowsRecordPath(
      stage,
      WINDOWS_RECORD_STORAGE.MAX_OWNER_BYTES,
      this.recordsIdentity,
      this.runtime,
    );
    if (staged !== null && !exactWindowsBytes(staged, replacement)) {
      this.runtime.files.unlinkSync(stage);
    }
    if (!exactWindowsBytes(staged, replacement))
      writeWindowsRecordFile(
        stage,
        replacement,
        WINDOWS_RECORD_STORAGE.MAX_OWNER_BYTES,
        this.recordsIdentity,
        this.runtime,
      );
    if (!exactWindowsBytes(this.ownerBytes(), prior))
      durabilityError("lock_lost", "Windows lock owner changed");
    this.runtime.rename(stage, ownerPath, { replace: prior !== null, writeThrough: true });
    if (!exactWindowsBytes(this.ownerBytes(), replacement))
      durabilityError("lock_lost", "Windows lock owner publication failed");
  }

  acquire(operation: string): WindowsOwnedProcessLock {
    if (!boundedOwnerAscii(operation, 512))
      durabilityError("invalid_value", "invalid lock operation");
    if (this.processIdentity === undefined)
      this.processIdentity = this.runtime.identity(this.runtime.pid);
    const identity = this.processIdentity;
    if (!identity) durabilityError("unsupported", "Windows process start identity is unavailable");
    const owner: ProcessLockOwnerV1 = {
      schema_version: "1.0",
      pid: this.runtime.pid,
      process_start_identity: identity,
      host: this.runtime.host,
      operation,
      nonce: this.runtime.nonce(),
    };
    const expected = canonicalJsonBytes(owner);
    parseProcessLockOwner(expected);
    const deadline = this.runtime.now() + this.timeoutMs;
    let kernel: WindowsKernelLock | null = null;
    while (!kernel) {
      assertWindowsDirectory(this.recordsRoot, this.recordsIdentity, this.runtime);
      kernel = this.runtime.kernelLocks.tryAcquire(this.lockPath);
      if (kernel) {
        assertWindowsDirectory(this.recordsRoot, this.recordsIdentity, this.runtime);
        break;
      }
      if (this.runtime.now() >= deadline) durabilityError("lock_busy", "Windows process lock busy");
      this.runtime.wait(this.pollIntervalMs);
    }
    const heldKernel = kernel;
    try {
      this.recoverReleaseTombs();
      const prior = this.ownerBytes();
      if (prior) {
        this.assertDeadOwner(prior, "Windows lock metadata");
      }
      this.publishOwner(prior, expected);
    } catch (error) {
      return cleanupThenThrow(error, [() => heldKernel.release()]);
    }
    const state = { released: false };
    const assertHeld = () => {
      if (state.released) durabilityError("lock_lost", "Windows process lock is released");
      heldKernel.assertHeld();
      if (!exactWindowsBytes(this.ownerBytes(), expected))
        durabilityError("lock_lost", "Windows process lock ownership lost");
    };
    return {
      owner,
      assertHeld,
      release: () => {
        assertHeld();
        return withCleanup(() => {
          const ownerPath = `${this.lockPath}${WINDOWS_RECORD_STORAGE.OWNER_SUFFIX}`;
          const released = `${ownerPath}${WINDOWS_RECORD_STORAGE.RELEASE_MARKER}${owner.nonce}`;
          this.runtime.rename(ownerPath, released, { replace: false, writeThrough: true });
          if (
            !exactWindowsBytes(
              readWindowsRecordPath(
                released,
                WINDOWS_RECORD_STORAGE.MAX_OWNER_BYTES,
                this.recordsIdentity,
                this.runtime,
              ),
              expected,
            )
          )
            durabilityError("lock_lost", "Windows lock release owner changed");
          this.runtime.files.unlinkSync(released);
          assertWindowsDirectory(this.recordsRoot, this.recordsIdentity, this.runtime);
        }, [
          () => {
            try {
              heldKernel.release();
            } finally {
              state.released = true;
            }
          },
        ]);
      },
    };
  }

  compareAndSwap(
    entry: string,
    expected: Uint8Array | null,
    replacement: Uint8Array,
    options: {
      operation: string;
      maxBytes?: number;
      fault?: (point: WindowsRecordFaultPoint) => void;
    },
  ): void {
    safeWindowsRecordLeaf(entry);
    const maxBytes = windowsRecordLimit(options.maxBytes, this.maxBytes, "CAS limit");
    if (replacement.length > maxBytes || (expected?.length ?? 0) > maxBytes)
      durabilityError("bounds", "Windows CAS value exceeds byte limit");
    const lock = this.acquire(options.operation);
    const target = join(this.recordsRoot, entry);
    const stage = join(
      this.recordsRoot,
      `${WINDOWS_RECORD_STORAGE.CAS_STAGE_PREFIX}${entry}${WINDOWS_RECORD_STORAGE.CAS_STAGE_SUFFIX}`,
    );
    withCleanup(() => {
      const current = readWindowsRecordPath(target, maxBytes, this.recordsIdentity, this.runtime);
      const staged = readWindowsRecordPath(stage, maxBytes, this.recordsIdentity, this.runtime);
      if (!exactWindowsBytes(current, expected))
        durabilityError("cas_mismatch", `Windows CAS preimage mismatch: ${target}`);
      if (exactWindowsBytes(current, replacement)) {
        if (staged !== null) this.runtime.files.unlinkSync(stage);
        return;
      }
      if (staged !== null && !exactWindowsBytes(staged, replacement))
        this.runtime.files.unlinkSync(stage);
      if (!exactWindowsBytes(staged, replacement))
        writeWindowsRecordFile(stage, replacement, maxBytes, this.recordsIdentity, this.runtime);
      options.fault?.("after-stage-sync");
      lock.assertHeld();
      if (
        !exactWindowsBytes(
          readWindowsRecordPath(target, maxBytes, this.recordsIdentity, this.runtime),
          expected,
        )
      )
        durabilityError("cas_mismatch", `Windows CAS preimage changed: ${target}`);
      options.fault?.("before-publication");
      lock.assertHeld();
      if (
        !exactWindowsBytes(
          readWindowsRecordPath(target, maxBytes, this.recordsIdentity, this.runtime),
          expected,
        )
      )
        durabilityError("cas_mismatch", `Windows CAS preimage raced: ${target}`);
      this.runtime.rename(stage, target, { replace: expected !== null, writeThrough: true });
      options.fault?.("after-publication");
      lock.assertHeld();
      if (
        !exactWindowsBytes(
          readWindowsRecordPath(target, maxBytes, this.recordsIdentity, this.runtime),
          replacement,
        )
      )
        durabilityError("corrupt", `Windows CAS postimage mismatch: ${target}`);
      options.fault?.("after-postimage");
    }, [() => lock.release()]);
  }
}
