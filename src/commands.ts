import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type ProjectContext,
  canonicalFiles,
  defaultContext,
  dispatchPrompt,
  engineFiles,
} from "./adapters.js";
import {
  CTX_DIR,
  ENGINES,
  type Engine,
  VERSION,
  type WorkUnit,
  type WorkflowState,
  c,
  ctxPathIn,
  cwd,
  hasCommand,
  isGitRepo,
  readState,
  recomputeTotals,
  writeFileSafe,
  writeState,
} from "./core.js";
import {
  type AsyncSpawner,
  type DispatchResult,
  buildEnginePrompt,
  engineCommand,
  isUnavailable,
  makeAsyncSpawner,
  persistDispatch,
  runDispatchAsync,
} from "./dispatch.js";
import { findScopeConflicts, policyGates } from "./gates.js";
import { downgradeBannerText, engineHookFiles } from "./hooks/adapters.js";
import { evaluateHook, parseHookInput, presentDecision } from "./hooks/runner.js";
import { type SelftestReport, runSelftest } from "./hooks/selftest.js";
import { appendJournal, ensureIndex } from "./journal.js";
import {
  type AsyncResearcher,
  type RiskClass,
  type UnitInvestigationOutcome,
  investigateUnit,
} from "./orchestrator/investigate.js";
import {
  DEFAULT_CONCURRENCY,
  type Reviewer,
  type UnitDispatcher,
  type UnitOutcome,
  goalEval,
  orchestrateUnits,
} from "./orchestrator/run.js";
import {
  type EngineReadiness,
  anyReady,
  preflightAll,
  preflightAllAsync,
  readyEngines,
} from "./preflight.js";
import {
  type Checkpoint,
  type GitRunner,
  createCheckpoint,
  gitState,
  recoveryHint,
  restoreIgnored,
} from "./safety/checkpoint.js";
import { type QuotaSignal, detectQuota } from "./safety/quota.js";
import { scanRepo, summarizeProfile } from "./scanner.js";
import {
  type FailureProtection,
  type ToolTier,
  type VibeSettings,
  priorityRank,
  readSettings,
  settingsPath,
  writeSettings,
} from "./settings.js";
import { discoverSkills, matchSkillsForTask, renderSkillIndex } from "./skills/registry.js";
import { renderSkillNeeds, resolveSkillNeeds, skillForFile } from "./skills/resolver.js";
import { TOOLS, type ToolName, resolveTools } from "./tools/index.js";
import type { JsonMcpEntry, StdioServer, TomlMcpEntry } from "./tools/index.js";
import { Spinner, StatusLine, link, panel, progressBar, table } from "./ui.js";
import {
  type CollisionPolicy,
  type DeletePlan,
  type MergeResult,
  applyDelete,
  deleteUnit,
  importWorkflow,
  planDelete,
} from "./workflow/lifecycle.js";

export { skillForFile };

/** Color a readiness level for the doctor table. */
function readinessMark(level: EngineReadiness["level"]): string {
  if (level === "ready") return c.green("✓");
  if (level === "no-binary") return c.dim("•");
  return c.yellow("!");
}

/**
 * Print per-engine readiness under the presence table. Without --probe this is a fast
 * presence/auth check; with --probe it runs the live round-trip. Informational only —
 * the hard gate lives in applyIntake/run, not here.
 */
function printReadiness(
  probe: boolean,
  list = preflightAll(ENGINES, { probe }),
): EngineReadiness[] {
  console.log(c.bold(`\nEngine readiness${probe ? " (live probe)" : " (presence/auth)"}:`));
  for (const r of list) {
    console.log(`  ${readinessMark(r.level)} ${r.engine}: ${c.dim(r.detail)}`);
  }
  if (!probe) console.log(c.dim("  (run `vf doctor --probe` for a live engine round-trip)"));
  return list;
}

export async function doctor(
  flags: Record<string, string | boolean> = {},
  inject: { readiness?: EngineReadiness[] } = {},
): Promise<number> {
  const checks: Array<[string, boolean, "required" | "optional"]> = [
    ["node", hasCommand("node"), "required"],
    ["git", hasCommand("git"), "required"],
    ["bun", hasCommand("bun"), "optional"],
    ["claude", hasCommand("claude"), "optional"],
    ["codex", hasCommand("codex"), "optional"],
    ["copilot", hasCommand("copilot") || hasCommand("gh"), "optional"],
    ["docker", hasCommand("docker"), "optional"],
  ];
  console.log(panel("VibeFlow", c.bold("environment check")));
  let missingRequired = 0;
  const toolRows: string[][] = [];
  for (const [name, ok, kind] of checks) {
    const mark = ok ? c.green("✔") : kind === "required" ? c.red("✗") : c.yellow("•");
    const status = ok ? c.green("ok") : kind === "required" ? c.red("missing") : c.dim("missing");
    if (!ok && kind === "required") missingRequired++;
    toolRows.push([mark, name, status]);
  }
  console.log(table(["", "tool", "status"], toolRows));
  console.log(`\n  git repository: ${isGitRepo() ? c.green("yes") : c.yellow("no")}`);
  console.log(
    `  ${liveGuardrailArmed(cwd()) ? c.green("live guardrail: ON") : guardrailOffNote()}`,
  );

  const probe = Boolean(flags.probe);
  let readiness: EngineReadiness[];
  if (inject.readiness) {
    readiness = inject.readiness;
  } else if (probe) {
    const spinner = new Spinner();
    spinner.start("Running engine probes (parallel)…");
    readiness = await preflightAllAsync(ENGINES, { probe: true });
    spinner.succeed("Engine probes complete");
  } else {
    readiness = preflightAll(ENGINES, { probe: false });
  }
  printReadiness(probe, readiness);

  if (missingRequired > 0) {
    console.log(c.red(`\n${missingRequired} required tool(s) missing.`));
    return 1;
  }
  const probeFailed = probe ? readiness.filter((r) => r.level === "probe-failed") : [];
  if (probeFailed.length > 0) {
    console.log(
      c.yellow(
        `\n${probeFailed.length} engine probe(s) failed: ${probeFailed.map((r) => r.engine).join(", ")}. Other tools are present.`,
      ),
    );
    return 1;
  }
  console.log(c.green("\nReady."));
  return 0;
}

export interface IntakeAnswers {
  goal?: string;
  engines?: string[];
  docSource?: string;
  taskSource?: string;
  fileTypes?: string[];
  expectedResult?: string;
  sample?: string;
  repoPath?: string;
}

function chosenEngines(engines?: string[]): Engine[] {
  const valid = (engines ?? []).filter((e): e is Engine => (ENGINES as string[]).includes(e));
  return valid.length ? valid : [...ENGINES];
}

/** Validate and resolve a user-supplied repo path to an absolute existing directory. */
export function resolveRepo(path?: string): string {
  if (!path || !path.trim()) return cwd();
  const abs = isAbsolute(path) ? path : resolve(cwd(), path);
  try {
    if (statSync(abs).isDirectory()) return abs;
  } catch {
    /* fall through */
  }
  return cwd();
}

const SKILL_BY_EXT_REMOVED = true;
void SKILL_BY_EXT_REMOVED;

export interface RepoDetection {
  repo: string;
  isGit: boolean;
  engines: Record<Engine, boolean>;
  clis: Record<Engine, boolean>;
}

/** Detect which engines a repo already carries (by marker files) and which CLIs are present. */
export function detectRepo(path?: string): RepoDetection {
  const repo = resolveRepo(path);
  const has = (rel: string) => existsSync(join(repo, rel));
  return {
    repo,
    isGit: has(".git"),
    engines: {
      claude: has("CLAUDE.md") || has(".claude"),
      codex: has("AGENTS.md") || has(".codex"),
      copilot: has(".github/copilot-instructions.md"),
    },
    clis: {
      claude: hasCommand("claude"),
      codex: hasCommand("codex"),
      copilot: hasCommand("copilot") || hasCommand("gh"),
    },
  };
}

function contextFrom(answers: IntakeAnswers): ProjectContext {
  const base = defaultContext();
  const clean = (s?: string) => (s?.trim() ? s.trim() : undefined);
  return {
    ...base,
    goal: clean(answers.goal) ?? base.goal,
    docSource: clean(answers.docSource),
    taskSource: clean(answers.taskSource),
    fileTypes: answers.fileTypes?.map((s) => s.trim()).filter(Boolean),
    expectedResult: clean(answers.expectedResult),
    sample: clean(answers.sample),
  };
}

/** Injectable readiness check so the creation gate is testable without spawning engines. */
export type PreflightFn = (engines: Engine[]) => EngineReadiness[];

export interface ApplyIntakeOpts {
  dry?: boolean;
  useAi?: boolean;
  base?: string;
  /** Opt out of the hard creation gate (web `/api/init` and dry/offline paths). */
  skipPreflight?: boolean;
  /** Override the readiness check (tests inject a fake; default is a live probe). */
  preflight?: PreflightFn;
}

export interface ApplyIntakeResult {
  files: string[];
  state: WorkflowState;
  /** Per-engine readiness from the gate (present whenever the gate ran). */
  readiness?: EngineReadiness[];
  /** True when the gate refused creation because no engine was ready. */
  refused?: boolean;
}

/**
 * Resolve which engines to generate for. When the gate is active (not dry, not skipped) it
 * runs a live preflight and keeps only ready engines; refusing entirely if none are ready.
 * The default skip ties the offline/browser path (useAi:false) to "no gate" so a browser
 * request never blocks on a live probe — Wave C may also pass skipPreflight explicitly.
 */
function gateEngines(
  answers: IntakeAnswers,
  opts: ApplyIntakeOpts,
): { engines: Engine[]; readiness?: EngineReadiness[]; refused: boolean } {
  const chosen = chosenEngines(answers.engines);
  const skip = opts.skipPreflight ?? opts.useAi === false;
  if (skip || opts.dry) return { engines: chosen, refused: false };
  const probe = opts.preflight ?? ((e: Engine[]) => preflightAll(e, { probe: true }));
  const readiness = probe(chosen);
  if (!anyReady(readiness)) return { engines: [], readiness, refused: true };
  return { engines: readyEngines(readiness), readiness, refused: false };
}

/**
 * Shared workflow generator used by both `vf init` (CLI) and the web intake wizard.
 * `useAi` is false for web-initiated init so a browser request never shells out to
 * $VIBEFLOW_AI; the CLI keeps the AI bridge enabled. When a workflow already exists in
 * `base`, its work units and attachments are preserved so re-submitting acts as an edit.
 *
 * Hard creation gate: for a real CLI init (not dry, not skipped) we preflight the chosen
 * engines and refuse creation when none is ready, generating only for ready engines
 * otherwise. The gate is parameterized via {@link ApplyIntakeOpts} so callers opt out.
 */
