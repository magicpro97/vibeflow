/**
 * LSP bridge via isaacphi/mcp-language-server — an MCP↔LSP bridge. It runs ONE MCP
 * server instance per (workspace, language server): `mcp-language-server --workspace
 * <dir> --lsp <serverCmd> -- <serverArgs...>`. This module is PURE: it detects the
 * bridge binary, returns an install plan (the Go bridge plus each language server), and
 * returns one MCP entry per detected language. It never installs anything or hits the net.
 */

import { hasCommand } from "../core.js";
import type { Engine } from "../core.js";
import { buildStdioEntry } from "./index.js";
import type { DetectOpts, InstallPlan, InstallStep, McpEntry, ToolContext } from "./index.js";

/** The bridge binary + its Go install path. */
const BRIDGE = "mcp-language-server";
const BRIDGE_GO_PKG = "github.com/isaacphi/mcp-language-server@latest";
const WORKSPACE_FLAG = "--workspace";
const LSP_FLAG = "--lsp";
const ARG_SEPARATOR = "--";

/** A language → its language server binary, args, and install command. */
interface LanguageServer {
  /** MCP server-name suffix, e.g. lsp-typescript. */
  key: string;
  serverCmd: string;
  serverArgs: string[];
  install: InstallStep;
}

const NPM_GLOBAL = ["i", "-g"];

/** Map from normalized language → its language server spec. */
const SERVERS: Record<string, LanguageServer> = {
  typescript: {
    key: "typescript",
    serverCmd: "typescript-language-server",
    serverArgs: ["--stdio"],
    install: {
      cmd: "npm",
      args: [...NPM_GLOBAL, "typescript-language-server", "typescript"],
      description: "Install the TypeScript/JavaScript language server.",
    },
  },
  python: {
    key: "python",
    serverCmd: "pyright-langserver",
    serverArgs: ["--stdio"],
    install: {
      cmd: "npm",
      args: [...NPM_GLOBAL, "pyright"],
      description: "Install the Python language server (pyright).",
    },
  },
  go: {
    key: "go",
    serverCmd: "gopls",
    serverArgs: [],
    install: {
      cmd: "go",
      args: ["install", "golang.org/x/tools/gopls@latest"],
      description: "Install the Go language server (gopls).",
    },
  },
  rust: {
    key: "rust",
    serverCmd: "rust-analyzer",
    serverArgs: [],
    install: {
      cmd: "rustup",
      args: ["component", "add", "rust-analyzer"],
      description: "Install the Rust language server (rust-analyzer).",
    },
  },
  kotlin: {
    key: "kotlin",
    serverCmd: "kotlin-language-server",
    serverArgs: [],
    install: {
      cmd: "brew",
      args: ["install", "kotlin-language-server"],
      description:
        "Install the Kotlin language server (or build fwcd/kotlin-language-server manually).",
    },
  },
  java: {
    key: "java",
    serverCmd: "jdtls",
    serverArgs: [],
    install: {
      cmd: "brew",
      args: ["install", "jdtls"],
      description: "Install the Eclipse JDT language server (jdtls).",
    },
  },
};

/** Normalize scanner language labels (e.g. "TypeScript", "Kotlin") to server keys. */
function normalizeLanguage(language: string): string | null {
  const lower = language.toLowerCase();
  if (lower === "javascript") return "typescript";
  return lower in SERVERS ? lower : null;
}

/** Unique, supported server keys for the given languages, preserving input order. */
function serverKeysFor(languages: string[]): string[] {
  const keys: string[] = [];
  for (const language of languages) {
    const key = normalizeLanguage(language);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** True when the `mcp-language-server` bridge is on PATH. Injectable for tests. */
export function detect(opts?: DetectOpts): boolean {
  const has = opts?.has ?? hasCommand;
  return has(BRIDGE);
}

/**
 * Install plan: the Go bridge first, then one install step per supported language server.
 * The caller runs these only after explicit approval.
 */
export function installPlan(languages: string[]): InstallPlan {
  const steps: InstallStep[] = [
    {
      cmd: "go",
      args: ["install", BRIDGE_GO_PKG],
      description: "Install the mcp-language-server MCP↔LSP bridge.",
    },
  ];
  for (const key of serverKeysFor(languages)) {
    const server = SERVERS[key];
    if (server) steps.push(server.install);
  }
  return { steps };
}

/** Build the bridge args for one language server. The workspace is emitted as
 *  "." (relative to the MCP client's spawn cwd, which is the workspace root
 *  where .mcp.json lives) so the generated config is PORTABLE across machines —
 *  no absolute /Users/... path baked in. mcp-language-server resolves it via
 *  filepath.Abs() from its own cwd (cmd main.go), so "." → the real root at
 *  runtime. Verified: `--workspace .` from the repo root opens the workspace
 *  correctly. */
function bridgeArgs(server: LanguageServer): string[] {
  const args = [WORKSPACE_FLAG, ".", LSP_FLAG, server.serverCmd];
  if (server.serverArgs.length > 0) args.push(ARG_SEPARATOR, ...server.serverArgs);
  return args;
}

/**
 * One MCP entry per detected language — each a separate bridge instance bound to the
 * workspace and that language's server. Unsupported languages are skipped.
 */
export function mcpServersFor(engine: Engine, ctx: ToolContext): McpEntry[] {
  const entries: McpEntry[] = [];
  for (const key of serverKeysFor(ctx.languages)) {
    const server = SERVERS[key];
    if (!server) continue;
    const name = `lsp-${server.key}`;
    const stdio = { command: BRIDGE, args: bridgeArgs(server), env: {} };
    entries.push(buildStdioEntry(engine, name, stdio, [name]));
  }
  return entries;
}
