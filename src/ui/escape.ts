/**
 * HTML-escape a string for safe interpolation into innerHTML.
 * Mirrors the `esc()` helper inside shell.html — keep them in sync.
 */
export function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
