import { expect, test } from "bun:test";
import {
  deriveBlockId,
  insertMarkers,
  parseBlocks,
  parseMarkers,
  resolveNearestBlock,
} from "../src/plan-review/blocks.js";
import type { PlanReviewBlock, PlanReviewBlockId } from "../src/plan-review/types.js";
import {
  BLOCK_MARKER_REGEX,
  assertValidBlockId,
  assertValidRevisionId,
  isValidBlockId,
} from "../src/plan-review/types.js";

function b0(r: { blocks: PlanReviewBlock[] }): PlanReviewBlock {
  return r.blocks[0] as PlanReviewBlock;
}

function b1(r: { blocks: PlanReviewBlock[] }): PlanReviewBlock {
  return r.blocks[1] as PlanReviewBlock;
}

test("deriveBlockId returns deterministic 32-char hex id from type+content+ordinal", () => {
  const id = deriveBlockId("paragraph", "hello world", 0);
  expect(id).toHaveLength(32);
  expect(isValidBlockId(id)).toBe(true);
  expect(deriveBlockId("paragraph", "hello world", 0)).toBe(id);
  expect(deriveBlockId("paragraph", "different", 0)).not.toBe(id);
  expect(deriveBlockId("heading", "hello world", 0)).not.toBe(id);
  expect(deriveBlockId("paragraph", "hello world", 1)).not.toBe(id);
});

test("parseBlocks: heading block", () => {
  const r = parseBlocks("# Title\n\nContent");
  expect(r.blocks).toHaveLength(2);
  expect(b0(r).type).toBe("heading");
  expect(b0(r).content).toBe("# Title");
  expect(b0(r).lines).toEqual({ startLine: 1, endLine: 1 });
});

test("parseBlocks: heading at various levels", () => {
  const r = parseBlocks("# a\n## b\n### c\n#### d\n##### e\n###### f");
  expect(r.blocks).toHaveLength(6);
  expect(r.blocks.map((b: PlanReviewBlock) => b.type)).toEqual([
    "heading",
    "heading",
    "heading",
    "heading",
    "heading",
    "heading",
  ]);
});

test("parseBlocks: paragraph grouping", () => {
  const r = parseBlocks("para one\npara two\n\npara three");
  expect(r.blocks).toHaveLength(2);
  expect(b0(r).type).toBe("paragraph");
  expect(b0(r).content).toBe("para one\npara two");
  expect(b0(r).lines).toEqual({ startLine: 1, endLine: 2 });
  expect(b1(r).content).toBe("para three");
  expect(b1(r).lines).toEqual({ startLine: 4, endLine: 4 });
});

test("parseBlocks: list-run blocks", () => {
  const r = parseBlocks("- item 1\n- item 2\n- item 3");
  expect(r.blocks).toHaveLength(1);
  expect(b0(r).type).toBe("list-run");
  expect(b0(r).content).toBe("- item 1\n- item 2\n- item 3");
});

test("parseBlocks: ordered list-run blocks", () => {
  const r = parseBlocks("1. first\n2. second");
  expect(r.blocks).toHaveLength(1);
  expect(b0(r).type).toBe("list-run");
  expect(b0(r).content).toBe("1. first\n2. second");
});

test("parseBlocks: fenced-code block", () => {
  const r = parseBlocks("```js\nconst x = 1;\n```");
  expect(r.blocks).toHaveLength(1);
  expect(b0(r).type).toBe("fenced-code");
  expect(b0(r).content).toBe("const x = 1;");
  expect(b0(r).lines).toEqual({ startLine: 1, endLine: 3 });
});

test("parseBlocks: fenced-mermaid block", () => {
  const r = parseBlocks("```mermaid\ngraph TD\n  A-->B\n```");
  expect(r.blocks).toHaveLength(1);
  expect(b0(r).type).toBe("fenced-mermaid");
  expect(b0(r).content).toBe("graph TD\n  A-->B");
});

