import { expect, test } from "bun:test";
import { ClaudeMemProvider } from "../../src/memory/claude-mem.js";

test("recall parses claude-mem JSON output", () => {
  const p = new ClaudeMemProvider({
    spawner: () => ({
      status: 0,
      stdout: JSON.stringify([{ id: "x", title: "past", text: "a decision", score: 0.9 }]),
    }),
  });
  const hits = p.recall("query");
  expect(hits[0]?.id).toBe("x");
  expect(hits[0]?.content).toBe("a decision");
});
test("recall: non-zero exit → []", () => {
  const p = new ClaudeMemProvider({ spawner: () => ({ status: 1, stdout: "" }) });
  expect(p.recall("q")).toEqual([]);
});
test("recall: spawn throw → []", () => {
  const p = new ClaudeMemProvider({
    spawner: () => {
      throw new Error("ENOENT");
    },
  });
  expect(p.recall("q")).toEqual([]);
});
test("recall: empty stdout → []", () => {
  const p = new ClaudeMemProvider({ spawner: () => ({ status: 0, stdout: "" }) });
  expect(p.recall("q")).toEqual([]);
});
test("recall: bad JSON → []", () => {
  const p = new ClaudeMemProvider({ spawner: () => ({ status: 0, stdout: "not-json" }) });
  expect(p.recall("q")).toEqual([]);
});
test("recall: default spawner (no inject) runs real spawnSync without throwing", () => {
  // No inject → exercises the built-in spawnSync arm. Assert the shape, not a
  // fixed value: on a box where claude-mem is absent Bun returns status:null → [],
  // but on a box with claude-mem installed it could return real hits — either way
  // recall must return an array and never throw.
  const p = new ClaudeMemProvider();
  expect(Array.isArray(p.recall("q"))).toBe(true);
});
