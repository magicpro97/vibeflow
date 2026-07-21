import { spawnSync } from "node:child_process";
import { resolveDashboardSelection } from "./dashboard.js";
import type { WorkflowDashboardItem } from "./dashboard.js";

// ── Diff preview types ─────────────────────────────────────────────────────
export interface DiffFileEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged" | "type-changed";
  added: number;
  deleted: number;
  isBinary: boolean;
}

export interface WorkflowDiffSummary {
  baseline: string | null;
  baselineLabel: string;
  files: DiffFileEntry[];
  totalAdded: number;
  totalDeleted: number;
  untracked: string[];
  truncated: boolean;
}

export interface WorkUnitDiffResult {
  unit: string;
  hasDiff: boolean;
  reason?: string;
  files: DiffFileEntry[];
  diff: string;
  truncated: boolean;
}

export interface DiffRequest {
  repoPath: string;
  workflowId: string;
  unit?: string;
}

export type DiffResponse =
  | { summary: WorkflowDiffSummary; unitDiff?: WorkUnitDiffResult }
  | { error: string; status: number };

const DIFF_CAP_BYTES = 200 * 1024;
const DIFF_CAP_LINES = 2000;

/** Truncate string to maxBytes at a valid UTF-8 boundary. Never emits U+FFFD. */
function safeByteTruncate(s: string, maxBytes: number): { result: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { result: s, truncated: false };
  let seqStart = maxBytes;
  while (seqStart > 0) {
    const b = buf[seqStart - 1];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    seqStart--;
  }
  if (seqStart === 0) return { result: "", truncated: true };
  const byte = buf[seqStart - 1];
  if (byte === undefined) return { result: "", truncated: true };
  if ((byte & 0x80) === 0) {
    return { result: buf.subarray(0, seqStart).toString("utf8"), truncated: true };
  }
  const seqLen = (byte & 0xf8) === 0xf0 ? 4 : (byte & 0xf0) === 0xe0 ? 3 : 2;
  const seqEnd = seqStart - 1 + seqLen;
  if (seqEnd <= maxBytes) {
    return { result: buf.subarray(0, seqEnd).toString("utf8"), truncated: true };
  }
  return { result: buf.subarray(0, seqStart - 1).toString("utf8"), truncated: true };
}

