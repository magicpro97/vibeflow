import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseEngineSummary } from "../dispatch/prompt.js";
import { isVerifiableEvidence, policyGates } from "../gates.js";
import { mapGateResult } from "../orchestrator/gate-map.js";
import { thresholdFor } from "../orchestrator/investigate.js";
import { type GateRunner, defaultRun, scopedGate } from "../orchestrator/scoped-gate.js";
import { mutateUnits, readState, sanitizeUnitName } from "./_shared.js";
import type { WorkUnit } from "./_shared.js";
import { makeReviewer } from "./dispatch-reviewer.js";
type Usage = {
  status?: unknown;
  exit_code?: unknown;
  timed_out?: unknown;
  result_file?: unknown;
  contract_hash?: unknown;
  stdout_sha256?: unknown;
  duration_seconds?: unknown;
  hermes_usage?: {
    total_tokens?: unknown;
    estimated_cost_usd?: unknown;
    completed?: unknown;
    failed?: unknown;
  };
};
type Git = (args: string[], cwd: string) => string;
export type UnitsIngestInject = {
  git?: Git;
  read?: (p: string) => Buffer;
  gate?: typeof scopedGate;
  run?: GateRunner;
  reviewer?: typeof makeReviewer;
  mutate?: typeof mutateUnits;
};
const hash = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const validPath = (p: string) =>
  p !== "" &&
  !isAbsolute(p) &&
  !/[\r\n\0]/.test(p) &&
  p === p.trim() &&
  p.split("/").every((x) => x && x !== "." && x !== "..");
