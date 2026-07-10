export interface AskPrefill {
  path: string;
  start: number;
  end: number;
}

export function prefillFromOpenedFile(
  opened: { path?: string; line?: number } | null,
): AskPrefill | null {
  if (!opened?.path) return null;
  // Guard non-positive/absent lines → 1: /api/ask's validateAskForm rejects a
  // start < 1, so a viewer that ever yields line 0 must not prefill an invalid form.
  const line = opened.line && opened.line > 0 ? opened.line : 1;
  return { path: opened.path, start: line, end: line };
}
