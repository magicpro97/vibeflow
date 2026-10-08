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

export function collapsePreview(body: string): string {
  if (body.length <= COLLAPSE_PREVIEW_CHARS) return body;
  const window = body.slice(0, COLLAPSE_PREVIEW_CHARS);
  const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  return `${(breakAt > 80 ? window.slice(0, breakAt) : window).trimEnd()}…`;
}