export function applyIntake(answers: IntakeAnswers, opts: ApplyIntakeOpts = {}): ApplyIntakeResult {
  const base = opts.base ?? resolveRepo(answers.repoPath);
  const ctx = contextFrom(answers);
  ctx.settings = readSettings(base);
  // Enrich context with an evidence-based scan of the target repo (PROJECT_CONTEXT.md).
  try {
    const profile = scanRepo(base);
    ctx.stack = summarizeProfile(profile);
    if (profile.summary && ctx.summary === defaultContext().summary) ctx.summary = profile.summary;
  } catch {
    /* scanning is best-effort; never block init */
  }
  const gate = gateEngines(answers, opts);
  const prev = readState(base);
  const state = recomputeTotals({
    task_id: prev?.task_id ?? "TASK-1",
    goal: ctx.goal,
    success_criteria: ctx.expectedResult ? [ctx.expectedResult] : (prev?.success_criteria ?? []),
    work_units: prev?.work_units ?? [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    repo_path: base,
    attachments: prev?.attachments ?? [],
  });
  if (gate.refused) return { files: [], state, readiness: gate.readiness, refused: true };

  const useAi = opts.useAi !== false;
  const files: Record<string, string> = { ...canonicalFiles(ctx) };
  for (const engine of gate.engines) {
    Object.assign(files, engineFiles(engine, ctx, useAi));
  }
  files[`${CTX_DIR}/WORKFLOW_STATE.json`] = JSON.stringify(state, null, 2);
  // TASK_CONTEXT.md holds human intent (Goal / Definition of Done / Must not change). Like
  // SETTINGS.json it must survive re-init: a no-args `vf init` must NOT clobber a hand-edited
  // spec with the generic placeholder. We only (re)write it when the file does not exist yet
  // (first init) OR the caller supplied an explicit goal (interactive init / `--goal`), which is
  // an explicit intent to overwrite. PROJECT_CONTEXT.md is scanner-derived and keeps regenerating.
  const explicitGoal = Boolean(answers.goal?.trim());
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const isTaskContext = rel.endsWith("TASK_CONTEXT.md");
    if (isTaskContext && !explicitGoal && existsSync(join(base, rel))) {
      // Preserve the user's hand-curated TASK_CONTEXT.md; don't claim to write what we skipped.
      continue;
    }
    if (!opts.dry) writeFileSafe(join(base, rel), content);
    written.push(rel);
  }
  // SETTINGS.json is owned by the settings layer, not the canonical templates: seed it with
  // the off-by-default baseline ONLY on first init. On every subsequent init the user's file
  // is left untouched so enabling codegraph/lsp (or tuning failureProtection) survives re-init.
  if (!opts.dry && !existsSync(settingsPath(base))) {
    writeSettings(base, {});
    written.push(`${CTX_DIR}/SETTINGS.json`);
  }
  // Keep MCP config in lockstep with the instructions: if any optional tool is enabled,
  // (re)write the engine MCP registrations so the injected "prefer codegraph > LSP" block
  // references servers that are actually registered. Skipped on dry runs.
  if (!opts.dry && (ctx.settings?.tools.codegraph || ctx.settings?.tools.lsp)) {
    writeToolConfigs(base, ctx.settings);
  }
  // Seed the work-journal catalog (knowledge/index.md) so the engine has a file to maintain.
  // Create-if-absent only — never clobbers a human-curated index. Skipped on dry runs.
  if (!opts.dry) ensureIndex(base);
  return { files: written, state, readiness: gate.readiness, refused: false };
}

/** Generate (and persist) the dispatch prompt for an engine using the saved goal. */
export function applyDispatch(
  engineName: string,
  base: string = cwd(),
): { file: string; prompt: string } | null {
  if (!(ENGINES as string[]).includes(engineName)) return null;
  const engine = engineName as Engine;
  const state = readState(base);
  const ctx: ProjectContext = { ...defaultContext(), goal: state?.goal ?? defaultContext().goal };
  const units = state ? state.work_units.map((u) => u.name) : [];
  const prompt = dispatchPrompt(engine, ctx, units);
  const rel = `${CTX_DIR}/dispatch/${engine}.md`;
  writeFileSafe(join(base, rel), prompt);
  return { file: rel, prompt };
}

const VALID_STATUS: WorkUnit["status"][] = ["pending", "running", "verifying", "done", "blocked"];

function normalizeUnit(input: Partial<WorkUnit> & { name: string }): WorkUnit {
  const g: Partial<WorkUnit["gates"]> = input.gates ?? {};
  const r: Partial<WorkUnit["resources"]> = input.resources ?? {};
  return {
    name: String(input.name),
    status: VALID_STATUS.includes(input.status as WorkUnit["status"])
      ? (input.status as WorkUnit["status"])
      : "pending",
    confidence: typeof input.confidence === "number" ? input.confidence : 0,
    owner_agent: input.owner_agent,
    skills_used: input.skills_used,
    knowledge_heavy: typeof input.knowledge_heavy === "boolean" ? input.knowledge_heavy : undefined,
    knowledge_heavy_source:
      input.knowledge_heavy_source === "risk" || input.knowledge_heavy_source === "regex"
        ? input.knowledge_heavy_source
        : undefined,
    skills_injected: Array.isArray(input.skills_injected) ? input.skills_injected : undefined,
    skills_required: Array.isArray(input.skills_required) ? input.skills_required : undefined,
    skill_waiver:
      input.skill_waiver &&
      typeof input.skill_waiver === "object" &&
      typeof input.skill_waiver.reason === "string"
        ? input.skill_waiver
        : undefined,
    scope: input.scope,
    spec: input.spec,
    gates: {
      build: g.build ?? "pending",
      lint: g.lint ?? "pending",
      test: g.test ?? "pending",
      review: g.review ?? "pending",
    },
    resources: {
      agents: r.agents ?? 0,
      tokens: r.tokens ?? 0,
      cost_usd: r.cost_usd ?? 0,
      wall_seconds: r.wall_seconds ?? 0,
    },
    evidence: input.evidence,
  };
}

/** Add, update, or delete a work unit in the workflow ledger at `base`. */
export function mutateUnits(
  base: string,
  action: "add" | "update" | "delete",
  unit: Partial<WorkUnit> & { name?: string },
): WorkflowState | null {
  const state = readState(base);
  if (!state) return null;
  const name = unit.name?.trim();
  if (!name) return null;
  const idx = state.work_units.findIndex((u) => u.name === name);
  if (action === "delete") {
    if (idx === -1) return null;
    state.work_units.splice(idx, 1);
  } else if (action === "add") {
    if (idx !== -1) return null; // name must be unique
    state.work_units.push(normalizeUnit({ ...unit, name }));
  } else {
    if (idx === -1) return null;
    state.work_units[idx] = normalizeUnit({ ...state.work_units[idx], ...unit, name });
  }
  recomputeTotals(state);
  writeState(base, state);
  return state;
}

/** Resolve the dispatch mode: --yes → real CLI, --dry → preview, else bridge or dry. */
function resolveMode(flags: Record<string, string | boolean>): "cli" | "bridge" | "dry" {
  if (flags.yes) return "cli";
  if (flags.dry) return "dry";
  return process.env.VIBEFLOW_AI ? "bridge" : "dry";
}

function resolveEngine(flags: Record<string, string | boolean>): Engine {
  return typeof flags.engine === "string" && (ENGINES as string[]).includes(flags.engine)
    ? (flags.engine as Engine)
    : "claude";
}

function resolveRisk(flags: Record<string, string | boolean>): RiskClass {
  const valid: RiskClass[] = [
    "docs",
    "simple-code",
    "feature",
    "architecture",
    "security",
    "deploy",
  ];
  return typeof flags.risk === "string" && (valid as string[]).includes(flags.risk)
    ? (flags.risk as RiskClass)
    : "feature";
}

/**
 * Before launching a non-native engine, warn the user their guardrails are detection-only and
 * resolve the engine command. Returns `skip:true` when the engine CLI is genuinely unavailable
 * (so we never spawn a bogus command). Pure-stdout for "dry"/"bridge" (nothing to launch).
 */
function announceLaunch(engine: Engine, mode: "cli" | "bridge" | "dry"): { skip: boolean } {
  if (mode !== "cli") return { skip: false };
  const banner = downgradeBannerText(engine);
  if (banner) console.log(c.yellow(banner));
  const invocation = engineCommand(engine);
  if (isUnavailable(invocation)) {
    console.log(c.yellow(`\n${engine} unavailable: ${invocation.unavailable}`));
    return { skip: true };
  }
  if (invocation.warning) console.log(c.yellow(`! ${engine}: ${invocation.warning}`));
  return { skip: false };
}

/** A synthetic "ready" readiness used when a caller injects its own dispatch spawner. */
function readyStub(engine: Engine): EngineReadiness {
  return { engine, level: "ready", detail: "ready (injected)", checkedAt: "" };
}

/**
 * The stronger pre-dispatch gate: a live preflight probe of the single chosen engine. Returns
 * true only when the engine is fully ready; otherwise prints the actionable detail and returns
 * false so the caller can refuse to dispatch. Dry/bridge modes skip the probe (nothing launches).
 * Injectable via `preflight` so tests never spawn a real engine.
 */
function engineReady(
  engine: Engine,
  mode: "cli" | "bridge" | "dry",
  preflight?: PreflightFn,
): boolean {
  if (mode !== "cli") return true;
  const probe = preflight ?? ((e: Engine[]) => preflightAll(e, { probe: true }));
  const [readiness] = probe([engine]);
  if (readiness?.level === "ready") return true;
  const detail = readiness?.detail ?? "engine not ready";
  console.log(c.red(`\n${engine} not ready: ${detail}`));
  return false;
}

/**
 * A read-only research step backed by the real dispatcher: each round dispatches a research
 * prompt (never writes) and reports the engine's self-assessed confidence. Used by
 * {@link investigateUnit} to raise confidence on a unit below the bar before we block it.
 */
function makeResearcher(
  engine: Engine,
  ctx: ProjectContext,
  mode: "cli" | "bridge" | "dry",
  spawner?: AsyncSpawner,
): AsyncResearcher {
  return async (round, question) => {
    const prompt = buildEnginePrompt(engine, { ...ctx, goal: question }, [
      `research round ${round}`,
    ]);
    const result = await runDispatchAsync({ engine, prompt, mode, spawner });
    const confidence = result.summary?.confidence ?? 0;
    const findings = result.summary?.uncertainty
      ? [result.summary.uncertainty]
      : result.ok
        ? [`round ${round}: research dispatched`]
        : [];
    return { findings, confidence, blocked: !result.ok };
  };
}

/** Persist an investigation outcome as auditable evidence inside the unit's evidence/ folder. */
function persistInvestigation(unitDir: string, outcome: UnitInvestigationOutcome): string {
  const rel = "evidence/investigation.json";
  writeFileSafe(
    join(unitDir, rel),
    JSON.stringify(
      {
        proceed: outcome.proceed,
        finalConfidence: outcome.finalConfidence,
        threshold: outcome.threshold,
        stoppedBy: outcome.stoppedBy,
        recommendation: outcome.recommendation,
        rounds: outcome.rounds,
      },
      null,
      2,
    ),
  );
  return rel;
}

/** Milliseconds in a second — timeout seconds are stored in settings, the spawner wants ms. */
const MS_PER_SECOND = 1000;

/** Shared quota latch: the first HIGH-confidence limit signal stops not-yet-started units. */
interface QuotaState {
  limited: boolean;
  signal?: QuotaSignal;
}

/** Per-dispatch source-protection runtime threaded into the (cli-mode) dispatcher. */
interface ProtectionRuntime {
  checkpoint: Checkpoint | null;
  fp: FailureProtection;
  git: GitRunner;
  quota: QuotaState;
  rolledBack: boolean;
}

/** Decision from the pre-dispatch source-protection gate. */
interface ProtectionPlan {
  refused: boolean;
  reason?: string;
  checkpoint: Checkpoint | null;
}

