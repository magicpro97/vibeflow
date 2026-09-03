import { createHash } from "node:crypto";

export type MarkdownAtomKind = "blank" | "heading" | "fence" | "table-separator" | "content";
export type NormativeCandidateKind =
  | "obligation"
  | "negative"
  | "state-transition"
  | "state-table"
  | "host-action-kind"
  | "authority-domain"
  | "cryptographic-literal";

export interface NormativeCandidateV2 {
  id: string;
  kind: NormativeCandidateKind;
  byte_start: number;
  byte_end: number;
  quote: string;
}

export interface ExtractedMarkdownAtomV2 {
  id: string;
  markdown_kind: MarkdownAtomKind;
  section_id: string;
  section: string;
  source_line_start: number;
  source_line_end: number;
  byte_start: number;
  byte_end: number;
  source_quote: string;
  source_sha256: string;
  candidates: NormativeCandidateV2[];
}

export interface NormativeSectionInventoryV2 {
  semantic_atom_count: number;
  semantic_atom_sha256: string;
  candidate_count: number;
  candidate_sha256: string;
}

export const sha256Text = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));
const compact = (value: string): string => value.trim().replace(/\s+/g, " ");

export function sectionIdForHeading(heading: string): string {
  const slug = compact(heading)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return `section:${slug || "document"}:${sha256Text(compact(heading)).slice(0, 12)}`;
}

function lineParts(text: string): Array<{ raw: string; content: string; byteStart: number }> {
  if (text.length === 0) return [];
  const output: Array<{ raw: string; content: string; byteStart: number }> = [];
  let byteStart = 0;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const raw = match[0] ?? "";
    if (!raw) continue;
    const content = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw;
    output.push({ raw, content, byteStart });
    byteStart += Buffer.byteLength(raw, "utf8");
  }
  return output;
}

