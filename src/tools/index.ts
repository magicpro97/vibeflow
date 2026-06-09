/**
 * Optional developer tools registry. Two opt-in tools — `codegraph` and `lsp` (an
 * MCP↔LSP bridge) — give AI agents better code navigation. Every tool module is PURE:
 * it DETECTS whether it's installed, returns an INSTALL PLAN (commands the caller may
 * run after approval), and returns the MCP server config entry to wire it into an
 * engine. Nothing here spawns installs or touches the network — the caller (Wave B)
 * executes approved steps and merges the returned MCP entries into each engine's config.
 *
 * Note on the index↔tool import cycle: codegraph.ts and lsp.ts import the shared types
 * and the `buildStdioEntry` helper from this file, while this file imports their
 * namespaces to build the registry. All cross-references are function declarations
 * (hoisted) or live inside function bodies, so the cycle never reads an undefined
 * binding at module-eval time.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../core.js";
import * as codegraph from "./codegraph.js";
import * as lsp from "./lsp.js";

/** Engine config files the caller merges MCP entries into. */
const CLAUDE_CONFIG = ".mcp.json";
const COPILOT_CONFIG = "~/.copilot/mcp-config.json";
const CODEX_CONFIG = "~/.codex/config.toml";

/** A single install command. NOT executed here — returned for the caller to approve/run. */
export interface InstallStep {
  cmd: string;
  args: string[];
  description: string;
}

/** An ordered set of install commands for one tool. */
export interface InstallPlan {
  steps: InstallStep[];
}

/** A local (stdio) MCP server definition, ready to serialize. */
export interface StdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Copilot tool filter ("*" or explicit names); omitted for engines without it. */
  tools?: string[];
}

/** Claude/Copilot MCP entry: a `mcpServers` map fragment ready to merge into JSON. */
export interface JsonMcpEntry {
  engine: "claude" | "copilot";
  /** Merge target file (repo-relative for claude, absolute-ish for copilot). */
  configPath: string;
  servers: Record<string, StdioServer>;
  /** Tool names this server exposes, for priority/gating downstream. */
  tools: string[];
}

/** Codex MCP entry: a structured TOML section the caller serializes to config.toml. */
export interface TomlMcpEntry {
  engine: "codex";
  configPath: string;
  /** e.g. "mcp_servers.codegraph" → [mcp_servers.codegraph]. */
  section: string;
  command: string;
  args: string[];
  /** Tools to disable (codex supports disabled_tools for gating). */
  disabledTools?: string[];
  tools: string[];
}

export type McpEntry = JsonMcpEntry | TomlMcpEntry;

/** Options for detection, injectable so callers/tests can stub PATH lookups. */
export interface DetectOpts {
  has?: (cmd: string) => boolean;
}

/** Per-repo context a tool needs to build install plans and MCP entries. */
export interface ToolContext {
  /** Absolute workspace directory (LSP servers are bound per-workspace). */
  workspace: string;
  /** Languages detected in the repo (scanner profile, normalized by the tool). */
  languages: string[];
}

export type ToolName = "codegraph" | "lsp";

/** Uniform descriptor so the caller can iterate every tool the same way. */
export interface ToolDescriptor {
  name: ToolName;
  title: string;
  description: string;
  detect(opts?: DetectOpts): boolean;
  installPlan(ctx: ToolContext): InstallPlan;
  mcpEntries(engine: Engine, ctx: ToolContext): McpEntry[];
  /** True when the per-repo artifact (e.g. a code index) the tool needs already exists.
   * Tools with no per-repo artifact (e.g. lsp) omit this — treated as always-present. */
  indexPresent?(base: string): boolean;
  /** Steps to (re)build the per-repo artifact when `indexPresent` is false. Omitted for
   * tools that need none. Lets `enable --yes` provision generically off the registry. */
  indexPlan?(ctx: ToolContext): InstallPlan;
}

/**
 * Build a per-engine MCP entry from a stdio server definition. Claude and Copilot share
 * the `mcpServers` JSON map (Copilot adds a per-server `tools` filter — verified against
 * a real ~/.copilot/mcp-config.json + `copilot mcp add --help`). Codex uses a TOML
 * section the caller serializes, and supports disabled_tools for gating.
 */
export function buildStdioEntry(
  engine: Engine,
  name: string,
  server: StdioServer,
  tools: string[],
): McpEntry {
  if (engine === "codex") {
    return {
      engine,
      configPath: CODEX_CONFIG,
      section: `mcp_servers.${name}`,
      command: server.command,
      args: server.args,
      disabledTools: [],
      tools,
    };
  }
  if (engine === "copilot") {
    return {
      engine,
      configPath: COPILOT_CONFIG,
      servers: { [name]: { ...server, tools: ["*"] } },
      tools,
    };
  }
  return { engine, configPath: CLAUDE_CONFIG, servers: { [name]: server }, tools };
}

/** Registry of every optional tool, keyed by name. */
export const TOOLS: Record<ToolName, ToolDescriptor> = {
  codegraph: {
    name: "codegraph",
    title: "CodeGraph",
    description: "100% local code graph (tree-sitter + SQLite) exposed as an MCP server.",
    detect: (opts) => codegraph.detect(opts),
    installPlan: () => codegraph.installPlan(),
    mcpEntries: (engine) => [codegraph.mcpConfigFor(engine)],
    indexPresent: (base) => existsSync(join(base, codegraph.INDEX_DIR)),
    indexPlan: () => ({ steps: [codegraph.indexBuildStep()] }),
  },
  lsp: {
    name: "lsp",
    title: "LSP Bridge",
    description: "Language-server navigation via the mcp-language-server MCP↔LSP bridge.",
    detect: (opts) => lsp.detect(opts),
    installPlan: (ctx) => lsp.installPlan(ctx.languages),
    mcpEntries: (engine, ctx) => lsp.mcpServersFor(engine, ctx),
  },
};

/** Registry order; codegraph first so its tools take precedence in merged priority. */
export const TOOL_ORDER: ToolName[] = ["codegraph", "lsp"];

/** Merged MCP config plus a flat, deduped tool-priority ordering. */
export interface MergedTools {
  entries: McpEntry[];
  /** Tool names in precedence order (codegraph tools first), deduped. */
  priority: string[];
}

/**
 * Given the set of enabled tools, an engine, and repo context, return the merged MCP
 * entries and tool-priority ordering. Disabled (or absent) tools are skipped entirely.
 * Pure: no spawning, no I/O.
 */
export function resolveTools(
  enabled: Partial<Record<ToolName, boolean>>,
  engine: Engine,
  ctx: ToolContext,
): MergedTools {
  const entries: McpEntry[] = [];
  const priority: string[] = [];
  for (const name of TOOL_ORDER) {
    if (!enabled[name]) continue;
    const toolEntries = TOOLS[name].mcpEntries(engine, ctx);
    entries.push(...toolEntries);
    for (const entry of toolEntries) {
      for (const tool of entry.tools) if (!priority.includes(tool)) priority.push(tool);
    }
  }
  return { entries, priority };
}