/** Default git seam (argv only, never shell) scoped to a repo, mirroring checkpoint.ts. */
function repoGit(base: string): GitRunner {
  return (args) => {
    const r = spawnSync("git", args, { cwd: base, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Settings + per-run flags merged: a flag can only turn a protection ON, never off. */
function resolveProtection(
  flags: Record<string, string | boolean>,
  fp: FailureProtection,
): FailureProtection {
  return {
    timeoutSeconds: fp.timeoutSeconds,
    autoWip: fp.autoWip || Boolean(flags["auto-wip"]),
    requireGit: fp.requireGit || Boolean(flags["require-git"]),
    rollbackOnFail: fp.rollbackOnFail || Boolean(flags["rollback-on-fail"]),
  };
}

/**
 * Gate a REAL (cli) dispatch on repo state. Refuses (no checkpoint) when git is required but
 * absent, or the tree is dirty without `autoWip`; otherwise warns/checkpoints and proceeds.
 */
function planProtection(
  base: string,
  runId: string,
  fp: FailureProtection,
  git: GitRunner,
): ProtectionPlan {
  const state = gitState(base, git);
  if (!state.isRepo) {
    if (fp.requireGit) {
      return {
        refused: true,
        reason: "refusing: not a git repository (requireGit). Run `git init` then re-run.",
        checkpoint: null,
      };
    }
    console.log(
      c.yellow("! no git — engine edits are irreversible; proceeding without a checkpoint"),
    );
    return { refused: false, checkpoint: createCheckpoint(base, runId, { autoWip: false, git }) };
  }
  if (state.dirty && !fp.autoWip) {
    return {
      refused: true,
      reason:
        "refusing: uncommitted changes in the working tree. Commit/stash them, or pass --auto-wip.",
      checkpoint: null,
    };
  }
  const cp = createCheckpoint(base, runId, { autoWip: state.dirty, git });
  if (cp.wipSha) {
    console.log(c.dim(`checkpoint: WIP snapshot ${cp.wipSha.slice(0, 8)} taken before dispatch`));
  }
  return { refused: false, checkpoint: cp };
}

/** Persist the pre-dispatch checkpoint (+ recovery hint) as auditable unit evidence. */
function persistCheckpoint(unitDir: string, cp: Checkpoint): string {
  const rel = "evidence/checkpoint.json";
  writeFileSafe(join(unitDir, rel), JSON.stringify({ ...cp, recovery: recoveryHint(cp) }, null, 2));
  return rel;
}

/** Persist a detected quota signal as unit evidence. */
function persistQuota(unitDir: string, sig: QuotaSignal): string {
  const rel = "evidence/quota.json";
  writeFileSafe(join(unitDir, rel), JSON.stringify(sig, null, 2));
  return rel;
}

/**
 * Inspect a dispatch result for a quota/rate-limit signal. Records it as evidence and, on a
 * HIGH-confidence limit, latches the shared stop flag so not-yet-started units are skipped
 * rather than deepening the hole. LOW-confidence prose stays advisory (never auto-stops).
 */
function recordQuota(
  prot: ProtectionRuntime,
  unitRel: string,
  unitDir: string,
  result: DispatchResult,
  evidence: string[],
): void {
  const sig = detectQuota({ status: result.ok ? 0 : 1, stdout: result.raw, reason: result.reason });
  if (!sig.limited) return;
  evidence.push(`${unitRel}/${persistQuota(unitDir, sig)}`);
  if (sig.confidence === "high") {
    prot.quota.limited = true;
    prot.quota.signal = sig;
    console.log(
      c.yellow(`! quota signal (${sig.kind}) — stopping remaining units: ${sig.evidence}`),
    );
  }
}

/** Roll the tree back to the pre-dispatch state (once) and restore backed-up ignored files. */
function rollbackCheckpoint(base: string, prot: ProtectionRuntime): void {
  const cp = prot.checkpoint;
  if (!cp || prot.rolledBack) return;
  prot.rolledBack = true;
  const target = cp.baseRef ?? cp.wipSha;
  if (target) prot.git(["reset", "--hard", target]);
  const restored = restoreIgnored(cp, base);
  const ref = (target ?? "HEAD").slice(0, 8);
  const extra = restored.length ? ` (+${restored.length} ignored file(s) restored)` : "";
  console.log(c.yellow(`rolled back to ${ref}${extra}`));
}

/** On a blocked unit in cli mode: print the recovery hint, then roll back when configured. */
function handleUnitFailure(prot: ProtectionRuntime, base: string): void {
  if (prot.checkpoint) console.log(c.yellow(recoveryHint(prot.checkpoint)));
  if (prot.fp.rollbackOnFail) rollbackCheckpoint(base, prot);
}

/** Blocked outcome for a unit skipped because an upstream rate limit was already hit. */
function skippedByQuota(): UnitOutcome {
  return {
    status: "blocked",
    confidence: 0,
    evidence: [],
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
  };
}

/**
 * Build the per-unit dispatcher: write the unit's CONTEXT.md, dispatch the prompt (async so
 * the bounded pool truly overlaps), persist the result as evidence, and — for real runs whose
 * reported confidence is below 1.0 — run a bounded investigation, recording its rounds +
 * recommendation as evidence rather than emitting a dead "investigate/debate" string.
 */
function makeDispatcher(
  engine: Engine,
  ctx: ProjectContext,
  base: string,
  mode: "cli" | "bridge" | "dry",
  riskClass: RiskClass,
  spawner?: AsyncSpawner,
  prot?: ProtectionRuntime,
): UnitDispatcher {
  return async (u) => {
    const unitRel = `${CTX_DIR}/workunits/${u.name}`;
    const unitDir = join(base, unitRel);
    // Quota latch: once an upstream HIGH-confidence limit is seen, skip not-yet-started units
    // rather than burning more of a shared account (the run.ts loop has no abort seam in scope).
    if (prot?.quota.limited) {
      const outcome = skippedByQuota();
      outcome.evidence = [`skipped: upstream rate limit (${prot.quota.signal?.kind ?? "quota"})`];
      return outcome;
    }
    // Skills-first: discover repo skills, match them to this unit's spec+name, and inject the
    // matches by name. When a knowledge-heavy unit (feature/architecture, or UX/UI by spec) has
    // NO match, flag the gap so the engine won't silently freelance (esp. UX/UI).
    const unitText = `${u.name} ${u.spec ?? ""}`;
    const skillMatches = matchSkillsForTask(discoverSkills(base), unitText);
    const skillNames = skillMatches.map((m) => m.skill.name);
    const looksUiUx = /\b(ui|ux|screen|layout|design|component|theme|accessib)/i.test(unitText);
    const knowledgeHeavy = riskClass === "feature" || riskClass === "architecture" || looksUiUx;
    const skillGap = knowledgeHeavy && skillNames.length === 0;
    // The full mixed-trust list actually injected into the prompt vs the VERIFIED-only subset
    // that a downstream skills-first gate is allowed to count as satisfying the requirement.
    const skillsInjected = skillNames;
    const skillsRequired = skillMatches
      .filter((m) => m.skill.status === "verified")
      .map((m) => m.skill.name);
    // Why the unit is knowledge-heavy: risk class first, else the UX/UI regex, else undefined.
    const knowledgeHeavySource: WorkUnit["knowledge_heavy_source"] = !knowledgeHeavy
      ? undefined
      : riskClass === "feature" || riskClass === "architecture"
        ? "risk"
        : looksUiUx
          ? "regex"
          : undefined;
    const prompt = buildEnginePrompt(engine, ctx, [
      { name: u.name, spec: u.spec, scope: u.scope, skills: skillNames, skillGap },
    ]);
    writeFileSafe(join(unitDir, "CONTEXT.md"), prompt);
    const evidence: string[] = [];
    if (prot?.checkpoint) {
      evidence.push(`${unitRel}/${persistCheckpoint(unitDir, prot.checkpoint)}`);
    }
    const result = await runDispatchAsync({ engine, prompt, mode, spawner });
    // A dry run is a READ-ONLY preview: the CONTEXT.md prompt above is its ONE intended
    // side-effect. It must never write result JSON nor append to the persisted evidence
    // ledger, so the dispatch outcome is reported in-memory only.
    if (mode !== "dry") {
      evidence.push(`${unitRel}/${persistDispatch(unitDir, result)}`);
      if (prot) recordQuota(prot, unitRel, unitDir, result, evidence);
    }
    let confidence = result.summary?.confidence ?? 0;
    const status: WorkUnit["status"] =
      mode === "dry" ? "verifying" : result.ok ? "verifying" : "blocked";

    // confidence<1 on a real run → investigate before blocking (never silently close).
    if (mode !== "dry" && confidence < 1) {
      const research = makeResearcher(engine, ctx, mode, spawner);
      const outcome = await investigateUnit(
        { name: u.name, confidence, owner_agent: u.owner_agent },
        { riskClass, research },
      );
      evidence.push(`${unitRel}/${persistInvestigation(unitDir, outcome)}`);
      confidence = Math.max(confidence, outcome.finalConfidence);
    }

    // A failed real dispatch: surface the recovery hint and (optionally) roll back.
    if (mode === "cli" && status === "blocked" && prot) handleUnitFailure(prot, base);

    return {
      status,
      confidence,
      evidence,
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      knowledge_heavy: knowledgeHeavy,
      knowledge_heavy_source: knowledgeHeavySource,
      skills_injected: skillsInjected,
      skills_required: skillsRequired,
      skills_used: result.summary?.skills_used ?? [],
    };
  };
}

/**
 * Independent reviewer. A dry run is a PREVIEW, not a verdict — it passes review neutrally so
 * the goal lands `partial` (exit 0), not `blocked`. A real run only passes at confidence 1.0
 * with evidence; anything less blocks (no completion on a guess).
 */
function makeReviewer(mode: "cli" | "bridge" | "dry"): Reviewer {
  return (_u, outcome) => {
    if (mode === "dry") {
      return { pass: true, reason: "dry preview — not evaluated (re-run with --yes)" };
    }
    if (outcome.confidence < 1) {
      return {
        pass: false,
        reason: `confidence ${outcome.confidence} < 1 — investigated, still blocked`,
      };
    }
    if (!outcome.evidence.length) return { pass: false, reason: "no recorded evidence" };
    return { pass: true, reason: "confidence 1.0 with evidence" };
  };
}

/**
 * Orchestrate the saved workflow: dispatch every work unit in parallel (bounded), run an
 * independent reviewer, record evidence, then evaluate the overarching goal. Mode is
 * `cli` (--yes, real engine), `bridge` ($VIBEFLOW_AI), or `dry` (prompts only, default).
 * Overlapping work-unit scopes are NOT dispatched concurrently — parallel dispatch is refused
 * (serialized) so independent lanes never clobber each other's files.
 */
export async function orchestrate(
  flags: Record<string, string | boolean>,
  base: string = cwd(),
  inject: { spawner?: AsyncSpawner; preflight?: PreflightFn; git?: GitRunner } = {},
): Promise<number> {
  const state = readState(base);
  if (!state) {
    console.error(c.yellow("No workflow. Run `vf init` first."));
    return 1;
  }
  const engine = resolveEngine(flags);
  const mode = resolveMode(flags);
  const riskClass = resolveRisk(flags);
  // Carry tool settings into the dispatch context so the prompt can tell the engine which
  // code-navigation tools (codegraph > lsp > native) are configured — otherwise dispatches run
  // tool-blind even when .mcp.json wired the servers.
  const ctx: ProjectContext = {
    ...defaultContext(),
    goal: state.goal,
    settings: readSettings(base),
  };

  // Run the whole task as one unit when none were planned (minimal-footprint principle).
  const allUnits: WorkUnit[] =
    state.work_units.length > 0
      ? state.work_units
      : [normalizeUnit({ name: "task", status: "pending", confidence: 0 })];

  // Only dispatch units that aren't already complete — a unit that is done at confidence 1.0
  // WITH evidence is finished; re-launching the engine against it wastes a round-trip and risks
  // clobbering accepted work. Completed units are still carried into the ledger + goal eval.
  const isComplete = (u: WorkUnit) =>
    u.status === "done" && u.confidence >= 1 && (u.evidence?.length ?? 0) > 0;
  const done = allUnits.filter(isComplete);
  const units: WorkUnit[] = allUnits.filter((u) => !isComplete(u));
  if (done.length) {
    console.log(
      c.dim(
        `Skipping ${done.length} already-complete unit(s): ${done.map((u) => u.name).join(", ")}`,
      ),
    );
  }

  // Nothing left to dispatch — every unit is already complete. Report the goal verdict and exit
  // without launching the engine (a no-op dispatch would only re-review finished work).
  if (units.length === 0) {
    console.log(c.green("\nAll work units already complete — nothing to dispatch."));
    const verdict = goalEval(state);
    const color = verdict.verdict === "met" ? c.green : c.yellow;
    console.log(color(`goal: ${verdict.verdict}`));
    for (const reason of verdict.reasons) console.log(c.dim(`  - ${reason}`));
    return verdict.verdict === "met" ? 0 : 1;
  }

  const launch = announceLaunch(engine, mode);
  if (launch.skip) return 1;
  // Stronger gate: a real (cli) dispatch requires a live-ready engine. When the caller injects
  // its own dispatch spawner (tests/headless), that spawner IS the engine round-trip, so we
  // trust it rather than probing the real binary — unless an explicit preflight is supplied.
  const preflight = inject.preflight ?? (inject.spawner ? () => [readyStub(engine)] : undefined);
  if (!engineReady(engine, mode, preflight)) return 1;

  // Source-protection: only on a REAL (cli) dispatch — never dry/bridge (nothing irreversible).
  const settings = readSettings(base);
  const fp = resolveProtection(flags, settings.failureProtection);
  const git = inject.git ?? repoGit(base);
  let prot: ProtectionRuntime | undefined;
  if (mode === "cli") {
    const plan = planProtection(base, state.task_id, fp, git);
    if (plan.refused) {
      console.error(c.red(`\n${plan.reason}`));
      return 1;
    }
    prot = { checkpoint: plan.checkpoint, fp, git, quota: { limited: false }, rolledBack: false };
  }

  // Build the dispatch spawner honoring the configured per-unit timeout (0 disables it). An
  // injected spawner (tests/headless) always wins so suites never launch a real engine.
  const timeoutMs = fp.timeoutSeconds > 0 ? fp.timeoutSeconds * MS_PER_SECOND : undefined;
  const spawner = inject.spawner ?? makeAsyncSpawner({ timeoutMs });

  // Scope-conflict gate: refuse to dispatch overlapping scopes in parallel — serialize them.
  const conflicts = findScopeConflicts(units);
  const requested =
    typeof flags.concurrency === "string" ? Number(flags.concurrency) : DEFAULT_CONCURRENCY;
  let concurrency = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CONCURRENCY;
  if (conflicts.length) {
    concurrency = 1;
    console.log(
      c.yellow(
        `! ${conflicts.length} overlapping scope(s) — serializing dispatch (parallel refused):`,
      ),
    );
    for (const [a, b] of conflicts) console.log(c.dim(`  - ${a} ⨯ ${b}`));
  }

  const spinner = new Spinner();
  spinner.start(
    `Orchestrating ${units.length} unit(s) → ${engine} (${mode}, concurrency ${concurrency})`,
  );

  const { units: ran, reviews } = await orchestrateUnits({
    units,
    concurrency,
    dispatcher: makeDispatcher(engine, ctx, base, mode, riskClass, spawner, prot),
    reviewer: makeReviewer(mode),
  });

  spinner.succeed(`Dispatched ${ran.length} unit(s)`);
  // Merge dispatched results back with the skipped (already-complete) units so the ledger and
  // goal eval see the full set — not just the ones we re-ran this pass.
  state.work_units = done.length ? [...done, ...ran] : ran;
  recomputeTotals(state);
  // Dry is read-only: keep the persisted ledger byte-identical (only the CONTEXT.md prompt
  // previews under workunits/* are written). Real runs (cli/bridge) persist the outcome.
  if (mode !== "dry") writeState(base, state);

  for (const r of reviews) {
    console.log(`${r.pass ? c.green("✓") : c.yellow("•")} review ${r.unit}: ${r.reason}`);
  }
  const verdict = goalEval(state);
  const color =
    verdict.verdict === "met" ? c.green : verdict.verdict === "blocked" ? c.red : c.yellow;
  console.log(color(`\ngoal: ${verdict.verdict}`));
  for (const reason of verdict.reasons) console.log(c.dim(`  - ${reason}`));
  // Append a machine event to the work journal — real runs only (dry is read-only).
  if (mode !== "dry") {
    appendJournal(base, "dispatch", `${engine} → goal ${verdict.verdict}`, [
      `${ran.length} unit(s) dispatched (${mode}, concurrency ${concurrency})`,
      ...ran.map((u) => `- ${u.name}: ${u.status} @ ${u.confidence}`),
      ...reviews.map((r) => `- review ${r.unit}: ${r.pass ? "pass" : "fail"} — ${r.reason}`),
    ]);
  }
  if (mode === "dry") {
    console.log(
      c.dim(
        `\nDry run: prompts written under ${CTX_DIR}/workunits/*. Re-run with --yes to launch the engine.`,
      ),
    );
  }
  return verdict.verdict === "blocked" ? 1 : 0;
}

/** Print per-engine readiness hints, then a clear refusal line. Returns the nonzero exit code. */
function reportPreflightRefusal(readiness: EngineReadiness[] | undefined): number {
  console.error(c.red("\nNo engine is ready — refusing to generate engine files."));
  for (const r of readiness ?? []) {
    console.error(`  ${c.yellow("!")} ${r.engine}: ${c.dim(r.detail)}`);
  }
  console.error(c.dim("Fix an engine above (or use `--dry-run` for an offline preview)."));
  return 1;
}

export function init(
  flags: Record<string, string | boolean>,
  inject: { preflight?: PreflightFn } = {},
): number {
  const engines = typeof flags.engine === "string" ? [flags.engine] : undefined;
  const dry = Boolean(flags["dry-run"]);
  const result = applyIntake({ engines }, { dry, skipPreflight: dry, preflight: inject.preflight });
  if (result.refused) return reportPreflightRefusal(result.readiness);
  const label = dry ? "dry run" : "init";
  console.log(panel("VibeFlow", c.bold(label)));
  const dropped = (result.readiness ?? []).filter((r) => r.level !== "ready");
  for (const r of dropped) {
    console.log(c.yellow(`• skipped ${r.engine}: ${c.dim(r.detail)}`));
  }
  for (const rel of result.files) {
    console.log(dry ? c.dim(`would write ${rel}`) : `${c.green("+")} ${rel}`);
  }
  if (!dry) console.log(c.bold(`\nGenerated ${result.files.length} files from canonical context.`));
  return 0;
}

/** Interactive `vf init --interactive` — asks the intake questions in the terminal. */
export async function initInteractive(_flags: Record<string, string | boolean>): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def = ""): Promise<string> =>
    new Promise((res) =>
      rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => res(a.trim() || def)),
    );
  console.log(c.bold("VibeFlow — new workflow\n"));
  const goal = await ask("Goal / task");
  const engines = (await ask("Engines (comma)", ENGINES.join(","))).split(",");
  const docSource = await ask("Project docs source (path/URL)");
  const taskSource = await ask("Task / issue source");
  const fileTypes = (await ask("File types (comma)")).split(",");
  const expectedResult = await ask("Expected result (Definition of Done)");
  rl.close();
  const result = applyIntake({
    goal,
    engines,
    docSource,
    taskSource,
    fileTypes,
    expectedResult,
  });
  if (result.refused) return reportPreflightRefusal(result.readiness);
  for (const rel of result.files) console.log(`${c.green("+")} ${rel}`);
  console.log(c.bold(`\nGenerated ${result.files.length} files from canonical context.`));
  return 0;
}

export async function run(
  engineArg: string | undefined,
  flags: Record<string, string | boolean>,
  inject: {
    preflight?: PreflightFn;
    base?: string;
    git?: GitRunner;
    spawner?: AsyncSpawner;
  } = {},
): Promise<number> {
  if (!engineArg || !(ENGINES as string[]).includes(engineArg)) {
    console.error(c.red(`Usage: vf run <${ENGINES.join("|")}>`));
    return 2;
  }
  const engine = engineArg as Engine;
  const base = inject.base ?? cwd();
  const ctx = defaultContext();
  const state = readState(base);
  const units = state ? state.work_units.map((u) => u.name) : [];
  const prompt = dispatchPrompt(engine, ctx, units);
  writeFileSafe(ctxPathIn(base, "dispatch", `${engine}.md`), prompt);
  console.log(`${c.green("+")} ${CTX_DIR}/dispatch/${engine}.md`);

  const invocation = engineCommand(engine);
  if (isUnavailable(invocation)) {
    console.log(
      c.yellow(`\n${invocation.unavailable}. Dispatch prompt written; install then re-run.`),
    );
    return 0;
  }
  if (invocation.warning) console.log(c.yellow(`! ${engine}: ${invocation.warning}`));
  // The dry-run path never launches, so it stays cheap: no git gate, no checkpoint.
  if (!flags.yes) {
    console.log(c.dim(`\nDry run. Re-run with --yes to launch ${engine}.`));
    return 0;
  }
  // runId derived from the saved task (never Date.now/random) so test-covered paths are stable.
  return launchEngine(engine, prompt, flags, base, inject, state?.task_id ?? engine);
}

/**
 * Real (cli) launch for `vf run`. Mirrors orchestrate()'s contract EXACTLY via the shared
 * helpers — engineReady probe, planProtection gate (refuse dirty/non-git per settings/flags),
 * checkpoint, then BUG 2 fix: deliver the prompt over stdin through runDispatchAsync (the same
 * unified dispatch path orchestrate uses) so the engine actually receives it. On engine failure
 * we surface the recovery hint and honor --rollback-on-fail just like orchestrate.
 */
async function launchEngine(
  engine: Engine,
  prompt: string,
  flags: Record<string, string | boolean>,
  base: string,
  inject: { preflight?: PreflightFn; git?: GitRunner; spawner?: AsyncSpawner },
  runId: string,
): Promise<number> {
  // Stronger gate: confirm a live-ready engine. An injected spawner IS the round-trip, so trust it.
  const preflight = inject.preflight ?? (inject.spawner ? () => [readyStub(engine)] : undefined);
  if (!engineReady(engine, "cli", preflight)) return 1;

  // Source-protection — identical to orchestrate(): refuse a dirty/non-git tree unless opted in.
  const fp = resolveProtection(flags, readSettings(base).failureProtection);
  const git = inject.git ?? repoGit(base);
  const plan = planProtection(base, runId, fp, git);
  if (plan.refused) {
    console.error(c.red(`\n${plan.reason}`));
    return 1;
  }
  const prot: ProtectionRuntime = {
    checkpoint: plan.checkpoint,
    fp,
    git,
    quota: { limited: false },
    rolledBack: false,
  };

  const banner = downgradeBannerText(engine);
  if (banner) console.log(c.yellow(banner));
  const spinner = new Spinner();
  spinner.start(`Launching ${engine}…`);

  const timeoutMs = fp.timeoutSeconds > 0 ? fp.timeoutSeconds * MS_PER_SECOND : undefined;
  const spawner = inject.spawner ?? makeAsyncSpawner({ timeoutMs });
  const result = await runDispatchAsync({ engine, prompt, mode: "cli", spawner });
  spinner.succeed(result.ok ? `${engine} finished` : `${engine} failed`);
  if (!result.ok) {
    handleUnitFailure(prot, base);
    return 1;
  }
  return 0;
}

export function units(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean> = {},
): number {
  const state = readState();
  if (!state) {
    console.error(c.yellow(`No ${CTX_DIR}/WORKFLOW_STATE.json. Run \`vf init\` first.`));
    return 1;
  }
  switch (sub) {
    case undefined:
    case "status": {
      if (state.work_units.length === 0) {
        console.log(c.dim("No work units. Single-concern tasks run without them."));
        return 0;
      }
      for (const u of state.work_units) {
        const g = u.gates;
        const gs = (["build", "lint", "test", "review"] as const)
          .map((k) => `${k}:${gateColor(g[k])}`)
          .join(" ");
        console.log(`${c.bold(u.name)} ${c.dim(u.status)} conf ${u.confidence}\n  ${gs}`);
      }
      return 0;
    }
    case "show": {
      const name = rest[0];
      if (!name) {
        console.error(c.yellow("Usage: vf units show <name>"));
        return 2;
      }
      const u = state.work_units.find((x) => x.name === name);
      if (!u) {
        console.error(c.red(`No such work unit: ${name}`));
        return 1;
      }
      console.log(JSON.stringify(u, null, 2));
      return 0;
    }
    case "resources": {
      const t = state.totals;
      console.log(
        `units ${t.done}/${t.units} · ${t.tokens} tokens · $${t.cost_usd} · ${t.wall_seconds}s`,
      );
      return 0;
    }
    case "evidence": {
      const name = rest[0];
      if (!name) {
        console.error(c.yellow("Usage: vf units evidence <name>"));
        return 2;
      }
      const u = state.work_units.find((x) => x.name === name);
      if (!u) {
        console.error(c.red(`No such work unit: ${name}`));
        return 1;
      }
      if ("add" in flags) {
        const text = typeof flags.add === "string" ? flags.add.trim() : "";
        if (!text) {
          console.error(c.yellow('Usage: vf units evidence <name> --add "<text>"'));
          return 2;
        }
        const cur = u.evidence ?? [];
        const next = mutateUnits(cwd(), "update", { name, evidence: [...cur, text] });
        if (!next) {
          console.error(c.red(`No such work unit: ${name}`));
          return 1;
        }
        console.log(c.green(`+ evidence for ${c.bold(name)}: ${text}`));
        return 0;
      }
      for (const e of u.evidence ?? []) console.log(e);
      if (!u.evidence?.length) console.log(c.dim("(no recorded evidence)"));
      return 0;
    }
    case "add": {
      const name = rest[0]?.trim();
      if (!name) {
        console.error(c.red('Usage: vf units add <name> [--spec "<text>"] [--scope a,b]'));
        return 2;
      }
      const addPatch: Partial<WorkUnit> & { name: string } = { name };
      if (typeof flags.spec === "string") addPatch.spec = flags.spec;
      if (typeof flags.scope === "string") {
        addPatch.scope = flags.scope
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const next = mutateUnits(cwd(), "add", addPatch);
      if (!next) {
        console.error(c.red(`Could not add "${name}" — a unit with that name already exists.`));
        return 1;
      }
      console.log(c.green(`+ added unit ${c.bold(name)}`));
      return 0;
    }
    case "update": {
      const name = rest[0]?.trim();
      if (!name) {
        console.error(
          c.red(
            'Usage: vf units update <name> [--status s] [--confidence n] [--spec "<text>"] [--scope a,b]',
          ),
        );
        return 2;
      }
      const patch: Partial<WorkUnit> & { name: string } = { name };
      if (typeof flags.status === "string") patch.status = flags.status as WorkUnit["status"];
      if (typeof flags.confidence === "string") patch.confidence = Number(flags.confidence);
      if (typeof flags.spec === "string") patch.spec = flags.spec;
      if (typeof flags.scope === "string") {
        patch.scope = flags.scope
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const next = mutateUnits(cwd(), "update", patch);
      if (!next) {
        console.error(c.red(`No such work unit: ${name}`));
        return 1;
      }
      console.log(c.green(`~ updated unit ${c.bold(name)}`));
      return 0;
    }
    case "delete": {
      const name = rest[0]?.trim();
      if (!name) {
        console.error(c.red("Usage: vf units delete <name>"));
        return 2;
      }
      const next = mutateUnits(cwd(), "delete", { name });
      if (!next) {
        console.error(c.red(`No such work unit: ${name}`));
        return 1;
      }
      console.log(c.green(`- deleted unit ${c.bold(name)}`));
      return 0;
    }
    case "waiver": {
      const name = rest[0]?.trim();
      const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";
      if (!name || !reason) {
        console.error(c.red('Usage: vf units waiver <name> --reason "<why no verified skill>"'));
        return 2;
      }
      const patch: Partial<WorkUnit> & { name: string } = {
        name,
        skill_waiver: { reason, at: new Date().toISOString(), by: "human" },
      };
      const next = mutateUnits(cwd(), "update", patch);
      if (!next) {
        console.error(c.red(`No such work unit: ${name}`));
        return 1;
      }
      console.log(c.green(`~ waived skill gate for ${c.bold(name)} (${reason})`));
      return 0;
    }
    default:
      console.error(c.red(`Unknown: vf units ${sub}`));
      return 2;
  }
}

function gateColor(s: string): string {
  if (s === "pass") return c.green(s);
  if (s === "fail") return c.red(s);
  if (s === "running") return c.yellow(s);
  return c.dim(s);
}

export function skills(sub: string | undefined, rest: string[] = []): number {
  const repo = cwd();
  const found = discoverSkills(repo);
  if (sub === undefined || sub === "list") {
    if (!found.length) {
      console.log(
        c.dim(`No skills discovered under ${CTX_DIR}/skills, .kiro/skills, or .claude/skills.`),
      );
      return 0;
    }
    process.stdout.write(renderSkillIndex(found));
    return 0;
  }
  if (sub === "search") {
    const term = rest.join(" ").trim();
    if (!term) {
      console.error(c.red("Usage: vf skills search <term>"));
      return 2;
    }
    const matches = matchSkillsForTask(found, term);
    if (!matches.length) {
      console.log(c.dim(`No skill matched "${term}".`));
      return 0;
    }
    for (const m of matches) {
      console.log(`${c.bold(m.skill.name)} ${c.dim(`(${m.score.toFixed(2)})`)} — ${m.reason}`);
    }
    return 0;
  }
  if (sub === "resolve") {
    // Demand-driven: derive skill NEEDS from the repo scan + saved intake, then report
    // which are satisfied locally and which must be acquired on demand (never pre-installed).
    const state = readState(repo);
    const profile = scanRepo(repo);
    const attachments = (state?.attachments ?? []).map((a) => a.name);
    const needs = resolveSkillNeeds({
      repo,
      attachments,
      task: state?.goal,
      profile,
    });
    process.stdout.write(renderSkillNeeds(needs));
    return 0;
  }
  if (sub === "init") {
    const name = rest[0]?.trim();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      console.error(
        c.red("Usage: vf skills init <name>  (lowercase-hyphen, e.g. compose-screen-ux)"),
      );
      return 2;
    }
    const dir = join(repo, CTX_DIR, "skills", name);
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) {
      console.error(c.red(`Skill "${name}" already exists at ${skillMd}.`));
      return 1;
    }
    writeFileSafe(skillMd, skillTemplate(name));
    console.log(c.green(`+ scaffolded skill ${c.bold(name)} → ${skillMd}`));
    console.log(
      c.dim(
        "Edit triggers/capabilities so `vf skills search <task>` matches it, then fill the steps.",
      ),
    );
    return 0;
  }
  console.log(
    c.dim(`vf skills ${sub} — registry operations are configured via providers (see docs).`),
  );
  return 0;
}

/** A starter SKILL.md: valid frontmatter (so discoverSkills/parseSkill accept it) + a steps stub. */
function skillTemplate(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: One-line summary of what this skill does and when to apply it.",
    "status: draft",
    "capabilities:",
    "  - capability-keyword",
    "triggers:",
    "  - trigger-keyword",
    "requires:",
    "  filesystem: read",
    "  network: false",
    "  shell: false",
    "---",
    "",
    `# ${name}`,
    "",
    "## When to use",
    "Describe the task shape that should invoke this skill.",
    "",
    "## Steps",
    "1. First concrete step.",
    "2. Next step.",
    "",
    "## Verification",
    "How to prove the skill was applied correctly (command output, file check, test).",
    "",
  ].join("\n");
}

