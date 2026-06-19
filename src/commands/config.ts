// src/commands/config.ts
//
// `vf config <key> <value>` — read/toggle per-repo settings in SETTINGS.json.
// Currently the only key is `memory`, the claude-mem feature switch (see
// src/memory.ts + the `vf init` Phase 1.5 prompt). The setting records the
// user's claude-mem opt-in and is the forward-compat switch a later
// orchestrate-side memory query will read; it does NOT gate the init prompt.
//
// All cross-module symbols come through the _shared barrel (cycle rule:
// test/commands-no-cycle.test.ts forbids sibling imports).
import { type VibeSettings, c, cwd, out, readSettings, writeSettings } from "./_shared.js";

/** Print `memory: on|off` for the given repo. */
function printMemory(base: string): void {
  const on = readSettings(base).memory;
  out("vf", `memory: ${on ? c.green("on") : c.yellow("off")}`);
}

/**
 * `vf config <key> [value]`. The `base` arg is injectable so unit tests can
 * point at a throwaway repo; production callers (cli.ts) omit it and the
 * current working directory is used.
 */
export function config(key: string | undefined, rest: string[], base: string = cwd()): number {
  if (key !== "memory") {
    out("vf", c.red("Usage: vf config memory <on|off|status>"), { level: "error" });
    return 2;
  }
  const value = rest[0];
  if (value === undefined || value === "status") {
    printMemory(base);
    return 0;
  }
  const next: Partial<VibeSettings> =
    value === "on" ? { memory: true } : value === "off" ? { memory: false } : {};
  if (value !== "on" && value !== "off") {
    out("vf", c.red(`Unknown value "${value}". Usage: vf config memory <on|off|status>`), {
      level: "error",
    });
    return 2;
  }
  writeSettings(base, next);
  printMemory(base);
  return 0;
}
