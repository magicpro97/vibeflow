import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CTX_DIR } from "../core.js";

/** Injectable git seam: run `git <args>` and report status + captured streams (never throws). */
export type GitRunner = (args: string[]) => { status: number; stdout: string; stderr: string };

/** Injectable filesystem seam so tests never touch the real tree. */
export type FsOps = {
  exists: (p: string) => boolean;
  copyFile: (src: string, dest: string) => void;
  mkdirp: (p: string) => void;
  size: (p: string) => number;
  isDir: (p: string) => boolean;
  writeFile: (p: string, content: string) => void;
};

/** Observed repo state at checkpoint time. */
export interface GitState {
  isRepo: boolean;
  hasCommits: boolean;
  dirty: boolean;
  untracked: string[];
  ignoredDirty: string[];
}

/** A pre-dispatch source-protection checkpoint. */
export interface Checkpoint {
  isRepo: boolean;
  hasCommits: boolean;
  /** SHA of the throwaway WIP snapshot commit (autoWip only), else null. */
  wipSha: string | null;
  /** Directory holding copied ignored files, else null. */
  backupDir: string | null;
  /** Relative paths of ignored files copied into backupDir. */
  backedUp: string[];
  /** Human notes for files intentionally not backed up (too large, etc.). */
  skipped: string[];
  /** SHA the tree sat at BEFORE the WIP commit — the ref to reset back to (null if unborn). */
  baseRef: string | null;
}

export interface CheckpointOpts {
  autoWip?: boolean;
  git?: GitRunner;
  fs?: FsOps;
  sizeCapBytes?: number;
}

/** Files larger than this are noted in `skipped` rather than copied. */
export const SIZE_CAP = 5 * 1024 * 1024;
/** Backup lives under the canonical context dir so it travels with the workspace. */
export const BACKUP_SUBDIR = join(CTX_DIR, "backup");
/** Path prefixes we must never copy (VCS internals, deps, the backup dir itself). */
const PROTECTED_PREFIXES = [".git/", "node_modules/", `${BACKUP_SUBDIR}/`];

/** Default git seam: argv array only, never `shell:true`, output captured as utf8. */
function defaultGit(base: string): GitRunner {
  return (args) => {
    const r = spawnSync("git", args, { cwd: base, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Default filesystem seam backed by node:fs. */
// Test seam: exported so unit tests can exercise the lambda body
// (line 70-79) by calling defaultFs() directly.
export function defaultFs(): FsOps {
  return {
    exists: existsSync,
    copyFile: (src, dest) => {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    },
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    size: (p) => statSync(p).size,
    isDir: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    writeFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    },
  };
}

/** Split git porcelain/ls-files output into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Inspect repo state. Every probe degrades to a safe default on git failure — notably an
 * unborn branch (no commits) reports `hasCommits:false` instead of crashing the caller.
 */
export function gitState(base: string, git: GitRunner = defaultGit(base)): GitState {
  const isRepo = git(["rev-parse", "--is-inside-work-tree"]).status === 0;
  if (!isRepo) {
    return { isRepo: false, hasCommits: false, dirty: false, untracked: [], ignoredDirty: [] };
  }
  const hasCommits = git(["rev-parse", "--verify", "HEAD"]).status === 0;
  const dirty = lines(git(["status", "--porcelain"]).stdout).length > 0;
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]).stdout);
  const ignoredDirty = lines(
    git(["ls-files", "--others", "--ignored", "--exclude-standard"]).stdout,
  );
  return { isRepo, hasCommits, dirty, untracked, ignoredDirty };
}

/** True when a relative path lives under a protected prefix and must never be copied. */
function isProtected(rel: string): boolean {
  return PROTECTED_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
}

/** Make ONE throwaway snapshot commit; returns {wipSha, baseRef}. Never throws on git failure. */
function makeWip(
  base: string,
  runId: string,
  hasCommits: boolean,
  git: GitRunner,
): { wipSha: string | null; baseRef: string | null } {
  // The pre-wip HEAD is the ref the caller resets back to; null on an unborn branch.
  const baseRef = hasCommits
    ? (lines(git(["rev-parse", "--verify", "HEAD"]).stdout)[0] ?? null)
    : null;
  git(["add", "-A"]);
  // --no-verify is intentional: a throwaway snapshot must not run the user's pre-commit hooks.
  git(["commit", "-m", `vibeflow WIP ${runId}`, "--no-verify"]);
  const head = git(["rev-parse", "HEAD"]);
  const wipSha = head.status === 0 ? (lines(head.stdout)[0] ?? null) : null;
  return { wipSha, baseRef };
}

