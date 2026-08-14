import { describe, expect, test } from "bun:test";
import { superpowers } from "../src/commands/superpowers.js";
import type { SuperpowersSyncOptions } from "../src/superpowers-sync-exec.js";
import type { SuperpowersSyncSummary } from "../src/superpowers-sync.js";

const OID = "a".repeat(40);

function summary(dryRun: boolean): SuperpowersSyncSummary {
  return {
    ok: true,
    dryRun,
    commitOID: OID,
    results: [
      {
        engine: "claude",
        status: dryRun ? "planned" : "installed",
        commitOID: OID,
        actions: ["install exact selector"],
        detail: "ok",
      },
      {
        engine: "codex",
        status: "already-current",
        commitOID: OID,
        actions: [],
        detail: "already current",
      },
      {
        engine: "opencode",
        status: "skipped",
        commitOID: OID,
        actions: [],
        detail: "binary not found",
      },
    ],
  };
}

describe("#765 superpowers command", () => {
  test("accepts only sync and known flags before touching execution", () => {
    let calls = 0;
    const inject = {
      sync: () => {
        calls++;
        return summary(true);
      },
      emit: () => {},
    };
    expect(superpowers(undefined, {}, "/repo", inject)).toBe(2);
    expect(superpowers("bad", {}, "/repo", inject)).toBe(2);
    expect(superpowers("sync", { nope: true }, "/repo", inject)).toBe(2);
    expect(superpowers("sync", { yes: true, "dry-run": true }, "/repo", inject)).toBe(2);
    expect(calls).toBe(0);
  });

  test("forwards dry-default, explicit dry-run, and yes exactly", () => {
    const seen: SuperpowersSyncOptions[] = [];
    const inject = {
      sync: (_repo: string, options: SuperpowersSyncOptions) => {
        seen.push(options);
        return summary(!options.yes || options.dryRun === true);
      },
      emit: () => {},
    };
    expect(superpowers("sync", {}, "/repo", inject)).toBe(0);
    expect(superpowers("sync", { "dry-run": true }, "/repo", inject)).toBe(0);
    expect(superpowers("sync", { yes: true }, "/repo", inject)).toBe(0);
    expect(seen).toEqual([
      { yes: false, dryRun: false },
      { yes: false, dryRun: true },
      { yes: true, dryRun: false },
    ]);
  });

  test("renders one deterministic line per engine and returns failure state", () => {
    const lines: string[] = [];
    expect(
      superpowers("sync", {}, "/repo", {
        sync: () => summary(true),
        emit: (line) => lines.push(line),
      }),
    ).toBe(0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain(`dry-run ${OID}`);
    expect(lines.slice(1).map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "claude planned",
      "codex already-current",
      "opencode skipped",
    ]);

    expect(
      superpowers("sync", { yes: true }, "/repo", {
        sync: () => ({ ...summary(false), ok: false, error: "failed safely" }),
        emit: (line) => lines.push(line),
      }),
    ).toBe(1);
  });
});
