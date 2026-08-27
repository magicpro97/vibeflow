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
import { AGENT_ENGINE, type Engine } from "../core/agent-contract.js";
import * as codegraph from "./codegraph.js";
import * as lsp from "./lsp.js";

/** Engine config files the caller merges MCP entries into. */
const CLAUDE_CONFIG = ".mcp.json";
const COPILOT_CONFIG = "~/.copilot/mcp-config.json";
const CODEX_CONFIG = "~/.codex/config.toml";
const OPENCODE_CONFIG = "opencode.json";
const ANTIGRAVITY_CONFIG = ".agents/mcp_config.json";

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

/** #548: a remote (http/sse) MCP server, serialized into the JSON `mcpServers` map. */
export interface RemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

/** Agy remote MCP server — uses serverUrl per official agy contract, not url. */
export interface AntigravityRemoteServer {
  serverUrl: string;
  headers?: Record<string, string>;
}

/** #548: either transport shape a JSON `mcpServers` map may hold. */
export type McpServerDef = StdioServer | RemoteServer;

/** #548: a user-declared MCP server, before per-engine serialization. Transport defaults
 *  to stdio (command required); http/sse carry a url + optional headers. */
export type UserMcpServer =
  | { transport?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "http" | "sse"; url: string; headers?: Record<string, string> };

/** Claude/Copilot MCP entry: a `mcpServers` map fragment ready to merge into JSON. */
export interface JsonMcpEntry {
  engine: typeof AGENT_ENGINE.CLAUDE | typeof AGENT_ENGINE.COPILOT;
  /** Merge target file (repo-relative for claude, absolute-ish for copilot). */
  configPath: string;
  servers: Record<string, McpServerDef>;
  /** Tool names this server exposes, for priority/gating downstream. */
  tools: string[];
}

/** Codex MCP entry: a structured TOML section the caller serializes to config.toml. */
export interface TomlMcpEntry {
  engine: typeof AGENT_ENGINE.CODEX;
  configPath: string;
  /** e.g. "mcp_servers.codegraph" → [mcp_servers.codegraph]. */
  section: string;
  command: string;
  args: string[];
  /** #548: set for a remote http server (codex emits `url = "..."` + the rmcp flag). */
  url?: string;
  /** Tools to disable (codex supports disabled_tools for gating). */
  disabledTools?: string[];
  tools: string[];
}

/** opencode's `mcp` config shape (opencode.json), verified against
 *  https://opencode.ai/docs/mcp-servers/ — JSON, NOT the codex TOML shape.
 *  `command` is the FULL argv (binary + args) as one array; env var is
 *  `environment`, not `env`. */
export type OpencodeServerDef =
  | { type: "local"; command: string[]; environment?: Record<string, string> }
  | { type: "remote"; url: string; headers?: Record<string, string> };

/** opencode MCP entry: merges into the top-level `mcp` map in opencode.json. */
export interface OpencodeMcpEntry {
  engine: typeof AGENT_ENGINE.OPENCODE;
  configPath: string;
  servers: Record<string, OpencodeServerDef>;
  tools: string[];
}

export interface AntigravityMcpEntry {
  engine: typeof AGENT_ENGINE.ANTIGRAVITY;
  configPath: string;
  servers: Record<string, StdioServer | AntigravityRemoteServer>;
  tools: string[];
}

export type McpEntry = JsonMcpEntry | TomlMcpEntry | OpencodeMcpEntry | AntigravityMcpEntry;

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
  /** Optional stricter check: marker file exists AND the tool itself reports a healthy
   * index (e.g. `codegraph status` does not say "Not initialized"). Used to flag a
   * corrupt or version-mismatched SQLite db that a plain file presence would miss.
   * The spawner is inlined (matches `runToolSteps`) to avoid a tools↔commands cycle. */
  indexHealthy?(
    base: string,
    spawner: (cmd: string, args: string[]) => { status: number; stdout?: string },
  ): boolean;
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
  if (engine === AGENT_ENGINE.CODEX) {
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
  if (engine === AGENT_ENGINE.OPENCODE) {
    return {
      engine,
      configPath: OPENCODE_CONFIG,
      servers: { [name]: { type: "local", command: [server.command, ...server.args] } },
      tools,
    };
  }
  if (engine === AGENT_ENGINE.ANTIGRAVITY) {
    return { engine, configPath: ANTIGRAVITY_CONFIG, servers: { [name]: server }, tools };
  }
  if (engine === AGENT_ENGINE.COPILOT) {
    return {
      engine,
      configPath: COPILOT_CONFIG,
      servers: { [name]: { ...server, tools: ["*"] } },
      tools,
    };
  }
  return { engine, configPath: CLAUDE_CONFIG, servers: { [name]: server }, tools };
}