function markdownKind(content: string): MarkdownAtomKind {
  if (content.trim() === "") return "blank";
  if (/^#{1,6}\s+/.test(content)) return "heading";
  if (/^\s*(?:```|~~~)/.test(content)) return "fence";
  if (/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(content)) return "table-separator";
  return "content";
}

function matches(line: string, expression: RegExp): Array<{ quote: string; index: number }> {
  return [...line.matchAll(expression)].map((match) => ({
    quote: match[0] ?? "",
    index: match.index ?? 0,
  }));
}

function tableHeaders(lines: readonly { content: string }[]): Map<number, string> {
  const output = new Map<number, string>();
  let header = "";
  let active = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.content ?? "";
    if (!line.trimStart().startsWith("|")) {
      header = "";
      active = false;
      continue;
    }
    const next = lines[index + 1]?.content ?? "";
    if (/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(next)) {
      header = compact(line).toLowerCase();
      active = true;
      continue;
    }
    if (active && !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) output.set(index, header);
  }
  return output;
}

function addCandidate(
  output: NormativeCandidateV2[],
  line: { content: string; byteStart: number },
  kind: NormativeCandidateKind,
  quote: string,
  index: number,
): void {
  const byteStart = line.byteStart + Buffer.byteLength(line.content.slice(0, index), "utf8");
  const byteEnd = byteStart + Buffer.byteLength(quote, "utf8");
  output.push({
    id: `candidate:${kind}:${byteStart}:${sha256Text(quote).slice(0, 12)}`,
    kind,
    byte_start: byteStart,
    byte_end: byteEnd,
    quote,
  });
}

function candidateInventory(
  lines: readonly { content: string; byteStart: number }[],
): Map<number, NormativeCandidateV2[]> {
  const output = new Map<number, NormativeCandidateV2[]>();
  const headers = tableHeaders(lines);
  let union: "host-action-kind" | "authority-domain" | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const candidates: NormativeCandidateV2[] = [];
    const addAll = (kind: NormativeCandidateKind, found: ReturnType<typeof matches>) => {
      for (const item of found) addCandidate(candidates, line, kind, item.quote, item.index);
    };
    addAll("obligation", matches(line.content, /\bmust\b/gi));
    addAll("negative", matches(line.content, /\b(?:never|cannot|forbidden|without)\b/gi));
    addAll("state-transition", matches(line.content, /(?:→|->)/g));
    addAll(
      "cryptographic-literal",
      matches(
        line.content,
        /rawSha256|sha[-_ ]?256|HMAC|digestV1|lowercaseHex|canonicali[sz](?:ation|ed|e)?/gi,
      ),
    );
    addAll(
      "cryptographic-literal",
      matches(line.content, /\bVF-[A-Z0-9][A-Z0-9/-]*\\0v[0-9]+\\0/gi),
    );
    addAll(
      "cryptographic-literal",
      matches(line.content, /\bVF-[A-Z0-9][A-Z0-9/-]*(?:\\0v[0-9]+\\0)?/g),
    );
    const header = headers.get(index) ?? "";
    if (/\b(?:state|status|phase|from|to|outcome|transition|recovery)\b/.test(header)) {
      addCandidate(candidates, line, "state-table", line.content, 0);
    }
    if (/\bdomain\b/.test(header))
      addCandidate(candidates, line, "authority-domain", line.content, 0);
    if (/\btype\s+HostActionKind\s*=/.test(line.content)) union = "host-action-kind";
    else if (/\btype\s+[A-Za-z0-9_]*Domain[A-Za-z0-9_]*\s*=/.test(line.content))
      union = "authority-domain";
    if (union) addAll(union, matches(line.content, /"[^"\r\n]+"/g));
    if (union && line.content.includes(";")) union = null;
    const unique = new Map(
      candidates.map((candidate) => [
        `${candidate.kind}:${candidate.byte_start}:${candidate.byte_end}:${candidate.quote}`,
        candidate,
      ]),
    );
    output.set(
      index,
      [...unique.values()].sort(
        (left, right) => left.byte_start - right.byte_start || left.kind.localeCompare(right.kind),
      ),
    );
  }
  return output;
}

export function extractNormativeAtoms(designText: string): ExtractedMarkdownAtomV2[] {
  const lines = lineParts(designText);
  const candidates = candidateInventory(lines);
  let heading = "Document";
  let sectionId = sectionIdForHeading(heading);
  return lines.map((line, index) => {
    const kind = markdownKind(line.content);
    if (kind === "heading") {
      heading = compact(line.content.replace(/^#{1,6}\s+/, ""));
      sectionId = sectionIdForHeading(heading);
    }
    const byteEnd = line.byteStart + Buffer.byteLength(line.raw, "utf8");
    return {
      id: `atom:${index + 1}:${sha256Text(line.raw).slice(0, 16)}`,
      markdown_kind: kind,
      section_id: sectionId,
      section: heading,
      source_line_start: index + 1,
      source_line_end: index + 1,
      byte_start: line.byteStart,
      byte_end: byteEnd,
      source_quote: line.raw,
      source_sha256: sha256Text(line.raw),
      candidates: candidates.get(index) ?? [],
    };
  });
}

export function normativeSectionInventories(
  atoms: readonly ExtractedMarkdownAtomV2[],
): Map<string, NormativeSectionInventoryV2> {
  const grouped = new Map<string, ExtractedMarkdownAtomV2[]>();
  for (const atom of atoms) {
    const entries = grouped.get(atom.section_id) ?? [];
    entries.push(atom);
    grouped.set(atom.section_id, entries);
  }
  return new Map(
    [...grouped].map(([sectionId, entries]) => {
      const semantic = entries
        .filter((atom) => atom.markdown_kind === "content")
        .map((atom) => ({
          id: atom.id,
          source_sha256: atom.source_sha256,
          byte_start: atom.byte_start,
          byte_end: atom.byte_end,
        }));
      const candidates = entries.flatMap((atom) => atom.candidates);
      return [
        sectionId,
        {
          semantic_atom_count: semantic.length,
          semantic_atom_sha256: sha256Text(canonicalJson(semantic)),
          candidate_count: candidates.length,
          candidate_sha256: sha256Text(canonicalJson(candidates)),
        },
      ];
    }),
  );
}