function git(args: string[], repoPath: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Resolve the best available diff baseline for a repo. */
export function resolveBaseline(
  repoPath: string,
  g: (args: string[]) => { status: number; stdout: string; stderr: string } = (a) =>
    git(a, repoPath),
): { baseline: string | null; label: string } {
  const head = g(["rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0) return { baseline: null, label: "unborn repository" };
  const headSha = head.stdout.trim();
  // Check for vibeflow WIP commits — the pre-dispatch snapshot
  const wipLog = g(["log", "--oneline", "--grep=vibeflow WIP", "-1", "--format=%H"]);
  if (wipLog.status === 0 && wipLog.stdout.trim()) {
    const wipSha = wipLog.stdout.trim();
    const parent = g(["rev-parse", `${wipSha}^`]);
    if (parent.status === 0 && parent.stdout.trim()) {
      const base = parent.stdout.trim();
      return { baseline: base, label: `checkpoint (pre-dispatch base ${base.slice(0, 8)})` };
    }
    return { baseline: wipSha, label: `checkpoint (WIP ${wipSha.slice(0, 8)})` };
  }
  // Use git stash reference if there's a WIP stash
  const stash = g(["stash", "list", "--grep=vibeflow WIP", "-1", "--format=%H"]);
  if (stash.status === 0 && stash.stdout.trim()) {
    return { baseline: headSha, label: `HEAD (${headSha.slice(0, 8)})` };
  }
  return { baseline: headSha, label: `HEAD (${headSha.slice(0, 8)})` };
}

function parseNumstatLine(line: string): DiffFileEntry | null {
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const addedStr = parts[0] ?? "";
  const deletedStr = parts[1] ?? "";
  const path = parts.slice(2).join("\t");
  if (!path) return null;
  const added = Number.parseInt(addedStr, 10);
  const deleted = Number.parseInt(deletedStr, 10);
  const isBinary =
    Number.isNaN(added) || Number.isNaN(deleted) || (addedStr === "-" && deletedStr === "-");
  return {
    path,
    added: isBinary ? 0 : added,
    deleted: isBinary ? 0 : deleted,
    isBinary,
    status: "modified",
  };
}

function parseNameStatusLine(
  line: string,
): { path: string; status: DiffFileEntry["status"] } | null {
  const parts = line.split("\t");
  if (parts.length < 2) return null;
  const statusChar = (parts[0] ?? "").trim();
  const path = parts[parts.length - 1];
  if (!path || !statusChar) return null;
  if (statusChar.startsWith("R")) {
    return { path, status: "renamed" };
  }
  const statusMap: Record<string, DiffFileEntry["status"]> = {
    A: "added",
    M: "modified",
    D: "deleted",
    C: "copied",
    U: "unmerged",
    T: "type-changed",
  };
  return { path, status: statusMap[statusChar] ?? "modified" };
}

/** Build workflow-level diff summary for a repo against its baseline. */
export function buildWorkflowDiffSummary(
  repoPath: string,
  g: (args: string[]) => { status: number; stdout: string; stderr: string } = (a) =>
    git(a, repoPath),
): WorkflowDiffSummary {
  const { baseline, label } = resolveBaseline(repoPath, g);
  if (!baseline) {
    return {
      baseline: null,
      baselineLabel: label,
      files: [],
      totalAdded: 0,
      totalDeleted: 0,
      untracked: [],
      truncated: false,
    };
  }
  // Numstat for +/- counts with binary detection
  const numstat = g(["diff", "--no-ext-diff", "--numstat", baseline, "--", "."]);
  const nameStatus = g(["diff", "--no-ext-diff", "--name-status", baseline, "--", "."]);
  const untracked = g(["status", "--porcelain"]);
  const files: DiffFileEntry[] = [];
  if (numstat.status === 0 && nameStatus.status === 0) {
    const statusMap = new Map<string, DiffFileEntry["status"]>();
    for (const line of nameStatus.stdout.split("\n").filter(Boolean)) {
      const parsed = parseNameStatusLine(line);
      if (parsed) statusMap.set(parsed.path, parsed.status);
    }
    for (const line of numstat.stdout.split("\n").filter(Boolean)) {
      const entry = parseNumstatLine(line);
      if (entry) {
        entry.status = statusMap.get(entry.path) ?? entry.status;
        files.push(entry);
      }
    }
  }
  const untrackedFiles: string[] = [];
  if (untracked.status === 0) {
    for (const line of untracked.stdout.split("\n").filter(Boolean)) {
      // Porcelain format: "?? path/to/file"
      const m = line.match(/^\?\? (.*)$/);
      if (m?.[1]) untrackedFiles.push(m[1]);
    }
  }
  const totalAdded = files.reduce((a, f) => a + (f.isBinary ? 0 : f.added), 0);
  const totalDeleted = files.reduce((a, f) => a + (f.isBinary ? 0 : f.deleted), 0);
  const MAX_ENTRIES = 500;
  const truncated = files.length + untrackedFiles.length > MAX_ENTRIES;
  let filesOut = files;
  let untrackedOut = untrackedFiles;
  if (truncated) {
    filesOut = files.slice(0, MAX_ENTRIES);
    const remaining = MAX_ENTRIES - filesOut.length;
    untrackedOut = remaining > 0 ? untrackedFiles.slice(0, remaining) : [];
  }
  return {
    baseline,
    baselineLabel: label,
    files: filesOut,
    totalAdded,
    totalDeleted,
    untracked: untrackedOut,
    truncated,
  };
}

/** Build scope-limited diff for a single work unit. */
export function buildUnitDiff(
  unit: string,
  scope: string[],
  repoPath: string,
  baseline: string | null,
  g: (args: string[]) => { status: number; stdout: string; stderr: string } = (a) =>
    git(a, repoPath),
): WorkUnitDiffResult {
  if (!baseline) {
    return { unit, hasDiff: false, reason: "no baseline", files: [], diff: "", truncated: false };
  }
  // Validate all scope entries — reject traversal/absolute/NUL
  for (const p of scope) {
    if (p.includes("..") || p.includes("\0") || p.startsWith("/")) {
      return {
        unit,
        hasDiff: false,
        reason: `invalid scope path: ${JSON.stringify(p)}`,
        files: [],
        diff: "",
        truncated: false,
      };
    }
  }
  // Single "--" separator followed by validated paths; empty scope → full repo
  const scopeArgs = scope.length > 0 ? ["--", ...scope] : ["--", "."];
  // Numstat for file-level info
  const numstatArgs = ["diff", "--no-ext-diff", "--numstat", baseline, ...scopeArgs];
  const numstat = g(numstatArgs);
  const nameStatusArgs = ["diff", "--no-ext-diff", "--name-status", baseline, ...scopeArgs];
  const nameStatus = g(nameStatusArgs);
  const files: DiffFileEntry[] = [];
  if (numstat.status === 0 && nameStatus.status === 0) {
    const statusMap = new Map<string, DiffFileEntry["status"]>();
    for (const line of nameStatus.stdout.split("\n").filter(Boolean)) {
      const parsed = parseNameStatusLine(line);
      if (parsed) statusMap.set(parsed.path, parsed.status);
    }
    for (const line of numstat.stdout.split("\n").filter(Boolean)) {
      const entry = parseNumstatLine(line);
      if (entry) {
        entry.status = statusMap.get(entry.path) ?? entry.status;
        files.push(entry);
      }
    }
  }
  // If all scoped files are binary, report that
  const allBinary = files.length > 0 && files.every((f) => f.isBinary);
  // Full unified diff — capped
  const diffArgs = ["diff", "--no-ext-diff", "--binary", baseline, ...scopeArgs];
  const diffResult = g(diffArgs);
  let diff = diffResult.stdout;
  let truncated = false;
  if (Buffer.byteLength(diff, "utf8") > DIFF_CAP_BYTES) {
    const r = safeByteTruncate(diff, DIFF_CAP_BYTES);
    diff = r.result;
    truncated = r.truncated;
  } else {
    const lineCount = diff.split("\n").length;
    if (lineCount > DIFF_CAP_LINES) {
      const lines = diff.split("\n");
      diff = lines.slice(0, DIFF_CAP_LINES).join("\n");
      truncated = true;
    }
  }
  if (allBinary) {
    return { unit, hasDiff: true, reason: "binary", files, diff: "", truncated: false };
  }
  if (!diff.trim() && !files.length) {
    return { unit, hasDiff: false, reason: "no-diff", files: [], diff: "", truncated: false };
  }
  return { unit, hasDiff: true, files, diff, truncated };
}

/** Build full diff response for a dashboard selection. */
export function buildDiffResponse(
  items: WorkflowDashboardItem[],
  request: DiffRequest,
): DiffResponse {
  const sel = resolveDashboardSelection(request.repoPath, request.workflowId, request.unit, items);
  if ("error" in sel) return sel as { error: string; status: number };
  const unit = request.unit ? sel.unit : undefined;
  const item = items.find((i) => i.repoPath === request.repoPath);
  const summary = buildWorkflowDiffSummary(request.repoPath);
  let unitDiff: WorkUnitDiffResult | undefined;
  if (unit && item) {
    const workUnit = item.workUnits.find((u) => u.name === unit);
    if (workUnit) {
      unitDiff = buildUnitDiff(unit, workUnit.scope ?? [], request.repoPath, summary.baseline);
    }
  }
  return { summary, unitDiff };
}
