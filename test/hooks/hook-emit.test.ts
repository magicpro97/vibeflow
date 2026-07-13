import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hook } from "../../src/commands/hooks.js";
import { Logbus, setLogbusForTests } from "../../src/logbus.js";

/** Drive the real hook() with a one-shot stdin payload. */
function fakeStdin(payload: object) {
  const s = {
    on: (event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") setImmediate(() => cb(Buffer.from(JSON.stringify(payload))));
      return s;
    },
    once: () => s,
    resume: () => {},
    pause: () => {},
  };
  return s;
}

function readEvents(bus: Logbus): Array<Record<string, unknown>> {
  return readFileSync(bus.currentFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const RM_RF = { event: "pre-command", command: "rm -rf /tmp/x", taskId: "t-1" };

describe("vf hook emits the decision onto the logbus 'hook' channel (#542)", () => {
  test("a live decision produces one channel:hook event with decision, risk and unit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-hook-emit-"));
    const orig = process.cwd();
    const bus = new Logbus({ runId: "test", dir });
    setLogbusForTests(bus);
    process.chdir(dir);
    const origLog = console.log;
    console.log = () => {};
    try {
      await hook({ stdin: fakeStdin(RM_RF) as never, stdinTimeoutMs: 100 });
      await bus.close();
      const hooks = readEvents(bus).filter(
        (e) => e.channel === "hook" && (e.meta as Record<string, unknown>)?.kind === "hook",
      );
      expect(hooks).toHaveLength(1);
      const h = hooks[0] as Record<string, unknown>;
      expect(h.unit).toBe("t-1");
      const meta = h.meta as Record<string, unknown>;
      expect(meta.decision).toBe("block");
      expect(meta.risk).toBe("critical");
    } finally {
      console.log = origLog;
      process.chdir(orig);
      setLogbusForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
