// Renders the composer draft as HTML with participant/agent mentions
// wrapped in chip spans. The composer textarea draws transparent text over
// this layer (aria-hidden, pointer-events none) so mentions read as
// bordered chips like modern chat apps while the draft stays plain text.
const CHIP_TOKEN = /(?:\+[^\s@]+@[^\s,;.!?)]+|-@[^\s,;.!?)]+|@[^\s,;.!?)]+)/gu;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderComposerHighlight(draft: string): string {
  let output = "";
  let cursor = 0;
  for (const match of draft.matchAll(CHIP_TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    output += escapeHtml(draft.slice(cursor, index));
    const kind = token.startsWith("+") ? "agent" : token.startsWith("-@") ? "remove" : "mention";
    output += `<span class="home-composer-chip home-composer-chip--${kind}">${escapeHtml(token)}</span>`;
    cursor = index + token.length;
  }
  output += escapeHtml(draft.slice(cursor));
  return output;
}
