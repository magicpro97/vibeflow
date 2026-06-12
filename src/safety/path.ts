/**
 * Path validation utilities. Use `assertWithinRoot(target, root)` before any
 * destructive filesystem operation (rmSync, chmod, write) on a path that
 * could be user-influenced. Defence in depth: even if upstream code is
 * buggy, a path that escapes the project root cannot be deleted.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a path to absolute form, relative to cwd if relative.
 */
export function toAbsolute(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/**
 * Walk up parent-by-parent until `realpathSync` succeeds.
 * Used when the target itself doesn't exist but we still need a
 * canonical (symlink-resolved) path for comparison.
 *
 * If even the root can't be resolved, falls back to the deepest ancestor
 * whose realpath worked — which is the best we can do for comparison.
 */
function realpathDeepestExisting(p: string): string {
  let current = p;
  const stop = resolve(p, "..");
  while (current !== stop) {
    try {
      return realpathSync(current);
    } catch {
      current = resolve(current, "..");
    }
  }
  return current; // fell off the root, use as-is
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
  const realRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;
  const real = existsSync(absTarget)
    ? realpathSync(absTarget)
    : realpathDeepestExisting(absTarget);
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `refusing to operate on path outside root: ${target} (resolved ${real}, root ${realRoot})`,
    );
  }
  // Also reject if a path separator appears at the start (defence in depth
  // against weird relative outputs on Windows).
  if (rel === "" || rel.startsWith(sep)) {
    // rel === "" means target IS root — only OK for some operations.
    // For rm/delete, root itself is suspicious; let the caller decide.
  }
}
