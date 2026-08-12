// Pure release-readiness model for multi-registry skill releases (#686).
// No filesystem, git, network, or spawn — every function is a pure
// parse/validate/derive over in-memory values so a malicious fanout or
// commit OID can never reach the CLI, the disk, or the browser.

import { createHash } from "node:crypto";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LOWERCASE_REPO = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const REGISTRY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^[0-9][0-9A-Za-z._-]*$/;
const MAX_VERSION_LENGTH = 128;
const MAX_STRING_LENGTH = 256;
const ABS_PATH = /(?<![/:])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g;

export interface FanoutTarget {
  repository: string;
  baseBranch: string;
  registries: string[];
}

export interface Fanout {
  schemaVersion: 1;
  targets: FanoutTarget[];
}

export type ProposalState =
  | "pending"
  | "running"
  | "completed"
  | "partial-failure"
  | "rejected"
  | "expired";
export type TargetState =
  | "pending"
  | "not-eligible"
  | "already-current"
  | "existing-pr"
  | "drifted"
  | "verifying"
  | "pr-opened"
  | "failed";

export interface ReleaseIdentity {
  fromOid: string;
  toOid: string;
  version: string;
  registry: string;
}

export interface ReleasePlan {
  proposalId: string;
  skill: string;
  version: string;
  registry: string;
  branch: string;
  target: FanoutTarget;
  fanout: Fanout;
}

export interface PublicProposal {
  id: string;
  skill: string;
  version: string;
  state: ProposalState;
  branch: string;
  target: FanoutTarget;
}

type Result<T> = { ok: true; value: T } | { ok: false; value: string };

function fail<T>(msg: string): Result<T> {
  return { ok: false, value: msg };
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** Pure mirror of `git check-ref-format --branch`, reused for branch safety. */
export function isSafeBranchRef(ref: string): boolean {
  if (ref === "HEAD") return false;
  if (ref.length === 0 || ref.length > 256) return false;
  if (hasControlChar(ref)) return false;
  if (ref.startsWith("-")) return false;
  if (ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.includes("//")) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("@{")) return false;
  if (ref.endsWith(".")) return false;
  for (const ch of ref) {
    if (ch === " " || "~^:?*[\\".includes(ch)) return false;
  }
  for (const comp of ref.split("/")) {
    if (comp.startsWith(".")) return false;
    if (comp.endsWith(".lock")) return false;
  }
  return true;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function exactKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(raw);
  return keys.length === allowed.length && keys.every((k) => allowed.includes(k));
}

function parseTarget(raw: unknown): FanoutTarget | null {
  if (!isObject(raw)) return null;
  if (!exactKeys(raw, ["repository", "baseBranch", "registries"])) return null;

  const { repository, baseBranch, registries } = raw;
  if (typeof repository !== "string" || !LOWERCASE_REPO.test(repository)) return null;
  if (
    typeof baseBranch !== "string" ||
    baseBranch.startsWith("refs/") ||
    !isSafeBranchRef(baseBranch)
  )
    return null;
  if (!Array.isArray(registries) || registries.length === 0) return null;

  const list: string[] = [];
  for (const r of registries) {
    if (typeof r !== "string" || !REGISTRY_NAME.test(r)) return null;
    if (list.includes(r)) return null; // duplicate registry in one target
    list.push(r);
  }
  return { repository, baseBranch, registries: list };
}

export function parseRegistryFanout(raw: unknown): Result<Fanout> {
  if (!isObject(raw)) return fail("@registryFanout must be an object");
  if (!exactKeys(raw, ["schemaVersion", "targets"]))
    return fail("@registryFanout has unknown or missing keys");
  if (raw.schemaVersion !== 1) return fail("@registryFanout schemaVersion must be 1");
  if (!Array.isArray(raw.targets)) return fail("@registryFanout targets must be an array");

  const targets: FanoutTarget[] = [];
  const seenPairs = new Set<string>();
  for (const t of raw.targets) {
    const parsed = parseTarget(t);
    if (!parsed) return fail("@registryFanout invalid target");
    for (const reg of parsed.registries) {
      const pair = `${parsed.repository}:${reg}`;
      if (seenPairs.has(pair)) return fail("@registryFanout duplicate repository/registry pair");
      seenPairs.add(pair);
    }
    targets.push(parsed);
  }
  return { ok: true, value: { schemaVersion: 1, targets } };
}

