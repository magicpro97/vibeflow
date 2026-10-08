// Completed-answer collapse policy (Orca 1.4.210 "collapsed chat answers" port).
export const COLLAPSE_MIN_CHARS = 600;
export const COLLAPSE_PREVIEW_CHARS = 400;

export function shouldCollapseAnswer(input: {
  kind: string;
  complete: boolean;
  body: string;
  isLast: boolean;
}): boolean {
  if (input.kind !== "assistant" || !input.complete || input.isLast) return false;
  return input.body.length >= COLLAPSE_MIN_CHARS;
}

/**
 * Index of the conversation tail (-1 when none): the last row whose kind is
 * `assistant` or `user`. Finality for answer collapse is relative to these
 * rows only — trailing tool/system/boundary noise must never collapse the
 * latest answer (the documented promise is that it stays expanded), while an
 * answer a later user message has already superseded collapses normally.
 */
export function finalAnswerIndex(items: readonly { kind: string }[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const kind = items[index]?.kind;
    if (kind === "assistant" || kind === "user") return index;
  }
  return -1;
}

export function collapsePreview(body: string): string {
  if (body.length <= COLLAPSE_PREVIEW_CHARS) return body;
  const window = body.slice(0, COLLAPSE_PREVIEW_CHARS);
  const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  return `${(breakAt > 80 ? window.slice(0, breakAt) : window).trimEnd()}…`;
}
