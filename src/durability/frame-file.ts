import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname } from "node:path";
import { cleanupThenThrow, withCleanup } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  canonicalDurabilityPath,
  closePinnedDirectory,
  openPrivateDirectory,
  tryLinkAt,
  unlinkAt,
} from "./native.js";
import {
  createPrivateFileAt,
  openExistingPrivateFileAt,
  readPrivateFd,
  validatePrivateFileFd,
} from "./path.js";

export type VffrFileFaultPoint =
  | "after-first-frame-link"
  | "before-existing-frame-write"
  | "after-existing-frame-fsync";

function stageName(name: string): string {
  const identity = createHash("sha256")
    .update("VF-VFFR-FIRST-STAGE\0v1\0")
    .update(name)
    .digest("hex");
  return `.vffr-first-${identity}.stage`;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertVisibleVffrEntry(
  directory: PinnedDirectory,
  name: string,
  fd: number,
  maxLinks = 1,
): void {
  assertPinnedDirectory(directory);
  const held = validatePrivateFileFd(fd, name, maxLinks);
  const visible = openExistingPrivateFileAt(directory, name, fs.constants.O_RDONLY, maxLinks);
  if (visible === null) durabilityError("conflict", `VFFR visible entry disappeared: ${name}`);
  withCleanup(() => {
    if (!sameIdentity(held, fs.fstatSync(visible)))
      durabilityError("conflict", `VFFR visible entry identity changed: ${name}`);
  }, [() => fs.closeSync(visible)]);
}

function assertRecognizedPublicationAlias(
  directory: PinnedDirectory,
  name: string,
  targetFd: number,
): void {
  const target = validatePrivateFileFd(targetFd, name, 2);
  if (target.nlink === 1) return;
  const staged = openExistingPrivateFileAt(directory, stageName(name), fs.constants.O_RDONLY, 2);
  if (staged === null)
    durabilityError("unsafe_path", `VFFR journal has an unrecognized hard link: ${name}`);
  withCleanup(() => {
    const stagedStat = validatePrivateFileFd(staged, stageName(name), 2);
    if (target.nlink !== 2 || stagedStat.nlink !== 2 || !sameIdentity(target, stagedStat))
      durabilityError("unsafe_path", `VFFR journal hard link is not its recovery stage: ${name}`);
  }, [() => fs.closeSync(staged)]);
}

function removeAbandonedStage(directory: PinnedDirectory, name: string): void {
  const stagedName = stageName(name);
  const staged = openExistingPrivateFileAt(directory, stagedName, fs.constants.O_RDONLY);
  if (staged === null) return;
  withCleanup(() => {
    assertVisibleVffrEntry(directory, stagedName, staged);
    assertPinnedDirectory(directory);
    unlinkAt(directory, stagedName);
    fs.fsyncSync(directory.fd);
  }, [() => fs.closeSync(staged)]);
}

export function readVffrFileAt(
  directory: PinnedDirectory,
  name: string,
  maxBytes: number,
): Buffer | null {
  const fd = openExistingPrivateFileAt(directory, name, fs.constants.O_RDONLY, 2);
  if (fd === null) return null;
  return withCleanup(() => {
    assertRecognizedPublicationAlias(directory, name, fd);
    const bytes = readPrivateFd(fd, name, maxBytes, 2);
    assertVisibleVffrEntry(directory, name, fd, 2);
    return bytes;
  }, [() => fs.closeSync(fd)]);
}

export function vffrFileBytes(path: string, maxBytes: number): Buffer | null {
  const target = canonicalDurabilityPath(path);
  try {
    fs.lstatSync(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const directory = openPrivateDirectory(dirname(target), false);
  return withCleanup(() => {
    const bytes = readVffrFileAt(directory, basename(target), maxBytes);
    assertPinnedDirectory(directory);
    return bytes;
  }, [() => closePinnedDirectory(directory)]);
}

export function openVffrFileForAppendAt(directory: PinnedDirectory, name: string): number | null {
  const fd = openExistingPrivateFileAt(directory, name, fs.constants.O_RDWR, 2);
  if (fd === null) {
    removeAbandonedStage(directory, name);
    return null;
  }
  try {
    const target = validatePrivateFileFd(fd, name, 2);
    if (target.nlink === 2) {
      assertRecognizedPublicationAlias(directory, name, fd);
      unlinkAt(directory, stageName(name));
      fs.fsyncSync(directory.fd);
      validatePrivateFileFd(fd, name);
    } else removeAbandonedStage(directory, name);
    assertVisibleVffrEntry(directory, name, fd);
    return fd;
  } catch (error) {
    return cleanupThenThrow(error, [() => fs.closeSync(fd)]);
  }
}

export function publishFirstVffrFrameAt(
  directory: PinnedDirectory,
  name: string,
  bytes: Uint8Array,
  fault?: (point: VffrFileFaultPoint) => void,
): void {
  const stagedName = stageName(name);
  const fd = createPrivateFileAt(directory, stagedName, bytes);
  if (fd === null) durabilityError("conflict", `VFFR first-frame stage already exists: ${name}`);
  let stagedPresent = true;
  withCleanup(() => {
    assertPinnedDirectory(directory);
    if (!tryLinkAt(directory, stagedName, name))
      durabilityError("conflict", "VFFR journal appeared during first-frame publication");
    assertVisibleVffrEntry(directory, name, fd, 2);
    fault?.("after-first-frame-link");
    unlinkAt(directory, stagedName);
    stagedPresent = false;
    fs.fsyncSync(directory.fd);
    assertVisibleVffrEntry(directory, name, fd);
  }, [
    () => {
      if (stagedPresent) unlinkAt(directory, stagedName, true);
    },
    () => fs.closeSync(fd),
  ]);
}
