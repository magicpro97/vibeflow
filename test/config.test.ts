import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/commands/config-decision.js";
import { readSettings, writeSettings } from "../src/settings.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-config-"));
}

/** Capture everything written to stdout/stderr while `fn` runs. */
async function capture(fn: () => number | Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErrW = process.stderr.write.bind(process.stderr);
  const sink = (chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  (process.stdout as { write: typeof sink }).write = sink;
  (process.stderr as { write: typeof sink }).write = sink;
  try {
    const code = await fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
    (process.stdout as { write: typeof origOut }).write = origOut;
    (process.stderr as { write: typeof origErrW }).write = origErrW;
  }
}

describe("config memory on|off", () => {
  test('`config memory on` persists memory:"builtin" (backward compat)', async () => {
    const dir = tmpRepo();
    try {
      // Seed the opposite so the toggle is observable.
      writeSettings(dir, { memory: false });
      const { code, out } = await capture(() => config("memory", ["on"], dir));
      expect(code).toBe(0);
      expect(out).toContain("builtin");
      expect(readSettings(dir).memory).toBe("builtin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`config memory off` persists memory:false and prints memory: off", async () => {
    const dir = tmpRepo();
    try {
      const { code, out } = await capture(() => config("memory", ["off"], dir));
      expect(code).toBe(0);
      expect(out).toContain("memory: off");
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`config memory builtin` writes builtin mode", async () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: false });
      const { code, out } = await capture(() => config("memory", ["builtin"], dir));
      expect(code).toBe(0);
      expect(out).toContain("builtin");
      expect(readSettings(dir).memory).toBe("builtin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`config memory claude-mem` writes claude-mem mode", async () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: false });
      const { code, out } = await capture(() => config("memory", ["claude-mem"], dir));
      expect(code).toBe(0);
      expect(out).toContain("claude-mem");
      expect(readSettings(dir).memory).toBe("claude-mem");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config memory status", () => {
  test("`config memory status` prints current mode without mutating", async () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: false });
      const { code, out } = await capture(() => config("memory", ["status"], dir));
      expect(code).toBe(0);
      expect(out).toContain("memory: off");
      // unchanged
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`config memory status` prints builtin when enabled", async () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: "builtin" });
      const { code, out } = await capture(() => config("memory", ["status"], dir));
      expect(code).toBe(0);
      expect(out).toContain("builtin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`config memory` with no value defaults to status", async () => {
    const dir = tmpRepo();
    try {
      const { code, out } = await capture(() => config("memory", [], dir));
      expect(code).toBe(0);
      // MUST-FIX (PR #160 review): default is now `off` (was `on`).
      // Operators opt-in explicitly via `vf config memory on` or
      // interactively during `vf init --ai` (Phase 1.55).
      expect(out).toContain("memory: off"); // default false
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config usage errors", () => {
  test("unknown subkey returns exit 2", async () => {
    const dir = tmpRepo();
    try {
      const { code } = await capture(() => config("bogus", [], dir));
      expect(code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no subkey returns exit 2 with usage", async () => {
    const dir = tmpRepo();
    try {
      const { code, out } = await capture(() => config(undefined, [], dir));
      expect(code).toBe(2);
      expect(out.toLowerCase()).toContain("usage");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid memory value returns exit 2", async () => {
    const dir = tmpRepo();
    try {
      const { code } = await capture(() => config("memory", ["maybe"], dir));
      expect(code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config env-policy (#556)", () => {
  test("status (no sub) prints the effective policy, exit 0", async () => {
    const dir = tmpRepo();
    try {
      const { code, out } = await capture(() => config("env-policy", [], dir));
      expect(code).toBe(0);
      expect(out).toContain("env-policy mode: default (denylist)");
      expect(out).toContain("built-in deny:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deny <glob> persists to settings.envPolicy.deny", async () => {
    const dir = tmpRepo();
    try {
      const { code } = await capture(() => config("env-policy", ["deny", "FOO_*"], dir));
      expect(code).toBe(0);
      expect(readSettings(dir).envPolicy?.deny).toContain("FOO_*");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allow <glob> persists + status flips to strict", async () => {
    const dir = tmpRepo();
    try {
      await capture(() => config("env-policy", ["allow", "MY_*"], dir));
      expect(readSettings(dir).envPolicy?.allow).toContain("MY_*");
      const { out } = await capture(() => config("env-policy", ["status"], dir));
      expect(out).toContain("strict (allowlist)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deny is additive + deduped across calls", async () => {
    const dir = tmpRepo();
    try {
      await capture(() => config("env-policy", ["deny", "A_*"], dir));
      await capture(() => config("env-policy", ["deny", "B_*"], dir));
      await capture(() => config("env-policy", ["deny", "A_*"], dir)); // dup
      const deny = readSettings(dir).envPolicy?.deny ?? [];
      expect(deny).toContain("A_*");
      expect(deny).toContain("B_*");
      expect(deny.filter((g) => g === "A_*").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reset clears the configured policy back to default", async () => {
    const dir = tmpRepo();
    try {
      await capture(() => config("env-policy", ["deny", "FOO_*"], dir));
      const { code } = await capture(() => config("env-policy", ["reset"], dir));
      expect(code).toBe(0);
      expect(readSettings(dir).envPolicy).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deny with no glob returns exit 2", async () => {
    const dir = tmpRepo();
    try {
      const { code } = await capture(() => config("env-policy", ["deny"], dir));
      expect(code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown env-policy subcommand returns exit 2", async () => {
    const dir = tmpRepo();
    try {
      const { code } = await capture(() => config("env-policy", ["frobnicate"], dir));
      expect(code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("test subcommand prints DROPPED and KEPT names, never values", async () => {
    const orig = process.env.MY_TEST_SECRET;
    process.env.MY_TEST_SECRET = "super-secret-value-should-not-appear";
    try {
      const dir = tmpRepo();
      try {
        const { code, out } = await capture(() => config("env-policy", ["test"], dir));
        expect(code).toBe(0);
        // NAMES appear under correct headers
        expect(out).toContain("MY_TEST_SECRET");
        expect(out).toContain("PATH");
        // VALUE must NOT appear
        expect(out).not.toContain("super-secret-value-should-not-appear");
        // Headers present
        expect(out).toContain("DROPPED");
        expect(out).toContain("KEPT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      // biome-ignore lint/performance/noDelete: restore to truly-absent when the var wasn't set
      if (orig === undefined) delete process.env.MY_TEST_SECRET;
      else process.env.MY_TEST_SECRET = orig;
    }
  });

  test("test subcommand with no-policy still drops DEFAULT_DENY secrets", async () => {
    const origAws = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "abc123";
    try {
      const dir = tmpRepo();
      try {
        const { code, out } = await capture(() => config("env-policy", ["test"], dir));
        expect(code).toBe(0);
        expect(out).toContain("AWS_SECRET_ACCESS_KEY");
        expect(out).toContain("DROPPED");
        expect(out).not.toContain("abc123");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      // biome-ignore lint/performance/noDelete: restore to truly-absent when the var wasn't set
      if (origAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = origAws;
    }
  });
});

describe("settings envPolicy coerce/writeSettings (#556)", () => {
  test("coerce materializes a valid envPolicy, drops non-string entries", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { envPolicy: { deny: ["FOO_*", 123 as unknown as string], allow: [] } });
      const ep = readSettings(dir).envPolicy;
      expect(ep?.deny).toEqual(["FOO_*"]);
      expect(ep?.allow).toBeUndefined(); // empty array → undefined
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("garbage envPolicy block coerces to undefined (default applies)", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { envPolicy: "nonsense" as unknown as { deny?: string[] } });
      expect(readSettings(dir).envPolicy).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSettings keeps prior envPolicy when next omits it", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { envPolicy: { deny: ["KEEP_*"] } });
      writeSettings(dir, { memory: "builtin" }); // unrelated write
      expect(readSettings(dir).envPolicy?.deny).toContain("KEEP_*");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings eval coerce/writeSettings (#549)", () => {
  test("round-trips minPassRate + minSamples, clamping to valid ranges", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { eval: { minPassRate: 1.4, minSamples: 5.6 } });
      const ev = readSettings(dir).eval;
      expect(ev?.minPassRate).toBe(1); // clamped to 1
      expect(ev?.minSamples).toBe(6); // rounded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("garbage eval block coerces to undefined (report-only, no gate)", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, {
        eval: { minPassRate: "x" as unknown as number, minSamples: Number.NaN },
      });
      expect(readSettings(dir).eval).toBeUndefined();
      writeSettings(dir, { eval: "nonsense" as unknown as { minPassRate?: number } });
      expect(readSettings(dir).eval).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSettings keeps prior eval when next omits it", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { eval: { minPassRate: 0.9 } });
      writeSettings(dir, { memory: "builtin" }); // unrelated write
      expect(readSettings(dir).eval?.minPassRate).toBe(0.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
