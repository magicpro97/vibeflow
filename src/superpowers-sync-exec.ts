import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { join } from "node:path";
import { hasCommand as nodeHasCommand, writeFileSafe as nodeWriteFileSafe } from "./core.js";
import { AGENT_ENGINE } from "./core/agent-contract.js";
import { filterEnv } from "./dispatch/env-filter.js";
import { RUNTIME_PLATFORM } from "./durability/process-identity-contract.js";
import type { SpawnFn } from "./skills/registry-types.js";
import {
  SUPERPOWERS_ENGINES,
  type SuperpowersEngine,
  type SuperpowersPin,
  type SuperpowersReceipt,
  type SuperpowersSyncResult,
  type SuperpowersSyncSummary,
  marketplaceName,
  mergeClaudeTelemetry,
  mergeCodexTelemetry,
  mergeOpenCodeConfig,
  parseReceipt,
  renderMarketplace,
  renderOpenCodeTelemetryHook,
  renderReceipt,
  resolveSuperpowersPin,
} from "./superpowers-sync.js";

export interface SuperpowersSyncOptions {
  yes?: boolean;
  dryRun?: boolean;
}

export interface SuperpowersSyncInject {
  hasCommand?: (command: string) => boolean;
  spawnSync?: SpawnFn;
  homedir?: () => string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFileSync?: (path: string, encoding: "utf8") => string;
  existsSync?: (path: string) => boolean;
  writeFileSafe?: (path: string, content: string) => void;
  gitHead?: (cacheDir: string) => string | null;
}

const TELEMETRY_KEY = "SUPERPOWERS_DISABLE_TELEMETRY";
const MANAGED_ID = /^superpowers@/;

interface Context {
  pin: SuperpowersPin;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  read: (path: string) => string | undefined;
  write: (path: string, content: string) => void;
  run: (command: string, args: readonly string[]) => string;
  receiptPath: string;
  receipt: SuperpowersReceipt;
}

function paths(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codexDir = env.CODEX_HOME ?? join(home, ".codex");
  const openGlobalDir = join(
    env.XDG_CONFIG_HOME ??
      (platform === RUNTIME_PLATFORM.WINDOWS && env.APPDATA ? env.APPDATA : join(home, ".config")),
    "opencode",
  );
  const openConfig =
    env.OPENCODE_CONFIG ??
    (env.OPENCODE_CONFIG_DIR
      ? join(env.OPENCODE_CONFIG_DIR, "opencode.json")
      : join(openGlobalDir, "opencode.json"));
  return {
    claudeSettings: join(claudeDir, "settings.json"),
    codexConfig: join(codexDir, "config.toml"),
    openConfig,
    openHook: join(env.OPENCODE_CONFIG_DIR ?? openGlobalDir, "plugins", "vf-superpowers-env.js"),
  };
}

function marketplace(pin: SuperpowersPin, home: string) {
  const name = marketplaceName(pin.commitOID);
  const root = join(home, ".vibeflow", "superpowers-marketplaces", name);
  return {
    name,
    root,
    manifest: join(root, ".claude-plugin", "marketplace.json"),
    selector: `superpowers@${name}`,
  };
}

