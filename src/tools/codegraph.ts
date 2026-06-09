/**
 * CodeGraph (https://github.com/colbymchenry/codegraph) — MIT, pre-1.0, 100% local
 * (tree-sitter + SQLite, no API keys). Ships as an MCP stdio server. This module is PURE:
 * it detects the binary, returns an install plan (npm-global as the portable default),
 * and returns the per-engine MCP entry. It never installs anything or hits the network.
 */

import { hasCommand } from "../core.js";
import type { Engine } from "../core.js";
import { buildStdioEntry } from "./index.js";
import type { DetectOpts, InstallPlan, McpEntry } from "./index.js";

/** Binary + MCP server name (also the codex TOML section / json map key). */
const BINARY = "codegraph";
/** npm package (primary, portable install) and MCP serve invocation. */
const NPM_PACKAGE = "@colbymchenry/codegraph";
const SERVE_ARGS = ["serve", "--mcp"];
const INIT_ARGS = ["init", "-i"];

/**
 * MCP tools CodeGraph exposes. Order is the navigation-priority order used for gating:
 * structural exploration first, then search, then call-graph and impact queries.
 */
export const CODEGRAPH_TOOLS = [
  "codegraph_explore",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_node",
  "codegraph_files",
  "codegraph_status",
] as const;

/** True when the `codegraph` binary is on PATH. Detection is injectable for tests. */
export function detect(opts?: DetectOpts): boolean {
  const has = opts?.has ?? hasCommand;
  return has(BINARY);
}

/** Relative path of the per-repo index that `codegraph init -i` builds. */
export const INDEX_DIR = ".codegraph";

/** The single index-build step (also the 2nd step of installPlan), exposed so `enable`
 * can build the index without re-running the global npm install. */
export function indexBuildStep(): { cmd: string; args: string[]; description: string } {
  return {
    cmd: BINARY,
    args: [...INIT_ARGS],
    description: "Build the per-repo CodeGraph index into .codegraph/.",
  };
}

/**
 * Install plan: global npm install (portable, no curl|sh piping) then a per-repo index
 * build. The caller runs these only after explicit approval.
 */
export function installPlan(): InstallPlan {
  return {
    steps: [
      {
        cmd: "npm",
        args: ["i", "-g", NPM_PACKAGE],
        description: `Install CodeGraph globally via npm (${NPM_PACKAGE}).`,
      },
      {
        cmd: BINARY,
        args: INIT_ARGS,
        description: "Build the per-repo CodeGraph index into .codegraph/.",
      },
    ],
  };
}

/** Per-engine MCP entry wiring CodeGraph's stdio server, with its tool names for gating. */
export function mcpConfigFor(engine: Engine): McpEntry {
  const server = { command: BINARY, args: [...SERVE_ARGS], env: {} };
  return buildStdioEntry(engine, BINARY, server, [...CODEGRAPH_TOOLS]);
}