/**
 * External docs/skill discovery via Context7 — network only with explicit approval.
 * Rides the stdlib `fetch` HTTP path (zero-install); `inject.fetchFn` is a test-only seam so
 * suites never hit the wire. Discovery results are experimental at most and skill names are
 * sanitized to a path-safe slug before they are surfaced.
 */
export async function discover(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  inject: { fetchFn?: typeof fetch } = {},
): Promise<number> {
  const query = rest.join(" ").trim();
  const approved = Boolean(flags.yes);
  if (sub !== "docs" && sub !== "skills") {
    console.error(c.red("Usage: vf discover <docs|skills> <query> [--yes]"));
    return 2;
  }
  if (!query) {
    console.error(c.red(`Usage: vf discover ${sub} <query> [--yes]`));
    return 2;
  }
  const opts = { approved, fetchFn: inject.fetchFn };
  const { lookupDocsHttp: lookup, searchSkillsHttp: search } = await import(
    "./discovery/context7.js"
  );
  const outcome = sub === "docs" ? await lookup(query, opts) : await search(query, opts);
  if (outcome.approvalRequired) {
    console.log(c.yellow(`${outcome.reason} Re-run with --yes to approve the network lookup.`));
    return 0;
  }
  if (!outcome.ok) {
    console.error(c.red(outcome.reason ?? "discovery failed"));
    return 1;
  }
  for (const r of outcome.results) {
    const tag = r.status ? c.yellow(`[${r.status}]`) : c.dim(`[${r.kind}]`);
    const slug = r.name ? c.dim(` name: ${r.name}`) : "";
    console.log(`${tag} ${c.bold(r.title)} — ${r.snippet}${slug}`);
  }
  if (!outcome.results.length) console.log(c.dim("(no results)"));
  return 0;
}

