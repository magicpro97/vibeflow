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
import type { UserMcpServer } from "../settings.js";
import { buildUserEntry, c, cwd, out, writeToolConfigs } from "./_shared.js";

function printMemory(base: string): void {
  const mode = readSettings(base).memory;
  const label = mode === false ? c.yellow("off") : c.green(String(mode));
  out("vf", `memory: ${label}`);
}

const VALID_MODES = ["on", "off", "builtin", "claude-mem"] as const;
type MemoryArg = (typeof VALID_MODES)[number];

export function config(
  key: string | undefined,
  rest: string[],
  base: string = cwd(),
  flags: Record<string, string | boolean> = {},
): number {
  if (key === "memory") return configMemory(rest, base);
  if (key === "env-policy") return configEnvPolicy(rest, base);
  if (key === "mcp") return configMcp(rest, base, flags);
  out("vf", c.red("Usage: vf config <memory|env-policy|mcp> ..."), { level: "error" });
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

/** #548: `vf config mcp <list|add <name> ...|remove <name>>`. */
function configMcp(rest: string[], base: string, flags: Record<string, string | boolean>): number {
  const sub = rest[0];
  if (sub === undefined || sub === "list") {
    return configMcpList(base);
  }
  if (sub === "add") {
    const name = rest[1];
    if (!name) {
      out("vf", c.red("Usage: vf config mcp add <name> --stdio|--http|--sse ..."), {
        level: "error",
      });
      return 2;
    }
    return configMcpAdd(name, rest.slice(2), base, flags);
  }
  if (sub === "remove") {
    const name = rest[1];
    if (!name) {
      out("vf", c.red("Usage: vf config mcp remove <name>"), { level: "error" });
      return 2;
    }
    return configMcpRemove(name, base);
  }
  out("vf", c.red(`Unknown subcommand "vf config mcp ${sub}"  (use: list | add | remove)`), {
    level: "error",
  });
  return 2;
}

function configMcpList(base: string): number {
  const servers = readSettings(base).mcpServers ?? {};
  if (!Object.keys(servers).length) {
    out("vf", c.dim("No user MCP servers configured. Add one with `vf config mcp add`."));
    return 0;
  }
  for (const [name, def] of Object.entries(servers)) {
    const transport = def.transport ?? "stdio";
    const target =
      transport === "stdio" ? (def as { command: string }).command : (def as { url: string }).url;
    out("vf", `  ${c.bold(name)}  ${c.dim(transport)}  ${target}`);
  }
  return 0;
}

function configMcpAdd(
  name: string,
  rest: string[],
  base: string,
  flags: Record<string, string | boolean>,
): number {
  // #548 security: the name becomes a TOML section (`[mcp_servers.<name>]`) and a JSON
  // map key — an unvalidated name could inject TOML/break the config. Restrict to the same
  // lowercase-hyphen shape as `vf skills init`.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    out("vf", c.red(`Invalid server name "${name}" (use lowercase-hyphen, e.g. my-server)`), {
      level: "error",
    });
    return 2;
  }
  const hasHttp = flags.http !== undefined;
  const hasSse = flags.sse !== undefined;
  const hasStdio = flags.stdio !== undefined;
  const transports = [hasHttp, hasSse, hasStdio].filter(Boolean).length;
  if (transports !== 1) {
    out("vf", c.red("Specify exactly one of --stdio, --http <url>, or --sse <url>"), {
      level: "error",
    });
    return 2;
  }

  let def: UserMcpServer;
  if (hasStdio) {
    const command = flags.command;
    if (typeof command !== "string" || !command) {
      out("vf", c.red("--stdio requires --command <cmd>"), { level: "error" });
      return 2;
    }
    def = { command };
    if (flags.transport === "stdio") def.transport = "stdio";
    const args: string[] = [];
    // ponytail: scan rest for consecutive positional args past the flags
    // parseFlags eats `--arg val` into flags.arg = "val". Also check rest for raw args.
    for (const a of rest) {
      if (!a.startsWith("-")) args.push(a);
    }
    if (args.length) def.args = args;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(flags)) {
      if (k.startsWith("env_")) {
        const envKey = k.slice(4);
        if (typeof v === "string") env[envKey] = v;
      }
    }
    if (Object.keys(env).length) def.env = env;
  } else {
    const transport = hasHttp ? ("http" as const) : ("sse" as const);
    const urlKey = hasHttp ? "http" : "sse";
    const url = flags[urlKey];
    if (typeof url !== "string" || !url) {
      out("vf", c.red(`--${urlKey} requires a URL`), { level: "error" });
      return 2;
    }
    def = { transport, url };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(flags)) {
      if (k.startsWith("header_")) {
        const hdrKey = k.slice(7);
        if (typeof v === "string") headers[hdrKey] = v;
      }
    }
    if (Object.keys(headers).length) def.headers = headers;
  }

  const current = readSettings(base);
  const mcpServers: Record<string, UserMcpServer> = { ...(current.mcpServers ?? {}), [name]: def };
  writeSettings(base, { mcpServers });
  out("vf", c.green(`✓ mcp server "${name}" added (${def.transport ?? "stdio"})`));
  writeToolConfigs(base, readSettings(base));
  out("vf", c.dim("Engine configs regenerated."));
  return 0;
}

function configMcpRemove(name: string, base: string): number {
  const current = readSettings(base);
  const existing = current.mcpServers ?? {};
  if (!(name in existing)) {
    out("vf", c.yellow(`! "${name}" was not configured.`));
    return 0;
  }
  const mcpServers = { ...existing };
  delete mcpServers[name];
  // pass empty {} to drop the key entirely
  writeSettings(base, { mcpServers: Object.keys(mcpServers).length ? mcpServers : {} });
  out("vf", c.yellow(`○ removed "${name}"`));
  // #548 (review): pass the removed name so writeClaudeMcp strips it from .mcp.json
  // (it's no longer in settings.mcpServers, so it would otherwise orphan).
  writeToolConfigs(base, readSettings(base), undefined, [name]);
  out("vf", c.dim("Engine configs regenerated."));
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
