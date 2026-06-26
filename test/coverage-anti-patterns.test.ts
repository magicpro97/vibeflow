import { describe, expect, test } from "bun:test";
// Coverage anti-pattern assertions. These are guard-rails against the
// patterns that historically caused coverage to drop to 99.9% or
// caused CI/local divergence.
//
// Why this exists: the 100% coverage invariant in this repo is
// fragile. A single `} catch (e) {}` empty block, or a new test
// that uses `Bun.spawn` instead of `makeFakeSpawner`, can drop
// coverage or break CI. Assert the patterns directly so they fail
// loud at test time, not silently in CI.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = [], includeTestFiles = false): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
      walk(p, out, includeTestFiles);
    } else if (
      p.endsWith(".ts") &&
      (includeTestFiles || (!p.endsWith(".test.ts") && !p.endsWith(".d.ts")))
    ) {
      out.push(p);
    }
  }
  return out;
}

describe("coverage anti-patterns (src/ only)", () => {
  const srcFiles = walk("src");

  test("no source file is empty or missing", () => {
    expect(srcFiles.length).toBeGreaterThan(30);
  });

  test("no file has Bun.spawn or spawnSync called at the top level", () => {
    for (const f of srcFiles) {
      const content = readFileSync(f, "utf8");
      // spawnSync / Bun.spawn at module top is forbidden — it
      // runs on import. Wrapped in functions is fine.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (/^\s*(?:await\s+)?(?:spawnSync|Bun\.spawn)\s*\(/.test(line)) {
          // Allow inside function bodies. The simplest heuristic:
          // if the line is indented OR is preceded by a function-like
          // declaration within 5 lines, OK. Otherwise fail.
          const isAtTopLevel = line.startsWith("spawnSync(") || line.startsWith("Bun.spawn(");
          if (isAtTopLevel) {
            throw new Error(`${f}:${i + 1}: top-level spawn is forbidden. Wrap in a function.`);
          }
        }
      }
    }
  });

  test("no file has unreachable defensive code (catch (e) {})", () => {
    // Pattern: } catch (e) { } or } catch { } with no body.
    const badPattern = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/m;
    for (const f of srcFiles) {
      const content = readFileSync(f, "utf8");
      const m = badPattern.exec(content);
      expect(m, `${f} has empty catch block`).toBeNull();
    }
  });

  test("no file ends without a trailing newline", () => {
    for (const f of srcFiles) {
      const content = readFileSync(f, "utf8");
      if (!content.endsWith("\n")) {
        throw new Error(`${f} does not end with a newline`);
      }
    }
  });
});

describe("coverage anti-patterns (test/ only)", () => {
  const testFiles = walk("test", [], true)
    .filter((p) => p.endsWith(".test.ts"))
    // The anti-pattern test itself contains the strings it's looking for;
    // skip it so the linter-style assertions don't trip on their own source.
    .filter((p) => !p.endsWith("coverage-anti-patterns.test.ts"))
    // Terminal prompt tests intentionally spawn a subprocess to exercise
    // real stdin/stdout behavior across the process boundary.
    .filter((p) => !p.endsWith("terminal-prompts.test.ts"))
    // tryLock TOCTOU test intentionally spawns child bun processes to
    // exercise real cross-process lock contention — using a fakeSpawner
    // would defeat the test's purpose (CWE-367 is a real-process race).
    .filter(
      (p) =>
        !p.endsWith("orchestrator/marker.test.ts") &&
        !p.replace(/\\/g, "/").endsWith("orchestrator/marker.test.ts"),
    )
    // The coordinator-skill validator tests intentionally exec the real
    // bash script — a fakeSpawner would just exercise bun's spawn API,
    // not the actual gate. The whole point is to assert the shipped
    // script exits 0 on the shipped SKILL.md (and non-zero on a
    // malformed one). Using a fake would let a broken script pass.
    .filter((p) => !p.endsWith("skills.test.ts"))
    // The hook path-robustness tests intentionally spawn real processes to
    // prove the difference between exec form (argv spawned directly — a path
    // with space/$/backtick survives) and a shell string (`sh -c` word-splits
    // and expands the same path, crashing node). A fakeSpawner cannot
    // reproduce the shell's tokenization, which is the entire point.
    .filter((p) => !p.endsWith("hooks.test.ts"));

  test("no test uses raw Bun.spawn or spawnSync without fakeSpawner", () => {
    for (const f of testFiles) {
      const content = readFileSync(f, "utf8");
      // Tests should use makeFakeSpawner or inject.spawner, not
      // call the real subprocess API.
      const badLines = content.split("\n").filter((l) => /\b(Bun\.spawn|spawnSync)\s*\(/.test(l));
      // Allow inside .skip() or comments. Quick check: comment lines start
      // with // or are inside a /* */ block.
      const realViolations = badLines.filter(
        (l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"),
      );
      expect(
        realViolations,
        `${f} should use makeFakeSpawner, not real spawn. Lines:\n${realViolations.join("\n")}`,
      ).toEqual([]);
    }
  });

  test("no test file is empty", () => {
    expect(testFiles.length).toBeGreaterThan(40);
  });
});
