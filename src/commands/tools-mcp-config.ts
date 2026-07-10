// MCP config writing extracted from src/commands/tools.ts (issue #136, split-tools).
// Owns reading/writing .mcp.json (claude/copilot), .codex/config.toml, and printing
// copilot mcp add commands. Also hosts `repoLanguages` (moved here to avoid a
// circular import with tools.ts). All imports through `./_shared.js`.

import {
  buildUserEntry,
  c,
  existsSync,
  join,
  out,
  readFileSync,
  resolveTools,
  rmSync,
  scanRepo,
  writeFileSafe,
} from "./_shared.js";
import type {
  Engine,
  JsonMcpEntry,
  McpServerDef,
  TomlMcpEntry,
  ToolName,
  VibeSettings,
} from "./_shared.js";

/** Languages detected in the active repo, used to build LSP install plans + entries. */
// Test seam: exported so unit tests can exercise the try/catch fallback
// by injecting a throwing scanRepo.
export function repoLanguages(
  base: string,
  inject: { scanRepo?: (b: string) => { languages: string[] } } = {},
): string[] {
  const scan = inject.scanRepo ?? scanRepo;
  try {
    return scan(base).languages;
  } catch {
    return [];
  }
}

/** Repo-relative MCP config files VibeFlow owns and may safely read+rewrite. */
const CLAUDE_MCP_FILE = ".mcp.json";
const CODEX_MCP_FILE = join(".codex", "config.toml");

/** Claude `.mcp.json` shape (only the slice we touch). */
interface ClaudeMcpFile {
  mcpServers: Record<string, McpServerDef>;
}

/** Every MCP server name VibeFlow manages, across BOTH tools AND user servers — the keys we
 * may remove so disabling/removing one cleans `.mcp.json` with no orphan. */
function managedClaudeServerNames(
  base: string,
  languages: string[],
  settings: VibeSettings,
  extraStrip: readonly string[] = [],
): string[] {
  const ctx = { workspace: base, languages };
  const all = resolveTools({ codegraph: true, lsp: true }, "claude", ctx);
  const names: string[] = [];
  for (const entry of all.entries) {
    for (const name of Object.keys((entry as JsonMcpEntry).servers)) names.push(name);
  }
  for (const name of Object.keys(settings.mcpServers ?? {})) names.push(name);
  // #548 (review): a just-removed user server is no longer in settings.mcpServers, so it
  // must be passed in explicitly or it orphans in .mcp.json.
  for (const name of extraStrip) names.push(name);
  return names;
}

/** Read the repo-owned `.mcp.json` (safe: no secrets). `corrupt` is set when an existing file
 * cannot be parsed, so callers can refuse to overwrite it and avoid losing unrelated servers. */
function readClaudeMcp(path: string): ClaudeMcpFile & { corrupt: boolean } {
  if (!existsSync(path)) return { mcpServers: {}, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaudeMcpFile>;
    return { mcpServers: parsed.mcpServers ?? {}, corrupt: false };
  } catch {
    return { mcpServers: {}, corrupt: true };
  }
}

/**
 * Merge enabled-tool servers into the repo's `.mcp.json` (claude). Managed keys are first
 * stripped (so disabling removes them), then re-added for currently-enabled tools. Unrelated
 * servers are preserved. Returns true when the file changed.
 */
function writeClaudeMcp(
  base: string,
  settings: VibeSettings,
  languages: string[],
  extraStrip: readonly string[] = [],
): boolean {
  const path = join(base, CLAUDE_MCP_FILE);
  const file = readClaudeMcp(path);
  if (file.corrupt) {
    out(
      "vf",
      c.yellow(`! ${CLAUDE_MCP_FILE} is not valid JSON — left untouched. Fix it, then re-run.`),
    );
    return false;
  }
  for (const name of managedClaudeServerNames(base, languages, settings, extraStrip)) {
    delete file.mcpServers[name];
  }
  const ctx = { workspace: base, languages };
  const merged = resolveTools(settings.tools, "claude", ctx);
  for (const entry of merged.entries) {
    Object.assign(file.mcpServers, (entry as JsonMcpEntry).servers);
  }
  for (const [name, def] of Object.entries(settings.mcpServers ?? {})) {
    const entry = buildUserEntry("claude", name, def);
    if (entry) Object.assign(file.mcpServers, (entry as JsonMcpEntry).servers);
  }
  const hasServers = Object.keys(file.mcpServers).length > 0;
  if (!hasServers && !existsSync(path)) return false;
  writeFileSafe(path, JSON.stringify({ mcpServers: file.mcpServers }, null, 2));
  return true;
}

/** Serialize one codex `[mcp_servers.x]` section (minimal, only the shapes we emit). */
function tomlSection(entry: TomlMcpEntry): string {
  const lines = [`[${entry.section}]`];
  if (entry.url) {
    lines.push(`url = ${JSON.stringify(entry.url)}`);
  } else {
    lines.push(`command = ${JSON.stringify(entry.command)}`);
    lines.push(`args = ${JSON.stringify(entry.args)}`);
  }
  if (entry.disabledTools && entry.disabledTools.length > 0) {
    lines.push(`disabled_tools = ${JSON.stringify(entry.disabledTools)}`);
  }
  return lines.join("\n");
}

/**
 * Apply structural gating on codex: when codegraph is enabled, disable the lower-priority
 * LSP servers' tools so the priority is structural, not just advisory in the instructions.
 */
