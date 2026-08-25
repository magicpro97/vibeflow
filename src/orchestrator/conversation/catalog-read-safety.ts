import * as fs from "node:fs";
import { join, resolve } from "node:path";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  closePinnedDirectory,
  openPrivateDirectory,
  tryOpenAt,
} from "../../durability/native.js";
import { effectiveOwnerMatches } from "../trace/path-safety.js";
import { readDirectoryNamesAt } from "./catalog-directory-reader.js";

export interface PrivateDirectorySnapshotV1 {
  state: "missing" | "valid" | "invalid";
  path: string;
  dev: number | null;
  ino: number | null;
  directory: PinnedDirectory | null;
}

const unsafe = (): never => {
  throw new Error("unsafe read-only source path");
};

const missing = (path: string): PrivateDirectorySnapshotV1 => ({
  state: "missing",
  path,
  dev: null,
  ino: null,
  directory: null,
});

const invalid = (path: string): PrivateDirectorySnapshotV1 => ({
  state: "invalid",
  path,
  dev: null,
  ino: null,
  directory: null,
});

export function inspectPrivateDirectoryReadOnly(input: string): PrivateDirectorySnapshotV1 {
  const path = resolve(input);
  try {
    fs.lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? missing(path) : invalid(path);
  }
  let directory: PinnedDirectory;
  try {
    directory = openPrivateDirectory(path, false);
  } catch {
    return invalid(path);
  }
  try {
    assertPinnedDirectory(directory);
    return { state: "valid", path, dev: directory.dev, ino: directory.ino, directory };
  } catch {
    closePinnedDirectory(directory);
    return invalid(path);
  }
}

export function closePrivateDirectorySnapshot(snapshot: PrivateDirectorySnapshotV1): void {
  if (!snapshot.directory) return;
  closePinnedDirectory(snapshot.directory);
  snapshot.directory = null;
}

export function assertPrivateDirectorySnapshot(snapshot: PrivateDirectorySnapshotV1): void {
  if (
    snapshot.state !== "valid" ||
    snapshot.directory === null ||
    snapshot.dev !== snapshot.directory.dev ||
    snapshot.ino !== snapshot.directory.ino
  )
    unsafe();
  const directory = snapshot.directory ?? unsafe();
  assertPinnedDirectory(directory);
}

export function openPrivateChildDirectoryReadOnly(
  parent: PrivateDirectorySnapshotV1,
  name: string,
): PrivateDirectorySnapshotV1 {
  assertPrivateDirectorySnapshot(parent);
  const pinned = parent.directory;
  if (!pinned) return unsafe();
  const path = join(pinned.path, name);
  let fd: number | null;
  try {
    fd = tryOpenAt(pinned, name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  } catch {
    return invalid(path);
  }
  if (fd === null) return missing(path);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || !effectiveOwnerMatches(stat) || (stat.mode & 0o7777) !== 0o700)
      unsafe();
    const directory = { fd, path, dev: stat.dev, ino: stat.ino };
    assertPinnedDirectory(directory);
    assertPrivateDirectorySnapshot(parent);
    return { state: "valid", path, dev: stat.dev, ino: stat.ino, directory };
  } catch {
    fs.closeSync(fd);
    return invalid(path);
  }
}

export function readPrivateDirectoryNames(snapshot: PrivateDirectorySnapshotV1): string[] {
  assertPrivateDirectorySnapshot(snapshot);
  const fd = snapshot.directory?.fd;
  if (fd === undefined) return unsafe();
  const names = readDirectoryNamesAt(fd);
  assertPrivateDirectorySnapshot(snapshot);
  return names;
}

export interface PrivateFileSnapshotV1 {
  fd: number;
  directory: PrivateDirectorySnapshotV1;
  name: string;
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function validateOpenedFile(
  directory: PrivateDirectorySnapshotV1,
  name: string,
  fd: number,
  maximum: number,
  allowEmpty: boolean,
): PrivateFileSnapshotV1 {
  assertPrivateDirectorySnapshot(directory);
  const opened = fs.fstatSync(fd);
  if (
    !opened.isFile() ||
    !effectiveOwnerMatches(opened) ||
    opened.nlink !== 1 ||
    (opened.mode & 0o7777) !== 0o600 ||
    (!allowEmpty && opened.size === 0) ||
    opened.size > maximum
  )
    unsafe();
  return {
    fd,
    directory,
    name,
    path: join(directory.path, name),
    dev: opened.dev,
    ino: opened.ino,
    size: opened.size,
    mtimeMs: opened.mtimeMs,
    ctimeMs: opened.ctimeMs,
  };
}

export function tryOpenPrivateFileReadOnlyAt(
  directory: PrivateDirectorySnapshotV1,
  name: string,
  maximum: number,
  allowEmpty = false,
): PrivateFileSnapshotV1 | null {
  assertPrivateDirectorySnapshot(directory);
  const pinned = directory.directory;
  if (!pinned) return unsafe();
  const fd = tryOpenAt(pinned, name, fs.constants.O_RDONLY);
  if (fd === null) return null;
  try {
    return validateOpenedFile(directory, name, fd, maximum, allowEmpty);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function openPrivateFileReadOnlyAt(
  directory: PrivateDirectorySnapshotV1,
  name: string,
  maximum: number,
  allowEmpty = false,
): PrivateFileSnapshotV1 {
  return tryOpenPrivateFileReadOnlyAt(directory, name, maximum, allowEmpty) ?? unsafe();
}

export function assertPrivateFileSnapshot(snapshot: PrivateFileSnapshotV1): void {
  assertPrivateDirectorySnapshot(snapshot.directory);
  const opened = fs.fstatSync(snapshot.fd);
  const pinned = snapshot.directory.directory ?? unsafe();
  const observedFd = tryOpenAt(pinned, snapshot.name, fs.constants.O_RDONLY) ?? unsafe();
  try {
    const observed = fs.fstatSync(observedFd);
    if (
      opened.dev !== snapshot.dev ||
      opened.ino !== snapshot.ino ||
      opened.size !== snapshot.size ||
      opened.mtimeMs !== snapshot.mtimeMs ||
      opened.ctimeMs !== snapshot.ctimeMs ||
      observed.dev !== snapshot.dev ||
      observed.ino !== snapshot.ino ||
      observed.size !== snapshot.size ||
      observed.mtimeMs !== snapshot.mtimeMs ||
      observed.ctimeMs !== snapshot.ctimeMs ||
      !observed.isFile() ||
      !effectiveOwnerMatches(observed) ||
      observed.nlink !== 1 ||
      (observed.mode & 0o7777) !== 0o600
    )
      unsafe();
  } finally {
    fs.closeSync(observedFd);
  }
  assertPrivateDirectorySnapshot(snapshot.directory);
}

export function readPrivateFileBytesAt(
  directory: PrivateDirectorySnapshotV1,
  name: string,
  maximum: number,
  allowEmpty = false,
): Buffer {
  const snapshot = openPrivateFileReadOnlyAt(directory, name, maximum, allowEmpty);
  try {
    const bytes = Buffer.alloc(snapshot.size);
    for (let offset = 0; offset < bytes.length; ) {
      const count = fs.readSync(snapshot.fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) unsafe();
      offset += count;
    }
    assertPrivateFileSnapshot(snapshot);
    return bytes;
  } finally {
    fs.closeSync(snapshot.fd);
  }
}