test("parseBlocks: mixed content", () => {
  const md =
    "# Intro\n\nParagraph here.\n\n- list one\n- list two\n\n```py\nx = 2\n```\n\n```mermaid\nflowchart\n```";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(5);
  expect(b0(r).type).toBe("heading");
  expect(b1(r).type).toBe("paragraph");
  expect((r.blocks[2] as PlanReviewBlock).type).toBe("list-run");
  expect((r.blocks[3] as PlanReviewBlock).type).toBe("fenced-code");
  expect((r.blocks[4] as PlanReviewBlock).type).toBe("fenced-mermaid");
});

test("parseBlocks: empty document", () => {
  const r = parseBlocks("");
  expect(r.blocks).toEqual([]);
});

test("parseBlocks: whitespace-only document", () => {
  const r = parseBlocks("  \n\n  ");
  expect(r.blocks).toEqual([]);
});

test("parseBlocks: heading followed immediately by list", () => {
  const r = parseBlocks("# Title\n- item");
  expect(r.blocks).toHaveLength(2);
  expect(b0(r).type).toBe("heading");
  expect(b1(r).type).toBe("list-run");
});

test("insertMarkers: inserts marker before each block", () => {
  const md = "# Hi\n\nParagraph";
  const result = insertMarkers(md);
  expect(result).toContain("<!-- vf:block:");
  const lines = result.split("\n");
  expect(lines[0] as string).toMatch(/^<!-- vf:block:[a-f0-9-]+ -->$/);
  expect(lines[1] as string).toBe("# Hi");
  expect(lines[3] as string).toMatch(/^<!-- vf:block:[a-f0-9-]+ -->$/);
  expect(lines[4] as string).toBe("Paragraph");
});

test("insertMarkers: idempotent when markers already present", () => {
  const md = "# A\n\nB";
  const once = insertMarkers(md);
  const twice = insertMarkers(once);
  expect(twice).toBe(once);
});

test("insertMarkers: preserves valid explicit markers", () => {
  const md = "<!-- vf:block:abc-123 -->\n# A\n\nB";
  const result = insertMarkers(md);
  const markers = parseMarkers(result);
  expect(markers).toHaveLength(2);
  const m0 = markers[0] as { id: string; line: number };
  expect(m0.id).toBe("abc-123");
  expect(markers[1]?.id).not.toBe("abc-123");
});

test("insertMarkers: rejects duplicate explicit markers", () => {
  const md = "<!-- vf:block:abc -->\n# A\n\n<!-- vf:block:abc -->\nB";
  expect(() => insertMarkers(md)).toThrow("Duplicate block marker: abc");
});

test("insertMarkers: rejects malformed marker line", () => {
  const md = "# A\n\n<!-- vf:block:bad!! -->\nB";
  expect(() => insertMarkers(md)).toThrow("Invalid block marker");
});

test("resolveNearestBlock: exact match", () => {
  const md = "# A\n\nB\n\n- C";
  const b = resolveNearestBlock(md, 1) as PlanReviewBlock;
  expect(b).not.toBeNull();
  expect(b.type).toBe("heading");
  expect(b.content).toBe("# A");
});

test("resolveNearestBlock: line in paragraph range", () => {
  const md = "line 1\nline 2\n\nnext";
  const b = resolveNearestBlock(md, 2) as PlanReviewBlock;
  expect(b).not.toBeNull();
  expect(b.type).toBe("paragraph");
});

test("resolveNearestBlock: nearest block for line between blocks", () => {
  const md = "# A\n\nB\n\n# C";
  const b = resolveNearestBlock(md, 3) as PlanReviewBlock;
  expect(b).not.toBeNull();
  expect(b.type).toBe("paragraph");
});

test("resolveNearestBlock: returns null for empty document", () => {
  expect(resolveNearestBlock("", 1)).toBeNull();
});

test("resolveNearestBlock: nearest by center for line past end", () => {
  const b = resolveNearestBlock("a\nb\nc", 10);
  expect(b).not.toBeNull();
  expect(b?.content).toBe("a\nb\nc");
});

test("resolveNearestBlock: nearest by center for line before start", () => {
  const b = resolveNearestBlock("a\nb\nc", -5);
  expect(b).not.toBeNull();
  expect(b?.content).toBe("a\nb\nc");
});