function gateCodexEntries(entries: TomlMcpEntry[], settings: VibeSettings): TomlMcpEntry[] {
  if (!settings.tools.codegraph) return entries;
  return entries.map((entry) =>
    entry.section.startsWith("mcp_servers.lsp-") ? { ...entry, disabledTools: entry.tools } : entry,
  );
}

/**
 * Write a repo-local `.codex/config.toml` for the enabled tools. We DO NOT merge the user's
 * `~/.codex/config.toml`: a zero-dep TOML round-trip of an arbitrary user file risks
 * corruption, so VibeFlow owns this scoped file instead. Returns true when written.
 */
function writeCodexMcp(base: string, settings: VibeSettings, languages: string[]): boolean {
  const ctx = { workspace: base, languages };
  const merged = resolveTools(settings.tools, "codex", ctx);
  const entries = gateCodexEntries(merged.entries as TomlMcpEntry[], settings);
  // #548: append user servers. stdio + http land; sse is unsupported by codex → skip + warn.
  let hasHttp = false;
  for (const [name, def] of Object.entries(settings.mcpServers ?? {})) {
    const entry = buildUserEntry("codex", name, def) as TomlMcpEntry | null;
    if (!entry) {
      out(
        "vf",
        c.yellow(`! codex does not support SSE MCP servers — "${name}" skipped for codex.`),
      );
      continue;
    }
    if (entry.url) hasHttp = true;
    entries.push(entry);
  }
  const path = join(base, CODEX_MCP_FILE);
  if (entries.length === 0) {
    if (existsSync(path)) rmSync(path);
    return false;
  }
  const rmcp = hasHttp ? "experimental_use_rmcp_client = true\n\n" : "";
  const header =
    "# Managed by VibeFlow (`vf tools`). Repo-local codex MCP config — merge into\n" +
    "# ~/.codex/config.toml or point codex at it. Edit `vf tools enable/disable` to regenerate.";
  writeFileSafe(path, `${rmcp}${header}\n\n${entries.map(tomlSection).join("\n\n")}`);
  return true;
}

/**
 * Copilot's MCP config (`~/.copilot/mcp-config.json`) holds a live secret, so VibeFlow NEVER
 * reads or writes it. Instead we PRINT the exact `copilot mcp add` command per enabled server
 * for the user to run themselves. Returns the printed command count.
 */
function printCopilotMcp(base: string, settings: VibeSettings, languages: string[]): number {
  const ctx = { workspace: base, languages };
  const merged = resolveTools(settings.tools, "copilot", ctx);
  const userNames = Object.keys(settings.mcpServers ?? {});
  if (merged.entries.length === 0 && userNames.length === 0) return 0;
  out("vf");
  out("vf", c.bold("Copilot (run these — VibeFlow won't touch your secret ~/.copilot):"));
  let count = 0;
  for (const entry of merged.entries) {
    for (const [name, server] of Object.entries((entry as JsonMcpEntry).servers)) {
      const s = server as { command: string; args: string[] };
      const args = s.args.map((a) => JSON.stringify(a)).join(" ");
      out("vf", c.cyan(`  copilot mcp add ${name} -- ${s.command} ${args}`.trim()));
      count++;
    }
  }
  for (const [name, def] of Object.entries(settings.mcpServers ?? {})) {
    out("vf", c.cyan(`  ${copilotAddCommand(name, def)}`));
    count++;
  }
  return count;
}

/** #548: render a `copilot mcp add` command for a user server. Header VALUES are masked so a
 *  bearer token never lands in vf output; users copy the printed command and fill the secret. */
function copilotAddCommand(
  name: string,
  def: NonNullable<VibeSettings["mcpServers"]>[string],
): string {
  const transport = def.transport ?? "stdio";
  if (transport === "stdio") {
    const s = def as { command: string; args?: string[] };
    const args = (s.args ?? []).map((a) => JSON.stringify(a)).join(" ");
    return `copilot mcp add ${name} --transport stdio -- ${s.command} ${args}`.trim();
  }
  const r = def as { url: string; headers?: Record<string, string> };
  const headers = Object.keys(r.headers ?? {})
    .map((k) => ` --header ${JSON.stringify(`${k}: <value>`)}`)
    .join("");
  return `copilot mcp add ${name} --transport ${transport} --url ${r.url}${headers}`;
}

/**
 * Wire enabled tools into selected engines' MCP configs: write `.mcp.json` for claude and
 * copilot (both read the workspace-level file), `.codex/config.toml` for codex, and print
 * `copilot mcp add` commands for copilot's global config.
 * When `engines` is provided, only configs for those engines are written.
 * Pure tool modules build the entries; the WRITING lives here. Languages drive LSP entries.
 * Exported (not just used internally) because `vf init`'s SETTINGS ↔ MCP-config lockstep
 * needs to call it from src/commands.ts (see syncToolConfigs closure).
 */
export function writeToolConfigs(
  base: string,
  settings: VibeSettings,
  engines?: readonly Engine[],
  removedMcpNames: readonly string[] = [],
): void {
  const languages = repoLanguages(base);
  const needsMcpJson = !engines || engines.includes("claude") || engines.includes("copilot");
  if (needsMcpJson) writeClaudeMcp(base, settings, languages, removedMcpNames);
  if (!engines || engines.includes("codex")) writeCodexMcp(base, settings, languages);
  if (!engines || engines.includes("copilot")) printCopilotMcp(base, settings, languages);
}

export { CLAUDE_MCP_FILE };
