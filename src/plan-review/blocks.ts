import { createHash } from "node:crypto";
import type {
  BlockMarker,
  PlanReviewBlock,
  PlanReviewBlockId,
  PlanReviewBlockType,
} from "./types.js";
import { BLOCK_MARKER_REGEX, isValidBlockId } from "./types.js";

function assertNoInvalidMarker(line: string, lineNum: number): void {
  if (!line.includes("vf:block:")) return;
  const m = line.match(BLOCK_MARKER_REGEX);
  const id = m?.[1];
  if (!m || !id || !isValidBlockId(id)) {
    throw new Error(`Invalid block marker at line ${lineNum}: ${line}`);
  }
}

const MARKER_OPEN = "<!-- vf:block:";
const MARKER_CLOSE = " -->";

function line(lines: string[], i: number): string {
  return lines[i] ?? "";
}

function group(m: RegExpMatchArray, idx: number): string {
  return m[idx] ?? "";
}

export function deriveBlockId(
  type: PlanReviewBlockType,
  content: string,
  ordinal: number,
): PlanReviewBlockId {
  return createHash("sha256")
    .update(`${type}\0${content}\0${ordinal}`)
    .digest("hex")
    .slice(0, 32) as PlanReviewBlockId;
}

export interface ParseBlocksOpts {
  detectMarkers?: boolean;
}

export interface ParseResult {
  blocks: PlanReviewBlock[];
  markers: BlockMarker[];
}

