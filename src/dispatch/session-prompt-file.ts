import * as fs from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { AGENT_ENGINE, type Engine } from "../core/agent-contract.js";
import { assertNoSymlinkComponents, writeAll } from "../durability/path.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import { ENGINE_ARG_PROMPT_LIMIT_BYTES } from "./prompt-limits.js";

export const SESSION_PROMPT_FILE_ENGINE = AGENT_ENGINE.COPILOT;
export const COPILOT_ARG_PROMPT_FILE_THRESHOLD_BYTES = ENGINE_ARG_PROMPT_LIMIT_BYTES;
export const MAX_SESSION_PROMPT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SESSION_PROMPT_POINTER_BYTES = 4 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_BITS_MASK = 0o777;
const PRIVATE_FILE_LINK_COUNT = 1;
const SESSION_PROMPT_FILE_SUFFIX = ".prompt.md";

export interface SessionPromptFile {
  cleanup(): void;
  pointerPrompt: string;
  privateValues: readonly string[];
}

const privateFileError = (): never => {
  throw new Error("private Copilot prompt-file authority is unavailable");
};

const ownerMatches = (stat: fs.Stats): boolean =>
  typeof process.geteuid !== "function" || stat.uid === process.geteuid();

function assertPrivateMode(stat: fs.Stats, expected: number): void {
  if (
    process.platform !== RUNTIME_PLATFORM.WINDOWS &&
    (stat.mode & PERMISSION_BITS_MASK) !== expected
  ) {
    privateFileError();
  }
}

function syncDirectory(path: string): void {
  if (process.platform === RUNTIME_PLATFORM.WINDOWS) return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    fs.fsyncSync(fd);
  } catch {
    privateFileError();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function privateRoot(input: string): string {
  try {
    const requested = assertNoSymlinkComponents(resolve(input));
    fs.mkdirSync(requested, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const canonical = assertNoSymlinkComponents(requested);
    const observed = fs.lstatSync(canonical);
    if (observed.isSymbolicLink() || !observed.isDirectory() || !ownerMatches(observed)) {
      privateFileError();
    }
    assertPrivateMode(observed, PRIVATE_DIRECTORY_MODE);
    syncDirectory(canonical);
    return fs.realpathSync(canonical);
  } catch {
    return privateFileError();
  }
}

function readPrivateFile(path: string): Buffer | null {
  let observed: fs.Stats;
  try {
    observed = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return privateFileError();
  }
  if (observed.isSymbolicLink() || !observed.isFile()) return privateFileError();
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      !ownerMatches(opened) ||
      opened.nlink !== PRIVATE_FILE_LINK_COUNT ||
      opened.dev !== observed.dev ||
      opened.ino !== observed.ino ||
      opened.size < 1 ||
      opened.size > MAX_SESSION_PROMPT_FILE_BYTES
    ) {
      privateFileError();
    }
    assertPrivateMode(opened, PRIVATE_FILE_MODE);
    const bytes = Buffer.allocUnsafe(opened.size);
    for (let offset = 0; offset < bytes.length; ) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) privateFileError();
      offset += count;
    }
    return bytes;
  } catch {
    return privateFileError();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createOrReuse(path: string, bytes: Buffer): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      path,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    if (process.platform !== RUNTIME_PLATFORM.WINDOWS) fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    writeAll(fd, bytes, 0);
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The private authority error below remains authoritative.
      }
      fd = undefined;
      try {
        fs.unlinkSync(path);
      } catch {
        // The private authority error below remains authoritative.
      }
      privateFileError();
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") privateFileError();
    const existing = readPrivateFile(path);
    if (!existing?.equals(bytes)) privateFileError();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function materializeCopilotSessionPrompt(input: {
  attemptId: string;
  engine: Engine;
  prompt: string;
  root: string;
  visibleRoot?: string;
}): SessionPromptFile | undefined {
  const bytes = Buffer.from(input.prompt, "utf8");
  if (
    input.engine !== SESSION_PROMPT_FILE_ENGINE ||
    bytes.byteLength < COPILOT_ARG_PROMPT_FILE_THRESHOLD_BYTES
  ) {
    return undefined;
  }
  if (bytes.byteLength > MAX_SESSION_PROMPT_FILE_BYTES) {
    throw new Error("Copilot conversation prompt exceeds the private prompt-file byte bound");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.attemptId)) privateFileError();
  const root = privateRoot(input.root);
  const name = `${input.attemptId}${SESSION_PROMPT_FILE_SUFFIX}`;
  const path = join(root, name);
  createOrReuse(path, bytes);
  syncDirectory(root);
  const visiblePath = input.visibleRoot ? posix.join(input.visibleRoot, name) : path;
  const pointerPrompt = `Read ${visiblePath.replace(/\\/g, "/")} and follow it`;
  if (Buffer.byteLength(pointerPrompt, "utf8") > MAX_SESSION_PROMPT_POINTER_BYTES) {
    try {
      fs.unlinkSync(path);
      syncDirectory(root);
    } catch {
      // The bounded pointer error remains authoritative.
    }
    throw new Error("Copilot conversation prompt pointer exceeds its byte bound");
  }
  let cleaned = false;
  return Object.freeze({
    pointerPrompt,
    privateValues: Object.freeze([path, visiblePath, pointerPrompt]),
    cleanup() {
      if (cleaned) return;
      const existing = readPrivateFile(path);
      if (existing && !existing.equals(bytes)) privateFileError();
      if (existing) fs.unlinkSync(path);
      syncDirectory(dirname(path));
      cleaned = true;
    },
  });
}
