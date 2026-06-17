/**
 * Minimal, zero-dependency YAML frontmatter parser for SKILL.md files.
 *
 * Supports exactly the subset the Anthropic skill-creator standard needs:
 *   - scalar values: string (quoted or bare), number, boolean, null
 *   - inline lists:  key: [a, b, c]
 *   - block lists:   key:\n  - a\n  - b
 *   - one level of nested maps: key:\n  sub: value
 *   - `#` comments and blank lines
 *
 * It deliberately does NOT implement full YAML — keeping VibeFlow dependency-free.
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

function coerce(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseInlineList(s: string): unknown[] {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  // Quote-aware split: commas inside "..." or '...' are separators, not data.
  // Without this, `["foo, bar", "baz"]` would be split into 3 chunks by the
  // naive split(",") (issue #81).
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (quote !== null) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((x) => coerce(x));
}

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

/**
 * Keys that would mutate the prototype chain if assigned to a normal object.
 * A SKILL.md is attacker-controllable, so a `__proto__:` block must never be
 * able to inject an inherited `status` (or anything else) — that would defeat
 * the "external/unknown skills are never auto-verified" invariant.
 *
 * The list is the full set of `Object.prototype` own properties that can be
 * safely assigned to a plain object. Anything in here is silently dropped
 * (and any child block is consumed) so downstream code keeps using the real
 * inherited method. The set mirrors the OWASP prototype-pollution cheat
 * sheet: __proto__, constructor, prototype, and every method inherited from
 * Object.prototype (valueOf, hasOwnProperty, toString, isPrototypeOf,
 * propertyIsEnumerable, toLocaleString, __defineGetter__, __defineSetter__,
 * __lookupGetter__, __lookupSetter__).
 */
const FORBIDDEN_KEYS = new Set<string>([
  "__proto__",
  "constructor",
  "prototype",
  "valueOf",
  "hasOwnProperty",
  "toString",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Create a prototype-less object so inherited keys can never leak through. */
function emptyMap(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function parseBlock(lines: string[]): Record<string, unknown> {
  const result = emptyMap();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const m = trimmed.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m || m[1] === undefined) {
      i++;
      continue;
    }
    const key = m[1];
    const valuePart = (m[2] ?? "").trim();
    const baseIndent = indentOf(line);

    // Skip prototype-polluting keys entirely (still consume their child block).
    const forbidden = FORBIDDEN_KEYS.has(key);

    if (valuePart === "") {
      // Gather the indented child block.
      const child: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j] as string;
        if (l.trim() === "") {
          child.push(l);
          j++;
          continue;
        }
        if (indentOf(l) <= baseIndent) break;
        child.push(l);
        j++;
      }
      if (!forbidden) {
        const firstReal = child.find((l) => l.trim() !== "");
        if (firstReal?.trim().startsWith("- ")) {
          result[key] = child
            .filter((l) => l.trim().startsWith("- "))
            .map((l) => coerce(l.trim().slice(2)));
        } else if (firstReal) {
          result[key] = parseBlock(child);
        } else {
          result[key] = "";
        }
      }
      i = j;
    } else if (valuePart.startsWith("[") && valuePart.endsWith("]")) {
      if (!forbidden) result[key] = parseInlineList(valuePart);
      i++;
    } else {
      if (!forbidden) result[key] = coerce(valuePart);
      i++;
    }
  }
  return result;
}

/**
 * Split a document into its YAML frontmatter (between the leading `---` fences)
 * and the markdown body. Documents without frontmatter return `{ data: {}, body }`.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const norm = text.replace(/\r\n/g, "\n");
  const lines = norm.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: norm };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { data: {}, body: norm };
  const data = parseBlock(lines.slice(1, endIdx));
  const body = lines
    .slice(endIdx + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return { data, body };
}
