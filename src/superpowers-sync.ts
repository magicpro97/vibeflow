import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { type JSONCParseError, parseJSONC } from "confbox/jsonc";
import { parse as parseToml } from "smol-toml";
import { AGENT_ENGINE } from "./core/agent-contract.js";
import { registryCacheDir, registryLockPath } from "./skills/registry-channel.js";

/** Engines with a first-party Superpowers installation adapter, in receipt order. */
export const SUPERPOWERS_ENGINES = Object.freeze([
  AGENT_ENGINE.CLAUDE,
  AGENT_ENGINE.CODEX,
  AGENT_ENGINE.OPENCODE,
] as const);
export type SuperpowersEngine = (typeof SUPERPOWERS_ENGINES)[number];
export type SuperpowersSyncStatus =
  | "planned"
  | "installed"
  | "already-current"
  | "skipped"
  | "failed";

export interface SuperpowersPin {
  url: string;
  commitOID: string;
  cacheDir: string;
}

export interface SuperpowersSyncResult {
  engine: SuperpowersEngine;
  status: SuperpowersSyncStatus;
  commitOID: string;
  actions: string[];
  detail: string;
}

export interface SuperpowersSyncSummary {
  ok: boolean;
  dryRun: boolean;
  commitOID?: string;
  results: SuperpowersSyncResult[];
  error?: string;
}

export interface SuperpowersReceipt {
  schemaVersion: 1;
  engines: Partial<Record<SuperpowersEngine, string>>;
}

interface PinInject {
  homedir?: () => string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  gitHead?: (cacheDir: string) => string | null;
}

export type PinResult = { ok: true; pin: SuperpowersPin } | { ok: false; error: string };
export interface MergeResult {
  changed: boolean;
  content: string;
}

const CANONICAL_URL = "https://github.com/obra/superpowers.git";
const FULL_OID = /^[0-9a-f]{40}$/;
const TELEMETRY_KEY = "SUPERPOWERS_DISABLE_TELEMETRY";
const MANAGED_SPEC =
  /^superpowers@git\+https:\/\/github\.com\/obra\/superpowers(?:\.git)?\/?(?:#.*)?$/;
const EXACT_SPEC = /^superpowers@git\+https:\/\/github\.com\/obra\/superpowers\.git#[0-9a-f]{40}$/;

function requireOID(oid: string): void {
  if (typeof oid !== "string" || !FULL_OID.test(oid))
    throw new Error("Expected a full 40-character lowercase hex OID");
}

function defaultGitHead(cacheDir: string): string | null {
  const result = spawnSync("git", ["-C", cacheDir, "rev-parse", "--show-toplevel", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
    shell: false,
  });
  const [topLevel, head] = result.stdout.trim().split("\n");
  if (
    result.status !== 0 ||
    !topLevel ||
    !head ||
    realpathSync(topLevel) !== realpathSync(cacheDir)
  )
    return null;
  return head;
}

function object(value: unknown, label: string): Record<string, unknown> {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  )
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectLossyJsonNumbers(raw: string): void {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] as string;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "/" && raw[index + 1] === "/") {
      const lineEnd = raw.indexOf("\n", index + 2);
      index = lineEnd < 0 ? raw.length : lineEnd;
      continue;
    }
    if (char === "/" && raw[index + 1] === "*") {
      const blockEnd = raw.indexOf("*/", index + 2);
      if (blockEnd < 0) throw new Error("Unterminated JSONC comment");
      index = blockEnd + 1;
      continue;
    }
    const token = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (!token) continue;
    const numeric = Number(token);
    if (!Number.isFinite(numeric) || (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)))
      throw new Error("JSON number cannot be rewritten losslessly");
    index += token.length - 1;
  }
}

function canonicalSource(url: string): string | null {
  const trimmed = url.endsWith("/") ? url.slice(0, -1) : url;
  return trimmed === CANONICAL_URL || trimmed === CANONICAL_URL.slice(0, -4) ? CANONICAL_URL : null;
}

