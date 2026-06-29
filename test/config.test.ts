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
  test("`config memory on` persists memory:true and prints memory: on", async () => {
    const dir = tmpRepo();
    try {
      // Seed the opposite so the toggle is observable.
      writeSettings(dir, { memory: false });
      const { code, out } = await capture(() => config("memory", ["on"], dir));
      expect(code).toBe(0);
      expect(out).toContain("memory: on");
      expect(readSettings(dir).memory).toBe(true);
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
});

describe("config memory status", () => {
  test("`config memory status` prints current state without mutating", async () => {
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
