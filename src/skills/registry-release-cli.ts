import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { c, writeFileSafe } from "../core.js";
import { out } from "../logbus.js";
import type {
  ExecutorDeps,
  ReleaseSnapshot,
  StoredReleasePlan,
} from "./registry-release-executor.js";
import { approveStoredRelease, createRegistryReleaseGitAdapter } from "./registry-release-git.js";
import {
  type ProposalState,
  type ReleaseIdentity,
  type ReleasePlan,
  type TargetState,
  buildReleasePlans,
  parseRegistryFanout,
  parseReleaseIdentity,
  sanitizeForOutput,
  setProposalState,
} from "./registry-release.js";

type OutputLevel = "info" | "error";

export interface RegistryReleaseCliDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
  readdirSync?: (path: string) => string[];
  writeFileSafe?: (path: string, content: string) => void;
  output?: (text: string, level?: OutputLevel) => void;
  executorAdapterFactory?: () => ExecutorDeps;
}

interface Io {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  readdir: (path: string) => string[];
  write: (path: string, content: string) => void;
  output: (text: string, level?: OutputLevel) => void;
}

const ID = /^[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_CHANGELOG_LENGTH = 10_000;
const PROPOSAL_STATES = new Set<ProposalState>([
  "pending",
  "running",
  "completed",
  "partial-failure",
  "rejected",
  "expired",
]);
const TARGET_STATES = new Set<TargetState>([
  "pending",
  "not-eligible",
  "already-current",
  "existing-pr",
  "drifted",
  "verifying",
  "pr-opened",
  "failed",
]);
const STORED_PLAN_KEYS = [
  "proposalId",
  "skill",
  "version",
  "registry",
  "branch",
  "target",
  "fanout",
  "status",
] as const;
const PROPOSE_USAGE =
  "Usage: vf skills registry release-propose <registry-id> --from <oid> --to <oid> --version <v> [--changelog <text>] [--dry-run]";
const RELEASE_USAGE =
  "Usage: vf skills registry release <list|show <proposal-id>|reject <proposal-id>|approve <proposal-id> --yes>";

function io(deps: RegistryReleaseCliDeps): Io {
  return {
    exists: deps.existsSync ?? existsSync,
    read: deps.readFileSync ?? ((path) => readFileSync(path, "utf8")),
    readdir: deps.readdirSync ?? ((path) => readdirSync(path)),
    write: deps.writeFileSafe ?? writeFileSafe,
    output:
      deps.output ??
      ((text, level = "info") => out("vf", level === "error" ? c.red(text) : text, { level })),
  };
}

function proposalDir(repo: string): string {
  return join(repo, ".vibeflow", "registry-release-proposals");
}

function proposalPath(repo: string, id: string): string {
  return join(proposalDir(repo), `${id}.json`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function reconstructStoredPlan(raw: unknown, expected: ReleasePlan): StoredReleasePlan | null {
  if (!isObject(raw) || !hasExactKeys(raw, STORED_PLAN_KEYS)) return null;
  const { status, ...plan } = raw;
  if (
    typeof status !== "string" ||
    !TARGET_STATES.has(status as TargetState) ||
    canonical(plan) !== canonical(expected)
  )
    return null;
  return { ...expected, status: status as TargetState };
}

function parseSourceLock(raw: unknown): Map<string, string> | null {
  if (!isObject(raw) || !hasExactKeys(raw, ["schemaVersion", "registries"])) return null;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.registries)) return null;
  const registries = new Map<string, string>();
  for (const value of raw.registries) {
    if (!isObject(value)) return null;
    const keys = Object.keys(value);
    if (
      !keys.every((key) => ["name", "url", "ref", "commitOID", "installed"].includes(key)) ||
      ![4, 5].includes(keys.length) ||
      typeof value.name !== "string" ||
      typeof value.url !== "string" ||
      typeof value.ref !== "string" ||
      typeof value.commitOID !== "string" ||
      !OID.test(value.commitOID) ||
      (value.installed !== undefined && !Array.isArray(value.installed)) ||
      registries.has(value.name)
    )
      return null;
    registries.set(value.name, value.commitOID);
  }
  return registries;
}

function parseSnapshot(raw: unknown): ReleaseSnapshot | null {
  if (
    !isObject(raw) ||
    !hasExactKeys(raw, ["schemaVersion", "id", "identity", "changelog", "state", "plans"]) ||
    raw.schemaVersion !== 1 ||
    typeof raw.id !== "string" ||
    !ID.test(raw.id) ||
    typeof raw.changelog !== "string" ||
    raw.changelog.length > MAX_CHANGELOG_LENGTH ||
    sanitizeForOutput(raw.changelog) !== raw.changelog ||
    typeof raw.state !== "string" ||
    !PROPOSAL_STATES.has(raw.state as ProposalState) ||
    !Array.isArray(raw.plans) ||
    raw.plans.length === 0
  )
    return null;
  const identity = parseReleaseIdentity(raw.identity);
  if (!identity.ok) return null;
  const targets = raw.plans.map((plan) => (isObject(plan) ? plan.target : null));
  const fanout = parseRegistryFanout({ schemaVersion: 1, targets });
  if (!fanout.ok) return null;
  const plans = buildReleasePlans(fanout.value.targets, identity.value, identity.value.registry);
  if (
    plans.length === 0 ||
    plans.length !== raw.plans.length ||
    plans.some((plan) => plan.proposalId !== raw.id)
  )
    return null;
  const storedPlans: StoredReleasePlan[] = [];
  for (let i = 0; i < plans.length; i++) {
    const stored = reconstructStoredPlan(raw.plans[i], plans[i] as ReleasePlan);
    if (!stored) return null;
    storedPlans.push(stored);
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    identity: identity.value,
    changelog: sanitizeForOutput(raw.changelog).slice(0, MAX_CHANGELOG_LENGTH),
    state: raw.state as ProposalState,
    plans: storedPlans,
  };
}

function readJson(path: string, fs: Io): unknown | null {
  try {
    return JSON.parse(fs.read(path));
  } catch {
    return null;
  }
}

function readSnapshot(repo: string, id: string, fs: Io): ReleaseSnapshot | null {
  const path = proposalPath(repo, id);
  if (!fs.exists(path)) return null;
  const snapshot = parseSnapshot(readJson(path, fs));
  return snapshot?.id === id ? snapshot : null;
}

function emitError(fs: Io, text: string): number {
  fs.output(text, "error");
  return 1;
}

type ParsedPropose = ReleaseIdentity & { changelog: string; dryRun: boolean };

function parsePropose(args: string[]): ParsedPropose | null {
  let registry = "";
  let changelog = "";
  let dryRun = false;
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--dry-run") {
      if (seen.has(token)) return null;
      seen.add(token);
      dryRun = true;
      continue;
    }
    const match = token?.match(/^(--from|--to|--version|--changelog)(?:=(.*))?$/);
    if (match) {
      const flag = match[1];
      if (!flag || seen.has(flag)) return null;
      seen.add(flag);
      const value = match[2] ?? args[++i];
      if (value === undefined || (!match[2] && value.startsWith("--"))) return null;
      if (flag === "--changelog") changelog = value;
      else values[flag] = value;
      continue;
    }
    if (token?.startsWith("--") || registry || token === undefined) return null;
    registry = token;
  }
  if (changelog.length > MAX_CHANGELOG_LENGTH) return null;
  const identity = parseReleaseIdentity({
    registry,
    fromOid: values["--from"] ?? "",
    toOid: values["--to"] ?? "",
    version: values["--version"] ?? "",
  });
  return identity.ok
    ? {
        ...identity.value,
        changelog: sanitizeForOutput(changelog).slice(0, MAX_CHANGELOG_LENGTH),
        dryRun,
      }
    : null;
}

