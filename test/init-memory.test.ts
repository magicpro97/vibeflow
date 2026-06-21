import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryPhase } from "../src/commands/init-memory.js";
import type { Engine } from "../src/core.js";
import type { MemoryWireResult } from "../src/memory.js";
import { readSettings } from "../src/settings.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-init-memory-"));
}

/** Seed a WORKFLOW_POLICY.md so appendMemoryGuide has a target. */
function seedPolicy(base: string): void {
  const dir = join(base, ".vibeflow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "WORKFLOW_POLICY.md"), "# Workflow Policy\n");
}

/** Collect the injection spies a test cares about. */
function spies(over: Record<string, unknown> = {}) {
  const calls = { wired: [] as Engine[][], append: 0 };
  return {
    calls,
    inject: {
      isTTY: () => false,
      ensureInstalledForEngines: (engines: Engine[]): MemoryWireResult => {
        calls.wired.push(engines);
        return { wired: engines, failed: [] };
      },
      appendMemoryGuide: (base: string) => {
        calls.append++;
        // Delegate to the real append so the file assertion still works.
        const { appendMemoryGuide } = require("../src/memory.js");
        return appendMemoryGuide(base);
      },
      ...over,
    },
  };
}

describe("runMemoryPhase — flag-driven decision", () => {
  test("--memory wires the given engines, persists memory:true, and appends the guide", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      await runMemoryPhase(dir, { memory: true }, ["claude", "codex", "copilot"], inject);
      expect(readSettings(dir).memory).toBe(true);
      // One wiring call carrying all three engines.
      expect(calls.wired).toEqual([["claude", "codex", "copilot"]]);
      expect(calls.append).toBe(1);
      expect(readFileSync(join(dir, ".vibeflow/WORKFLOW_POLICY.md"), "utf8")).toContain(
        "## Memory: claude-mem",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--no-memory persists memory:false and never wires", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      await runMemoryPhase(dir, { "no-memory": true }, ["claude"], inject);
      expect(readSettings(dir).memory).toBe(false);
      expect(calls.wired).toEqual([]);
      expect(calls.append).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wires only the workflow's chosen engines (not all three)", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      await runMemoryPhase(dir, { memory: true }, ["claude", "codex"], inject);
      expect(calls.wired).toEqual([["claude", "codex"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fully-failed wiring persists the setting but writes no guide", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({
        ensureInstalledForEngines: (engines: Engine[]): MemoryWireResult => {
          calls.wired.push(engines);
          return { wired: [], failed: engines.map((e) => ({ engine: e, reason: "network down" })) };
        },
      });
      await runMemoryPhase(dir, { memory: true }, ["claude"], inject);
      expect(readSettings(dir).memory).toBe(true);
      expect(calls.wired).toEqual([["claude"]]);
      expect(calls.append).toBe(0); // guide skipped when nothing wired
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a partial wiring (one engine fails) still appends the guide", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({
        ensureInstalledForEngines: (engines: Engine[]): MemoryWireResult => {
          calls.wired.push(engines);
          return { wired: ["claude"], failed: [{ engine: "copilot", reason: "exited 1" }] };
        },
      });
      await runMemoryPhase(dir, { memory: true }, ["claude", "copilot"], inject);
      expect(calls.append).toBe(1); // shared store wired → guide added
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty engine list defaults to claude (never wires nothing-yet-claims-success)", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      await runMemoryPhase(dir, { memory: true }, [], inject);
      expect(calls.wired).toEqual([["claude"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runMemoryPhase — prompt + skip", () => {
  test("non-TTY with no flag skips entirely (no settings write, no wiring)", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      // No SETTINGS.json exists yet — a skip must not create one.
      await runMemoryPhase(dir, {}, ["claude"], inject);
      expect(calls.wired).toEqual([]);
      expect(calls.append).toBe(0);
      // MUST-FIX (PR #160 review): readSettings returns the default
      // (memory:false). Nothing was persisted because non-TTY
      // cannot ask. The previous default (memory:true) was a
      // lie — the setting claimed on but init never asked.
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TTY prompt answered yes wires and persists true", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({ isTTY: () => true, ask: async () => true });
      await runMemoryPhase(dir, {}, ["claude", "codex"], inject);
      expect(readSettings(dir).memory).toBe(true);
      expect(calls.wired).toEqual([["claude", "codex"]]);
      expect(calls.append).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TTY prompt answered no persists false and never wires", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({ isTTY: () => true, ask: async () => false });
      await runMemoryPhase(dir, {}, ["claude"], inject);
      expect(readSettings(dir).memory).toBe(false);
      expect(calls.wired).toEqual([]);
      expect(calls.append).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
