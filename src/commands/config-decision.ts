// src/commands/config-decision.ts
//
// `vf config` and `vf decision` command implementations.
// Inlined from the former commands/config.ts and commands/decision.ts
// (deleted in #390). Kept in a separate module (not cli.ts) so tests
// can import just these functions without pulling in the full CLI entry
// point, which is not fully testable in unit-test scope.

import { existsSync, readFileSync } from "node:fs";
import { appendDecision, decisionsPath } from "../decisions.js";
import { ALWAYS_KEEP, DEFAULT_DENY, filterEnv } from "../dispatch/env-filter.js";
import { type VibeSettings, readSettings, writeSettings } from "../settings.js";
import { c, cwd, out } from "./_shared.js";

function printMemory(base: string): void {
  const mode = readSettings(base).memory;
  const label = mode === false ? c.yellow("off") : c.green(String(mode));
  out("vf", `memory: ${label}`);
}

const VALID_MODES = ["on", "off", "builtin", "claude-mem"] as const;
type MemoryArg = (typeof VALID_MODES)[number];

export function config(key: string | undefined, rest: string[], base: string = cwd()): number {
  if (key === "memory") return configMemory(rest, base);
  if (key === "env-policy") return configEnvPolicy(rest, base);
  out("vf", c.red("Usage: vf config <memory|env-policy> ..."), { level: "error" });
  return 2;
}

function configMemory(rest: string[], base: string): number {
  const value = rest[0];
  if (value === undefined || value === "status") {
    printMemory(base);
    return 0;
  }
  if (!(VALID_MODES as readonly string[]).includes(value)) {
    out(
      "vf",
      c.red(`Unknown value "${value}". Usage: vf config memory <builtin|claude-mem|off|status>`),
      { level: "error" },
    );
    return 2;
  }
  const arg = value as MemoryArg;
  if (arg === "off") {
    writeSettings(base, { memory: false });
    out("vf", c.yellow("○ memory: off"));
  } else {
    const mode = arg === "on" ? "builtin" : arg;
    writeSettings(base, { memory: mode as VibeSettings["memory"] });
    out("vf", c.green(`✓ memory: ${mode}`));
  }
  return 0;
}

/** #556: print the effective env-scrub policy — mode, built-in deny set, configured
 *  overrides, and a sample of what WOULD be dropped from the current process.env (NAMES only). */
function printEnvPolicy(base: string): void {
  const policy = readSettings(base).envPolicy ?? {};
  const strict = (policy.allow?.length ?? 0) > 0;
  out("vf", c.green(`env-policy mode: ${strict ? "strict (allowlist)" : "default (denylist)"}`));
  out("vf", `built-in deny: ${DEFAULT_DENY.join(" ")}`);
  out("vf", `always keep:  ${ALWAYS_KEEP.join(" ")}`);
  out("vf", `configured deny: ${policy.deny?.length ? policy.deny.join(" ") : c.dim("(none)")}`);
  out("vf", `configured allow: ${policy.allow?.length ? policy.allow.join(" ") : c.dim("(none)")}`);
  const { dropped } = filterEnv(process.env, policy);
  out(
    "vf",
    `would drop from current env (${dropped.length}): ${dropped.join(" ") || c.dim("(none)")}`,
  );
}

/** #556: `vf config env-policy <status|deny <glob>|allow <glob>|reset>`. */
function configEnvPolicy(rest: string[], base: string): number {
  const sub = rest[0];
  if (sub === undefined || sub === "status") {
    printEnvPolicy(base);
    return 0;
  }
  if (sub === "reset") {
    writeSettings(base, { envPolicy: undefined });
    out("vf", c.yellow("○ env-policy: reset to conservative default"));
    return 0;
  }
  if (sub === "deny" || sub === "allow") {
    const glob = rest[1];
    if (!glob) {
      out("vf", c.red(`Usage: vf config env-policy ${sub} <glob>  (e.g. FOO_*)`), {
        level: "error",
      });
      return 2;
    }
    const current = readSettings(base).envPolicy ?? {};
    const list = new Set(current[sub] ?? []);
    list.add(glob);
    writeSettings(base, { envPolicy: { ...current, [sub]: [...list] } });
    out("vf", c.green(`✓ env-policy ${sub}: added "${glob}"`));
    return 0;
  }
  out(
    "vf",
    c.red(
      `Unknown subcommand "${sub}". Usage: vf config env-policy <status|deny <glob>|allow <glob>|reset>`,
    ),
    { level: "error" },
  );
  return 2;
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
