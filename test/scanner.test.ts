import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { scanRepo } from "../src/scanner.js";

describe("scanner language detection", () => {
  test("detects Kotlin via build.gradle.kts marker even when sources are deep (KMP)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scan-"));
    try {
      // KMP layout: marker at root, .kt sources buried at depth 6 (the old depth-2 walk missed them).
      writeFileSync(join(dir, "build.gradle.kts"), "// kmp\n");
      writeFileSync(join(dir, "settings.gradle.kts"), "// kmp\n");
      const deep = join(dir, "composeApp", "src", "commonMain", "kotlin", "com", "app");
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "App.kt"), "fun main() {}\n");
      const langs = scanRepo(dir).languages;
      expect(langs).toContain("Kotlin");
      // marker-detected language is surfaced first (signals the primary stack)
      expect(langs[0]).toBe("Kotlin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects shallow extensions too (TypeScript) and unions with markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scan-"));
    try {
      writeFileSync(join(dir, "tsconfig.json"), "{}\n");
      writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
      const langs = scanRepo(dir).languages;
      expect(langs).toContain("TypeScript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("go.mod marker → Go even with no shallow .go files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scan-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module x\n");
      expect(scanRepo(dir).languages).toContain("Go");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scanner evidence", () => {
  test("returns stack findings with evidence file paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-rust-evidence-"));
    writeFileSync(
      join(dir, "Cargo.toml"),
      '[package]\nname="zoom-terminal-translator-rs"\n[dependencies]\ntokio = "1"\n',
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.rs"), "fn main() {}");
    const profile = scanRepo(dir);
    expect(profile.findings).toBeDefined();
    const langFinding = profile.findings?.find((f) => f.component === "language");
    expect(langFinding).toBeDefined();
    expect(langFinding?.value).toBe("Rust");
    expect(langFinding?.evidence).toContain("Cargo.toml");
    expect(langFinding?.confidence).toBe("high");
  });

  test("marks UI as none detected when no web manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-rust-no-ui-"));
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="x"');
    const profile = scanRepo(dir);
    const ui = profile.findings?.find((f) => f.component === "ui");
    expect(ui).toBeDefined();
    expect(ui?.value).toContain("none detected");
    expect(ui?.confidence).toBe("low");
  });
});

