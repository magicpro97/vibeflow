// src/commands/state-frontmatter.ts
//
// Extracted from state.ts to keep that file under the 400-line cap.
// Pure frontmatter parsing + upsert; no I/O, no logbus, no state.
// All exports here are private to the state cluster (state.ts and
// its tests). The cycle rule forbids sibling imports in `commands/`,
// so this file is imported only by state.ts.

/** Parsed brief frontmatter: the body after `--- ... ---` is stripped,
 *  plus the optional `last-consult` timestamp. */
export interface ParsedFrontmatter {
  body: string;
  lastConsult: string | null;
}

/** Parse a leading `---` YAML frontmatter block (best-effort, single-key). */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---")) return { body: raw, lastConsult: null };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw, lastConsult: null };
  const header = raw.slice(3, end).trim();
  const rest = raw.slice(end + 4).replace(/^[\r\n]+/, "");
  let lastConsult: string | null = null;
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^\s*last-consult:\s*(.+?)\s*$/);
    if (m) lastConsult = m[1] ?? null;
  }
  return { body: rest, lastConsult };
}

/** Upsert a key into the YAML frontmatter. Adds the block if absent. */
export function upsertFrontmatter(raw: string, kv: Record<string, string>): string {
  const entries = Object.entries(kv)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end === -1) return `---\n${entries}\n---\n${raw}`;
    const header = raw.slice(3, end);
    const rest = raw.slice(end + 4);
    const updated = upsertKeys(header, kv);
    return `---\n${updated}\n---${rest}`;
  }
  return `---\n${entries}\n---\n\n${raw}`;
}

function upsertKeys(header: string, kv: Record<string, string>): string {
  const lines = header.split(/\r?\n/);
  for (const [k, v] of Object.entries(kv)) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.match(new RegExp(`^\\s*${k}:\\s*`))) {
        lines[i] = `${k}: ${v}`;
        found = true;
        break;
      }
    }
    if (!found) lines.push(`${k}: ${v}`);
  }
  return lines.filter((l, i, arr) => !(l.trim() === "" && i === arr.length - 1)).join("\n");
}
