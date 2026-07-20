import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logbus } from "../src/logbus.js";
import type { LogEvent } from "../src/logbus/types.js";

describe("dashboard log context", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-logctx-"));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => cleanup());

  test("default log context stamps workflowId and repoPath", async () => {
    const bus = new Logbus({
      runId: "run-1",
      dir,
      context: { workflowId: "TASK-1", repoPath: "/repo/a" },
    });
    const captured: LogEvent[] = [];
    bus.subscribe((ev) => captured.push(ev));
    bus.write({ channel: "vf", level: "info", text: "hello", runId: "run-1" });
    await bus.close();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.workflowId).toBe("TASK-1");
    expect(captured[0]?.repoPath).toBe("/repo/a");

    const lines = readFileSync(bus.currentFile(), "utf8").split("\n").filter(Boolean);
    const parsed = JSON.parse(lines[0] as string) as LogEvent;
    expect(parsed.workflowId).toBe("TASK-1");
    expect(parsed.repoPath).toBe("/repo/a");
  });

  test("explicit event ownership overrides only explicitly supplied fields", async () => {
    const bus = new Logbus({
      runId: "run-2",
      dir,
      context: { workflowId: "TASK-1", repoPath: "/repo/a" },
    });
    const captured: LogEvent[] = [];
    bus.subscribe((ev) => captured.push(ev));
    bus.write({
      channel: "vf",
      level: "info",
      text: "override",
      runId: "run-2",
      workflowId: "TASK-OVERRIDE",
    });
    await bus.close();
    expect(captured[0]?.workflowId).toBe("TASK-OVERRIDE");
    expect(captured[0]?.repoPath).toBe("/repo/a");
  });

  test("legacy event without ownership parses and stringifyEvent remains JSON", async () => {
    const bus = new Logbus({ runId: "run-3", dir });
    bus.write({ channel: "vf", level: "info", text: "legacy", runId: "run-3" });
    await bus.close();
    const lines = readFileSync(bus.currentFile(), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as LogEvent;
    expect(parsed.workflowId).toBeUndefined();
    expect(parsed.repoPath).toBeUndefined();
    expect(parsed.text).toBe("legacy");
  });
});