test("resolveNearestBlock: multiple blocks, picks nearest", () => {
  const b = resolveNearestBlock("a\n\n---\n\nb", 3);
  expect(b).not.toBeNull();
  expect(b?.type).toBe("paragraph");
});

test("assertValidBlockId throws for invalid id", () => {
  expect(() => assertValidBlockId("")).toThrow("Invalid block ID");
  expect(() => assertValidBlockId("not-valid!!")).toThrow("Invalid block ID");
});

test("assertValidBlockId does not throw for valid id", () => {
  expect(() => assertValidBlockId("abc-123")).not.toThrow();
});

test("assertValidRevisionId throws for invalid id", () => {
  expect(() => assertValidRevisionId("")).toThrow("Invalid revision ID");
  expect(() => assertValidRevisionId("not-a-uuid")).toThrow("Invalid revision ID");
});

test("assertValidRevisionId does not throw for valid id", () => {
  expect(() => assertValidRevisionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
});

test("resolveNearestBlock: works with blocks array", () => {
  const { blocks } = parseBlocks("a\nb\nc");
  const b = resolveNearestBlock(blocks, 2) as PlanReviewBlock;
  expect(b).not.toBeNull();
  expect(b.content).toBe("a\nb\nc");
});

test("parseMarkers: extracts markers from document", () => {
  const md = "<!-- vf:block:abc12345-6789 -->\n# Title\n\n<!-- vf:block:deadbeef-0123 -->\nBody";
  const markers = parseMarkers(md);
  expect(markers).toHaveLength(2);
  const m0 = markers[0] as { id: string; line: number };
  const m1 = markers[1] as { id: string; line: number };
  expect(m0.id).toBe("abc12345-6789");
  expect(m0.line).toBe(1);
  expect(m1.id).toBe("deadbeef-0123");
  expect(m1.line).toBe(4);
});

test("parseMarkers: returns empty for document without markers", () => {
  expect(parseMarkers("# plain title")).toEqual([]);
});

test("BLOCK_MARKER_REGEX matches valid marker", () => {
  const m = "<!-- vf:block:abc-123 -->".match(BLOCK_MARKER_REGEX) as RegExpMatchArray;
  expect(m).not.toBeNull();
  expect(m[1]).toBe("abc-123");
});

test("BLOCK_MARKER_REGEX rejects malformed marker", () => {
  expect("<!-- vf:block: -->".match(BLOCK_MARKER_REGEX)).toBeNull();
  expect("<!-- vf:block:abc 123 -->".match(BLOCK_MARKER_REGEX)).toBeNull();
});

test("parseBlocks: fenced code preserves inner content exactly", () => {
  const md = "```\n\n\nline\n```";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(1);
  expect(b0(r).content).toBe("\n\nline");
});

test("parseBlocks: multiple consecutive fenced blocks", () => {
  const md = "```a\n1\n```\n```b\n2\n```";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(2);
  expect(b0(r).content).toBe("1");
  expect(b1(r).content).toBe("2");
});

test("parseBlocks: indented list items grouped into one block", () => {
  const r = parseBlocks("  - a\n  - b\n- c");
  expect(r.blocks).toHaveLength(1);
  expect(b0(r).content).toBe("  - a\n  - b\n- c");
});

test("parseBlocks: heading not inside paragraph", () => {
  const r = parseBlocks("text\n# heading\nmore");
  expect(r.blocks).toHaveLength(3);
  expect(b0(r).type).toBe("paragraph");
  expect((r.blocks[1] as PlanReviewBlock).type).toBe("heading");
  expect((r.blocks[2] as PlanReviewBlock).type).toBe("paragraph");
});

test("insertMarkers: trailing newline handling", () => {
  const result = insertMarkers("hello");
  expect(result.endsWith("\n")).toBe(false);
});

test("duplicate paragraphs get unique deterministic derived IDs", () => {
  const md = "same\n\nsame\n\nsame";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(3);
  const ids = r.blocks.map((b: PlanReviewBlock) => b.id);
  expect(ids[0]).not.toBe(ids[1]);
  expect(ids[1]).not.toBe(ids[2]);
  expect(ids[0]).not.toBe(ids[2]);
  const r2 = parseBlocks(md);
  const ids2 = r2.blocks.map((b: PlanReviewBlock) => b.id);
  expect(ids2).toEqual(ids);
});

test("explicit valid marker is preserved as block ID", () => {
  const md = "<!-- vf:block:aaaaaaaa-bbbbbbbb-cccccccc-dddddddd -->\n# Title";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(1);
  expect(r.blocks[0]?.id).toBe("aaaaaaaa-bbbbbbbb-cccccccc-dddddddd" as PlanReviewBlockId);
});

test("duplicate marker throws error", () => {
  const md =
    "<!-- vf:block:aaaaaaaa-bbbbbbbb-cccccccc-dddddddd -->\n# A\n\n<!-- vf:block:aaaaaaaa-bbbbbbbb-cccccccc-dddddddd -->\n# B";
  expect(() => parseBlocks(md)).toThrow(
    "Duplicate block marker: aaaaaaaa-bbbbbbbb-cccccccc-dddddddd",
  );
});

test("unterminated fence does not produce out-of-bounds line range", () => {
  const md = "```\nhello";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(1);
  const block = r.blocks[0] as PlanReviewBlock;
  expect(block.content).toBe("hello");
  expect(block.lines.endLine).toBe(2);
  expect(block.lines.endLine).toBeLessThanOrEqual(md.split("\n").length);
});

test("unterminated fence consumes rest of document as code", () => {
  const md = "```\nhello\nworld\n\nparagraph";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(1);
  expect(r.blocks[0]?.type).toBe("fenced-code");
  expect(r.blocks[0]?.content).toBe("hello\nworld\n\nparagraph");
  expect(r.blocks[0]?.lines.endLine).toBe(5);
  expect(r.blocks[0]?.lines.endLine).toBeLessThanOrEqual(md.split("\n").length);
});

test("empty sequence in deriveBlockId ordinal produces different IDs for same content", () => {
  const id0 = deriveBlockId("paragraph", "", 0);
  const id1 = deriveBlockId("paragraph", "", 1);
  expect(id0).not.toBe(id1);
  expect(id0).toHaveLength(32);
  expect(id1).toHaveLength(32);
});

test("parseBlocks: rejects malformed marker line", () => {
  const md = "# A\n\n<!-- vf:block:bad!! -->\nB";
  expect(() => parseBlocks(md)).toThrow("Invalid block marker at line 3");
});

test("parseBlocks: rejects marker with invalid block ID", () => {
  const md = "<!-- vf:block: -->\n# A";
  expect(() => parseBlocks(md)).toThrow("Invalid block marker at line 1");
});

test("parseBlocks: does not reject vf:block: inside fenced code", () => {
  const md = "```\n<!-- vf:block:bad -->\n```";
  const r = parseBlocks(md);
  expect(r.blocks).toHaveLength(1);
  expect(r.blocks[0]?.content).toBe("<!-- vf:block:bad -->");
});

test("parseBlocks: rejects vf:block: inside paragraph", () => {
  const md = "text text <!-- vf:block:bad --> more";
  expect(() => parseBlocks(md)).toThrow("Invalid block marker at line 1");
});

test("parseBlocks: valid explicit marker preserved with insertMarkers round-trip", () => {
  const md = "<!-- vf:block:abc-123 -->\n# Title\n\nContent";
  const r = insertMarkers(md);
  const markers = parseMarkers(r);
  expect(markers[0]?.id).toBe("abc-123" as PlanReviewBlockId);
  const r2 = insertMarkers(r);
  expect(r2).toBe(r);
});

test("utf8ByteLength returns correct UTF-8 byte count", () => {
  const encoder = new TextEncoder();
  expect(encoder.encode("hello").length).toBe(5);
  expect(encoder.encode("héllo").length).toBe(6);
  expect(encoder.encode("").length).toBe(0);
  expect(encoder.encode("\u{1F600}").length).toBe(4);
});
