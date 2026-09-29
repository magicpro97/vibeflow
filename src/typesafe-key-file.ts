import { randomBytes } from "node:crypto";
import {
  constants,
  type Stats,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory } from "./durability/path.js";
import { hasPrivateMode } from "./durability/posix-fs-semantics.js";

/**
 * The API key file on disk: where it lives, how it is read without following a symlink, and how it is
 * replaced without leaving a staged copy behind. Split out of `typesafe-settings.ts` when the file
 * hit the 400-line cap - the settings block and the key file are two different jobs.
 */

/** The per-user `~/.vibeflow` root — the same root `vf init` resolves, so an injected
 *  `userRoot` is that DIRECTORY (a test injects a temp dir) and the `VF_USER_VIBEFLOW_ROOT`
 *  override wins when nothing is injected. */
export function userVibeflowDir(userRoot?: string): string {
  return userRoot ?? process.env.VF_USER_VIBEFLOW_ROOT ?? join(homedir(), ".vibeflow");
}

/** `~/.vibeflow/typesafe.env` (the same per-user root `vf init` uses). */
export function typesafeEnvPath(userRoot?: string): string {
  return join(userVibeflowDir(userRoot), "typesafe.env");
}

export type TypesafeKeySource = { key: string; source: "env" | "file" } | null;

/**
 * Resolve the API key: `TYPESAFE_API_KEY` first, then `~/.vibeflow/typesafe.env`.
 * The file is parsed line-wise (`KEY=VALUE`, `#` comments) so a hand-edited file
 * cannot smuggle extra whitespace into the bearer token. Returns null when neither
 * source carries a non-empty key — callers treat that as "integration unavailable".
 */
/** `lstat` that reports "absent" instead of throwing. */
function safeLstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Read the key file without following a symlink at the leaf.
 *
 * `O_NOFOLLOW` is POSIX-only; where it is unavailable the `safeLstat` check above is what refuses a
 * symlink, so the open here is a second line rather than the only one.
 */
function readKeyFileNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function resolveTypesafeKey(
  inject: {
    env?: NodeJS.ProcessEnv;
    userRoot?: string;
    readFile?: (p: string) => string;
  } = {},
): TypesafeKeySource {
  const env = inject.env ?? process.env;
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const path = typesafeEnvPath(inject.userRoot);
  const read = inject.readFile ?? readKeyFileNoFollow;
  if (inject.readFile) {
    if (!existsSync(path)) return null;
  } else if (!safeLstat(path)?.isFile()) {
    // `existsSync` follows symlinks: a symlink at `typesafe.env` made any file's content the bearer
    // key sent to the endpoint. `readHealthFile` and `writeTypesafeEnv` already refuse to follow one.
    return null;
  }
  try {
    for (const line of read(path).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      if (trimmed.slice(0, eq).trim() !== "TYPESAFE_API_KEY") continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value) return { key: value, source: "file" };
    }
  } catch {
    /* unreadable file → treat as absent */
  }
  return null;
}

/**
 * Write the key to `~/.vibeflow/typesafe.env` as an owner-only file and return the path.
 *
 * `chmod 0600` is a no-op on Windows and `stat().mode` reports `0o666` there, so a mode-bit
 * assertion would pass there without checking anything. The durability layer already owns the
 * cross-platform answer, so this reuses it:
 *
 *   - `ensurePrivateDirectory` creates and verifies `~/.vibeflow` as owner-only on BOTH
 *     platforms (POSIX mode bits; a migrated owner-only DACL on Windows).
 *   - The key is staged with `O_CREAT | O_EXCL | O_NOFOLLOW` + `fchmodSync(fd, 0o600)`, fsynced,
 *     then renamed into place, so a pre-existing symlink or a concurrent writer cannot capture it.
 *   - `hasPrivateMode(stat, 0o777, 0o600, path, fd)` verifies the RESULT, bound to the descriptor
 *     it stat'ed so a leaf swapped in afterwards cannot answer in its name.
 *
 * A failure to reach owner-only privacy is a hard error, not a warning: continuing would store an
 * API key at a path this module calls protected.
 *
 * `inject.verifyPrivate` is the ONE seam: it lets a test drive the "not owner-only" refusal that
 * a POSIX `O_EXCL` + `fchmodSync(0o600)` write cannot produce by itself (it is a real refusal on
 * Windows, where the DACL migration can fail). Everything platform-specific stays inside
 * `hasPrivateMode`; nothing else about the write is injectable.
 */
export function writeTypesafeEnv(
  key: string,
  inject: {
    userRoot?: string;
    verifyPrivate?: (path: string, fd: number) => boolean;
    /** Seam for the failure path: a real `fsync` failure cannot be provoked from a test. */
    fsync?: (fd: number) => void;
  } = {},
): string {
  const path = typesafeEnvPath(inject.userRoot);
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let staged = false;
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `TYPESAFE_API_KEY=${key}\n`);
    (inject.fsync ?? fsyncSync)(fd);
    staged = true;
  } finally {
    closeSync(fd);
    if (!staged) {
      // A failure after the open (fchmod, write, fsync) left the KEY sitting in `~/.vibeflow` under a
      // name no reader looks at: the `rename` catch below never runs, because we throw before it.
      rmSync(temporary, { force: true });
    }
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    // A leaf that cannot be replaced (a directory, a foreign mount) must not leave the staged
    // key sitting in `~/.vibeflow` under a name no reader looks at.
    rmSync(temporary, { force: true });
    throw error;
  }
  const opened = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const verify =
      inject.verifyPrivate ??
      ((p: string, f: number) => hasPrivateMode(fstatSync(f), 0o777, 0o600, p, f));
    if (!verify(path, opened)) {
      // Never leave a key at a path this module calls protected, not even for the caller to read.
      rmSync(path, { force: true });
      throw new Error(`typesafe.env is not owner-only at ${path}`);
    }
  } finally {
    closeSync(opened);
  }
  return path;
}
