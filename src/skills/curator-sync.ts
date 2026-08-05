import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CuratorScope = "local" | "repo";
export type CuratorFindingType = "stale-anchor" | "duplicate-owner" | "unpinned-registry";

export interface CuratorScanOptions {
  scope: CuratorScope;
  sync: boolean;
  yes: boolean;
}

export const CURATOR_NOTES_REF = "refs/notes/vibeflow-curator";
export const CURATOR_REMOTE = "origin";
const MARKER_KIND = "vibeflow-curator-marker";
const MAX_SYNC_RETRIES = 2;

export interface CuratorMarker {
  schemaVersion: 1;
  kind: typeof MARKER_KIND;
  commit: string;
  fingerprint: string;
  type: CuratorFindingType;
}

export interface SharedFinding {
  type: CuratorFindingType;
  findingKey: string;
}

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], repo: string) => GitResult;

function isFindingType(value: unknown): value is CuratorFindingType {
  return value === "stale-anchor" || value === "duplicate-owner" || value === "unpinned-registry";
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isSafeCuratorIdentity(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code < 32 || code === 127) return false;
  }
  return true;
}

function isSafeCuratorFindingKey(value: string): boolean {
  return value.split("\0").every(isSafeCuratorIdentity);
}

export function parseCuratorScanOptions(args: string[]): CuratorScanOptions | null {
  let scope: CuratorScope | undefined;
  let sync = false;
  let yes = false;
  for (const arg of args) {
    if (arg === "--scope=local" || arg === "--scope=repo") {
      if (scope) return null;
      scope = arg.slice("--scope=".length) as CuratorScope;
    } else if (arg === "--sync") {
      if (sync) return null;
      sync = true;
    } else if (arg === "--yes") {
      if (yes) return null;
      yes = true;
    } else {
      return null;
    }
  }
  if (!scope) return sync || yes ? null : { scope: "local", sync: false, yes: false };
  if (scope === "local" && (sync || yes)) return null;
  if (yes && (!sync || scope !== "repo")) return null;
  return { scope, sync, yes };
}

export function renderCuratorSyncPreview(): string[] {
  return [
    "Shared sync preview",
    `Remote: ${CURATOR_REMOTE}`,
    `Ref: ${CURATOR_NOTES_REF}`,
    "Data sent: commit OID, finding type, SHA-256 fingerprint only",
    "Never sent: detail, finding key, source content, paths, URLs, usernames, credentials",
    "Risk: remote readers may infer that a matching finding existed.",
    "To proceed: rerun with --scope=repo --sync --yes",
  ];
}

export function curatorFingerprint(
  commitSha: string,
  type: string,
  findingKey: string,
): string | null {
  if (
    !/^[0-9a-f]{40}$/.test(commitSha) ||
    !isFindingType(type) ||
    !isSafeCuratorFindingKey(findingKey)
  )
    return null;
  return createHash("sha256").update(`${commitSha}\u0000${type}\u0000${findingKey}`).digest("hex");
}

function markerFromUnknown(value: unknown, commit: string): CuratorMarker | null {
  if (!value || typeof value !== "object") return null;
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort(compareCodePoints);
  if (keys.join(",") !== "commit,fingerprint,kind,schemaVersion,type") return null;
  if (
    marker.schemaVersion !== 1 ||
    marker.kind !== MARKER_KIND ||
    marker.commit !== commit ||
    typeof marker.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(marker.fingerprint) ||
    !isFindingType(marker.type)
  )
    return null;
  return {
    schemaVersion: 1,
    kind: MARKER_KIND,
    commit,
    fingerprint: marker.fingerprint,
    type: marker.type,
  };
}

export function parseCuratorMarkers(text: string, commit: string): CuratorMarker[] {
  if (!/^[0-9a-f]{40}$/.test(commit)) return [];
  const byFingerprint = new Map<string, CuratorMarker>();
  for (const line of text.split("\n")) {
    try {
      const marker = markerFromUnknown(JSON.parse(line), commit);
      if (marker) byFingerprint.set(marker.fingerprint, marker);
    } catch {
      // Untrusted notes never become CLI output.
    }
  }
  return [...byFingerprint.values()].sort((a, b) =>
    compareCodePoints(a.fingerprint, b.fingerprint),
  );
}

