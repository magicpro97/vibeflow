/**
 * Path validation utilities. Use `assertWithinRoot(target, root)` before any
 * destructive filesystem operation (rmSync, chmod, write) on a path that
 * could be user-influenced. Defence in depth: even if upstream code is
 * buggy, a path that escapes the project root cannot be deleted.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a path to absolute form, relative to cwd if relative. If the
 * path already exists, also realpath it so that symlinks (notably
 * macOS /var/folders -> /private/var/folders) are resolved uniformly.
 * This keeps callers' `root` and `target` on the same canonical
 * filesystem view before they reach assertWithinRoot's
 * relative(realRoot, real) check.
 */
export function toAbsolute(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(p);
  return existsSync(abs) ? realpathSync(abs) : abs;
}

/**
 * Walk up parent-by-parent until `realpathSync` succeeds.
 * Used when the target itself doesn't exist but we still need a
 * canonical (symlink-resolved) path for comparison.
 *
 * If even the root can't be resolved, falls back to the deepest ancestor
 * whose realpath worked — which is the best we can do for comparison.
 *
 * Bounded to MAX_REALPATH_DEPTH iterations to avoid pathological walks
 * (e.g. a malicious `/proc/self/root/...` chain on Linux, or a deeply
 * nested non-existing path on a slow filesystem). At each step the
 * parent is one level closer to filesystem root, so MAX_REALPATH_DEPTH
 * caps absolute path length at MAX_REALPATH_DEPTH * max-component, which
 * is comfortably larger than any realistic path on any OS we support.
 *
 * SECURITY NOTE: the depth cap is a performance / DoS guard, NOT a
 * security boundary. If the cap is exhausted, the fallback `current`
 * is the most-recently-failed ancestor (an un-resolved path). The
 * downstream `relative(realRoot, real)` check in {@link assertWithinRoot}
 * is what enforces the security invariant — if the relative path
 * escapes, the assert throws regardless of whether realpath was
 * resolved or capped.
 */
const MAX_REALPATH_DEPTH = 4096;

function realpathDeepestExisting(p: string): string {
  let current = p;
  // Walk up from `p` toward the filesystem root. The previous version
  // set `stop = resolve(p, "..")` and exited when `current === stop`,
  // which on a non-existing path would walk exactly ONE step up and
  // return an un-realpathed value. That broke assertWithinRoot on
  // macOS (where /var/folders -> /private/var/folders) for any
  // non-existing child of an existing test root. New approach: keep
  // walking up while the current value cannot be realpath'd, and
  // return the highest ancestor that resolves.
  const root = resolve(p, "/..");
  let depth = 0;
  while (depth < MAX_REALPATH_DEPTH) {
    if (current === root) break; // can't go higher than /
    try {
      return realpathSync(current);
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) break; // parent is self — at /
      current = parent;
      depth++;
    }
  }
  // Last resort: try realpath of the current dir.
  try {
    return realpathSync(current);
  } catch {
    return current;
  }
}

/**
 * Throw if `target` is not within `root` (after symlink resolution).
 * Use this BEFORE any destructive operation (rm, chmod, write).
 *
 * Defence in depth: even if upstream code is buggy, a path that escapes
 * the project root cannot be deleted.
 */
export function assertWithinRoot(target: string, root: string): void {
  const absRoot = toAbsolute(root);
  const absTarget = toAbsolute(target);
  // Realpath resolves symlinks. If the root or target doesn't exist yet, walk
  // up parent-by-parent until realpathSync succeeds, then use that. This
  // handles the case where an intermediate symlink points outside root.
  //
  // PLATFORM NOTE (Windows): realpathSync on Windows does NOT normalize
  // across drive boundaries — `C:\a\..\D:\b` is not detected as a
  // cross-drive traversal. The call-site caller is responsible for
  // passing a root + target on the same drive. This is acceptable for
  // VibeFlow's use case (one project = one worktree = one drive on
  // Windows), but a defense-in-depth improvement would split-and-resolve
  // each drive root separately before the relative() check.
  const realRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;
  const real = existsSync(absTarget) ? realpathSync(absTarget) : realpathDeepestExisting(absTarget);
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `refusing to operate on path outside root: ${target} (resolved ${real}, root ${realRoot})`,
    );
  }
  // rel === "" means target IS root (after symlink resolution). For
  // destructive operations like rmSync, this is almost always a bug:
  // the caller almost certainly meant to operate on a sub-path, not
  // the entire project root. Fail-closed: reject and let the caller
  // pass the explicit sub-path they intended. If a legitimate use case
  // arises (e.g. "clean the build dir" where the build dir is the root),
  // the caller can opt out by passing the path with a trailing separator
  // — but that needs an explicit decision, not silent acceptance.
  if (rel === "" || rel.startsWith(sep)) {
    throw new Error(
      `refusing to operate on path equal to root: ${target} (resolved ${real}, root ${realRoot}). Pass an explicit sub-path; rmSync of the project root is never safe.`,
    );
  }
}