/** Copy ignored+untracked files into the run backup dir, honouring the size cap + protected prefixes. */
function backupIgnored(
  base: string,
  runId: string,
  ignoredDirty: string[],
  fs: FsOps,
  sizeCap: number,
): { backupDir: string | null; backedUp: string[]; skipped: string[] } {
  const candidates = ignoredDirty.filter((rel) => !isProtected(rel));
  if (candidates.length === 0) return { backupDir: null, backedUp: [], skipped: [] };
  const backupDir = join(base, BACKUP_SUBDIR, runId);
  const backedUp: string[] = [];
  const skipped: string[] = [];
  for (const rel of candidates) {
    const src = join(base, rel);
    // git can list stale paths (e.g. from a moved/deleted .viteflow/backup/ tree) that
    // no longer exist on disk — ENOENT. Also: wholly-ignored DIRECTORIES (node_modules/,
    // build/, web/) — EISDIR. Skip both rather than crash the checkpoint (the WIP commit
    // already snapshots every tracked change).
    try {
      if (fs.isDir(src)) {
        skipped.push(`${rel} (ignored directory — not backed up)`);
        continue;
      }
      if (fs.size(src) > sizeCap) {
        skipped.push(`${rel} (> ${sizeCap} bytes size cap)`);
        continue;
      }
      fs.copyFile(src, join(backupDir, rel)); // copy by path only — contents are never read/logged
      backedUp.push(rel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      skipped.push(
        `${rel} (${code === "ENOENT" ? "stale — no longer exists" : (code ?? "copy failed")})`,
      );
    }
  }
  return { backupDir, backedUp, skipped };
}

/** Write `<base>/.vibeflow/.gitignore` (idempotent): ignore transient/secret artifacts
 * (state, dispatch, workunits, backup) but KEEP curated knowledge + canonical context, so
 * `git add -A` never stages a copied secret yet the wiki/config travel with the repo. */
function ensureCtxIgnored(base: string, fs: FsOps): void {
  const ignore = join(base, CTX_DIR, ".gitignore");
  if (fs.exists(ignore)) return;
  const body = [
    "# Ignore transient + secret artifacts; keep curated knowledge and canonical context.",
    "*",
    "!.gitignore",
    "!knowledge/",
    "!knowledge/**",
    "!*.md",
    "!SETTINGS.json",
    "!PROJECT_ID.json",
    "backup/",
    "dispatch/",
    "workunits/",
    "WORKFLOW_STATE.json",
    "",
  ].join("\n");
  fs.writeFile(ignore, body);
}

/**
 * Create a pre-dispatch checkpoint. Reports state and protects source without ever throwing:
 *  - non-repo → all-null report (the integrator decides to refuse or proceed)
 *  - autoWip  → one `git add -A` + `commit --no-verify` snapshot (also seeds an unborn branch)
 *  - always   → copies ignored+untracked files (e.g. .env.local) that `git add -A` skips
 */
export function createCheckpoint(
  base: string,
  runId: string,
  opts: CheckpointOpts = {},
): Checkpoint {
  const git = opts.git ?? defaultGit(base);
  const fs = opts.fs ?? defaultFs();
  const sizeCap = opts.sizeCapBytes ?? SIZE_CAP;
  const empty: Checkpoint = {
    isRepo: false,
    hasCommits: false,
    wipSha: null,
    backupDir: null,
    backedUp: [],
    skipped: [],
    baseRef: null,
  };
  const state = gitState(base, git);
  if (!state.isRepo) return empty;

  // Ensure the transient context dir (state, evidence, ignored-file backups) can NEVER be
  // staged by the WIP `git add -A` below — backups may contain copied secrets (.env.local).
  ensureCtxIgnored(base, fs);

  const wip = opts.autoWip
    ? makeWip(base, runId, state.hasCommits, git)
    : { wipSha: null, baseRef: null };
  const backup = backupIgnored(base, runId, state.ignoredDirty, fs, sizeCap);
  return {
    isRepo: true,
    hasCommits: state.hasCommits,
    wipSha: wip.wipSha,
    backupDir: backup.backupDir,
    backedUp: backup.backedUp,
    skipped: backup.skipped,
    baseRef: wip.baseRef,
  };
}

/** Human-facing recovery instructions for a checkpoint (exact commands the user can run). */
export function recoveryHint(cp: Checkpoint): string {
  if (!cp.isRepo) {
    return "no git — engine edits are irreversible; no checkpoint was taken";
  }
  const parts: string[] = [];
  if (cp.wipSha) {
    const target = cp.baseRef ?? cp.wipSha;
    parts.push(`To undo engine edits: git reset --hard ${target}`);
    parts.push(`(WIP commit ${cp.wipSha} holds your pre-dispatch state)`);
  }
  if (cp.backupDir) {
    parts.push(`Ignored files are restorable from ${cp.backupDir}`);
  }
  if (parts.length === 0) {
    return "no checkpoint snapshot taken — review `git status` before keeping engine edits";
  }
  return parts.join("\n");
}

/** Restore backed-up ignored files from the checkpoint to their original relative paths. */
export function restoreIgnored(cp: Checkpoint, base: string, fs: FsOps = defaultFs()): string[] {
  if (!cp.backupDir) return [];
  const restored: string[] = [];
  for (const rel of cp.backedUp) {
    fs.copyFile(join(cp.backupDir, rel), join(base, rel));
    restored.push(rel);
  }
  return restored;
}
