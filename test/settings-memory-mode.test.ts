import { expect, test } from "bun:test";
import { coerceMemory } from "../src/settings.js";

test("coerceMemory: legacy true → builtin", () => {
  expect(coerceMemory(true)).toBe("builtin");
});
test("coerceMemory: legacy false → false", () => {
  expect(coerceMemory(false)).toBe(false);
});
test("coerceMemory: valid modes pass through", () => {
  expect(coerceMemory("builtin")).toBe("builtin");
  expect(coerceMemory("claude-mem")).toBe("claude-mem");
});
test("coerceMemory: garbage → false", () => {
  expect(coerceMemory("xxx")).toBe(false);
  expect(coerceMemory(undefined)).toBe(false);
  expect(coerceMemory(null)).toBe(false);
});