/**
 * #548: build a per-engine MCP entry from a user-declared server of any transport.
 * Transport defaults to stdio. Codex does not support SSE → returns null (caller warns).
 * User servers expose unknown tools, so the `tools` list is empty; copilot's stdio servers
 * still get the "*" filter via the JSON server shape written by the writer.
 */
export function buildUserEntry(engine: Engine, name: string, def: UserMcpServer): McpEntry | null {
  const transport = def.transport ?? "stdio";
  if (engine === AGENT_ENGINE.OPENCODE) {
    // opencode's remote type covers both http and sse (single "remote" shape,
    // see https://opencode.ai/docs/mcp-servers/) — unlike codex, sse is not rejected.
    if (transport === "http" || transport === "sse") {
      const r = def as { url: string; headers?: Record<string, string> };
      return {
        engine,
        configPath: OPENCODE_CONFIG,
        servers: {
          [name]: r.headers
            ? { type: "remote", url: r.url, headers: r.headers }
            : { type: "remote", url: r.url },
        },
        tools: [],
      };
    }
    const stdio = def as { command: string; args?: string[] };
    return {
      engine,
      configPath: OPENCODE_CONFIG,
      servers: { [name]: { type: "local", command: [stdio.command, ...(stdio.args ?? [])] } },
      tools: [],
    };
  }
  if (engine === AGENT_ENGINE.ANTIGRAVITY) {
    const configPath = ANTIGRAVITY_CONFIG;
    let server: StdioServer | AntigravityRemoteServer;
    if (transport === "stdio") {
      const s = def as { command: string; args?: string[]; env?: Record<string, string> };
      server = { command: s.command, args: s.args ?? [], env: s.env ?? {} };
    } else {
      const r = def as { url: string; headers?: Record<string, string> };
      server = r.headers ? { serverUrl: r.url, headers: r.headers } : { serverUrl: r.url };
    }
    return { engine, configPath, servers: { [name]: server }, tools: [] };
  }
  if (engine === AGENT_ENGINE.CODEX) {
    if (transport === "sse") return null;
    if (transport === "http") {
      return {
        engine,
        configPath: CODEX_CONFIG,
        section: `mcp_servers.${name}`,
        command: "",
        args: [],
        url: (def as { url: string }).url,
        tools: [],
      };
    }
    const stdio = def as { command: string; args?: string[] };
    return {
      engine,
      configPath: CODEX_CONFIG,
      section: `mcp_servers.${name}`,
      command: stdio.command,
      args: stdio.args ?? [],
      tools: [],
    };
  }
  const configPath = engine === AGENT_ENGINE.COPILOT ? COPILOT_CONFIG : CLAUDE_CONFIG;
  let server: McpServerDef;
  if (transport === "stdio") {
    const s = def as { command: string; args?: string[]; env?: Record<string, string> };
    server = { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  } else {
    const r = def as { url: string; headers?: Record<string, string> };
    server = r.headers
      ? { type: transport, url: r.url, headers: r.headers }
      : { type: transport, url: r.url };
  }
  return { engine, configPath, servers: { [name]: server }, tools: [] };
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
    // Marker must be the SQLite db inside INDEX_DIR, not just the directory: a fresh
    // `mkdir .codegraph` (or a leftover .gitignore-only folder) would otherwise be
    // reported as "index present" while the MCP server actually serves zero tools.
    indexPresent: (base) => existsSync(join(base, codegraph.INDEX_DIR, codegraph.INDEX_FILE)),
    indexHealthy: (base, spawner) => codegraph.indexLooksHealthy(base, spawner),
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