/** Hook entry: read a JSON event from stdin, score risk, print a decision, set exit code. */
export async function hook(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = parseHookInput(Buffer.concat(chunks).toString("utf8"));
  if (!input) {
    // FAIL OPEN on the live tool gate: a parser gap must never brick a running agent.
    // (The git pre-commit path is independently fail-closed in shell — see adapters.gitPreCommit.)
    console.log(
      JSON.stringify({
        decision: "allow",
        risk: "none",
        reasons: ["unrecognized hook input — allowing (fail-open on live tool gate)"],
      }),
    );
    return 0;
  }
  const result = evaluateHook(input);
  // presentDecision emits the structured Claude "ask" envelope for PreToolUse approvals while
  // keeping the exit-code veto (2) correct for block / require_approval on every engine.
  const { json, exitCode } = presentDecision(result, input);
  console.log(json);
  return exitCode;
}

/** Where the dogfood self-test report lands — knowledge/ survives checkpoint gitignore. */
const SELFCHECK_REL = `${CTX_DIR}/knowledge/hook-selfcheck.json`;

/**
 * `vf hook --selftest` (item 3): run the FIXED attack+benign corpus through the real decision
 * path with NO engine spawn, write an auditable report to .viteflow/knowledge/hook-selfcheck.json,
 * and return 0 only when every case holds (each attack blocked, each benign allowed). A regression
 * returns nonzero. `now`/`base` are injectable so tests stay deterministic and never dirty the repo.
 */