export function parseBlocks(markdown: string, opts: ParseBlocksOpts = {}): ParseResult {
  const lines = markdown.split("\n");
  const blocks: PlanReviewBlock[] = [];
  const markers: BlockMarker[] = [];
  const seenMarkerIds = new Set<string>();
  let pendingMarkerId: PlanReviewBlockId | null = null;

  function flushBlock(
    type_: PlanReviewBlockType,
    content: string,
    start: number,
    end: number,
  ): void {
    if (content.length === 0) return;
    const id = pendingMarkerId ?? deriveBlockId(type_, content, blocks.length);
    pendingMarkerId = null;
    blocks.push({ id, type: type_, content, lines: { startLine: start + 1, endLine: end + 1 } });
    markers.push({ id, line: start + 1 });
  }

  let i = 0;
  while (i < lines.length) {
    const cur = line(lines, i);

    if (cur.trim() === "") {
      i++;
      continue;
    }

    assertNoInvalidMarker(cur, i + 1);

    const fenceMatch = cur.match(/^(```+)(\S*)\s*$/);
    if (fenceMatch) {
      const fenceStr = group(fenceMatch, 1);
      const lang = fenceMatch[2] ?? "";
      const contentLines: string[] = [];
      const start = i;
      i++;
      while (i < lines.length) {
        if (line(lines, i).trimStart().startsWith(fenceStr)) break;
        contentLines.push(line(lines, i));
        i++;
      }
      const content = contentLines.join("\n");
      const blockType: PlanReviewBlockType =
        lang.trim() === "mermaid" ? "fenced-mermaid" : "fenced-code";
      const closed = i < lines.length;
      flushBlock(blockType, content, start, closed ? i : i - 1);
      if (closed) i++;
      continue;
    }

    const markerMatch = cur.match(BLOCK_MARKER_REGEX);
    if (markerMatch && isValidBlockId(group(markerMatch, 1))) {
      const markerId = markerMatch[1] as string;
      if (seenMarkerIds.has(markerId)) {
        throw new Error(`Duplicate block marker: ${markerId}`);
      }
      seenMarkerIds.add(markerId);
      if (opts.detectMarkers !== false) {
        pendingMarkerId = markerId as PlanReviewBlockId;
        markers.push({ id: pendingMarkerId, line: i + 1 });
      }
      i++;
      continue;
    }

    // ponytail: list items with continuation lines (indented text after marker)
    // not detected as list-run — add when full AST-based parser needed
    if (/^\s*(?:[-*+]\s|\d+\.\s)/.test(cur)) {
      const start = i;
      const listLines: string[] = [];
      while (i < lines.length) {
        const l = line(lines, i);
        if (l.trim() === "") break;
        if (/^#{1,6}\s/.test(l.trimStart())) break;
        if (/^```/.test(l)) break;
        if (BLOCK_MARKER_REGEX.test(l)) break;
        if (!/^\s*(?:[-*+]\s|\d+\.\s)/.test(l)) break;
        listLines.push(l);
        i++;
      }
      flushBlock("list-run", listLines.join("\n"), start, i - 1);
      continue;
    }

    // ponytail: atx headings with >3 leading spaces not recognized
    // add when CommonMark alignment needed
    if (/^\s{0,3}#{1,6}\s/.test(cur)) {
      flushBlock("heading", cur, i, i);
      i++;
      continue;
    }

    const start = i;
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = line(lines, i);
      if (l.trim() === "") break;
      if (/^#{1,6}\s/.test(l.trimStart())) break;
      if (/^```/.test(l)) break;
      if (BLOCK_MARKER_REGEX.test(l)) break;
      // ponytail: paragraph stops at list markers — inline list detection
      // not supported; add when mixed content needed
      if (/^\s*(?:[-*+]\s|\d+\.\s)/.test(l)) break;
      paraLines.push(l);
      i++;
    }
    flushBlock("paragraph", paraLines.join("\n"), start, i - 1);
  }

  return { blocks, markers };
}

export function insertMarkers(markdown: string): string {
  const lines = markdown.split("\n");
  const markerOrigIdx = new Set<number>();
  const origLineToId = new Map<number, string>();
  const seenIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const cur = line(lines, i);
    assertNoInvalidMarker(cur, i + 1);
    const m = cur.match(BLOCK_MARKER_REGEX);
    if (m && isValidBlockId(group(m, 1))) {
      const id = group(m, 1);
      if (seenIds.has(id)) throw new Error(`Duplicate block marker: ${id}`);
      seenIds.add(id);
      markerOrigIdx.add(i);
      origLineToId.set(i, id);
    }
  }

  const cleanToOrig: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!markerOrigIdx.has(i)) cleanToOrig.push(i);
  }

  const cleanLines = lines.filter((_, i) => !markerOrigIdx.has(i));
  const cleanMd = cleanLines.join("\n");
  const { markers: cleanMarkers } = parseBlocks(cleanMd, { detectMarkers: false });

  const usedIds = new Set<string>();
  const out: string[] = [];
  let mi = 0;

  for (let ci = 0; ci < cleanLines.length; ci++) {
    while (mi < cleanMarkers.length) {
      const cm = cleanMarkers[mi];
      if (!cm || cm.line !== ci + 1) break;
      const origIdx = cleanToOrig[ci] as number;
      const markerOrigIdx_ = origIdx - 1;
      let markerId: PlanReviewBlockId = cm.id;
      if (markerOrigIdx_ >= 0 && origLineToId.has(markerOrigIdx_)) {
        markerId = origLineToId.get(markerOrigIdx_) as PlanReviewBlockId;
      }
      if (usedIds.has(markerId)) throw new Error(`Duplicate block marker: ${markerId}`);
      usedIds.add(markerId);
      out.push(`${MARKER_OPEN}${markerId}${MARKER_CLOSE}`);
      mi++;
    }
    out.push(line(cleanLines, ci));
  }

  // ponytail: all markers are consumed in the for loop above because
  // parseBlocks always returns markers within [1, cleanLines.length].
  // If parseBlocks ever returns markers past the last line, add a
  // trailing while loop here to emit them.

  return out.join("\n");
}

export function resolveNearestBlock(
  source: string | PlanReviewBlock[],
  line_: number,
): PlanReviewBlock | null {
  const blocks = Array.isArray(source)
    ? source
    : parseBlocks(source, { detectMarkers: true }).blocks;

  for (const b of blocks) {
    if (b.lines.startLine <= line_ && line_ <= b.lines.endLine) return b;
  }

  let nearest: PlanReviewBlock | null = null;
  let minDist = Number.POSITIVE_INFINITY;
  for (const b of blocks) {
    const center = (b.lines.startLine + b.lines.endLine) / 2;
    const dist = Math.abs(line_ - center);
    if (dist < minDist) {
      minDist = dist;
      nearest = b;
    }
  }
  return nearest;
}

export function parseMarkers(markdown: string): BlockMarker[] {
  const markers: BlockMarker[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = line(lines, i).match(BLOCK_MARKER_REGEX);
    if (m && isValidBlockId(group(m, 1))) {
      markers.push({ id: m[1] as PlanReviewBlockId, line: i + 1 });
    }
  }
  return markers;
}
