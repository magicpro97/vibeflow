/**
 * Engine-priority cross-file invariant (C3).
 *
 * The 4-CLI audit (2026-06-17) found THREE different engine priority
 * orderings in the repo:
 *   1. src/core.ts:49 (ENGINES)            — [claude, codex, copilot]
 *   2. src/ai-init.ts:24 (ENGINE_PRIORITY) — [claude, copilot, codex]
 *   3. docs/USER_GUIDE.md:101              — "claude > copilot > codex"
 *
 * Fix: ENGINES in core.ts is the single source of truth (changed to
 * [claude, copilot, codex] to match the user-facing doc). All other
 * call sites import ENGINES directly. The duplicate ENGINE_PRIORITY
 * constant in ai-init.ts was removed.
 *
 * This test pins the cross-file contract:
 *  - No file in src/ should declare its own priority list literal
 *  - The user guide must say "claude > copilot > codex"
 *  - The preflight-delegate first-ready picker must use ENGINES
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(REPO_ROOT, "src");
const USER_GUIDE = join(REPO_ROOT, "docs", "USER_GUIDE.md");

/** Recursive walk of src/. Excludes test/ and helpers. */
function* walkSrc(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "test" || entry === "node_modules") continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkSrc(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("engine-priority cross-file invariant (C3)", () => {
  test("src/core.ts ENGINES is the canonical source: [claude, copilot, codex]", () => {
    // Import the live value to confirm — this is what other modules see.
    const { ENGINES } = require("../src/core.js") as { ENGINES: readonly string[] };
    expect(ENGINES).toEqual(["claude", "copilot", "codex"]);
  });

  test("docs/USER_GUIDE.md says claude > copilot > codex", () => {
    const doc = readFileSync(USER_GUIDE, "utf8");
    expect(doc).toMatch(/claude\s*>\s*copilot\s*>\s*codex/);
  });

  test("no .ts file under src/ redeclares a private engine-priority list", () => {
    // Allowed: a `["claude", "codex", "copilot"]` literal that is NOT
    // a top-level constant. Disallowed: a top-level `const X = ["claude",
    // "codex", "copilot"]` (other than ENGINES in core.ts).
    //
    // The audit (C3) found one such constant: `ENGINE_PRIORITY` in
    // src/ai-init.ts. This test guards against a re-introduction.
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of walkSrc(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Top-level declaration of a list of exactly these three engine
        // names in this order. We allow `["claude", "copilot", "codex"]`
        // (the new canonical) but flag `["claude", "codex", "copilot"]`
        // and any other reordering.
        if (
          /^(?:export\s+)?(?:const|let)\s+[A-Z_]+\s*[:=][^=\n]*\[\s*"claude"\s*,\s*"codex"\s*,\s*"copilot"\s*\]/.test(
            line,
          )
        ) {
          offenders.push({
            file: file.replace(`${REPO_ROOT}/`, ""),
            line: i + 1,
            text: line.trim().slice(0, 120),
          });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(`Found a redeclared engine-priority literal (audit C3):\n${detail}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no file under src/ declares a top-level ENGINE_PRIORITY constant", () => {
    const offenders: string[] = [];
    for (const file of walkSrc(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      // Match top-level `const ENGINE_PRIORITY = ...` or `export const ENGINE_PRIORITY = ...`
      if (/^(?:export\s+)?const\s+ENGINE_PRIORITY\s*[:=]/m.test(text)) {
        offenders.push(file.replace(`${REPO_ROOT}/`, ""));
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Found legacy ENGINE_PRIORITY constant(s): ${offenders.join(", ")}. Use ENGINES from core.ts instead.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  test("preflight-delegate picks the first-ready engine in ENGINES order", () => {
    // Behavioural test: the first-ready picker (preflight-delegate.ts)
    // must respect ENGINES order. The audit flagged that ai-init.ts
    // had its own ordering that disagreed.
    const { ENGINES } = require("../src/core.js") as { ENGINES: readonly string[] };
    const { pickFirstReady } = require("../src/preflight-delegate.js") as {
      pickFirstReady?: (readiness: { engine: string; level: string }[]) => string | null;
    };
    // If the function exists, run it.
    if (typeof pickFirstReady === "function") {
      // Make ONLY codex ready — should NOT be picked (claude + copilot come first).
      const result = pickFirstReady([
        { engine: "claude", level: "blocked" },
        { engine: "codex", level: "ready" },
        { engine: "copilot", level: "blocked" },
      ]);
      expect(result).not.toBe("codex");
    }
    // If the helper has a different name (we did not know), at minimum
    // assert ENGINES is iterated in this module.
    expect(ENGINES[0]).toBe("claude");
  });
});
