import { expect, test } from "bun:test";
import { BuiltinMemoryProvider } from "../../src/memory/builtin.js";
import { ClaudeMemProvider } from "../../src/memory/claude-mem.js";
import { resolveMemoryProvider } from "../../src/memory/provider.js";
import { renderMemoryBlock } from "../../src/memory/render.js";

test("resolveMemoryProvider: false → null", () => {
  expect(resolveMemoryProvider(false, "/ctx")).toBeNull();
});
test("resolveMemoryProvider: builtin → BuiltinMemoryProvider", () => {
  expect(resolveMemoryProvider("builtin", "/ctx")).toBeInstanceOf(BuiltinMemoryProvider);
});
test("resolveMemoryProvider: claude-mem → ClaudeMemProvider", () => {
  expect(resolveMemoryProvider("claude-mem", "/ctx")).toBeInstanceOf(ClaudeMemProvider);
});
test("renderMemoryBlock: empty → empty string", () => {
  expect(renderMemoryBlock([])).toBe("");
});
test("renderMemoryBlock: renders hits with id, title, body", () => {
  const out = renderMemoryBlock([
    { id: "ADR-001", title: "use sqlite", content: "decision body", score: 0.9 },
  ]);
  expect(out).toContain("Relevant past decisions:");
  expect(out).toContain("ADR-001");
  expect(out).toContain("use sqlite");
  expect(out).toContain("decision body");
});
test("renderMemoryBlock: content truncated at 200 chars", () => {
  const long = "x".repeat(300);
  const out = renderMemoryBlock([{ id: "A", title: "t", content: long, score: 1 }]);
  const line = out.split("\n").find((l) => l.startsWith("- A")) ?? "";
  expect(line.length).toBeLessThan(250);
});
test("renderMemoryBlock: empty content omits colon", () => {
  const out = renderMemoryBlock([{ id: "A", title: "t", content: "", score: 1 }]);
  const hitLine = out.split("\n").find((l) => l.startsWith("- A")) ?? "";
  expect(hitLine).toContain("- A — t");
  expect(hitLine).not.toContain(":");
});