export function hookSelftest(inject: { base?: string; now?: () => string } = {}): number {
  const base = inject.base ?? cwd();
  const now = inject.now ?? (() => new Date().toISOString());
  const report: SelftestReport = runSelftest(now);
  writeFileSafe(join(base, SELFCHECK_REL), JSON.stringify(report, null, 2));
  for (const c0 of report.cases) {
    const mark = c0.pass ? c.green("✓") : c.red("✗");
    console.log(`${mark} [${c0.expected}→${c0.actual}] ${c0.risk} · ${c0.input}`);
  }
  if (report.failed > 0) {
    console.log(c.red(`\n${report.failed}/${report.cases.length} self-test case(s) regressed.`));
    return 1;
  }
  console.log(
    c.green(`\nhook self-test: ${report.passed}/${report.cases.length} pass → ${SELFCHECK_REL}`),
  );
  return 0;
}

/** True when .claude/settings.json wires a PreToolUse hook whose command delegates to
 * `vf hook` — the only way the live per-tool-call guardrail is actually armed. Parses the
 * JSON and inspects the PreToolUse entries so an unrelated mention of "vf hook" can't read
 * as ON. */
export function liveGuardrailArmed(base: string): boolean {
  try {
    const raw = readFileSync(join(base, ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown }> }> };
    };
    const pre = parsed.hooks?.PreToolUse;
    if (!Array.isArray(pre)) return false;
    return pre.some((entry) =>
      (entry.hooks ?? []).some(
        (h) => typeof h.command === "string" && /\bvf\s+hook\b/.test(h.command),
      ),
    );
  } catch {
    return false;
  }
}

/** A loud, actionable note when the live guardrail is OFF — silence reads as "protected". */
function guardrailOffNote(): string {
  return c.yellow(
    "live guardrail: OFF — risky tool calls are NOT intercepted. Run `vf hooks emit --yes` to arm the PreToolUse gate.",
  );
}

export function hooks(
  sub: string | undefined,
  flags: Record<string, string | boolean> = {},
): number {
  switch (sub) {
    case "install": {
      const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
      if (r.status === 0) console.log(c.green("Installed: core.hooksPath → .githooks"));
      return r.status ?? 0;
    }
    case undefined:
    case "status": {
      const r = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
      const path = r.stdout.trim();
      console.log(
        path
          ? `core.hooksPath = ${path}`
          : c.yellow("core.hooksPath not set — run `vf hooks install`"),
      );
      // The live per-tool-call guardrail only exists if .claude/settings.json delegates a
      // PreToolUse hook to `vf hook`. Report it LOUDLY — a silent "OFF" reads as "protected".
      console.log(liveGuardrailArmed(cwd()) ? c.green("live guardrail: ON") : guardrailOffNote());
      return 0;
    }
    case "emit": {
      const files = engineHookFiles();
      // Default to a DRY RUN: writing .claude/settings.json hot-reloads a PreToolUse hook
      // into the running agent, so never overwrite engine configs without explicit --yes.
      if (!flags.yes || flags["dry-run"]) {
        for (const rel of Object.keys(files)) console.log(`${c.dim("[dry-run]")} ${rel}`);
        console.log(
          c.yellow(
            ".claude/settings.json installs a PreToolUse hook that affects the running agent.",
          ),
        );
        console.log(c.dim("Re-run with --yes to write."));
        return 0;
      }
      // --yes: write per-engine hook configs into the active repo, all delegating to `vf hook`.
      for (const [rel, content] of Object.entries(files)) {
        writeFileSafe(join(cwd(), rel), content);
        console.log(`${c.green("+")} ${rel}`);
      }
      return 0;
    }
    default:
      console.error(c.red(`Unknown: vf hooks ${sub}`));
      return 2;
  }
}

/** Plan which toolchain gates `vf verify` should run, by detecting the project's build system.
 * Pure + injectable (exists/readScripts) so it's testable without a real filesystem. */
export type ToolchainPlan =
  | { kind: "npm"; runner: string; gates: string[] }
  | { kind: "gradle"; cmd: string }
  | { kind: "monorepo"; runner: string; dir: string; gates: string[] }
  | { kind: "none" };

