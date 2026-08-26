import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { canonicalJsonBytes } from "./canonical.js";
import { cleanupThenThrow, withCleanup } from "./cleanup.js";
import { DurabilityError, durabilityError } from "./errors.js";
import {
  type ProcessLockOwnerRuntime,
  type ProcessLockOwnerV1,
  boundedOwnerAscii,
  parseProcessLockOwner,
  processLockOwnerIsAlive,
  processStartIdentity,
} from "./lock-owner.js";
import {
  type StableLockRecord,
  ensureStableLockInitialized,
  publishStableLockRecord,
  readStableLockRecord,
} from "./lock-record.js";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  canonicalDurabilityPath,
  closePinnedDirectory,
  openPinnedDescendant,
  openPrivateDirectory,
  releaseAdvisoryLock,
  tryAdvisoryLock,
} from "./native.js";
import {
  openExistingPrivateFileAt,
  openOrCreatePrivateFileAt,
  validatePrivateFileFd,
} from "./path.js";

export type { ProcessLockOwnerRuntime, ProcessLockOwnerV1 } from "./lock-owner.js";
export { processStartIdentity } from "./lock-owner.js";
export interface AcquireProcessLockOptions {
  operation: string;
  coverageRoot?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  processRuntime?: Partial<ProcessLockOwnerRuntime>;
  fault?: (point: LockPublicationFaultPoint) => void;
}

export type LockPublicationFaultPoint =
  | "acquire-owner-slot-mid-write"
  | "acquire-owner-slot-written"
  | "acquire-owner-slot-fsynced"
  | "release-owner-slot-mid-write"
  | "release-owner-slot-written"
  | "release-owner-slot-fsynced";

export interface ProcessLock {
  readonly path: string;
  readonly owner: ProcessLockOwnerV1;
  assertHeld(): void;
  release(): void;
}
export type ProcessLockStatus =
  | { status: "absent"; owner: null }
  | { status: "live" | "dead" | "unprovable"; owner: ProcessLockOwnerV1 };
interface LockState {
  root: PinnedDirectory;
  coverageRoot: PinnedDirectory | null;
  name: string;
  fd: number;
  expected: Buffer;
  generation: number;
  fault?: (point: LockPublicationFaultPoint) => void;
  pendingReleaseGeneration?: number;
  released: boolean;
}

const STATES = new WeakMap<ProcessLock, LockState>();

function ownerFromRecord(record: StableLockRecord): ProcessLockOwnerV1 | null {
  return record.payload === null ? null : parseProcessLockOwner(record.payload);
}

