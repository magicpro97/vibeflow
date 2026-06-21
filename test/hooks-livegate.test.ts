import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armHooks, hook } from "../src/commands/hooks.js";

// End-to-end: the menu's chosen policy → armHooks → SETTINGS.json → the live
// `vf hook` gate honors it. This is the one cross-module promise of the feature
// that the per-module unit tests cannot prove on their own (the gate's
// readSettings(cwd()).hooks lookup). It chdir's into a temp repo so readSettings
// resolves the seeded policy. Per the 2026 spec EVERY decision exits 0 — the
// decision rides in the emitted JSON — so we capture console.log and assert on
// the decision field, not the exit code.

/** Drive the real hook() with a one-shot stdin payload; return the emitted decision JSON. */
async function runHook(payload: object): Promise<string> {
  const fakeStdin = {
    on: (event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") setImmediate(() => cb(Buffer.from(JSON.stringify(payload))));
      return fakeStdin;
    },
    once: () => fakeStdin,
    resume: () => {},
    pause: () => {},
  };
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await hook({ stdin: fakeStdin as never, stdinTimeoutMs: 100 });
  } finally {
    console.log = origLog;
  }
  return captured.join("\n");
}

// A legacy pre-command destructive payload: presentDecision emits the raw
// {decision, risk, reasons} JSON for non-PreToolUse events, so we can read the
// decision directly.
const RM_RF = { event: "pre-command", command: "rm -rf /tmp/x" };

describe("vf hook live gate honors the stored policy (end-to-end)", () => {
  test("all-on default (no SETTINGS) blocks a destructive command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-livegate-on-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const emitted = await runHook(RM_RF);
      expect(emitted).toContain('"decision":"block"');
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disabling block-destructive in SETTINGS flips the live decision to allow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-livegate-off-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      armHooks(dir, {
        templates: ["protect-secrets", "protect-config", "flag-installs", "workspace-guard"],
        custom: [],
      });
      const emitted = await runHook(RM_RF);
      expect(emitted).toContain('"decision":"allow"');
      expect(emitted).not.toContain('"decision":"block"');
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a custom rule armed via SETTINGS fires on the live gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-livegate-custom-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      armHooks(dir, {
        templates: [],
        custom: [{ name: "no-prod", kind: "command", pattern: "deploy prod", risk: "critical" }],
      });
      expect(await runHook({ event: "pre-command", command: "deploy prod now" })).toContain(
        '"decision":"block"',
      );
      // A command the custom rule doesn't match is allowed (all built-ins off).
      expect(await runHook({ event: "pre-command", command: "ls -la" })).toContain(
        '"decision":"allow"',
      );
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
