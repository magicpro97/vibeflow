// test/decisions.test.ts
//
// issue #335: ADR-lite decision log. Pure formatters + FS-injectable append,
// plus the `vf decision` command (add / list / usage errors).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decision } from "../src/commands/config-decision.js";
import { CTX_DIR } from "../src/core.js";
import {
  appendDecision,
  decisionsPath,
  formatDecision,
  nextDecisionSeq,
} from "../src/decisions.js";

describe("decisions — formatters", () => {
  test("formatDecision renders ADR header + sections", () => {
    const out = formatDecision(1, "Pick YAML", "ctx here", "keep yaml");
    expect(out).toContain("ADR-001 | Pick YAML");
    expect(out).toContain("**Context:** ctx here");
    expect(out).toContain("**Decision:** keep yaml");
    expect(out).not.toContain("**Consequences:**");
  });

  test("formatDecision includes Consequences when provided", () => {
    const out = formatDecision(12, "t", "c", "d", "spec stays compliant");
    expect(out).toContain("ADR-012 |");
    expect(out).toContain("**Consequences:** spec stays compliant");
  });

  test("formatDecision strips newlines from the title", () => {
    const out = formatDecision(2, "line1\nline2", "c", "d");
    expect(out).toContain("ADR-002 | line1 line2");
  });

  test("nextDecisionSeq counts existing ADR headers", () => {
    expect(nextDecisionSeq("")).toBe(1);
    expect(nextDecisionSeq("# Decisions\n\nno entries")).toBe(1);
    expect(nextDecisionSeq("## [2026-06-25] ADR-001 | a\n## [2026-06-25] ADR-002 | b\n")).toBe(3);
  });
});

describe("appendDecision — injectable FS", () => {
  test("seeds the header on first write, returns ADR-001", () => {
    const files: Record<string, string> = {};
    const writes: string[] = [];
    const appends: string[] = [];
    const seq = appendDecision("/base", "t", "c", "d", undefined, {
      existsSync: (p) => p in files,
      readFileSync: (p) => files[p] ?? "",
      writeFileSafe: (p, ct) => {
        files[p] = ct;
        writes.push(ct);
      },
      appendFileSafe: (p, ct) => {
        files[p] = (files[p] ?? "") + ct;
        appends.push(ct);
      },
    });
    expect(seq).toBe(1);
    expect(writes[0]).toContain("# Decisions (ADR-lite)"); // header seeded
    expect(appends[0]).toContain("ADR-001 |");
  });

  test("appends ADR-002 when the file already has one entry (no re-seed)", () => {
    const path = decisionsPath("/base");
    const files: Record<string, string> = {
      [path]: "# Decisions (ADR-lite)\n\n## [2026-06-25] ADR-001 | first\n",
    };
    const writes: string[] = [];
    const seq = appendDecision("/base", "second", "c", "d", undefined, {
      existsSync: (p) => p in files,
      readFileSync: (p) => files[p] ?? "",
      writeFileSafe: (_p, ct) => writes.push(ct),
      appendFileSafe: (p, ct) => {
        files[p] = (files[p] ?? "") + ct;
      },
    });
    expect(seq).toBe(2);
    expect(writes).toHaveLength(0); // header NOT re-seeded
    expect(files[path]).toContain("ADR-002 | second");
  });
});

describe("vf decision command", () => {
  function freshRepo(): string {
    return mkdtempSync(join(tmpdir(), "vf-decision-"));
  }

  test("add with all required flags writes the file and returns 0", () => {
    const dir = freshRepo();
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const code = decision("add", {
        title: "Use YAML",
        context: "verified raw",
        decision: "keep yaml",
        consequences: "spec compliant",
      });
      expect(code).toBe(0);
      const path = join(dir, CTX_DIR, "knowledge", "decisions.md");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("ADR-001 | Use YAML");
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("add missing --decision returns 2 (usage error)", () => {
    const dir = freshRepo();
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const code = decision("add", { title: "t", context: "c" });
      expect(code).toBe(2);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("list on empty repo returns 0 with a friendly message", () => {
    const dir = freshRepo();
    const orig = process.cwd();
    process.chdir(dir);
    try {
      expect(decision("list", {})).toBe(0);
      expect(decision(undefined, {})).toBe(0); // bare `vf decision` → list
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("list prints existing decisions", () => {
    const dir = freshRepo();
    const orig = process.cwd();
    process.chdir(dir);
    try {
      decision("add", { title: "T1", context: "c", decision: "d" });
      expect(decision("list", {})).toBe(0);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown subcommand returns 2", () => {
    const dir = freshRepo();
    const orig = process.cwd();
    process.chdir(dir);
    try {
      expect(decision("bogus", {})).toBe(2);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("add ignores a boolean --title (treated as missing) → 2", () => {
    const dir = freshRepo();
    const orig = process.cwd();
    process.chdir(dir);
    try {
      // `--title` with no value parses to boolean true → flagStr returns undefined.
      const code = decision("add", { title: true, context: "c", decision: "d" });
      expect(code).toBe(2);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