function propose(repo: string, args: string[], fs: Io): number {
  const parsed = parsePropose(args);
  if (!parsed) {
    fs.output(PROPOSE_USAGE, "error");
    return 2;
  }
  const configPath = join(repo, ".vibeflow", "REGISTRY_FANOUT.json");
  if (!fs.exists(configPath)) {
    fs.output(`No release targets configured for ${parsed.registry}.`);
    return 0;
  }
  const fanout = parseRegistryFanout(readJson(configPath, fs));
  if (!fanout.ok) return emitError(fs, `Invalid REGISTRY_FANOUT.json: ${fanout.value}`);
  const plans = buildReleasePlans(fanout.value.targets, parsed, parsed.registry).map(
    (plan): StoredReleasePlan => ({ ...plan, status: "pending" }),
  );
  if (plans.length === 0) {
    fs.output(`No release targets configured for ${parsed.registry}.`);
    return 0;
  }
  const lockPath = join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json");
  const lock = fs.exists(lockPath) ? parseSourceLock(readJson(lockPath, fs)) : null;
  if (!lock) return emitError(fs, "Invalid source registry lock.");
  if (lock.get(parsed.registry) !== parsed.toOid)
    return emitError(fs, `Source registry ${parsed.registry} is not locked to the new OID.`);
  const snapshot: ReleaseSnapshot = {
    schemaVersion: 1,
    id: plans[0]?.proposalId ?? "",
    identity: {
      registry: parsed.registry,
      fromOid: parsed.fromOid,
      toOid: parsed.toOid,
      version: parsed.version,
    },
    changelog: parsed.changelog,
    state: "pending",
    plans,
  };
  const content = JSON.stringify(snapshot, null, 2);
  if (!parsed.dryRun) {
    const path = proposalPath(repo, snapshot.id);
    if (fs.exists(path)) return emitError(fs, `Release proposal ${snapshot.id} already exists.`);
    try {
      fs.write(path, content);
    } catch {
      return emitError(fs, "Failed to write release proposal snapshot.");
    }
  }
  fs.output(content);
  return 0;
}

