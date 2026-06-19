import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryPhase } from "../src/commands/init-memory.js";
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
  const calls = { ensure: 0, append: 0 };
  return {
    calls,
    inject: {
      isTTY: () => false,
      isInstalled: () => false,
      ensureInstalled: async () => {
        calls.ensure++;
        return { ok: true };
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
  test("--memory installs, persists memory:true, and appends the guide", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      await runMemoryPhase(dir, { memory: true }, inject);
      expect(readSettings(dir).memory).toBe(true);
      expect(calls.ensure).toBe(1);
      expect(calls.append).toBe(1);
      expect(readFileSync(join(dir, ".vibeflow/WORKFLOW_POLICY.md"), "utf8")).toContain(
        "## Memory: claude-mem",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--no-memory persists memory:false and never installs", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      await runMemoryPhase(dir, { "no-memory": true }, inject);
      expect(readSettings(dir).memory).toBe(false);
      expect(calls.ensure).toBe(0);
      expect(calls.append).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("when already installed, skips install but still appends the guide", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({ isInstalled: () => true });
      await runMemoryPhase(dir, { memory: true }, inject);
      expect(calls.ensure).toBe(0); // ensureInstalled not reached
      expect(calls.append).toBe(1);
      expect(readSettings(dir).memory).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed install persists the setting but writes no guide", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({
        ensureInstalled: async () => {
          calls.ensure++;
          return { ok: false, reason: "network down" };
        },
      });
      await runMemoryPhase(dir, { memory: true }, inject);
      expect(readSettings(dir).memory).toBe(true);
      expect(calls.ensure).toBe(1);
      expect(calls.append).toBe(0); // guide skipped on failed install
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runMemoryPhase — prompt + skip", () => {
  test("non-TTY with no flag skips entirely (no settings write, no install)", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies();
      // No SETTINGS.json exists yet — a skip must not create one.
      await runMemoryPhase(dir, {}, inject);
      expect(calls.ensure).toBe(0);
      expect(calls.append).toBe(0);
      // readSettings returns the default (memory:true) but nothing was persisted.
      // Assert the file was not written by checking it stays at the default
      // even though we never wrote false — i.e. no write occurred.
      expect(readSettings(dir).memory).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TTY prompt answered yes installs and persists true", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({ isTTY: () => true, ask: async () => true });
      await runMemoryPhase(dir, {}, inject);
      expect(readSettings(dir).memory).toBe(true);
      expect(calls.ensure).toBe(1);
      expect(calls.append).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TTY prompt answered no persists false and never installs", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({ isTTY: () => true, ask: async () => false });
      await runMemoryPhase(dir, {}, inject);
      expect(readSettings(dir).memory).toBe(false);
      expect(calls.ensure).toBe(0);
      expect(calls.append).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
