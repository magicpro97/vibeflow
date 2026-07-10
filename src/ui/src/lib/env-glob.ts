// Validate an env-var glob against matchesGlob's ceiling (PREFIX_* | *_SUFFIX | exact).
// Returns null if valid, else an error string. Mirrors src/dispatch/env-filter.ts:111.
// If matchesGlob is upgraded (micromatch / broader glob syntax), update this validator.
export function validateEnvGlob(raw: string): string | null {
  const g = raw.trim();
  if (!g) return "pattern is empty";
  if (/[?\[\]]/.test(g)) return "wildcards ? and [ ] are not supported";

  // Bare "*" is valid (matches everything on that side). Anything else made only
  // of stars (e.g. "**") strips to an empty body — reject, it's not a real glob.
  const body = g.replace(/^\*/, "").replace(/\*$/, "");
  if (body.includes("*")) return "only a single leading or trailing * is supported";
  if (!body) return g === "*" ? null : "invalid pattern — use a single leading or trailing *";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body))
    return "use letters, digits, underscore (optionally one leading/trailing *)";
  return null;
}