export function inspectProcessLock(path: string): ProcessLockOwnerV1 | null {
  const target = canonicalDurabilityPath(path);
  try {
    fs.lstatSync(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const directory = openPrivateDirectory(dirname(target), false);
  return withCleanup(() => {
    const name = basename(target);
    const fd = openExistingPrivateFileAt(directory, name, fs.constants.O_RDONLY);
    if (fd === null) return null;
    return withCleanup(
      () => ownerFromRecord(readStableLockRecord(fd, name)),
      [() => fs.closeSync(fd)],
    );
  }, [() => closePinnedDirectory(directory)]);
}

export function inspectProcessLockStatus(path: string): ProcessLockStatus {
  const owner = inspectProcessLock(path);
  if (!owner) return { status: "absent", owner: null };
  const alive = processLockOwnerIsAlive(owner);
  return { status: alive === true ? "live" : alive === false ? "dead" : "unprovable", owner };
}

function stateOf(lock: ProcessLock): LockState {
  const state = STATES.get(lock);
  if (!state || state.released) durabilityError("lock_lost", "process lock is not held");
  return state;
}

function assertEntry(root: PinnedDirectory, name: string, fd: number): void {
  assertPinnedDirectory(root);
  validatePrivateFileFd(fd, name);
  const entry = openExistingPrivateFileAt(root, name, fs.constants.O_RDONLY);
  if (entry === null) durabilityError("lock_lost", "process lock entry disappeared");
  withCleanup(() => {
    const held = fs.fstatSync(fd);
    const current = fs.fstatSync(entry);
    if (held.dev !== current.dev || held.ino !== current.ino)
      durabilityError("lock_lost", "process lock entry identity changed");
  }, [() => fs.closeSync(entry)]);
}

function assertStateHeld(state: LockState): void {
  if (state.released) durabilityError("lock_lost", "process lock is released");
  assertEntry(state.root, state.name, state.fd);
  if (state.coverageRoot) assertPinnedDirectory(state.coverageRoot);
  const current = readStableLockRecord(state.fd, state.name);
  if (
    current.generation !== state.generation ||
    current.payload === null ||
    current.payload.length !== state.expected.length ||
    !timingSafeEqual(current.payload, state.expected)
  )
    durabilityError("lock_lost", `process lock ownership lost: ${state.root.path}/${state.name}`);
}

export function assertProcessLockCovers(lock: ProcessLock, targetPath: string): void {
  const state = stateOf(lock);
  assertStateHeld(state);
  const target = canonicalDurabilityPath(targetPath);
  const relationship = relative((state.coverageRoot ?? state.root).path, dirname(target));
  if (isAbsolute(relationship) || relationship === ".." || relationship.startsWith(`..${sep}`))
    durabilityError("lock_lost", "process lock does not cover the target path");
}

export function withLockedParent<T>(
  lock: ProcessLock,
  targetPath: string,
  create: boolean,
  callback: (directory: PinnedDirectory, name: string) => T,
): T {
  assertProcessLockCovers(lock, targetPath);
  const state = stateOf(lock);
  const target = canonicalDurabilityPath(targetPath);
  const directory = openPinnedDescendant(state.coverageRoot ?? state.root, dirname(target), create);
  return withCleanup(() => {
    assertStateHeld(state);
    const result = callback(directory, basename(target));
    assertPinnedDirectory(directory);
    assertStateHeld(state);
    return result;
  }, [() => closePinnedDirectory(directory)]);
}

function wait(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function closeAttempt(
  root: PinnedDirectory,
  coverageRoot: PinnedDirectory | null,
  fd: number,
  unlock: boolean,
): void {
  try {
    if (unlock) releaseAdvisoryLock(fd);
  } catch {
    // Acquisition already failed; cleanup must preserve that primary error.
  }
  try {
    fs.closeSync(fd);
  } catch {
    // Acquisition already failed; cleanup must preserve that primary error.
  }
  try {
    closePinnedDirectory(root);
  } catch {
    // Acquisition already failed; cleanup must preserve that primary error.
  }
  if (coverageRoot) {
    try {
      closePinnedDirectory(coverageRoot);
    } catch {
      // Acquisition already failed; cleanup must preserve that primary error.
    }
  }
}

function faultFor(
  state: LockState,
  phase: "acquire" | "release",
): (point: "mid-write" | "written" | "fsynced") => void {
  return (point) => state.fault?.(`${phase}-owner-slot-${point}` as LockPublicationFaultPoint);
}

function finishRelease(state: LockState): void {
  releaseAdvisoryLock(state.fd);
  state.released = true;
  let failure: unknown;
  try {
    fs.closeSync(state.fd);
  } catch (error) {
    failure = error;
  }
  try {
    closePinnedDirectory(state.root);
  } catch (error) {
    failure ??= error;
  }
  if (state.coverageRoot) {
    try {
      closePinnedDirectory(state.coverageRoot);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

function makeHandle(path: string, owner: ProcessLockOwnerV1, state: LockState): ProcessLock {
  const handle: ProcessLock = {
    path,
    owner,
    assertHeld() {
      assertStateHeld(stateOf(this));
    },
    release() {
      const current = stateOf(this);
      if (current.pendingReleaseGeneration === undefined) {
        assertStateHeld(current);
        try {
          const prior = readStableLockRecord(current.fd, current.name);
          const absent = publishStableLockRecord(
            current.fd,
            current.name,
            prior,
            null,
            faultFor(current, "release"),
          );
          current.pendingReleaseGeneration = absent.generation;
        } catch (error) {
          try {
            const observed = readStableLockRecord(current.fd, current.name);
            if (observed.payload === null && observed.generation > current.generation)
              current.pendingReleaseGeneration = observed.generation;
          } catch {
            // The original publication error remains primary; the flock stays held for retry.
          }
          throw error;
        }
      }
      const pending = readStableLockRecord(current.fd, current.name);
      if (pending.payload !== null || pending.generation !== current.pendingReleaseGeneration)
        durabilityError("lock_lost", "process lock release slot was not retained exactly");
      fs.fsyncSync(current.fd);
      assertPinnedDirectory(current.root);
      finishRelease(current);
    },
  };
  STATES.set(handle, state);
  return handle;
}

export function acquireProcessLock(path: string, options: AcquireProcessLockOptions): ProcessLock {
  if (!boundedOwnerAscii(options.operation, 512))
    durabilityError("invalid_value", "process lock operation must be bounded printable ASCII");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000)
    durabilityError("bounds", "invalid process lock timeout");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000)
    durabilityError("bounds", "invalid process lock polling interval");
  const startIdentity = processStartIdentity(process.pid, options.processRuntime);
  if (!startIdentity) durabilityError("unsupported", "process start identity is unavailable");
  if (!boundedOwnerAscii(startIdentity, 512))
    durabilityError("invalid_value", "generated process start identity is outside owner bounds");
  const localHost = options.processRuntime?.host ?? hostname();
  if (!boundedOwnerAscii(localHost, 255))
    durabilityError("invalid_value", "generated hostname is outside process lock owner bounds");
  const owner: ProcessLockOwnerV1 = {
    schema_version: "1.0",
    pid: process.pid,
    process_start_identity: startIdentity,
    host: localHost,
    operation: options.operation,
    nonce: randomBytes(32).toString("hex"),
  };
  const expected = canonicalJsonBytes(owner);
  parseProcessLockOwner(expected);
  const deadline = Date.now() + timeoutMs;
  const target = canonicalDurabilityPath(path);
  const root = openPrivateDirectory(dirname(target), true);
  let coverageRoot: PinnedDirectory | null = null;
  try {
    if (options.coverageRoot !== undefined) {
      const coveragePath = canonicalDurabilityPath(options.coverageRoot);
      const relationship = relative(coveragePath, dirname(target));
      if (isAbsolute(relationship) || relationship === ".." || relationship.startsWith(`..${sep}`))
        durabilityError("invalid_value", "process lock coverage root does not own the lock path");
      if (coveragePath !== root.path) coverageRoot = openPrivateDirectory(coveragePath, false);
    }
  } catch (error) {
    closePinnedDirectory(root);
    throw error;
  }
  const name = basename(target);
  const canonicalPath = `${root.path}/${name}`;
  let fd: number | undefined;
  try {
    fd = openOrCreatePrivateFileAt(root, name);
    validatePrivateFileFd(fd, name);
    fs.fsyncSync(root.fd);
  } catch (error) {
    const opened = fd;
    return cleanupThenThrow(error, [
      ...(opened === undefined ? [] : [() => fs.closeSync(opened)]),
      () => closePinnedDirectory(root),
      ...(coverageRoot ? [() => closePinnedDirectory(coverageRoot as PinnedDirectory)] : []),
    ]);
  }
  let locked = false;
  try {
    do {
      locked = tryAdvisoryLock(fd);
      if (locked) break;
      if (Date.now() >= deadline) break;
      wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    if (!locked) throw new DurabilityError("lock_busy", `process lock busy: ${canonicalPath}`);
    assertEntry(root, name, fd);
    const prior = ensureStableLockInitialized(fd, name);
    const observed = ownerFromRecord(prior);
    if (observed) {
      const alive = processLockOwnerIsAlive(observed, options.processRuntime);
      if (alive === true) durabilityError("lock_busy", "process lock metadata names a live owner");
      if (alive === null)
        durabilityError(
          "lock_busy",
          observed.host === localHost
            ? "process lock owner death is unprovable"
            : "process lock has an unprovable remote owner",
        );
    }
    const state: LockState = {
      root,
      coverageRoot,
      name,
      fd,
      expected,
      generation: prior.generation,
      fault: options.fault,
      released: false,
    };
    let committed: StableLockRecord;
    try {
      committed = publishStableLockRecord(fd, name, prior, expected, faultFor(state, "acquire"));
    } catch (error) {
      try {
        const partial = readStableLockRecord(fd, name);
        if (
          partial.payload !== null &&
          partial.payload.length === expected.length &&
          timingSafeEqual(partial.payload, expected)
        )
          publishStableLockRecord(fd, name, partial, null);
      } catch (rollbackError) {
        throw new DurabilityError(
          "lock_lost",
          "process lock owner publication failed and could not be rolled back safely",
          { cause: rollbackError },
        );
      }
      throw error;
    }
    state.generation = committed.generation;
    assertStateHeld(state);
    return makeHandle(canonicalPath, owner, state);
  } catch (error) {
    closeAttempt(root, coverageRoot, fd, locked);
    throw error;
  }
}
