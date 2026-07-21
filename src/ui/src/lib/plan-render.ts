// PlanReviewBlock DTO shape duplicated from src/plan-review/types.ts
// because UI workspace pkg cannot resolve cross-package imports
// (root tsconfig excludes src/ui; ui tsconfig scoped to src/ui/src).

export const MAX_MERMAID_BYTES = 32 * 1024;

export interface HeadingDescriptor {
  type: "heading";
  id: string;
  level: number;
  text: string;
}

export interface ParagraphDescriptor {
  type: "paragraph";
  id: string;
  text: string;
}

export interface ListRunDescriptor {
  type: "list-run";
  id: string;
  text: string;
}

export interface FencedCodeDescriptor {
  type: "fenced-code";
  id: string;
  language: string;
  text: string;
}

export interface FencedMermaidDescriptor {
  type: "fenced-mermaid";
  id: string;
  fallback: MermaidFallback;
}

export type RenderDescriptor =
  | HeadingDescriptor
  | ParagraphDescriptor
  | ListRunDescriptor
  | FencedCodeDescriptor
  | FencedMermaidDescriptor;

export interface MermaidFallback {
  reason: "no-engine" | "too-large";
  source: string;
}

const htmlRe = /[&<>"']/g;
const htmlEscMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(htmlRe, (c) => htmlEscMap[c] ?? c);
}

function headingLevel(text: string): number {
  const m = text.match(/^#{1,6}/);
  return m ? m[0].length : 1;
}

function stripHeading(text: string): string {
  return text.replace(/^#{1,6}\s*/, "").trim();
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function makeMermaidFallback(source: string): MermaidFallback {
  return {
    reason: utf8ByteLength(source) > MAX_MERMAID_BYTES ? "too-large" : "no-engine",
    source,
  };
}

export function renderBlock(block: {
  id: string;
  type: string;
  content: string;
}): RenderDescriptor {
  const { id, type, content } = block;

  switch (type) {
    case "heading":
      return {
        type: "heading",
        id,
        level: headingLevel(content),
        text: esc(stripHeading(content)),
      };
    case "paragraph":
      return { type: "paragraph", id, text: esc(content) };
    case "list-run":
      return { type: "list-run", id, text: esc(content) };
    case "fenced-code":
      return { type: "fenced-code", id, language: "", text: esc(content) };
    case "fenced-mermaid":
      return { type: "fenced-mermaid", id, fallback: makeMermaidFallback(content) };
    default:
      return { type: "paragraph", id, text: esc(content) };
  }
}

export function renderBlocks(
  blocks: readonly { id: string; type: string; content: string }[],
): RenderDescriptor[] {
  return blocks.map(renderBlock);
}
