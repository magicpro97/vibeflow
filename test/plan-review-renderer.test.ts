import { describe, expect, test } from "bun:test";
import { MAX_MERMAID_BYTES, renderBlock, renderBlocks } from "../src/ui/src/lib/plan-render.js";

describe("renderBlock", () => {
  test("heading extracts level and strips markers", () => {
    const r = renderBlock({ id: "h1", type: "heading", content: "## Section 2" });
    expect(r).toEqual({ type: "heading", id: "h1", level: 2, text: "Section 2" });
  });

  test("heading level 1 no space after #", () => {
    const r = renderBlock({ id: "h2", type: "heading", content: "#Title" });
    expect(r).toEqual({ type: "heading", id: "h2", level: 1, text: "Title" });
  });

  test("heading level 6", () => {
    const r = renderBlock({ id: "h3", type: "heading", content: "###### deep" });
    expect(r).toEqual({ type: "heading", id: "h3", level: 6, text: "deep" });
  });

  test("paragraph returns escaped text", () => {
    const r = renderBlock({ id: "p1", type: "paragraph", content: "Hello world" });
    expect(r).toEqual({ type: "paragraph", id: "p1", text: "Hello world" });
  });

  test("list-run returns escaped text", () => {
    const r = renderBlock({
      id: "l1",
      type: "list-run",
      content: "- item one\n- item two",
    });
    expect(r).toEqual({
      type: "list-run",
      id: "l1",
      text: "- item one\n- item two",
    });
  });

  test("fenced-code returns escaped code with empty language", () => {
    const r = renderBlock({
      id: "c1",
      type: "fenced-code",
      content: "const x = 1;",
    });
    expect(r).toEqual({
      type: "fenced-code",
      id: "c1",
      language: "",
      text: "const x = 1;",
    });
  });

  test("fenced-mermaid returns no-engine fallback with source", () => {
    const r = renderBlock({
      id: "m1",
      type: "fenced-mermaid",
      content: "graph TD\n  A-->B",
    });
    expect(r).toEqual({
      type: "fenced-mermaid",
      id: "m1",
      fallback: { reason: "no-engine", source: "graph TD\n  A-->B" },
    });
  });

  test("fenced-mermaid oversized returns too-large fallback", () => {
    const big = "x".repeat(MAX_MERMAID_BYTES + 1);
    const r = renderBlock({
      id: "m2",
      type: "fenced-mermaid",
      content: big,
    });
    expect(r.type).toBe("fenced-mermaid");
    if (r.type === "fenced-mermaid") {
      expect(r.fallback.reason).toBe("too-large");
      expect(r.fallback.source).toBe(big);
    }
  });

  test("raw script content escaped, not rendered as HTML", () => {
    const r = renderBlock({
      id: "p2",
      type: "paragraph",
      content: "<script>alert('xss')</script>",
    });
    expect(r).toEqual({
      type: "paragraph",
      id: "p2",
      text: "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
    });
  });

  test("HTML angle brackets in code block escaped", () => {
    const r = renderBlock({
      id: "c2",
      type: "fenced-code",
      content: "<div>hello</div>",
    });
    expect(r).toEqual({
      type: "fenced-code",
      id: "c2",
      language: "",
      text: "&lt;div&gt;hello&lt;/div&gt;",
    });
  });

  test("unknown type falls back to paragraph", () => {
    const r = renderBlock({ id: "x1", type: "unknown", content: "fallback" });
    expect(r).toEqual({ type: "paragraph", id: "x1", text: "fallback" });
  });
});

describe("renderBlocks", () => {
  test("maps multiple blocks in order", () => {
    const blocks = [
      { id: "h", type: "heading" as const, content: "# Intro" },
      { id: "p", type: "paragraph" as const, content: "Body" },
    ];
    const rs = renderBlocks(blocks);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toEqual({ type: "heading", id: "h", level: 1, text: "Intro" });
    expect(rs[1]).toEqual({ type: "paragraph", id: "p", text: "Body" });
  });

  test("empty array", () => {
    expect(renderBlocks([])).toEqual([]);
  });
});