function safeDetail(value: unknown): string {
  return String(value)
    .replace(/(?:\/Users|\/home)\/[^/\s]+/gu, "~")
    .replace(/[A-Z]:\\Users\\[^\\\s]+/giu, "~")
    .replace(/(\bBearer\s+)[^\s]+/giu, "$1***")
    .replace(/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)[^\s]*/gu, "$1***")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1***@")
    .replace(/([?&](?:token|access_token|api_key|key|secret|password)=)[^\s&#]*/giu, "$1***")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?")
    .slice(0, 500);
}

function jsonObject(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function writeReceipt(context: Context, engine: SuperpowersEngine): void {
  const content = renderReceipt(context.receipt, engine, context.pin.commitOID);
  context.write(context.receiptPath, content);
  const parsed = parseReceipt(content);
  if (!parsed) throw new Error("Generated an invalid Superpowers receipt");
  context.receipt = parsed;
}

function readClaude(raw: string): Array<{ id: string; scope: string }> {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("Claude plugin list must be an array");
  return value.map((item) => {
    const row = item as Record<string, unknown>;
    if (!row || typeof row.id !== "string") throw new Error("Claude plugin list is malformed");
    return {
      id: row.id,
      scope: ["user", "project", "local"].includes(String(row.scope)) ? String(row.scope) : "user",
    };
  });
}

function applyClaude(context: Context): string[] {
  const p = paths(context.home, context.env, context.platform);
  const market = marketplace(context.pin, context.home);
  const settingsRaw = context.read(p.claudeSettings) ?? "{}";
  const telemetry = mergeClaudeTelemetry(settingsRaw);
  const installed = readClaude(context.run("claude", ["plugin", "list", "--json"]));
  const desired = installed.some((item) => item.id === market.selector);
  const foreign = installed.filter(
    (item) => MANAGED_ID.test(item.id) && item.id !== market.selector,
  );
  if (
    desired &&
    foreign.length === 0 &&
    !telemetry.changed &&
    context.receipt.engines[AGENT_ENGINE.CLAUDE] === context.pin.commitOID
  )
    return [];

  const actions: string[] = [];
  if (telemetry.changed) {
    context.write(p.claudeSettings, telemetry.content);
    actions.push(`write ${p.claudeSettings}`);
  }
  if (!desired) {
    context.write(market.manifest, renderMarketplace(context.pin));
    context.run("claude", ["plugin", "marketplace", "add", market.root, "--scope", "user"]);
    context.run("claude", ["plugin", "install", market.selector, "--scope", "user"]);
    actions.push(`install ${market.selector}`);
  } else if (context.receipt.engines[AGENT_ENGINE.CLAUDE] !== context.pin.commitOID) {
    context.run("claude", ["plugin", "uninstall", market.selector, "--scope", "user", "-y"]);
    context.run("claude", ["plugin", "marketplace", "remove", market.name, "--scope", "user"]);
    context.write(market.manifest, renderMarketplace(context.pin));
    context.run("claude", ["plugin", "marketplace", "add", market.root, "--scope", "user"]);
    context.run("claude", ["plugin", "install", market.selector, "--scope", "user"]);
    actions.push(`refresh ${market.selector}`);
  }
  for (const item of foreign) {
    context.run("claude", ["plugin", "uninstall", item.id, "--scope", item.scope, "-y"]);
    actions.push(`remove ${item.id}`);
  }
  const verified = readClaude(context.run("claude", ["plugin", "list", "--json"]));
  if (
    !verified.some((item) => item.id === market.selector) ||
    verified.some((item) => MANAGED_ID.test(item.id) && item.id !== market.selector)
  )
    throw new Error("Claude did not report one exact Superpowers selector after sync");
  writeReceipt(context, AGENT_ENGINE.CLAUDE);
  return actions;
}

function readCodex(raw: string): Array<{ pluginId: string; sha?: string }> {
  const root = jsonObject(raw, "Codex plugin list");
  if (!Array.isArray(root.installed)) throw new Error("Codex installed plugins must be an array");
  return root.installed.map((item) => {
    const row = item as Record<string, unknown>;
    const source = row?.source as Record<string, unknown> | undefined;
    if (!row || typeof row.pluginId !== "string") throw new Error("Codex plugin list is malformed");
    return {
      pluginId: row.pluginId,
      sha: typeof source?.sha === "string" ? source.sha : undefined,
    };
  });
}

function applyCodex(context: Context): string[] {
  const p = paths(context.home, context.env, context.platform);
  const market = marketplace(context.pin, context.home);
  const configRaw = context.read(p.codexConfig) ?? "";
  const telemetry = mergeCodexTelemetry(configRaw);
  const installed = readCodex(context.run("codex", ["plugin", "list", "--json"]));
  const desired = installed.some(
    (item) => item.pluginId === market.selector && item.sha === context.pin.commitOID,
  );
  const staleDesired = installed.some(
    (item) => item.pluginId === market.selector && item.sha !== context.pin.commitOID,
  );
  const foreign = installed.filter(
    (item) => MANAGED_ID.test(item.pluginId) && item.pluginId !== market.selector,
  );
  if (
    desired &&
    foreign.length === 0 &&
    !telemetry.changed &&
    context.receipt.engines[AGENT_ENGINE.CODEX] === context.pin.commitOID
  )
    return [];

  const actions: string[] = [];
  if (telemetry.changed) {
    context.write(p.codexConfig, telemetry.content);
    actions.push(`write ${p.codexConfig}`);
  }
  if (!desired) {
    context.write(market.manifest, renderMarketplace(context.pin));
    if (staleDesired) {
      context.run("codex", ["plugin", "remove", market.selector, "--json"]);
      context.run("codex", ["plugin", "marketplace", "remove", market.name, "--json"]);
    }
    context.run("codex", ["plugin", "marketplace", "add", market.root, "--json"]);
    context.run("codex", ["plugin", "add", market.selector, "--json"]);
    actions.push(`install ${market.selector}`);
  }
  for (const item of foreign) {
    context.run("codex", ["plugin", "remove", item.pluginId, "--json"]);
    actions.push(`remove ${item.pluginId}`);
  }
  const verified = readCodex(context.run("codex", ["plugin", "list", "--json"]));
  if (
    !verified.some(
      (item) => item.pluginId === market.selector && item.sha === context.pin.commitOID,
    ) ||
    verified.some((item) => MANAGED_ID.test(item.pluginId) && item.pluginId !== market.selector)
  )
    throw new Error("Codex did not report one exact Superpowers commit after sync");
  writeReceipt(context, AGENT_ENGINE.CODEX);
  return actions;
}

function applyOpenCode(context: Context): string[] {
  const p = paths(context.home, context.env, context.platform);
  const spec = `superpowers@git+${context.pin.url}#${context.pin.commitOID}`;
  const configRaw = context.read(p.openConfig) ?? "{}";
  const merged = mergeOpenCodeConfig(configRaw, spec);
  const hook = renderOpenCodeTelemetryHook();
  const hookCurrent = context.read(p.openHook) === hook;
  if (
    !merged.changed &&
    hookCurrent &&
    context.receipt.engines[AGENT_ENGINE.OPENCODE] === context.pin.commitOID
  )
    return [];

  const actions: string[] = [];
  if (merged.changed) {
    context.write(p.openConfig, merged.content);
    actions.push(`write ${p.openConfig}`);
  }
  if (!hookCurrent) {
    context.write(p.openHook, hook);
    actions.push(`write ${p.openHook}`);
  }
  const resolved = jsonObject(
    context.run("opencode", ["debug", "config"]),
    "OpenCode resolved config",
  );
  if (!Array.isArray(resolved.plugin) || !resolved.plugin.includes(spec))
    throw new Error("OpenCode did not report the exact Superpowers spec after sync");
  actions.push(`install ${spec}`);
  writeReceipt(context, AGENT_ENGINE.OPENCODE);
  return actions;
}

// biome-ignore format: compact signature keeps this capped orchestration module within 400 lines
function planned(engine: SuperpowersEngine, pin: SuperpowersPin, present: boolean): SuperpowersSyncResult {
  const market = marketplace(pin, "~");
  const action =
    engine === AGENT_ENGINE.OPENCODE
      ? `configure superpowers@git+${pin.url}#${pin.commitOID}`
      : `install ${market.selector}`;
  return {
    engine,
    status: present ? "planned" : "skipped",
    commitOID: pin.commitOID,
    actions: present ? [action] : [],
    detail: present ? "eligible binary found" : "binary not found",
  };
}

export function syncSuperpowers(
  repo: string,
  options: SuperpowersSyncOptions = {},
  inject: SuperpowersSyncInject = {},
): SuperpowersSyncSummary {
  const home = (inject.homedir ?? nodeHomedir)();
  const exists = inject.existsSync ?? nodeExistsSync;
  const readFile = inject.readFileSync ?? ((path, encoding) => nodeReadFileSync(path, encoding));
  const pinResult = resolveSuperpowersPin(repo, {
    homedir: () => home,
    existsSync: exists,
    readFileSync: readFile,
    gitHead: inject.gitHead,
  });
  const dryRun = !options.yes || options.dryRun === true;
  if (!pinResult.ok) return { ok: false, dryRun, results: [], error: safeDetail(pinResult.error) };

  const has = inject.hasCommand ?? nodeHasCommand;
  if (dryRun) {
    const results = SUPERPOWERS_ENGINES.map((engine) =>
      planned(engine, pinResult.pin, has(engine)),
    );
    return { ok: true, dryRun: true, commitOID: pinResult.pin.commitOID, results };
  }

  const env = inject.env ?? process.env;
  const platform = inject.platform ?? process.platform;
  const write = inject.writeFileSafe ?? nodeWriteFileSafe;
  const spawn = inject.spawnSync ?? (nodeSpawnSync as unknown as SpawnFn);
  const childEnv = { [TELEMETRY_KEY]: "1", ...filterEnv(env, {}, platform).env };
  const receiptPath = join(home, ".vibeflow", "superpowers-sync.json");
  const read = (path: string) => (exists(path) ? readFile(path, "utf8") : undefined);
  const receipt = parseReceipt(read(receiptPath));
  if (!receipt)
    return {
      ok: false,
      dryRun: false,
      commitOID: pinResult.pin.commitOID,
      results: [],
      error: "Superpowers sync receipt is malformed",
    };
  const run = (command: string, args: readonly string[]) => {
    const result = spawn(command, args, {
      encoding: "utf8",
      env: childEnv,
      shell: false,
      timeout: 120_000,
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(safeDetail(result.stderr || result.stdout || `${command} failed`));
    return String(result.stdout);
  };
  const context: Context = {
    pin: pinResult.pin,
    home,
    env,
    platform,
    read,
    write,
    run,
    receiptPath,
    receipt,
  };
  const adapters = {
    [AGENT_ENGINE.CLAUDE]: applyClaude,
    [AGENT_ENGINE.CODEX]: applyCodex,
    [AGENT_ENGINE.OPENCODE]: applyOpenCode,
  } as const;
  const results: SuperpowersSyncResult[] = [];
  for (const engine of SUPERPOWERS_ENGINES) {
    if (!has(engine)) {
      results.push(planned(engine, pinResult.pin, false));
      continue;
    }
    try {
      const actions = adapters[engine](context);
      results.push({
        engine,
        status: actions.length === 0 ? "already-current" : "installed",
        commitOID: pinResult.pin.commitOID,
        actions,
        detail: actions.length === 0 ? "already current" : "sync complete",
      });
    } catch (error) {
      results.push({
        engine,
        status: "failed",
        commitOID: pinResult.pin.commitOID,
        actions: [],
        detail: safeDetail(error instanceof Error ? error.message : error),
      });
    }
  }
  return {
    ok: results.every((result) => result.status !== "failed"),
    dryRun: false,
    commitOID: pinResult.pin.commitOID,
    results,
  };
}
