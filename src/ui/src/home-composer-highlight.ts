// Renders the composer draft as HTML with participant/agent mentions
// wrapped in chip spans. The composer textarea draws transparent text over
// this layer (aria-hidden, pointer-events none) so mentions read as
// bordered chips like modern chat apps while the draft stays plain text.
const CHIP_TOKEN = /(?:\+[^\s@]+@[^\s,;.!?)]+|-@[^\s,;.!?)]+|@[^\s,;.!?)]+)/gu;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

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
    label = agentLabels.get(base) ?? base.replace(/^[+-]?@?/, "");
  } else {
    const fallback = base.replace(/^[+-]?@?/, "");
    label = participantLabels.get(fallback) ?? fallback;
  }
  return suffix ? `${label} ${suffix}` : label;
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

// Apply chipLabelFor while rendering, keeping the label escaped in the chip.
export function renderComposerHighlight(
  draft: string,
  agentLabels: ReadonlyMap<string, string> = new Map(),
  participantLabels: ReadonlyMap<string, string> = new Map(),
): string {
  let output = "";
  let cursor = 0;
  for (const match of draft.matchAll(CHIP_TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    output += escapeHtml(draft.slice(cursor, index));
    const kind = token.startsWith("+") ? "agent" : token.startsWith("-@") ? "remove" : "mention";
    const label = chipLabelFor(token, agentLabels, participantLabels);
    output += `<span class="home-composer-chip home-composer-chip--${kind}">${escapeHtml(label)}</span>`;
    cursor = index + token.length;
  }
  output += escapeHtml(draft.slice(cursor));
  return output;
}