function list(repo: string, fs: Io): number {
  const dir = proposalDir(repo);
  if (!fs.exists(dir)) {
    fs.output("[]");
    return 0;
  }
  let names: string[];
  try {
    names = fs
      .readdir(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return emitError(fs, "Failed to read release proposals.");
  }
  const snapshots: ReleaseSnapshot[] = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    if (!ID.test(id)) return emitError(fs, `Invalid release proposal snapshot ${name}.`);
    const snapshot = readSnapshot(repo, id, fs);
    if (!snapshot) return emitError(fs, `Invalid release proposal snapshot ${name}.`);
    snapshots.push(snapshot);
  }
  fs.output(JSON.stringify(snapshots, null, 2));
  return 0;
}

function show(repo: string, id: string, fs: Io): number {
  const snapshot = readSnapshot(repo, id, fs);
  if (!snapshot) return emitError(fs, `Release proposal ${id} was not found or is invalid.`);
  fs.output(JSON.stringify(snapshot, null, 2));
  return 0;
}

function reject(repo: string, id: string, fs: Io): number {
  const snapshot = readSnapshot(repo, id, fs);
  if (!snapshot) return emitError(fs, `Release proposal ${id} was not found or is invalid.`);
  if (!setProposalState(snapshot.state, "rejected"))
    return emitError(fs, `Release proposal ${id} is not pending.`);
  const rejected: ReleaseSnapshot = { ...snapshot, state: "rejected" };
  try {
    fs.write(proposalPath(repo, id), JSON.stringify(rejected, null, 2));
  } catch {
    return emitError(fs, "Failed to write release proposal snapshot.");
  }
  fs.output(JSON.stringify(rejected, null, 2));
  return 0;
}

export function handleRegistryReleaseCommand(
  repo: string,
  args: string[],
  deps: RegistryReleaseCliDeps = {},
): number {
  const fs = io(deps);
  if (args[0] === "release-propose") return propose(repo, args.slice(1), fs);
  if (args[0] !== "release") {
    fs.output(RELEASE_USAGE, "error");
    return 2;
  }
  const action = args[1];
  if (action === "list" && args.length === 2) return list(repo, fs);
  if (action === "approve" && args.length === 4 && ID.test(args[2] ?? "") && args[3] === "--yes") {
    const id = args[2] ?? "";
    const snapshot = readSnapshot(repo, id, fs);
    if (!snapshot) return emitError(fs, `Release proposal ${id} was not found or is invalid.`);
    return approveStoredRelease(
      snapshot,
      proposalPath(repo, id),
      deps.executorAdapterFactory ?? createRegistryReleaseGitAdapter,
      fs.write,
      fs.output,
    );
  }
  if ((action === "show" || action === "reject") && args.length === 3 && ID.test(args[2] ?? ""))
    return action === "show" ? show(repo, args[2] ?? "", fs) : reject(repo, args[2] ?? "", fs);
  fs.output(RELEASE_USAGE, "error");
  return 2;
}
