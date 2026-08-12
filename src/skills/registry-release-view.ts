import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseSnapshot, StoredReleasePlan } from "./registry-release-executor.js";
import {
  type ProposalState,
  type ReleasePlan,
  type TargetState,
  buildReleasePlans,
  parseRegistryFanout,
  parseReleaseIdentity,
  sanitizeForOutput,
} from "./registry-release.js";

export type SnapshotReader = {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  readdir: (path: string) => string[];
};

export interface ReleaseProposalSummary {
  id: string;
  registry: string;
  version: string;
  state: ProposalState;
  targetCount: number;
}

export interface ReleaseProposalDetail {
  id: string;
  registry: string;
  version: string;
  state: ProposalState;
  changelog: string;
  fromOid: string;
  toOid: string;
  targets: { repository: string; baseBranch: string; status: TargetState }[];
}

const ID = /^[0-9a-f]{64}$/;
const SNAPSHOT_FILE = /^([0-9a-f]{64})\.json$/;
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
const DEFAULT_READER: SnapshotReader = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  readdir: (path) => readdirSync(path),
};

function proposalDir(repo: string): string {
  return join(repo, ".vibeflow", "registry-release-proposals");
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

// #759 DRY-DEBT: mirrors parseSnapshot in registry-release-cli.ts; consolidate into a shared parser in a follow-up task
function parseStoredSnapshot(raw: unknown): ReleaseSnapshot | null {
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

function readSnapshot(path: string, reader: SnapshotReader): ReleaseSnapshot | null {
  try {
    return parseStoredSnapshot(JSON.parse(reader.read(path)));
  } catch {
    return null;
  }
}

function output(value: string): string {
  return sanitizeForOutput(value).slice(0, 256);
}

export function listReleaseProposals(
  repo: string,
  reader: SnapshotReader = DEFAULT_READER,
): ReleaseProposalSummary[] {
  const dir = proposalDir(repo);
  let entries: string[];
  try {
    if (!reader.exists(dir)) return [];
    entries = reader.readdir(dir);
  } catch {
    return [];
  }

  const summaries: ReleaseProposalSummary[] = [];
  for (const entry of entries) {
    const filename = SNAPSHOT_FILE.exec(entry);
    if (!filename) continue;
    const snapshot = readSnapshot(join(dir, entry), reader);
    if (!snapshot || snapshot.id !== filename[1]) continue;
    summaries.push({
      id: output(snapshot.id),
      registry: output(snapshot.identity.registry),
      version: output(snapshot.identity.version),
      state: output(snapshot.state) as ProposalState,
      targetCount: snapshot.plans.length,
    });
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

export function getReleaseProposal(
  repo: string,
  id: string,
  reader: SnapshotReader = DEFAULT_READER,
): ReleaseProposalDetail | null {
  if (!ID.test(id)) return null;
  const path = join(proposalDir(repo), `${id}.json`);
  try {
    if (!reader.exists(path)) return null;
  } catch {
    return null;
  }
  const snapshot = readSnapshot(path, reader);
  if (!snapshot || snapshot.id !== id) return null;
  return {
    id: output(snapshot.id),
    registry: output(snapshot.identity.registry),
    version: output(snapshot.identity.version),
    state: output(snapshot.state) as ProposalState,
    changelog: output(snapshot.changelog),
    fromOid: snapshot.identity.fromOid,
    toOid: snapshot.identity.toOid,
    targets: snapshot.plans.map((plan) => ({
      repository: output(plan.target.repository),
      baseBranch: output(plan.target.baseBranch),
      status: output(plan.status) as TargetState,
    })),
  };
}