export function renderCuratorMarkers(records: unknown[]): string {
  const valid = new Map<string, CuratorMarker>();
  for (const record of records) {
    const commit =
      record &&
      typeof record === "object" &&
      typeof (record as { commit?: unknown }).commit === "string"
        ? (record as { commit: string }).commit
        : "";
    const marker = markerFromUnknown(record, commit);
    if (marker) valid.set(marker.fingerprint, marker);
  }
  return [...valid.values()]
    .sort((a, b) => compareCodePoints(a.fingerprint, b.fingerprint))
    .map((marker) =>
      JSON.stringify({
        schemaVersion: marker.schemaVersion,
        kind: marker.kind,
        commit: marker.commit,
        fingerprint: marker.fingerprint,
        type: marker.type,
      }),
    )
    .join("\n");
}

export function resolveCleanCuratorCommit(repo: string, git: GitRunner): string | null {
  const status = git(["status", "--porcelain"], repo);
  if (status.status !== 0 || status.stdout.trim()) return null;
  const commit = git(["rev-parse", "HEAD^{commit}"], repo);
  const oid = commit.status === 0 ? commit.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

function readMarkers(repo: string, commit: string, git: GitRunner): CuratorMarker[] | null {
  const result = git(["notes", `--ref=${CURATOR_NOTES_REF}`, "show", commit], repo);
  if (result.status === 0) return parseCuratorMarkers(result.stdout, commit);
  return result.status === 1 ? [] : null;
}

function writeMarkers(
  repo: string,
  commit: string,
  markers: CuratorMarker[],
  git: GitRunner,
): boolean {
  const dir = mkdtempSync(join(tmpdir(), "vf-curator-notes-"));
  const file = join(dir, "markers.jsonl");
  try {
    writeFileSync(file, renderCuratorMarkers(markers));
    return (
      git(["notes", `--ref=${CURATOR_NOTES_REF}`, "add", "-f", "-F", file, commit], repo).status ===
      0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface CuratorSyncResult {
  synced: boolean;
  duplicateFingerprints: Set<string>;
}

/** Explicit remote synchronization. Call only after CLI consent gate. */
export function syncCuratorMarkers(
  repo: string,
  commit: string,
  findings: SharedFinding[],
  git: GitRunner,
): CuratorSyncResult {
  for (let attempt = 0; attempt < MAX_SYNC_RETRIES; attempt++) {
    const remoteNote = git(["ls-remote", "--exit-code", CURATOR_REMOTE, CURATOR_NOTES_REF], repo);
    if (remoteNote.status !== 0 && remoteNote.status !== 2)
      return { synced: false, duplicateFingerprints: new Set() };
    if (
      remoteNote.status === 0 &&
      git(["fetch", CURATOR_REMOTE, `+${CURATOR_NOTES_REF}:${CURATOR_NOTES_REF}`], repo).status !==
        0
    )
      return { synced: false, duplicateFingerprints: new Set() };
    const existing = readMarkers(repo, commit, git);
    if (existing === null) return { synced: false, duplicateFingerprints: new Set() };
    const duplicates = new Set(existing.map((marker) => marker.fingerprint));
    const next = [...existing];
    const added = new Set<string>();
    for (const finding of findings) {
      const fingerprint = curatorFingerprint(commit, finding.type, finding.findingKey);
      if (!fingerprint) return { synced: false, duplicateFingerprints: new Set() };
      if (fingerprint && !duplicates.has(fingerprint) && !added.has(fingerprint)) {
        next.push({ schemaVersion: 1, kind: MARKER_KIND, commit, fingerprint, type: finding.type });
        added.add(fingerprint);
      }
    }
    if (!writeMarkers(repo, commit, next, git))
      return { synced: false, duplicateFingerprints: new Set() };
    const pushed = git(["push", CURATOR_REMOTE, `${CURATOR_NOTES_REF}:${CURATOR_NOTES_REF}`], repo);
    if (pushed.status === 0) return { synced: true, duplicateFingerprints: duplicates };
  }
  return { synced: false, duplicateFingerprints: new Set() };
}