export function parseReleaseIdentity(raw: unknown): Result<ReleaseIdentity> {
  if (!isObject(raw)) return fail("@releaseIdentity must be an object");
  if (!exactKeys(raw, ["fromOid", "toOid", "version", "registry"]))
    return fail("@releaseIdentity has unknown or missing keys");
  const { fromOid, toOid, version, registry } = raw;
  if (typeof fromOid !== "string" || !(HEX40.test(fromOid) || HEX64.test(fromOid)))
    return fail("@releaseIdentity fromOid must be 40 or 64 lowercase hex");
  if (typeof toOid !== "string" || !(HEX40.test(toOid) || HEX64.test(toOid)))
    return fail("@releaseIdentity toOid must be 40 or 64 lowercase hex");
  if (fromOid === toOid) return fail("@releaseIdentity from/to OIDs must differ");
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_VERSION_LENGTH)
    return fail("@releaseIdentity version must be a bounded string");
  if (!VERSION.test(version)) return fail("@releaseIdentity version is unsafe");
  if (typeof registry !== "string" || !REGISTRY_NAME.test(registry))
    return fail("@releaseIdentity registry must be a valid registry ID");
  return { ok: true, value: { fromOid, toOid, version, registry } };
}

/** Strip controls, credentials, query/fragment, and absolute paths. */
export function sanitizeForOutput(input: string): string {
  let out = "";
  for (const ch of input) {
    const c = ch.charCodeAt(0);
    if (c <= 0x1f || c === 0x7f) continue;
    out += ch;
  }
  try {
    const url = new URL(out);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      // A whole-string http(s) URL is already stripped of credentials/query/
      // fragment; its multi-segment path is not a filesystem path, so skip the
      // ABS_PATH redaction that would otherwise eat the PR link from evidence.
      return url.toString();
    }
  } catch {
    /* not a URL — leave as-is */
  }
  return out.replace(ABS_PATH, "[redacted]");
}

/** Bounds a string for the public DTO. */
function bound(s: string): string {
  return s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) : s;
}

function sortKey(t: FanoutTarget): string {
  return `${t.repository}\0${t.baseBranch}`;
}

export function proposalIdFor(
  schemaVersion: number,
  identity: ReleaseIdentity,
  registry: string,
  targets: readonly FanoutTarget[],
): string {
  const eligible = [...targets]
    .filter((t) => t.registries.includes(registry))
    .map((t) => sortKey(t))
    .sort()
    .join("\u001f");
  const stable = [
    String(schemaVersion),
    registry,
    identity.fromOid,
    identity.toOid,
    identity.version,
    eligible,
  ].join("\0");
  return createHash("sha256").update(stable).digest("hex");
}

function slugName(name: string): string {
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildReleasePlans(
  targets: readonly FanoutTarget[],
  identity: ReleaseIdentity,
  skillName: string,
): ReleasePlan[] {
  const eligible = targets
    .filter((t) => t.registries.includes(identity.registry))
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const slug = slugName(skillName);
  return eligible.map((target) => ({
    proposalId: proposalIdFor(1, identity, identity.registry, targets),
    skill: skillName,
    version: identity.version,
    registry: identity.registry,
    branch: `chore/update-skill-${slug}-${identity.version}`,
    target,
    fanout: { schemaVersion: 1, targets: [target] },
  }));
}

const PROPOSAL_FLOWS: readonly (readonly [ProposalState, ProposalState])[] = [
  ["pending", "running"],
  ["pending", "rejected"],
];
const TARGET_STATES: readonly TargetState[] = [
  "pending",
  "not-eligible",
  "already-current",
  "existing-pr",
  "drifted",
  "verifying",
  "pr-opened",
  "failed",
];

export function setProposalState(from: ProposalState, to: ProposalState): boolean {
  return PROPOSAL_FLOWS.some(([f, t]) => f === from && t === to);
}

export function setTargetState(from: TargetState, to: TargetState): boolean {
  return from === "pending" && to !== "pending" && TARGET_STATES.includes(to);
}

export function toPublicProposal(p: {
  id: string;
  skill: string;
  version: string;
  state: ProposalState;
  branch: string;
  target: FanoutTarget;
}): PublicProposal {
  return {
    id: sanitizeForOutput(bound(p.id)),
    skill: sanitizeForOutput(bound(p.skill)),
    version: sanitizeForOutput(bound(p.version)),
    state: p.state,
    branch: sanitizeForOutput(bound(p.branch)),
    target: {
      repository: sanitizeForOutput(bound(p.target.repository)),
      baseBranch: sanitizeForOutput(bound(p.target.baseBranch)),
      registries: p.target.registries.map((r) => sanitizeForOutput(bound(r))),
    },
  };
}