export function detectToolchain(
  base: string,
  opts: {
    exists?: (p: string) => boolean;
    readScripts?: (p: string) => string[];
    runner?: string;
  } = {},
): ToolchainPlan {
  const exists = opts.exists ?? existsSync;
  const runner = opts.runner ?? (hasCommand("bun") ? "bun" : "npm");
  const readScripts =
    opts.readScripts ??
    ((p: string) =>
      Object.keys(
        (JSON.parse(readFileSync(p, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {},
      ));
  const root = join(base, "package.json");
  if (exists(root)) {
    const gates = readScripts(root).filter((s) => ["typecheck", "lint", "test"].includes(s));
    return { kind: "npm", runner, gates };
  }
  if (
    ["build.gradle.kts", "build.gradle", "settings.gradle.kts"].some((f) => exists(join(base, f)))
  ) {
    return { kind: "gradle", cmd: exists(join(base, "gradlew")) ? "./gradlew" : "gradle" };
  }
  for (const d of ["web", "app", "frontend"]) {
    const p = join(base, d, "package.json");
    if (exists(p)) {
      const gates = readScripts(p).filter((s) =>
        ["typecheck", "lint", "test", "build"].includes(s),
      );
      return { kind: "monorepo", runner, dir: join(base, d), gates };
    }
  }
  return { kind: "none" };
}

export function verify(): number {
  let failed = 0;
  const base = cwd();
  const runGate = (label: string, cmd: string, args: string[], dir = base) => {
    console.log(c.cyan(`▶ ${label}`));
    const r = spawnSync(cmd, args, { stdio: "inherit", cwd: dir });
    if (r.status !== 0) {
      failed++;
      console.log(c.red(`✗ ${label} failed`));
    } else {
      console.log(c.green(`✓ ${label}`));
    }
  };

  // Toolchain gates — detect the project's build system instead of assuming npm.
  const plan = detectToolchain(base);
  if (plan.kind === "npm") {
    for (const gate of plan.gates)
      runGate(`${plan.runner} run ${gate}`, plan.runner, ["run", gate]);
    if (plan.gates.length === 0)
      console.log(c.dim("package.json has no typecheck/lint/test scripts."));
  } else if (plan.kind === "gradle") {
    runGate(`${plan.cmd} check`, plan.cmd, ["check"]);
  } else if (plan.kind === "monorepo") {
    const label = plan.dir.split("/").pop();
    for (const gate of plan.gates)
      runGate(`(${label}) ${plan.runner} run ${gate}`, plan.runner, ["run", gate], plan.dir);
  } else {
    console.log(
      c.yellow(
        "⚠ no package.json or Gradle build found — skipping toolchain gates (unsupported build system)",
      ),
    );
  }

  // Policy gates (confidence / evidence / scope) over the workflow ledger.
  const report = policyGates(readState());
  for (const ok of report.passed) console.log(c.green(`✓ ${ok}`));
  for (const w of report.warnings) console.log(c.yellow(`⚠ ${w}`));
  for (const f of report.failures) {
    failed++;
    console.log(c.red(`✗ ${f}`));
  }

  if (failed > 0) {
    console.log(c.red(`\n${failed} gate(s) failed.`));
    appendJournal(base, "verify", "fail", [
      `${failed} gate(s) failed`,
      ...report.failures.map((f) => `- ${f}`),
    ]);
    return 1;
  }
  console.log(c.green("\nAll configured gates passed."));
  appendJournal(base, "verify", "pass", [
    `${report.passed.length} gate(s) passed`,
    ...(report.warnings.length ? [`${report.warnings.length} warning(s)`] : []),
  ]);
  return 0;
}

/** Spawn seam for tool installs — defaults to a real spawnSync, injectable for tests. */
export type StepSpawner = (cmd: string, args: string[]) => { status: number };
const VALID_TOOLS: ToolName[] = ["codegraph", "lsp"];

function isToolName(v: string | undefined): v is ToolName {
  return v === "codegraph" || v === "lsp";
}

/** Languages detected in the active repo, used to build LSP install plans + entries. */
function repoLanguages(base: string): string[] {
  try {
    return scanRepo(base).languages;
  } catch {
    return [];
  }
}

/** Render the priority ladder (highest first) from settings for `vf tools status`. */
function renderPriority(settings: VibeSettings): string {
  const rank = priorityRank(settings);
  const tiers: ToolTier[] = ["codegraph", "lsp", "native"];
  return [...tiers].sort((a, b) => rank[b] - rank[a]).join(" > ");
}

/** `vf tools status` — show enabled/installed/priority for each optional tool. */
function toolsStatus(base: string): number {
  const settings = readSettings(base);
  const languages = repoLanguages(base);
  console.log(c.bold("Optional developer tools\n"));
  for (const name of VALID_TOOLS) {
    const tool = TOOLS[name];
    const enabled = settings.tools[name];
    const installed = tool.detect();
    const en = enabled ? c.green("enabled") : c.dim("disabled");
    const inst = installed ? c.green("installed") : c.yellow("not installed");
    console.log(`  ${c.bold(tool.title)} [${en}, ${inst}]`);
    console.log(`    ${c.dim(tool.description)}`);
    if (enabled && !installed) {
      console.log(
        c.yellow(
          `    ! enabled but binary not on PATH — MCP server won't start. Run \`vf tools install ${name}\`.`,
        ),
      );
    }
  }
  console.log(`\n  priority: ${c.cyan(renderPriority(settings))}`);
  if (languages.length) console.log(`  detected languages: ${c.dim(languages.join(", "))}`);
  console.log(c.dim("\n  Re-run `vf init` after changing tools to regenerate instructions."));
  return 0;
}

/** Repo-relative MCP config files VibeFlow owns and may safely read+rewrite. */
const CLAUDE_MCP_FILE = ".mcp.json";
const CODEX_MCP_FILE = join(".codex", "config.toml");

/** Claude `.mcp.json` shape (only the slice we touch). */
interface ClaudeMcpFile {
  mcpServers: Record<string, StdioServer>;
}

/** Every MCP server name VibeFlow manages, across BOTH tools — the keys we may remove. */
function managedClaudeServerNames(base: string, languages: string[]): string[] {
  const ctx = { workspace: base, languages };
  const all = resolveTools({ codegraph: true, lsp: true }, "claude", ctx);
  const names: string[] = [];
  for (const entry of all.entries) {
    for (const name of Object.keys((entry as JsonMcpEntry).servers)) names.push(name);
  }
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
function writeClaudeMcp(base: string, settings: VibeSettings, languages: string[]): boolean {
  const path = join(base, CLAUDE_MCP_FILE);
  const file = readClaudeMcp(path);
  if (file.corrupt) {
    console.log(
      c.yellow(`! ${CLAUDE_MCP_FILE} is not valid JSON — left untouched. Fix it, then re-run.`),
    );
    return false;
  }
  for (const name of managedClaudeServerNames(base, languages)) delete file.mcpServers[name];
  const ctx = { workspace: base, languages };
  const merged = resolveTools(settings.tools, "claude", ctx);
  for (const entry of merged.entries) {
    Object.assign(file.mcpServers, (entry as JsonMcpEntry).servers);
  }
  const hasServers = Object.keys(file.mcpServers).length > 0;
  if (!hasServers && !existsSync(path)) return false;
  writeFileSafe(path, JSON.stringify({ mcpServers: file.mcpServers }, null, 2));
  return true;
}

/** Serialize one codex `[mcp_servers.x]` section (minimal, only the shapes we emit). */
function tomlSection(entry: TomlMcpEntry): string {
  const lines = [`[${entry.section}]`, `command = ${JSON.stringify(entry.command)}`];
  lines.push(`args = ${JSON.stringify(entry.args)}`);
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
  const path = join(base, CODEX_MCP_FILE);
  if (entries.length === 0) {
    if (existsSync(path)) rmSync(path);
    return false;
  }
  const header =
    "# Managed by VibeFlow (`vf tools`). Repo-local codex MCP config — merge into\n" +
    "# ~/.codex/config.toml or point codex at it. Edit `vf tools enable/disable` to regenerate.";
  writeFileSafe(path, `${header}\n\n${entries.map(tomlSection).join("\n\n")}`);
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
  if (merged.entries.length === 0) return 0;
  console.log(c.bold("\nCopilot (run these — VibeFlow won't touch your secret ~/.copilot):"));
  let count = 0;
  for (const entry of merged.entries) {
    for (const [name, server] of Object.entries((entry as JsonMcpEntry).servers)) {
      const args = server.args.map((a) => JSON.stringify(a)).join(" ");
      console.log(c.cyan(`  copilot mcp add ${name} -- ${server.command} ${args}`.trim()));
      count++;
    }
  }
  return count;
}

/**
 * Wire enabled tools into every engine's MCP config: merge claude's `.mcp.json`, write the
 * repo-local codex `config.toml` (with structural gating), and print copilot's add commands.
 * Pure tool modules build the entries; the WRITING lives here. Languages drive LSP entries.
 */
function writeToolConfigs(base: string, settings: VibeSettings): void {
  const languages = repoLanguages(base);
  writeClaudeMcp(base, settings, languages);
  writeCodexMcp(base, settings, languages);
  printCopilotMcp(base, settings, languages);
}

/** `vf tools enable|disable <tool>` — flip the flag in SETTINGS.json and report. When enabling
 * with `--yes`, also PROVISION the tool (install the binary if missing, build the index if
 * absent) and report honest readiness, instead of only warning about a missing binary. */
function toolsToggle(
  base: string,
  name: ToolName,
  on: boolean,
  opts: { approved?: boolean; spawner?: StepSpawner } = {},
): number {
  const settings = writeSettings(base, { tools: { ...readSettings(base).tools, [name]: on } });
  const word = on ? c.green("enabled") : c.yellow("disabled");
  console.log(`${word} ${c.bold(TOOLS[name].title)} in ${settingsPath(base)}`);
  writeToolConfigs(base, settings);
  console.log(`  wrote MCP config to ${join(base, CLAUDE_MCP_FILE)}`);
  if (on && !TOOLS[name].detect()) {
    // Enabling writes .mcp.json pointing at the tool's binary — but if that binary isn't on
    // PATH the MCP server can't start and dispatched engines silently get no navigation.
    if (opts.approved && opts.spawner) {
      const rc = provisionTool(base, name, opts.spawner);
      if (rc !== 0) {
        console.error(
          c.yellow(
            `  note: ${name} stays enabled in ${settingsPath(base)} but is NOT provisioned — re-run \`vf tools enable ${name} --yes\` after fixing the failure, or \`vf tools disable ${name}\`.`,
          ),
        );
        return rc;
      }
    } else {
      console.log(
        c.yellow(
          `  ! ${TOOLS[name].title} binary not found on PATH — the MCP server will not start until it is installed.`,
        ),
      );
      console.log(
        c.dim(
          `    Run \`vf tools enable ${name} --yes\` to install + index it now, or \`vf tools install ${name}\` for the plan.`,
        ),
      );
    }
  } else if (on && opts.approved && opts.spawner) {
    // Binary present but the per-repo artifact (e.g. code index) may be missing — build it.
    const rc = ensureToolIndex(base, name, opts.spawner);
    if (rc !== 0) return rc;
  }
  console.log(
    c.dim(
      settings.tools[name] === on ? "Re-run `vf init` to regenerate instructions." : "no change",
    ),
  );
  return 0;
}

/** Run an ordered set of install steps via the spawner, stopping on the first failure.
 * Generic over any tool — drives entirely off the registry's plans, no per-tool branching. */
function runToolSteps(steps: { cmd: string; args: string[] }[], spawner: StepSpawner): boolean {
  for (const step of steps) {
    console.log(c.cyan(`\n▶ ${step.cmd} ${step.args.join(" ")}`));
    const { status } = spawner(step.cmd, step.args);
    if (status !== 0) {
      console.error(c.red(`✗ step failed (${status}).`));
      return false;
    }
  }
  return true;
}

/** Install a tool (its full install plan) then build its per-repo index if it has one.
 * Generic: reads installPlan/indexPlan off the registry descriptor. Returns an exit code. */
function provisionTool(base: string, name: ToolName, spawner: StepSpawner): number {
  const tool = TOOLS[name];
  const ctx = { workspace: base, languages: repoLanguages(base) };
  if (!runToolSteps(tool.installPlan(ctx).steps, spawner)) {
    console.error(c.red(`  ${tool.title} is enabled but not provisioned.`));
    return 1;
  }
  console.log(c.green(`  ✓ ${tool.title} installed.`));
  return 0;
}

/** Build a tool's per-repo artifact only when its descriptor reports it absent. Tools with no
 * per-repo artifact (no indexPresent/indexPlan) are no-ops. Exported for direct testing. */
export function ensureToolIndex(base: string, name: ToolName, spawner: StepSpawner): number {
  const tool = TOOLS[name];
  if (!tool.indexPlan || !tool.indexPresent) return 0;
  if (tool.indexPresent(base)) {
    console.log(c.dim(`  ${tool.title} index present.`));
    return 0;
  }
  const ctx = { workspace: base, languages: repoLanguages(base) };
  if (!runToolSteps(tool.indexPlan(ctx).steps, spawner)) return 1;
  console.log(c.green(`  ✓ built ${tool.title} index.`));
  return 0;
}

/** `vf tools install <tool>` — print the plan; only execute steps when `--yes` is passed. */
function toolsInstall(
  base: string,
  name: ToolName,
  approved: boolean,
  spawner: StepSpawner,
): number {
  const ctx = { workspace: base, languages: repoLanguages(base) };
  const plan = TOOLS[name].installPlan(ctx);
  console.log(c.bold(`Install plan for ${TOOLS[name].title}:`));
  for (const step of plan.steps) {
    console.log(
      `  ${c.cyan(`${step.cmd} ${step.args.join(" ")}`)}\n    ${c.dim(step.description)}`,
    );
  }
  if (!approved) {
    console.log(c.yellow("\nNo changes made. Re-run with --yes to execute the plan."));
    return 0;
  }
  for (const step of plan.steps) {
    console.log(c.cyan(`\n▶ ${step.cmd} ${step.args.join(" ")}`));
    const { status } = spawner(step.cmd, step.args);
    if (status !== 0) {
      console.error(c.red(`✗ step failed (${status}). Stopping.`));
      return 1;
    }
  }
  console.log(
    c.green(`\nInstalled ${TOOLS[name].title}. Run \`vf tools enable ${name}\` to wire it.`),
  );
  return 0;
}

/**
 * `vf tools` — manage the optional code-navigation tools (codegraph, lsp). Subcommands:
 * status (default), enable/disable <tool>, install <tool> (--yes to execute). The install
 * path mirrors the discovery/hooks approval gate: print-only without --yes, never auto-run.
 */
export function tools(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  inject: { spawner?: StepSpawner; base?: string } = {},
): number {
  const base = inject.base ?? cwd();
  if (sub === undefined || sub === "status") return toolsStatus(base);
  const name = rest[0];
  if ((sub === "enable" || sub === "disable" || sub === "install") && !isToolName(name)) {
    console.error(c.red(`Usage: vf tools ${sub} <${VALID_TOOLS.join("|")}>`));
    return 2;
  }
  const spawner: StepSpawner =
    inject.spawner ??
    ((cmd, args) => ({ status: spawnSync(cmd, args, { stdio: "inherit" }).status ?? 0 }));
  if (sub === "enable")
    return toolsToggle(base, name as ToolName, true, { approved: Boolean(flags.yes), spawner });
  if (sub === "disable") return toolsToggle(base, name as ToolName, false);
  if (sub === "install") {
    return toolsInstall(base, name as ToolName, Boolean(flags.yes), spawner);
  }
  console.error(c.red(`Unknown: vf tools ${sub}`));
  return 2;
}

export function printVersion(): number {
  console.log(VERSION);
  return 0;
}

/** Print a delete plan: the workflow summary + targets to remove + preserved files. */
function printDeletePlan(plan: DeletePlan, willApply: boolean): void {
  console.log(c.bold("Workflow delete plan\n"));
  console.log(plan.summary);
  console.log(c.bold("\nWould remove:"));
  for (const t of plan.targets) console.log(`  ${c.red("-")} ${t}`);
  if (!plan.targets.length) console.log(c.dim("  (nothing)"));
  if (plan.preserved.length) {
    console.log(c.bold("\nPreserved:"));
    for (const p of plan.preserved) console.log(`  ${c.green("•")} ${p}`);
  }
  if (!willApply) {
    console.log(c.yellow("\nDry run. Re-run with --yes to delete the targets above."));
  }
}

/** `vf workflow delete` — plan (always), then delete only with --yes. Never nukes silently. */
function workflowDelete(flags: Record<string, string | boolean>): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  const plan = planDelete(base, { all: Boolean(flags.all) });
  if (!plan.targets.length) {
    console.log(c.yellow(plan.summary));
    return 0;
  }
  const apply = Boolean(flags.yes);
  printDeletePlan(plan, apply);
  if (!apply) return 0;
  const removed = applyDelete(plan);
  console.log(c.green(`\nRemoved ${removed.length} target(s).`));
  return 0;
}

/** `vf workflow delete-unit <name>` — remove one unit; list names when not found. */
function workflowDeleteUnit(
  name: string | undefined,
  flags: Record<string, string | boolean>,
): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  if (!name?.trim()) {
    console.error(c.red("Usage: vf workflow delete-unit <name> [--repo <path>]"));
    return 2;
  }
  const state = deleteUnit(base, name);
  if (!state) {
    const existing = readState(base);
    console.error(c.red(`No such unit "${name}".`));
    const names = existing?.work_units.map((u) => u.name) ?? [];
    console.log(names.length ? `Available: ${names.join(", ")}` : c.dim("(no work units)"));
    return 1;
  }
  console.log(c.green(`Removed unit "${name}". ${state.work_units.length} remaining.`));
  return 0;
}

/** Print the outcome of a merge: added / renamed / conflicts / goal reconciliation. */
function printMergeResult(result: MergeResult): void {
  console.log(c.bold("Import plan\n"));
  console.log(`added: ${result.added.length ? result.added.join(", ") : "(none)"}`);
  for (const [from, to] of result.renamed) console.log(c.yellow(`renamed: ${from} → ${to}`));
  for (const conflict of result.conflicts) console.log(c.yellow(`conflict: ${conflict.detail}`));
  console.log(c.dim(result.goalReconciliation));
}

/** `vf workflow import <srcPath>` — merge another workflow; persist only with --yes. */
function workflowImport(src: string | undefined, flags: Record<string, string | boolean>): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  if (!src?.trim()) {
    console.error(
      c.red("Usage: vf workflow import <srcPath> [--on-collision rename|skip|replace] [--yes]"),
    );
    return 2;
  }
  const onNameCollision = resolveCollision(flags);
  const result = importWorkflow(base, src, { onNameCollision });
  if (!result) {
    console.error(c.red("Import failed: a workflow must exist in BOTH the source and this repo."));
    return 1;
  }
  printMergeResult(result);
  if (!flags.yes) {
    console.log(c.yellow("\nDry run. Re-run with --yes to persist the merged workflow."));
    return 0;
  }
  writeState(base, result.merged);
  console.log(c.green(`\nMerged: ${result.merged.work_units.length} total unit(s).`));
  return 0;
}

/** Resolve the collision policy flag, defaulting to "rename" (the safest non-destructive merge). */
function resolveCollision(flags: Record<string, string | boolean>): CollisionPolicy {
  const raw = flags["on-collision"];
  return raw === "skip" || raw === "replace" ? raw : "rename";
}

/**
 * `vf workflow` — manage a saved workflow. Subcommands: delete [--all] [--yes],
 * delete-unit <name>, import <srcPath> [--on-collision] [--yes]. Destructive paths are
 * dry by default and always print exactly what they will touch before --yes acts.
 */
export function workflow(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
): number {
  if (sub === "delete") return workflowDelete(flags);
  if (sub === "delete-unit") return workflowDeleteUnit(rest[0], flags);
  if (sub === "import") return workflowImport(rest[0], flags);
  console.error(c.red("Usage: vf workflow <delete|delete-unit|import> …"));
  return 2;
}

export function printHelp(): number {
  console.log(`${c.bold("VibeFlow")} v${VERSION} — orchestrate Claude Code, Codex & Copilot CLI

${c.bold("Usage:")} vf [command] [options]

${c.bold("Commands:")}
  ${c.cyan("(none)")}            open the local web UI
  ${c.cyan("ui")}                open the local web UI
  ${c.cyan("doctor")}            check required and optional tools (--probe for live engine readiness)
  ${c.cyan("init")}             generate canonical context + engine files (--engine, --interactive, --dry-run)
  ${c.cyan("run <engine>")}      dispatch claude | codex | copilot (--yes to launch)
  ${c.cyan("orchestrate")}       plan + dispatch work units in parallel, review, goal-eval (--engine, --yes, --concurrency)
  ${c.cyan("workflow [sub]")}    delete [--all] | delete-unit <name> | import <src> [--on-collision] (--yes to apply)
  ${c.cyan("units [sub]")}       status | show <name> | resources | evidence <name> | add <name> | update <name> [--status s] [--confidence n] | delete <name>
  ${c.cyan("skills [sub]")}      list | search <term> | resolve (demand-driven needs)
  ${c.cyan("tools [sub]")}       status | enable <tool> | disable <tool> | install <tool> (--yes)
  ${c.cyan("discover <kind>")}   docs|skills <query> via Context7 (--yes approves network)
  ${c.cyan("hook")}              evaluate a JSON hook event from stdin (allow/warn/require_approval/block)
  ${c.cyan("hooks [sub]")}       status | install | emit (write engine hook configs)
  ${c.cyan("verify")}            typecheck / lint / test + confidence / evidence / scope gates
  ${c.cyan("help, --version")}   show help / version

${c.dim("Run `vf <command> --help` for command-specific usage.")}
`);
  return 0;
}

/** Per-subcommand help blocks. Keys mirror the routing switch in cli.ts. Each entry is a short
 * usage/description/flags block; derived from the actual command implementations above. */
const COMMAND_HELP: Record<string, () => string> = {
  ui: () => `${c.bold("vf ui")} ${c.dim("[--port <n>] [--no-open]")}
Open the local web UI (intake wizard + workflow console). This is also the default
command when you run \`vf\` with no arguments.

${c.bold("Options:")}
  --port <n>    bind to a specific port (default: an ephemeral free port)
  --no-open     start the server without launching a browser

${c.bold("Examples:")}
  vf
  vf ui --port 4173 --no-open`,

  doctor: () => `${c.bold("vf doctor")} ${c.dim("[--probe]")}
Check required (node, git) and optional (bun, engine CLIs, docker) tools, plus
per-engine readiness.

${c.bold("Options:")}
  --probe       run a live engine round-trip instead of a presence/auth check

${c.bold("Examples:")}
  vf doctor
  vf doctor --probe`,

  init: () => `${c.bold("vf init")} ${c.dim("[--engine <claude|codex|copilot>] [--interactive] [--dry-run]")}
Generate the canonical context + engine instruction files and a workflow ledger.
By default a hard creation gate refuses when no engine is ready; --dry-run previews
offline (writes nothing).

${c.bold("Options:")}
  --engine <e>   generate for a single engine instead of all three
  --interactive  ask the intake questions in the terminal (TTY only)
  --dry-run      read-only preview — print what would be written, change nothing

${c.bold("Examples:")}
  vf init --engine claude
  vf init --dry-run`,

  run: () => `${c.bold("vf run")} ${c.dim("<claude|codex|copilot> [--yes]")}
Write the dispatch prompt for one engine. Without --yes it is a read-only dry run;
--yes launches the engine CLI behind the source-protection gate.

${c.bold("Options:")}
  --yes               launch the engine (otherwise dry-run only)
  --auto-wip          snapshot a dirty tree before launching instead of refusing
  --require-git       refuse to launch outside a git repo
  --rollback-on-fail  reset the tree to the pre-dispatch checkpoint on failure

${c.bold("Examples:")}
  vf run claude
  vf run codex --yes`,

  orchestrate:
    () => `${c.bold("vf orchestrate")} ${c.dim("[--engine <e>] [--yes] [--concurrency <n>] [--risk <class>]")}
Dispatch every saved work unit (bounded-parallel), run an independent reviewer,
record evidence, then evaluate the goal. Default mode is a read-only dry run.

${c.bold("Options:")}
  --engine <e>        target engine (default: claude)
  --yes               real run — launch the engine (otherwise dry preview)
  --concurrency <n>   max units dispatched in parallel
  --risk <class>      docs | simple-code | feature | architecture | security | deploy
  --auto-wip / --require-git / --rollback-on-fail   source-protection toggles

${c.bold("Examples:")}
  vf orchestrate
  vf orchestrate --engine codex --yes --concurrency 2`,

  workflow: () => `${c.bold("vf workflow")} ${c.dim("<delete | delete-unit | import> …")}
Manage a saved workflow. Destructive paths are dry by default and print exactly what
they will touch before --yes applies them.

${c.bold("Subcommands:")}
  delete [--all] [--yes]                          remove the workflow (or everything with --all)
  delete-unit <name> [--repo <path>]              remove a single work unit
  import <src> [--on-collision rename|skip|replace] [--yes]   merge another workflow

${c.bold("Examples:")}
  vf workflow delete
  vf workflow import ../other-repo --yes`,

  units:
    () => `${c.bold("vf units")} ${c.dim("[status | show <name> | resources | evidence <name> | add <name> | update <name> | delete <name>]")}
Inspect and mutate work units in the workflow ledger.

${c.bold("Subcommands:")}
  status                                  list every unit and its gates (default)
  show <name>                             print one unit as JSON
  resources                               totals: units / tokens / cost / wall-seconds
  evidence <name>                         list a unit's recorded evidence
  evidence <name> --add "<text>"          append an evidence record to a unit
  add <name>                              add a new (pending) unit
  update <name> [--status s] [--confidence n]   patch a unit
  delete <name>                           remove a unit

${c.bold("Examples:")}
  vf units status
  vf units update auth --status done --confidence 1`,

  skills: () => `${c.bold("vf skills")} ${c.dim("[list | search <term> | resolve]")}
Inspect locally discovered skills and demand-driven skill needs.

${c.bold("Subcommands:")}
  list             list discovered skills (default)
  search <term>    rank skills matching a task description
  resolve          report which skill needs are satisfied locally vs. on demand

${c.bold("Examples:")}
  vf skills list
  vf skills search "read a pdf"`,

  tools:
    () => `${c.bold("vf tools")} ${c.dim("[status | enable <tool> | disable <tool> | install <tool> [--yes]]")}
Manage the optional code-navigation tools (codegraph, lsp).

${c.bold("Subcommands:")}
  status                  show enabled/installed/priority for each tool (default)
  enable <tool>           enable a tool and wire its MCP config
  disable <tool>          disable a tool and remove its MCP config
  install <tool> [--yes]  print the install plan; --yes executes it

${c.dim("tool = codegraph | lsp")}

${c.bold("Examples:")}
  vf tools status
  vf tools enable codegraph`,

  discover: () => `${c.bold("vf discover")} ${c.dim("<docs|skills> <query> [--yes]")}
Look up external docs or skills via Context7. The network is only touched with
explicit approval.

${c.bold("Options:")}
  --yes         approve the network lookup (otherwise prints an approval prompt)

${c.bold("Examples:")}
  vf discover docs react --yes
  vf discover skills "pdf reader" --yes`,

  hook: () => `${c.bold("vf hook")} ${c.dim("[--selftest]")}
Read a JSON hook event from stdin, score its risk, and print a decision
(allow / warn / require_approval / block) with the matching exit code.

${c.bold("Options:")}
  --selftest    run the fixed attack+benign corpus and write an audit report

${c.bold("Examples:")}
  echo '{"tool":"Bash","input":"rm -rf /"}' | vf hook
  vf hook --selftest`,

  hooks: () => `${c.bold("vf hooks")} ${c.dim("[status | install | emit [--yes] [--dry-run]]")}
Manage git/engine hook wiring (all hooks delegate to \`vf hook\`).

${c.bold("Subcommands:")}
  status     show the configured core.hooksPath (default)
  install    point git core.hooksPath at .githooks
  emit       write per-engine hook config files into the repo
             (dry-run by default; pass --yes to actually write)

${c.bold("Examples:")}
  vf hooks status
  vf hooks install
  vf hooks emit           ${c.dim("# dry-run: show what would be written")}
  vf hooks emit --yes`,

  verify: () => `${c.bold("vf verify")}
Run the project's toolchain gates (typecheck / lint / test, auto-detected for
npm/Gradle/monorepo) plus the policy gates (confidence / evidence / scope) over the
workflow ledger. Returns nonzero if any gate fails.

${c.bold("Examples:")}
  vf verify`,
};

/** True when `cmd` is a known subcommand that carries its own help block. */
export function hasCommandHelp(cmd: string | undefined): boolean {
  return cmd !== undefined && cmd in COMMAND_HELP;
}

/** Print the help block for a single subcommand. Falls back to global help when unknown. */
export function printCommandHelp(cmd: string): number {
  const render = COMMAND_HELP[cmd];
  if (!render) return printHelp();
  console.log(render());
  return 0;
}