function validInstalledSkill(value: unknown): boolean {
  try {
    const skill = object(value, "Installed skill");
    if (
      typeof skill.name !== "string" ||
      !skill.name ||
      typeof skill.version !== "string" ||
      !skill.version ||
      typeof skill.commitOID !== "string" ||
      !FULL_OID.test(skill.commitOID)
    )
      return false;
    if (
      skill.bundleHash !== undefined &&
      (typeof skill.bundleHash !== "string" || !/^[0-9a-f]{64}$/.test(skill.bundleHash))
    )
      return false;
    if (
      skill.skillPath !== undefined &&
      (typeof skill.skillPath !== "string" ||
        !skill.skillPath ||
        skill.skillPath.includes("..") ||
        skill.skillPath.includes("\\") ||
        skill.skillPath.includes("\0"))
    )
      return false;
    if (skill.scan_summary !== undefined) {
      const scan = object(skill.scan_summary, "Scan summary");
      if (
        typeof scan.scanned !== "boolean" ||
        typeof scan.finding_count !== "number" ||
        !Number.isInteger(scan.finding_count) ||
        scan.finding_count < 0 ||
        (scan.risk_severity !== undefined && typeof scan.risk_severity !== "string") ||
        (scan.reason !== undefined && typeof scan.reason !== "string")
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function strictLockEntries(
  repo: string,
  read: (path: string, encoding: "utf8") => string,
): Array<{ url: string; commitOID: string }> | null {
  try {
    const root = object(JSON.parse(read(registryLockPath(repo), "utf8")), "Registry lock");
    if (root.schemaVersion !== 1 || !Array.isArray(root.registries)) return null;
    const entries: Array<{ url: string; commitOID: string }> = [];
    for (const value of root.registries) {
      const entry = object(value, "Registry entry");
      if (
        typeof entry.name !== "string" ||
        typeof entry.url !== "string" ||
        typeof entry.ref !== "string" ||
        typeof entry.commitOID !== "string" ||
        (entry.installed !== undefined &&
          (!Array.isArray(entry.installed) ||
            entry.installed.some((item) => !validInstalledSkill(item))))
      )
        return null;
      entries.push({ url: entry.url, commitOID: entry.commitOID });
    }
    return entries;
  } catch {
    return null;
  }
}

export function resolveSuperpowersPin(repo: string, inject: PinInject = {}): PinResult {
  const entries = strictLockEntries(repo, inject.readFileSync ?? readFileSync);
  if (!entries) return { ok: false, error: "Superpowers registry lock is malformed." };
  const matches = entries.filter((entry) => canonicalSource(entry.url) !== null);
  if (matches.length !== 1)
    return {
      ok: false,
      error: "Expected exactly one canonical obra/superpowers registry lock entry.",
    };
  const entry = matches[0] as (typeof matches)[number];
  if (!FULL_OID.test(entry.commitOID))
    return {
      ok: false,
      error: "Superpowers lock commitOID must be a full 40-character lowercase hex OID.",
    };
  const cacheDir = registryCacheDir(entry.url, { homedir: inject.homedir ?? homedir });
  if (!(inject.existsSync ?? existsSync)(cacheDir))
    return { ok: false, error: `Superpowers registry cache is missing: ${cacheDir}` };
  const head = (inject.gitHead ?? defaultGitHead)(cacheDir);
  if (head !== entry.commitOID)
    return {
      ok: false,
      error: "Superpowers registry cache HEAD does not match the locked commit OID.",
    };
  return { ok: true, pin: { url: CANONICAL_URL, commitOID: entry.commitOID, cacheDir } };
}

export function marketplaceName(oid: string): string {
  requireOID(oid);
  return `vf-superpowers-${oid.slice(0, 12)}`;
}

export function renderMarketplace(pin: SuperpowersPin): string {
  if (pin.url !== CANONICAL_URL) throw new Error("Expected the canonical obra/superpowers URL");
  requireOID(pin.commitOID);
  return JSON.stringify(
    {
      name: marketplaceName(pin.commitOID),
      owner: { name: "VibeFlow" },
      description: "VibeFlow-managed exact Superpowers pin",
      plugins: [
        {
          name: "superpowers",
          source: { source: "url", url: pin.url, sha: pin.commitOID },
          strict: true,
        },
      ],
    },
    null,
    2,
  );
}

export function mergeOpenCodeConfig(raw: string, desiredSpec: string): MergeResult {
  if (typeof desiredSpec !== "string" || !EXACT_SPEC.test(desiredSpec))
    throw new Error("Expected an exact canonical Superpowers spec");
  rejectLossyJsonNumbers(raw);
  const errors: JSONCParseError[] = [];
  const config = object(parseJSONC(raw, { allowTrailingComma: true, errors }), "OpenCode config");
  if (errors.length > 0) throw new Error("OpenCode config is malformed JSONC");
  const current = config.plugin;
  if (
    current !== undefined &&
    (!Array.isArray(current) || current.some((item) => typeof item !== "string"))
  )
    throw new Error("OpenCode plugin must be a string array");
  const plugins = (current as string[] | undefined) ?? [];
  const next = [...plugins.filter((item) => !MANAGED_SPEC.test(item)), desiredSpec];
  if (plugins.length === next.length && plugins.every((item, index) => item === next[index]))
    return { changed: false, content: raw };
  return { changed: true, content: JSON.stringify({ ...config, plugin: next }, null, 2) };
}

export function mergeClaudeTelemetry(raw: string): MergeResult {
  rejectLossyJsonNumbers(raw);
  const config = object(JSON.parse(raw), "Claude settings");
  const existing = config.env;
  if (existing !== undefined) object(existing, "Claude settings env");
  const env = (existing as Record<string, unknown> | undefined) ?? {};
  if (Object.hasOwn(env, TELEMETRY_KEY)) return { changed: false, content: raw };
  return {
    changed: true,
    content: JSON.stringify({ ...config, env: { ...env, [TELEMETRY_KEY]: "1" } }, null, 2),
  };
}

export function mergeCodexTelemetry(raw: string): MergeResult {
  const config = object(parseToml(raw), "Codex config");
  const policyValue = config.shell_environment_policy;
  if (policyValue !== undefined) object(policyValue, "Codex shell_environment_policy");
  const policy = (policyValue as Record<string, unknown> | undefined) ?? {};
  const setValue = policy.set;
  if (setValue !== undefined) object(setValue, "Codex shell_environment_policy.set");
  const set = (setValue as Record<string, unknown> | undefined) ?? {};
  if (Object.hasOwn(set, TELEMETRY_KEY)) return { changed: false, content: raw };

  const assignment = `${TELEMETRY_KEY} = "1"\n`;
  if (setValue !== undefined) {
    const headers = [
      ...raw.matchAll(
        /^\s*\[\s*(?:["']shell_environment_policy["']|shell_environment_policy)\s*\.\s*(?:["']set["']|set)\s*\]\s*(?:#.*)?$/gm,
      ),
    ];
    for (const header of headers.reverse()) {
      const lineEnd = raw.indexOf("\n", header.index);
      const at = lineEnd < 0 ? raw.length : lineEnd + 1;
      const prefix = lineEnd < 0 ? `${raw}\n` : raw.slice(0, at);
      const content = `${prefix}${assignment}${raw.slice(at)}`;
      const reparsed = parseToml(content) as Record<string, any>;
      if (reparsed.shell_environment_policy?.set?.[TELEMETRY_KEY] === "1")
        return { changed: true, content };
    }
    throw new Error("Codex shell environment set table could not be updated safely");
  }
  const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  const content = `${raw}${separator}[shell_environment_policy.set]\n${assignment}`;
  const reparsed = parseToml(content) as Record<string, any>;
  if (reparsed.shell_environment_policy?.set?.[TELEMETRY_KEY] === "1")
    return { changed: true, content };
  throw new Error("Codex shell environment policy uses an unsupported inline form");
}

export function renderOpenCodeTelemetryHook(): string {
  return `export const VfSuperpowersEnv = async () => ({\n  "shell.env": async (_input, output) => {\n    output.env.${TELEMETRY_KEY} ??= "1"\n  },\n})\n`;
}

export function parseReceipt(raw: string | undefined): SuperpowersReceipt | null {
  if (raw === undefined) return { schemaVersion: 1, engines: {} };
  try {
    const receipt = object(JSON.parse(raw), "Superpowers receipt");
    if (receipt.schemaVersion !== 1) return null;
    const engines = object(receipt.engines, "Superpowers receipt engines");
    for (const [engine, oid] of Object.entries(engines)) {
      if (
        !SUPERPOWERS_ENGINES.includes(engine as SuperpowersEngine) ||
        typeof oid !== "string" ||
        !FULL_OID.test(oid)
      )
        return null;
    }
    return { schemaVersion: 1, engines: engines as Partial<Record<SuperpowersEngine, string>> };
  } catch {
    return null;
  }
}

export function renderReceipt(
  current: SuperpowersReceipt,
  engine: SuperpowersEngine,
  oid: string,
): string {
  if (!SUPERPOWERS_ENGINES.includes(engine)) throw new Error("Unknown Superpowers engine");
  requireOID(oid);
  if (current.schemaVersion !== 1) throw new Error("Invalid Superpowers receipt");
  const currentEngines = object(current.engines, "Superpowers receipt engines");
  for (const [currentEngine, currentOID] of Object.entries(currentEngines)) {
    if (
      !SUPERPOWERS_ENGINES.includes(currentEngine as SuperpowersEngine) ||
      typeof currentOID !== "string" ||
      !FULL_OID.test(currentOID)
    )
      throw new Error("Invalid Superpowers receipt");
  }
  const validated = parseReceipt(JSON.stringify(current));
  if (!validated) throw new Error("Invalid Superpowers receipt");
  return JSON.stringify(
    { schemaVersion: 1, engines: { ...validated.engines, [engine]: oid } },
    null,
    2,
  );
}
