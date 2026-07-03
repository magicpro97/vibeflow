import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canary } from "../src/commands/canary.js";
import { readState, writeState } from "../src/core.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-canary-cmd-"));
  dirs.push(d);
  mkdirSync(join(d, ".vibeflow"), { recursive: true });
  return d;
}

const baseState = (units: unknown[]) =>
  ({
    task_id: "t",
    goal: "g",
    success_criteria: [],
    work_units: units,
    totals: { units: units.length, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  }) as never;

const flags = (repoDir: string) => ({ repo: repoDir });

describe("vf canary list", () => {
  test("no canary files → 0, prints empty note", () => {
    const d = repo();
    mkdirSync(join(d, "test"), { recursive: true });
    expect(canary("list", [], flags(d))).toBe(0);
  });

  test("lists canary files + unit coverage (and no-match)", () => {
    const d = repo();
    mkdirSync(join(d, "test"), { recursive: true });
    writeFileSync(join(d, "test", "a.canary.test.ts"), "// canary-scope: src/a.ts\n");
    writeFileSync(join(d, "test", "orphan.canary.test.ts"), "// canary-scope: src/zzz.ts\n");
    writeState(d, baseState([{ name: "unit-a", scope: ["src/a.ts"] }]));
    // default sub (undefined) also routes to list
    expect(canary(undefined, [], flags(d))).toBe(0);
    expect(canary("list", [], flags(d))).toBe(0);
  });
});

describe("vf canary link", () => {
  const unit = () => ({
    name: "auth",
    status: "done",
    scope: ["src/auth.ts"],
    owner_agent: "codex",
  });

  test("missing args → usage exit 2", () => {
    const d = repo();
    expect(canary("link", [], flags(d))).toBe(2);
    expect(canary("link", ["auth"], flags(d))).toBe(2);
  });

  test("non-canary file → exit 2", () => {
    const d = repo();
    expect(canary("link", ["auth", "test/auth.test.ts"], flags(d))).toBe(2);
  });

  test("no state → exit 1", () => {
    const d = repo();
    expect(canary("link", ["auth", "test/auth.canary.test.ts"], flags(d))).toBe(1);
  });

  test("unknown unit → exit 1 (with and without other units)", () => {
    const d = repo();
    writeState(d, baseState([unit()]));
    expect(
      canary("link", ["nope", "test/auth.canary.test.ts"], flags(d), {
        blameAuthor: () => "alice",
      }),
    ).toBe(1);
    writeState(d, baseState([]));
    expect(
      canary("link", ["nope", "test/auth.canary.test.ts"], flags(d), {
        blameAuthor: () => "alice",
      }),
    ).toBe(1);
  });

  test("no git author → exit 1", () => {
    const d = repo();
    writeState(d, baseState([unit()]));
    expect(
      canary("link", ["auth", "test/auth.canary.test.ts"], flags(d), { blameAuthor: () => null }),
    ).toBe(1);
  });

  test("author IS the dispatch engine → refuse, exit 1", () => {
    const d = repo();
    writeState(d, baseState([unit()]));
    expect(
      canary("link", ["auth", "test/auth.canary.test.ts"], flags(d), {
        blameAuthor: () => "codex",
      }),
    ).toBe(1);
  });

  test("human author → links, persists canary, exit 0", () => {
    const d = repo();
    writeState(d, baseState([unit()]));
    expect(
      canary("link", ["auth", "test/auth.canary.test.ts"], flags(d), {
        blameAuthor: () => "alice",
        now: () => "2026-07-03T00:00:00.000Z",
      }),
    ).toBe(0);
    const u = readState(d)?.work_units.find((x) => x.name === "auth");
    expect(u?.canary).toEqual({
      file: "test/auth.canary.test.ts",
      author: "alice",
      linkedAt: "2026-07-03T00:00:00.000Z",
    });
  });

  test("default now + default blameAuthor seam is reachable", () => {
    const d = repo();
    writeState(d, baseState([unit()]));
    // Real git blame on a tmp dir yields null (not a repo) → exit 1, exercising defaults.
    expect(canary("link", ["auth", "test/auth.canary.test.ts"], flags(d))).toBe(1);
  });
});

describe("vf canary check", () => {
  test("all covered → 0", () => {
    const d = repo();
    writeState(
      d,
      baseState([
        {
          name: "auth",
          status: "done",
          knowledge_heavy: true,
          owner_agent: "codex",
          canary: { file: "test/a.canary.test.ts", author: "alice", linkedAt: "x" },
        },
      ]),
    );
    expect(canary("check", [], flags(d))).toBe(0);
  });

  test("missing canary on knowledge-heavy done unit → 1", () => {
    const d = repo();
    writeState(
      d,
      baseState([{ name: "auth", status: "done", knowledge_heavy: true, owner_agent: "codex" }]),
    );
    expect(canary("check", [], flags(d))).toBe(1);
  });

  test("no units (no state) → 0", () => {
    const d = repo();
    expect(canary("check", [], flags(d))).toBe(0);
  });
});

test("vf canary: unknown subcommand → exit 2", () => {
  const d = repo();
  expect(canary("bogus", [], flags(d))).toBe(2);
});

test("vf canary: no --repo flag falls back to resolveRepo", () => {
  // No repo flag → resolveRepo(undefined) → cwd(); list returns 0 regardless.
  expect(canary("list", [], {})).toBe(0);
});