const scalar = (v: string) => v.trim();
function readSafe(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("evidence must be regular file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function pathsAt(git: Git, base: string, commit: string): string[] {
  const raw = git(
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit],
    base,
  );
  if (!raw.endsWith("\0")) throw new Error("committed path stream lacks terminal NUL");
  const paths = raw.slice(0, -1).split("\0");
  if (!paths.length || paths.some((path) => !validPath(path)))
    throw new Error("invalid committed path");
  return paths;
}
function objectType(git: Git, base: string, rev: string, path: string) {
  try {
    return scalar(git(["cat-file", "-t", `${rev}:${path}`], base));
  } catch {
    return "";
  }
}
function scopeMatches(git: Git, base: string, commit: string, scope: string, path: string) {
  const explicitDirectory = scope.endsWith("/");
  const normalized = explicitDirectory ? scope.slice(0, -1) : scope;
  if (!validPath(normalized)) return false;
  if (path === normalized) return true;
  if (!path.startsWith(`${normalized}/`)) return false;
  if (explicitDirectory) return true;
  const parent = `${commit}^`;
  const parentType = objectType(git, base, parent, normalized);
  return (
    parentType === "tree" ||
    (parentType === "" && objectType(git, base, commit, normalized) === "tree")
  );
}
function sourcePath(path: string, root: string) {
  if (
    !isAbsolute(path) ||
    path !== resolve(path) ||
    lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isFile()
  )
    throw new Error("evidence rejected");
  const canonical = join(realpathSync(dirname(path)), basename(path));
  if (inside(canonical, root)) throw new Error("evidence source inside repository");
  return canonical;
}
function persistRaw(base: string, name: string, raw: Buffer) {
  const root = realpathSync(base);
  let cursor = root;
  for (const part of [".vibeflow", "workunits", sanitizeUnitName(name), "evidence"]) {
    cursor = join(cursor, part);
    const entry = lstatSync(cursor, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error("destination symlink rejected");
    if (!entry) mkdirSync(cursor, { mode: 0o700 });
    if (!lstatSync(cursor).isDirectory() || !inside(realpathSync(cursor), root))
      throw new Error("destination outside repository");
  }
  const dest = join(cursor, "hermes.raw");
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isFile()))
    throw new Error("destination file rejected");
  if (!inside(realpathSync(cursor), root)) throw new Error("destination outside repository");
  const temp = join(cursor, `.hermes.raw.${randomBytes(16).toString("hex")}`);
  try {
    writeFileSync(temp, raw, { flag: "wx", mode: 0o600 });
    renameSync(temp, dest);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
function measuredEvidence(command: string, status: number | null, stdout: string) {
  return `${command} → "exit ${status ?? -1}: ${stdout
    .slice(-400)
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, '\\"')
    .trim()}"`;
}
// biome-ignore format: production file ceiling
function normalizeLegacyGateReason(unit: WorkUnit) {
  const evidence = [...(unit.evidence ?? [])]; const reason = evidence.at(-1);
  const measured = evidence.at(-2);
  const gate = reason?.match(/^gate (build|lint|test): [^\r\n]+(?![\s\S])/)?.[1] as "build" | "lint" | "test";
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expected = gate === "build" ? "(?:bun run --cwd src/ui build|bunx tsc --noEmit)" : gate === "lint" ? escaped(`bunx biome check ${(unit.scope ?? []).join(" ")}`) : gate === "test" ? "bun test --timeout 30000" : "";
  const measuredShape = expected && new RegExp(`^${expected} → "exit (?:-1|[1-9]\\d*): (?:\\\\"|[^"\\r\\n])*"(?![\\s\\S])`);
  const at = unit.evidence_at;
  if (!reason || !measured || !measuredShape || unit.status !== "blocked" || isVerifiableEvidence(reason) || unit.gates?.[gate] !== "fail" || !measuredShape.test(measured) || !at?.[reason] || at[reason] !== at[measured]) return unit;
  const normalized = `vf units ingest → ${JSON.stringify(reason)}`; if (evidence.includes(normalized) || Object.hasOwn(at, normalized)) return unit; evidence[evidence.length - 1] = normalized;
  const evidence_at = { ...at, [normalized]: at[reason] }; delete evidence_at[reason]; return { ...unit, evidence, evidence_at };
}
export async function unitsIngest(
  base: string,
  rest: string[],
  flags: Record<string, string | boolean>,
  inject: UnitsIngestInject = {},
): Promise<number> {
  const state = readState(base);
  const name = rest[0]?.trim();
  const unit = state?.work_units?.find((u) => u.name === name);
  const mutate = inject.mutate ?? mutateUnits;
  const block = (
    reason: string,
    gates = unit?.gates,
    resources = unit?.resources,
    freshEvidence: string[] = [],
  ) => {
    try {
      if (!unit || !name) return 1;
      const persistedReason = `vf units ingest → ${JSON.stringify(reason)}`;
      const evidence = [...new Set([...(unit.evidence ?? []), ...freshEvidence, persistedReason])];
      const evidence_at = { ...(unit.evidence_at ?? {}) };
      for (const item of [...freshEvidence, persistedReason])
        if (!evidence_at[item]) evidence_at[item] = new Date().toISOString();
      return mutate(base, "update", {
        name,
        status: "blocked",
        confidence: 0,
        gates,
        resources,
        evidence,
        evidence_at,
      })
        ? 1
        : 1;
    } catch {
      return 1;
    }
  };
  if (!state || !unit || !name) return 1;
  const rawArg = typeof flags.raw === "string" ? flags.raw : "";
  const usageArg = typeof flags.usage === "string" ? flags.usage : "";
  const commit = typeof flags.commit === "string" ? flags.commit : "";
  const expected = flags["contract-hash"];
  if (flags.producer !== "hermes") return block("producer must be hermes");
  if (!/^[0-9a-f]{40}$/.test(commit)) return block("commit must be lowercase 40-hex");
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))
    return block("contract hash required");
  const git: Git =
    inject.git ??
    ((args, cwd) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  let raw: Buffer;
  let usageRaw: Buffer;
  const root = realpathSync(base);
  try {
    if (rawArg === usageArg) throw new Error("evidence paths equal");
    raw = inject.read ? inject.read(sourcePath(rawArg, root)) : readSafe(sourcePath(rawArg, root));
    usageRaw = inject.read
      ? inject.read(sourcePath(usageArg, root))
      : readSafe(sourcePath(usageArg, root));
  } catch (error) {
    return block((error as Error).message);
  }
  let changed: string[];
  try {
    git(["cat-file", "-e", `${commit}^{commit}`], base);
    git(["merge-base", "--is-ancestor", commit, "HEAD"], base);
    if (!/\nSigned-off-by:\s+.+/i.test(`\n${git(["show", "-s", "--format=%B", commit], base)}`))
      throw new Error("commit lacks Signed-off-by");
    if (scalar(git(["status", "--porcelain"], base))) throw new Error("working tree dirty");
    changed = pathsAt(git, base, commit);
    if (!changed.some((p) => /\.(test|spec)\.[^/]+$/.test(p)))
      throw new Error("commit has no test");
    if (changed.some((p) => !unit.scope?.some((s) => scopeMatches(git, base, commit, s, p))))
      throw new Error("commit changes outside scope");
  } catch (error) {
    return block((error as Error).message);
  }
  let usage: Usage;
  try {
    usage = JSON.parse(usageRaw.toString("utf8"));
  } catch {
    return block("usage is not JSON");
  }
  const hu = usage.hermes_usage;
  if (
    usage.status !== "succeeded" ||
    usage.exit_code !== 0 ||
    usage.timed_out !== false ||
    usage.result_file !== rawArg ||
    usage.contract_hash !== expected ||
    usage.stdout_sha256 !== hash(raw) ||
    !hu ||
    hu.completed !== true ||
    hu.failed !== false ||
    ![hu.total_tokens, hu.estimated_cost_usd, usage.duration_seconds].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  )
    return block("invalid usage envelope");
  const stdout = raw.toString("utf8");
  const summary = parseEngineSummary(stdout);
  const result = [...stdout.matchAll(/```yaml\s*([\s\S]*?)```/g)]
    .at(-1)?.[1]
    ?.match(/^result:\s*(\S+)\s*$/m)?.[1];
  if (
    !summary ||
    !strings(summary.skills_used) ||
    !strings(summary.files_changed) ||
    !strings(summary.commands_run) ||
    !strings(summary.tests_run) ||
    typeof summary.uncertainty !== "string" ||
    typeof summary.confidence !== "number" ||
    !Number.isFinite(summary.confidence) ||
    summary.confidence < 0 ||
    summary.confidence > 1 ||
    result !== "done" ||
    new Set(summary.files_changed).size !== summary.files_changed.length ||
    summary.files_changed.length !== changed.length ||
    summary.files_changed.some((path) => !validPath(path) || !changed.includes(path))
  )
    return block("invalid engine summary");
  const wt = mkdtempSync(join(tmpdir(), "vf-ingest-"));
  let failure = "";
  let candidate: WorkUnit | undefined;
  let finalGates = unit.gates;
  let finalResources = unit.resources;
  const outputs: string[] = [];
  try {
    execFileSync("git", ["worktree", "add", "--detach", wt, commit], {
      cwd: base,
      stdio: "ignore",
    });
    const modules = join(base, "node_modules");
    const target = join(wt, "node_modules");
    if (lstatSync(modules, { throwIfNoEntry: false })) {
      if (!realpathSync(modules) || !lstatSync(modules).isDirectory())
        throw new Error("node_modules must be directory");
      if (!lstatSync(target, { throwIfNoEntry: false }))
        symlinkSync(
          realpathSync(modules),
          target,
          process.platform === "win32" ? "junction" : "dir",
        );
    }
    const run: GateRunner = (command, cwd) => {
      const value = (inject.run ?? defaultRun)(command, cwd);
      outputs.push(measuredEvidence(command, value.status, value.stdout));
      return value;
    };
    const build = run("bun run --cwd src/ui build", wt);
    if (build.status !== 0) {
      finalGates = { build: "fail", lint: "pending", test: "pending", review: "pending" };
      finalResources = {
        agents: 1,
        tokens: hu.total_tokens as number,
        cost_usd: hu.estimated_cost_usd as number,
        wall_seconds: usage.duration_seconds as number,
      };
      failure = `gate build: ${outputs.at(-1)}`;
    } else {
      const measured = (inject.gate ?? scopedGate)({ scope: unit.scope ?? [], cwd: wt, run });
      const gates = mapGateResult(measured);
      const resources = {
        agents: 1,
        tokens: hu.total_tokens as number,
        cost_usd: hu.estimated_cost_usd as number,
        wall_seconds: usage.duration_seconds as number,
      };
      finalGates = gates;
      finalResources = resources;
      if (!measured.pass) failure = `gate ${measured.failedGate}: ${measured.detail ?? ""}`;
      else {
        const outcome = {
          status: "done" as const,
          confidence: summary.confidence,
          evidence: [`commit ${commit}`, ...outputs],
          gates,
          commit,
        };
        const reviewUnit = structuredClone(unit);
        const reviewEvidenceLength = reviewUnit.evidence?.length ?? 0;
        const review = await (inject.reviewer ?? makeReviewer)(
          "cli",
          thresholdFor(unit.riskClass ?? "feature"),
          { cwd: wt, diffReader: () => `${changed.join("\n")}\n` },
        )(reviewUnit, outcome);
        const reviewerEvidence = reviewUnit.evidence?.slice(reviewEvidenceLength) ?? [];
        gates.review = review.pass ? "pass" : "fail";
        if (!review.pass) failure = `review: ${review.reason}`;
        else {
          const freshEvidence = [`commit ${commit}`, ...outputs, ...reviewerEvidence];
          const normalizedUnit = normalizeLegacyGateReason(unit);
          const evidence = [...new Set([...(normalizedUnit.evidence ?? []), ...freshEvidence])];
          const evidence_at = { ...(normalizedUnit.evidence_at ?? {}) };
          for (const item of freshEvidence)
            if (!evidence_at[item]) evidence_at[item] = new Date().toISOString();
          candidate = {
            ...normalizedUnit,
            name,
            status: "done",
            confidence: summary.confidence,
            skills_used: summary.skills_used,
            gates,
            resources,
            evidence,
            evidence_at,
          };
          if (unit.status === "done") candidate = { ...normalizedUnit, evidence, evidence_at };
          if (!policyGates({ ...state, work_units: [candidate] }, { base: wt }).ok)
            failure = "policy gate failed";
        }
      }
    }
  } catch (error) {
    failure = (error as Error).message;
  }
  for (const cleanup of [
    () =>
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: base, stdio: "ignore" }),
    () => rmSync(wt, { recursive: true, force: true }),
    () => execFileSync("git", ["worktree", "prune"], { cwd: base, stdio: "ignore" }),
  ])
    try {
      cleanup();
    } catch (error) {
      failure ||= `cleanup: ${(error as Error).message}`;
    }
  if (failure || !candidate)
    return block(failure || "ingest failed", finalGates, finalResources, outputs);
  try {
    persistRaw(base, name, raw);
    return mutate(base, "update", candidate) ? 0 : 1;
  } catch {
    return block("final mutation failed");
  }
}
