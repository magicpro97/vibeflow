import {
  buildUserEntry,
  c,
  discoverSkills,
  existsSync,
  join,
  out,
  readFileSync,
  resolveTools,
  skillMcpServers,
  writeFileSafe,
} from "./_shared.js";
import type {
  AntigravityRemoteServer,
  JsonMcpEntry,
  McpServerDef,
  VibeSettings,
} from "./_shared.js";

export const ANTIGRAVITY_MCP_FILE = join(".agents", "mcp_config.json");
const MANAGED_FILE = join(".vibeflow", ".antigravity-mcp-managed.json");

type McpFile = {
  mcpServers: Record<string, McpServerDef | AntigravityRemoteServer>;
  [key: string]: unknown;
};

function readManaged(base: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(base, MANAGED_FILE), "utf8"));
    return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function readConfig(path: string): McpFile | null {
  if (!existsSync(path)) return { mcpServers: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<McpFile>;
    if (
      raw.mcpServers !== undefined &&
      (typeof raw.mcpServers !== "object" ||
        raw.mcpServers === null ||
        Array.isArray(raw.mcpServers))
    )
      return null;
    return { ...raw, mcpServers: raw.mcpServers ?? {} };
  } catch {
    return null;
  }
}

/** Merge Antigravity MCP entries; only VibeFlow-managed names are removed. */
export function writeAntigravityMcp(
  base: string,
  settings: VibeSettings,
  languages: string[],
): boolean {
  const path = join(base, ANTIGRAVITY_MCP_FILE);
  const file = readConfig(path);
  if (!file) {
    out(
      "vf",
      c.yellow(
        `! ${ANTIGRAVITY_MCP_FILE} is not valid JSON — left untouched. Fix it, then re-run.`,
      ),
    );
    return false;
  }
  const context = { workspace: base, languages };
  const skillServers = skillMcpServers(discoverSkills(base));
  // P1: delete only names VibeFlow actually wrote last time (data-loss invariant).
  for (const name of readManaged(base)) delete file.mcpServers[name];
  // Write enabled built-in tools.
  const toolEntries = resolveTools(settings.tools, "antigravity", context).entries;
  for (const entry of toolEntries) {
    Object.assign(file.mcpServers, (entry as JsonMcpEntry).servers);
  }
  // Write skill and user-declared servers.
  const written: string[] = [];
  for (const [name, definition] of Object.entries({
    ...skillServers,
    ...(settings.mcpServers ?? {}),
  })) {
    const entry = buildUserEntry("antigravity", name, definition);
    if (entry) {
      Object.assign(file.mcpServers, (entry as JsonMcpEntry).servers);
      written.push(name);
    }
  }
  // Record every written entry including built-in tools for future cleanup.
  const toolNames = toolEntries.flatMap((e) => Object.keys((e as JsonMcpEntry).servers));
  // P1: write config first, sidecar only after successful config write.
  // If config write throws, sidecar must remain with previous run's names
  // to prevent false ownership claims on next run.
  if (Object.keys(file.mcpServers).length === 0 && !existsSync(path)) return false;
  writeFileSafe(path, JSON.stringify(file, null, 2));
  writeFileSafe(
    join(base, MANAGED_FILE),
    JSON.stringify([...written, ...toolNames].sort(), null, 2),
  );
  return true;
}
