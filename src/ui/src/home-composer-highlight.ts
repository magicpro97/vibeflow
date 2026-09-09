// Splits the composer draft into plain-text and mention segments. The
// composer draws transparent text over an aria-hidden layer that renders
// each mention token as a bordered chip (like modern chat apps) while the
// draft stays plain text. Segments are rendered by Vue interpolation
// (auto-escaped) — never via v-html — so draft text cannot inject markup.
const CHIP_TOKEN = /(?:\+[^\s@]+@[^\s,;.!?)]+|-@[^\s,;.!?)]+|@[^\s,;.!?)]+)/gu;

// Chip labels: token → readable text. Agent tokens map to their suggestion
// labels (`+web_ui@codex` → `Web UI`), participant/@ tokens map to their
// role display or fall back to the token without its leading special
// character. The draft itself is never rewritten — only the visual chip text
// changes, and chip kind is conveyed by color (amber agent / red remove /
// blue mention), not by glyphs.
export function chipLabelFor(
  token: string,
  agentLabels: ReadonlyMap<string, string>,
  participantLabels: ReadonlyMap<string, string>,
): string {
  const suffixMatch = /#\d+$/u.exec(token);
  const suffix = suffixMatch ? suffixMatch[0] : "";
  const base = suffix ? token.slice(0, token.length - suffix.length) : token;
  let label: string;
  if (base.startsWith("+")) {
    label = agentLabels.get(base) ?? prefixLabel(base, agentLabels) ?? base.replace(/^[+-]?@?/, "");
  } else {
    const fallback = base.replace(/^[+-]?@?/, "");
    label = participantLabels.get(fallback) ?? prefixLabel(fallback, participantLabels) ?? fallback;
  }
  return suffix ? `${label} ${suffix}` : label;
}

// While the user is typing or backspacing an agent/participant token, the
// token is only a PREFIX of the full value (e.g. `+web_ui@co` after deleting
// from `+web_ui@codex`). Resolve any key that either extends or is extended
// by the partial token to its stable label, so the chip keeps its readable
// name (and color) instead of flashing raw draft text mid-edit.
function prefixLabel(partial: string, labels: ReadonlyMap<string, string>): string | null {
  for (const key of labels.keys()) {
    if (key.startsWith(partial) || partial.startsWith(key)) return labels.get(key) ?? null;
  }
  return null;
}

// A second call with the same agent token gets a numeric suffix so repeated
// same-role agents stay distinguishable in the draft and on their chips
// (`+web_ui@codex` → `+web_ui@codex#2` → `Web UI #2`).
export function nextMentionToken(draft: string, value: string): string {
  const count = draft.split(value).length - 1;
  return count > 0 ? `${value}#${count + 1}` : value;
}

// Mentions currently present in the draft (agent `+role@engine` tokens and
// `@participant` tokens) — what the Remove toolbar menu can actually remove
// instead of needing a live participant list.
export function findComposerMentions(draft: string): string[] {
  return Array.from(draft.matchAll(CHIP_TOKEN), (match) => match[0]);
}

export type ComposerHighlightSegment =
  | { kind: "text"; text: string }
  | { kind: "chip-agent" | "chip-remove" | "chip-mention"; text: string };

// Draft → renderable segments. Plain text stays raw (Vue escapes it when
// interpolating); mention tokens become labeled chip segments whose class
// carries the kind color.
export function parseComposerHighlight(
  draft: string,
  agentLabels: ReadonlyMap<string, string> = new Map(),
  participantLabels: ReadonlyMap<string, string> = new Map(),
): ComposerHighlightSegment[] {
  const segments: ComposerHighlightSegment[] = [];
  let cursor = 0;
  for (const match of draft.matchAll(CHIP_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "text", text: draft.slice(cursor, index) });
    const token = match[0];
    const kind = token.startsWith("+")
      ? "chip-agent"
      : token.startsWith("-@")
        ? "chip-remove"
        : "chip-mention";
    segments.push({ kind, text: chipLabelFor(token, agentLabels, participantLabels) });
    cursor = index + token.length;
  }
  if (cursor < draft.length) segments.push({ kind: "text", text: draft.slice(cursor) });
  return segments;
}
