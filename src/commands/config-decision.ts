// src/commands/config-decision.ts
//
// `vf config` and `vf decision` command implementations.
// Inlined from the former commands/config.ts and commands/decision.ts
// (deleted in #390). Kept in a separate module (not cli.ts) so tests
// can import just these functions without pulling in the full CLI entry
// point, which is not fully testable in unit-test scope.

import { existsSync, readFileSync } from "node:fs";
import { appendDecision, decisionsPath } from "../decisions.js";
import { type VibeSettings, readSettings, writeSettings } from "../settings.js";
import { c, cwd, out } from "./_shared.js";

function printMemory(base: string): void {
  const on = readSettings(base).memory;
  out("vf", `memory: ${on ? c.green("on") : c.yellow("off")}`);
}

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
  if (value !== "on" && value !== "off") {
    out("vf", c.red(`Unknown value "${value}". Usage: vf config memory <on|off|status>`), {
      level: "error",
    });
    return 2;
  }
  const next: Partial<VibeSettings> = value === "on" ? { memory: true } : { memory: false };
  writeSettings(base, next);
  out("vf", value === "on" ? c.green("✓ memory: on") : c.yellow("○ memory: off"));
  return 0;
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function decision(sub: string | undefined, flags: Record<string, string | boolean>): number {
  const base = cwd();
  if (sub === "add") {
    const title = flagStr(flags, "title");
    const context = flagStr(flags, "context");
    const dec = flagStr(flags, "decision");
    const consequences = flagStr(flags, "consequences");
    if (!title || !context || !dec) {
      out(
        "vf",
        c.red(
          'Usage: vf decision add --title "<t>" --context "<c>" --decision "<d>" [--consequences "<x>"]',
        ),
        { level: "error" },
      );
      return 2;
    }
    const seq = appendDecision(base, title, context, dec, consequences);
    out("vf", c.green(`+ ADR-${String(seq).padStart(3, "0")} recorded → ${decisionsPath(base)}`));
    return 0;
  }
  if (sub === "list" || sub === undefined) {
    const path = decisionsPath(base);
    if (!existsSync(path)) {
      out("vf", c.dim("No decisions recorded yet. Add one with `vf decision add`."));
      return 0;
    }
    out("vf", readFileSync(path, "utf8").trimEnd());
    return 0;
  }
  out("vf", c.red(`Unknown subcommand: vf decision ${sub}  (use: add | list)`), { level: "error" });
  return 2;
}
