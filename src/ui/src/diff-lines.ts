// src/ui/src/diff-lines.ts — pure unified-diff line classifier for the Changes
// panel. No Vue, no DOM: the panel renders what this returns.
//
// The route caps a diff in bytes (DIFF_MAX_CHARS); this caps the rendered rows.
// Both cuts are reported so the panel can say the view is partial instead of
// silently dropping lines.
export type DiffLineKind = "hunk" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Rendered-row cap; a longer diff reports truncated instead of growing the DOM. */
const LINE_CAP = 2000;

export function classifyDiffLines(text: string): { lines: DiffLine[]; truncated: boolean } {
  // One trailing newline terminates the diff; it is not an empty last row.
  const raw = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (raw === "") return { lines: [], truncated: false };
  const all = raw.split("\n");
  const truncated = all.length > LINE_CAP;
  const kept = truncated ? all.slice(0, LINE_CAP) : all;
  return {
    lines: kept.map((line) => {
      // A CRLF diff keeps a trailing \r on every row after the \n split; under
      // `white-space: pre-wrap` a lone \r is its own break, so the row would
      // render a stray blank line. One trailing \r is the line terminator.
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      return { kind: classifyLine(text), text };
    }),
    truncated,
  };
}

// `+++`/`---` are `diff --git` file headers, not body lines: testing them after
// the single-character prefixes would paint both headers as add/del.
function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "ctx";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}
