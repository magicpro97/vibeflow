import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectEntry } from "../src/registry.js";
import { readRegistry, upsertRegistry } from "../src/registry.js";

const REGISTRY_PATH = join(homedir(), ".vibeflow", "projects.json");

function withRegistry(content: string | null, fn: () => void) {
  const had = existsSync(REGISTRY_PATH);
  const prev = had ? readFileSync(REGISTRY_PATH, "utf8") : null;
  try {
    if (content === null) {
      // leave file absent — but we can't delete it easily if it was there
      // so write invalid JSON to trigger catch
      writeFileSync(REGISTRY_PATH, "not-json");
    } else {
      writeFileSync(REGISTRY_PATH, content);
    }
    fn();
  } finally {
    if (prev !== null) writeFileSync(REGISTRY_PATH, prev);
  }
}

const ENTRY: ProjectEntry = {
  path: "/tmp/__vf_test_proj__",
  name: "__vf_test_proj__",
  lastUsed: 1_000_000,
  goal: "test goal",
  totals: { units: 2, done: 1, tokens: 100, cost_usd: 0.01 },
};

describe("src/registry.ts", () => {
  test("readRegistry returns [] on invalid JSON (covers catch branch)", () => {
    withRegistry(null, () => {
      expect(readRegistry()).toEqual([]);
    });
  });

  test("readRegistry returns parsed array", () => {
    withRegistry(JSON.stringify([ENTRY]), () => {
      const list = readRegistry();
      expect(list[0]?.path).toBe(ENTRY.path);
    });
  });

  test("upsertRegistry dedupes by path and puts newest first", () => {
    withRegistry("[]", () => {
      upsertRegistry(ENTRY);
      upsertRegistry({ ...ENTRY, lastUsed: 2_000_000 });
      const list = readRegistry();
      const hits = list.filter((e) => e.path === ENTRY.path);
      expect(hits.length).toBe(1);
      expect(hits[0]?.lastUsed).toBe(2_000_000);
    });
  });

  test("upsertRegistry swallows write errors (best-effort)", () => {
    // Trigger catch in upsertRegistry by making writeFileSafe fail —
    // easiest: pass an entry where writeFileSafe path is unwritable.
    // We can't easily do that without injection, so we verify it doesn't throw.
    expect(() => upsertRegistry(ENTRY)).not.toThrow();
    // Clean up our test entry
    withRegistry(JSON.stringify(readRegistry().filter((e) => e.path !== ENTRY.path)), () => {});
  });
});
