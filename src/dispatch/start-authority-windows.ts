import { basename, dirname, join } from "node:path";
import { DurabilityError, durabilityError } from "../durability/errors.js";
import {
  type WindowsRecordRuntime,
  createWindowsRecordRuntime,
  ensureWindowsRecordDirectory,
  exactWindowsBytes,
  readWindowsRecordPath,
  safeWindowsRecordLeaf,
  windowsDirectoryIdentity,
} from "./owned-process-record-windows-storage.js";
import { WindowsOwnedProcessRecordBackend } from "./owned-process-record-windows.js";

export interface WindowsAttemptAuthorityStorage {
  readonly root: string;
  read(path: string, maxBytes: number): Buffer | null;
  createOrVerify(path: string, value: Uint8Array, maxBytes: number): void;
}

export class NativeWindowsAttemptAuthorityStorage implements WindowsAttemptAuthorityStorage {
  readonly root: string;
  private readonly runtime: WindowsRecordRuntime;
  private readonly rootIdentity;
  private readonly records: WindowsOwnedProcessRecordBackend;

  constructor(root: string, runtime: Partial<WindowsRecordRuntime> = {}) {
    this.runtime = createWindowsRecordRuntime(runtime);
    this.root = ensureWindowsRecordDirectory(root, this.runtime);
    this.rootIdentity = windowsDirectoryIdentity(this.root, this.runtime);
    this.records = new WindowsOwnedProcessRecordBackend(this.root, {
      recordsRoot: join(this.root, "start-authority"),
      lockPath: join(this.root, "start-authority", "writer.lock"),
      runtime: this.runtime,
    });
  }

  read(path: string, maxBytes: number): Buffer | null {
    if (dirname(path) === this.root)
      return readWindowsRecordPath(path, maxBytes, this.rootIdentity, this.runtime);
    if (dirname(path) !== this.records.recordsRoot)
      durabilityError("unsafe_path", "Windows attempt authority path escapes storage root");
    return this.records.read(basename(path), maxBytes);
  }

  createOrVerify(path: string, value: Uint8Array, maxBytes: number): void {
    if (dirname(path) !== this.records.recordsRoot)
      durabilityError("unsafe_path", "Windows attempt authority record escapes storage root");
    const entry = safeWindowsRecordLeaf(basename(path));
    const prior = this.records.read(entry, maxBytes);
    if (prior) {
      if (!exactWindowsBytes(prior, value))
        durabilityError("cas_mismatch", "immutable Windows attempt authority changed");
      return;
    }
    try {
      this.records.compareAndSwap(entry, null, value, {
        operation: `attempt-start-authority:${entry}`,
        maxBytes,
      });
    } catch (error) {
      if (!(error instanceof DurabilityError) || error.code !== "cas_mismatch") throw error;
      const winner = this.records.read(entry, maxBytes);
      if (!exactWindowsBytes(winner, value)) throw error;
    }
  }
}
