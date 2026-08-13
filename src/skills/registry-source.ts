// #763 Layer 1: `owner/repo` shorthand for `vf skills registry add`.
// Pure resolver — the ONLY new code for Layer 1. Pin/lock already ship in
// registry-channel.ts (registryAdd); install is Layer 3 (#765). Kept in its
// own module because registry-channel.ts sits at the 400-line cap.

export interface ResolvedRegistrySource {
  /** Git URL to clone (shorthand expanded, or the input URL passed through). */
  url: string;
  /** Default registry name derived from a shorthand repo slug; undefined for a URL. */
  name: string | undefined;
  /** True when the input was `owner/repo` shorthand (vs. an explicit URL). */
  shorthand: boolean;
}

// A spec is a URL (pass through) when it carries a scheme or scp-style host.
function looksLikeUrl(spec: string): boolean {
  return spec.includes("://") || /^[\w.-]+@[\w.-]+:/.test(spec);
}

// GitHub owner/repo: each segment is a GitHub-legal name (alnum, dot, hyphen,
// underscore), exactly one slash, no traversal/space/control chars.
const SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

/**
 * Resolve an `add` source spec.
 * - `owner/repo` → `{ url: https://github.com/owner/repo.git, name: <repo slug>, shorthand: true }`.
 * - an explicit git URL → `{ url: <unchanged>, name: undefined, shorthand: false }`.
 * - anything else (empty, multi-slash, spaces, traversal, null byte) → `null` (caller errors).
 */
export function resolveRegistrySource(spec: string): ResolvedRegistrySource | null {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  if (looksLikeUrl(trimmed)) {
    return { url: trimmed, name: undefined, shorthand: false };
  }

  const m = SHORTHAND.exec(trimmed);
  if (!m) return null;
  const owner = m[1] as string;
  // Strip a trailing ".git" on the repo once, then re-add it to the URL so a
  // `owner/repo.git` shorthand doesn't double the suffix. Name = repo slug,
  // lowercased — matches isValidRegistryName (lowercase-hyphen/dot).
  const repo = (m[2] as string).replace(/\.git$/i, "");
  const name = repo.toLowerCase();
  return { url: `https://github.com/${owner}/${repo}.git`, name, shorthand: true };
}
