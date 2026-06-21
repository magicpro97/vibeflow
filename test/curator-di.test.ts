import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curateSkillsFromEvidence } from "../src/skills/curator.js";
import { DEFAULT_WHITELIST } from "../src/skills/whitelist.js";

describe("curator DI seam (curateSkillsFromEvidence inject.spawnSync)", () => {
  let dir: string;
  let origCwd: string;
  let calls: Array<{ cmd: string; args: readonly string[]; options: SpawnSyncOptions }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-curator-di-"));
    origCwd = process.cwd();
    process.chdir(dir);
    calls = [];
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses injected spawnSync to fake a successful ctx7 install (no real npx)", () => {
    // Seed stack-evidence.md with one of the whitelist keywords (PostgreSQL).
    mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
    writeFileSync(
      join(dir, ".vibeflow", "ai-context", "stack-evidence.md"),
      ["| Component | Value |", "|-----------|-------|", "| DB | PostgreSQL 16 |", ""].join("\n"),
    );
    // The injected spawnSync records calls and reports a successful install.
    // We return a synthetic SpawnSyncReturns shape (no real spawn) so the
    // test stays fast and the coverage anti-pattern check (no raw
    // spawnSync) stays green.
    // Synthetic successful-install response. The curator code only
    // reads `status`, `stdout`, and `stderr`, so the cast is safe.
    const fakeSpawn = (cmd: string, args: readonly string[], options: SpawnSyncOptions): any => {
      // biome-ignore lint/suspicious/noExplicitAny: test fake; SyncSubprocess type is hard to construct synthetically
      calls.push({ cmd, args, options });
      return {
        pid: 0,
        output: [Buffer.from(""), Buffer.from("installed"), Buffer.from("")],
        stdout: Buffer.from("installed"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
      };
    };

    const result = curateSkillsFromEvidence(dir, "claude", {
      whitelist: DEFAULT_WHITELIST,
      ctx7Authenticated: true,
      inject: { spawnSync: fakeSpawn },
    });

    // At least one npx ctx7 call must have been issued — proves the seam wired through.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.cmd).toBe("npx");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["ctx7", "skills", "install"]);
    // Result is shaped correctly even with the injected runner.
    expect(Array.isArray(result.installed)).toBe(true);
    expect(Array.isArray(result.unmatched)).toBe(true);
  });
});