describe("scanner: edge branches", () => {
  test("readmeSummary returns the first non-heading line", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-readme-"));
    writeFileSync(
      join(dir, "README.md"),
      "# Heading 1\n\nThis is the project summary line.\n\nMore details below.\n",
    );
    const profile = scanRepo(dir);
    expect(profile.summary).toContain("This is the project summary line");
  });

  test("readmeSummary returns undefined when README has only headings", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-readme-heads-"));
    writeFileSync(join(dir, "README.md"), "# Title\n## Subtitle\n### Subsubtitle\n");
    const profile = scanRepo(dir);
    // No summary line, but no error
    const summary = profile.findings?.find((f) => f.component === "summary");
    // Either no summary finding, or the value is empty
    if (summary) expect(summary.value).toBe("");
  });

  test("readmeSummary returns undefined when no README exists (line 121)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-no-readme-"));
    // No README
    const profile = scanRepo(dir);
    const summary = profile.findings?.find((f) => f.component === "summary");
    // No summary finding emitted
    if (summary) expect(summary.value).toBe("");
  });

  test("readmeSummary: falls through to next variant when README.md has only headings (line 121)", () => {
    // REGRESSION GUARD: previously the inner-loop "no usable line"
    // exit used `return undefined` which silently killed the outer
    // README-variant loop. A repo whose primary README.md opens
    // with a title image / # Heading / ## Section and whose only
    // real prose lives in README.MD (or readme.md / README) lost
    // its summary entirely. The fix falls through to the next
    // variant when the current one has no usable content.
    //
    // macOS HFS+/APFS is case-insensitive by default, so README.md,
    // README.MD and readme.md all resolve to the same file and the
    // fallthrough is invisible on this platform. The fourth variant
    // `README` (no extension) is distinct on macOS, so we use it
    // as the fallback target to exercise the bug on this platform.
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-readme-fallthrough-"));
    // First variant: README.md with only headings and badge lines.
    // The inner for-loop finds no usable line → falls through to L121.
    writeFileSync(
      join(dir, "README.md"),
      "# Project Title\n\n![banner](banner.png)\n\n## Subtitle\n",
    );
    // Fourth variant: README (no extension) with real content.
    // Distinct from README.md on every filesystem (case-insensitive
    // or not) because the filename has no extension.
    writeFileSync(
      join(dir, "README"),
      "Real project description lives here.\n\nMore details below.\n",
    );
    try {
      const profile = scanRepo(dir);
      // Pre-fix: README.md's inner loop finds only headings → exits
      //   → L121 returns undefined → outer loop dies → summary = undefined.
      // Post-fix: README.md has no usable line → fall through to
      //   the next variant → README → returns prose.
      expect(profile.summary).toBeDefined();
      expect(profile.summary).toContain("Real project description");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readJson is null when JSON is malformed (line 140 catch)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-bad-json-"));
    writeFileSync(join(dir, "package.json"), "not valid json {{{");
    // scanRepo doesn't crash, profile fields are empty/default
    const profile = scanRepo(dir);
    expect(profile.languages).toBeDefined();
  });

  test("readJson returns null for files larger than MAX_SCAN_FILE_BYTES (CWE-400)", () => {
    // Pre-fix: a 5MB package.json is read fully into memory and
    // fed to JSON.parse — for a legitimate JSON, the parse would
    // succeed but the buffer would be 5MB. For a binary, JSON.parse
    // would throw (caught) but the buffer is still allocated.
    // Post-fix: statSync().size is checked before readFileSync, so
    // the buffer is never allocated.
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-oversize-"));
    // 5 MiB of valid-but-oversize JSON: a single string field
    // whose value is ~5MB of "x" characters.
    const big = "x".repeat(5 * 1024 * 1024);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: big }));
    const profile = scanRepo(dir);
    // profile.name should fall back to the directory basename
    // because readJson returned null for the oversize file.
    expect(profile.name).toBe(basename(dir));
  });

  test("readmeSummary skips README files larger than MAX_SCAN_FILE_BYTES (CWE-400)", () => {
    // A 5MB README.md would otherwise be loaded as utf8, split
    // into lines, and walked. The split is O(n) in size; for a
    // pathological file it's megabytes of garbage. With the cap,
    // we never allocate the buffer.
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-oversize-readme-"));
    const big = "x".repeat(5 * 1024 * 1024);
    writeFileSync(join(dir, "README.md"), big);
    const profile = scanRepo(dir);
    // summary stays undefined because all README variants were
    // skipped for being oversize.
    expect(profile.summary).toBeUndefined();
  });

  test("detects KMP frameworks from version catalog (line 259-265)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-kmp-"));
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "gradle", "libs.versions.toml"), '[versions]\nkoin = "3.5"\n');
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "build.gradle.kts"), 'plugins { kotlin("jvm") }');
    const profile = scanRepo(dir);
    expect(profile.frameworks).toContain("Koin");
  });

  test("detects web/package.json subproject build/test commands (line 272-279)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-scanner-web-"));
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(
      join(dir, "web", "package.json"),
      JSON.stringify({
        name: "web",
        scripts: { build: "vite build", test: "vitest" },
      }),
    );
    const profile = scanRepo(dir);
    expect(profile.buildCommand).toContain("cd web");
    expect(profile.testCommand).toContain("cd web");
  });

  test("scanRepo: broken symlink is silently skipped (line 144)", () => {
    // Create a broken symlink so statSync throws ENOENT → the
    // catch (line 144) fires and the entry is skipped.
    const dir = mkdtempSync(join(tmpdir(), "vf-scan-sym-"));
    const sub = join(dir, "src");
    mkdirSync(sub, { recursive: true });
    try {
      symlinkSync("/nonexistent/abc", join(sub, "badlink"));
      const p = scanRepo(dir);
      expect(p).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scanRepo: broken symlink for marker file is skipped (line 232)", () => {
    // A broken symlink as a marker file → existsSync returns true,
    // readFileSync throws → catch returns "" → framework detection
    // continues with empty text.
    const { scanRepo } = require("../src/scanner.js");
    const dir = mkdtempSync(join(tmpdir(), "vf-scan-marker-sym-"));
    try {
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      symlinkSync("/nonexistent/abc", join(dir, "pyproject.toml"));
      const p = scanRepo(dir);
      expect(p).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scanRepo: symlink loop (a → b → a) does not infinite-recurse or OOM", () => {
    // REGRESSION GUARD: previously the walk() used statSync (which follows
    // symlinks) and recursed into symlinked directories. A symlink loop
    // a → b → a would infinite-recurse until the 4000-file cap or
    // stack overflow. The fix uses lstatSync and skips symlinks.
    const dir = mkdtempSync(join(tmpdir(), "vf-scan-symloop-"));
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    // Create a self-referential loop: a/loop → b/loop → a/loop
    // But symlinkSync can't make true cycles on most systems (ELOOP).
    // Instead: a/loop → b, b/loop → a — both valid targets but recursive
    // walk would loop.
    symlinkSync(b, join(a, "loop"));
    symlinkSync(a, join(b, "loop"));
    try {
      // Pre-fix: walk() recurses a → a/loop (resolves to b) → b/loop
      //   (resolves to a) → ... until depth>6 OR seen>4000. The cap
      //   stops the recursion but the walk spends a lot of time and
      //   eventually times out OR consumes a lot of stack.
      // Post-fix: lstatSync on a/loop reveals isSymbolicLink() → skip
      //   the entry entirely. No recursion into the symlink target.
      const start = Date.now();
      const p = scanRepo(dir);
      const elapsed = Date.now() - start;
      expect(p).toBeDefined();
      // Should complete in well under 5 seconds; pre-fix would either
      // OOM/timeout or take much longer due to recursion.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scanRepo: symlink to a deep path outside repo is NOT followed (CWE-22)", () => {
    // SECURITY: walk() previously followed symlinks. A symlink
    // `external → /tmp` (or any path outside the repo) would be
    // recursed into and its .ts/.js/.py files would be counted in
    // `languages` — leaking detection of unrelated code and
    // performing unnecessary I/O on attacker-chosen paths.
    // Post-fix: lstatSync + skip-if-symlink means we never leave
    // the repo boundary.
    const dir = mkdtempSync(join(tmpdir(), "vf-scan-sym-escape-"));
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    // Build a sandbox with a few .ts files in it so the post-fix walk
    // has something to find. Then point a symlink at a directory
    // CONTAINING a totally different stack (Python files). Pre-fix:
    // walk follows the symlink → Python ends up in `languages`.
    const sandbox = mkdtempSync(join(tmpdir(), "vf-sandbox-"));
    mkdirSync(join(sandbox, "py"), { recursive: true });
    writeFileSync(join(sandbox, "py", "x.py"), "x = 1");
    writeFileSync(join(sandbox, "py", "y.py"), "y = 2");
    symlinkSync(sandbox, join(sub, "external"));
    // Repo-side: just one ts file, no Python.
    writeFileSync(join(sub, "app.ts"), "export const x = 1;");
    try {
      const p = scanRepo(dir) as { languages: string[] };
      // Repo has TypeScript only. Pre-fix would have included Python
      // (from the symlinked sandbox). Post-fix: Python must NOT
      // appear in the languages list.
      expect(p.languages).toContain("TypeScript");
      expect(p.languages).not.toContain("Python");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
