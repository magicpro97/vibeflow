import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ProjectContext, UnitBrief } from "./adapters.js";
import { dispatchPrompt } from "./adapters.js";
import { type Engine, hasCommand, writeFileSafe } from "./core.js";

/** Structured summary an engine is asked to emit at the end of a dispatch. */
export interface EngineSummary {
  skills_used?: string[];
  files_changed?: string[];
  commands_run?: string[];
  tests_run?: string[];
  confidence?: number;
  uncertainty?: string;
}

export interface DispatchResult {
  engine: Engine;
  mode: "bridge" | "cli" | "dry";
  ok: boolean;
  raw: string;
  summary?: EngineSummary;
  reason?: string;
  /** Non-fatal advisory (e.g. an unverifiable Copilot CLI version). */
  warning?: string;
}

export type Spawner = (
  cmd: string,
  args: string[],
  input: string,
) => { status: number; stdout: string };

/** Async spawn seam: genuinely overlapping process launches for the parallel path. */
export type AsyncSpawner = (
  cmd: string,
  args: string[],
  input: string,
) => Promise<{ status: number; stdout: string; timedOut?: boolean }>;

function defaultSpawner(cmd: string, args: string[], input: string) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** Exit status surfaced when a hung engine is force-killed by the timeout (matches GNU timeout). */
const TIMEOUT_STATUS = 124;
/** Default grace between SIGTERM and the hard SIGKILL when a process group ignores the term. */
const DEFAULT_GRACE_MS = 3000;

interface AsyncResult {
  status: number;
  stdout: string;
  timedOut?: boolean;
}

/**
 * Build an async spawner using node child_process.spawn (no shell). Unlike spawnSync it does
 * NOT block the event loop, so multiple lanes truly overlap under the parallel runner. The
 * prompt is written to stdin so we never interpolate it into a shell string.
 *
 * When `timeoutMs` is set, the child is spawned `detached:true` so it becomes its own process
 * group leader; on timeout we kill the WHOLE group (`process.kill(-pid, …)`) with SIGTERM, then
 * SIGKILL after `graceMs`, so the engine's own tool-subprocesses die too rather than orphaning.
 * (Verified under Bun: node child_process detached + negative-pid kill group-kills correctly;
 * `Bun.spawn` does not form a group, hence we stay on node child_process.) `timedOut` is surfaced
 * explicitly rather than inferred from the 124 status. With no `timeoutMs` no timer is ever armed.
 */
export function makeAsyncSpawner(
  opts: { timeoutMs?: number; graceMs?: number; shell?: boolean } = {},
): AsyncSpawner {
  const { timeoutMs, graceMs = DEFAULT_GRACE_MS, shell = false } = opts;
  return (cmd, args, input) =>
    new Promise<AsyncResult>((resolve) => {
      const child = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "inherit"],
        detached: timeoutMs != null,
        shell,
      });
      let stdout = "";
      let timedOut = false;
      let term: ReturnType<typeof setTimeout> | undefined;
      let kill: ReturnType<typeof setTimeout> | undefined;
      const clear = () => {
        if (term) clearTimeout(term);
        if (kill) clearTimeout(kill);
      };
      const killGroup = (signal: "SIGTERM" | "SIGKILL") => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          /* group already gone */
        }
      };
      if (timeoutMs != null) {
        term = setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          kill = setTimeout(() => killGroup("SIGKILL"), graceMs);
          kill.unref();
        }, timeoutMs);
        term.unref();
      }
      child.stdout.on("data", (d) => {
        stdout += String(d);
      });
      child.on("error", () => {
        clear();
        resolve({ status: 1, stdout, timedOut: false });
      });
      child.on("close", (code) => {
        clear();
        resolve({ status: timedOut ? TIMEOUT_STATUS : (code ?? 1), stdout, timedOut });
      });
      child.stdin.end(input);
    });
}

/** Default async spawner — {@link makeAsyncSpawner} with no timeout (behavior unchanged). */
const defaultAsyncSpawner: AsyncSpawner = makeAsyncSpawner();

/** Probe seam so engine-availability / version checks are injectable in tests. */
export interface EngineProbe {
  has?: (cmd: string) => boolean;
  version?: (cmd: string) => string | undefined;
}

export interface EngineInvocation {
  cmd: string;
  args: string[];
  /** Non-fatal advisory surfaced to the caller (does not block dispatch). */
  warning?: string;
}

export interface EngineUnavailable {
  unavailable: string;
}

export type EngineCommandResult = EngineInvocation | EngineUnavailable;

export function isUnavailable(r: EngineCommandResult): r is EngineUnavailable {
  return "unavailable" in r;
}

/** Best-effort read of `copilot --version` (lightweight; used only for the version guard). */
function copilotVersion(cmd = "copilot"): string | undefined {
  try {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout?.trim()) return r.stdout.trim();
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

/**
 * Headless invocation per engine (verified against current CLI docs):
 *   claude  -> claude -p --output-format json   (print mode, JSON envelope on stdout)
 *   codex   -> codex exec -                      (non-interactive, `-` reads prompt from stdin)
 *   copilot -> copilot -p                        (non-interactive prompt)
 * The prompt is always provided on stdin so we never hit argv length limits or shell-inject.
 * `gh -p` is NOT a valid fallback (gh has no global -p flag) so copilot resolves to an explicit
 * unavailability when the binary is absent rather than a bogus command.
 */
export function engineCommand(engine: Engine, probe: EngineProbe = {}): EngineCommandResult {
  switch (engine) {
    case "claude":
      return { cmd: "claude", args: ["-p", "--output-format", "json"] };
    case "codex":
      return { cmd: "codex", args: ["exec", "-"] };
    case "copilot": {
      const has = probe.has ?? hasCommand;
      if (!has("copilot")) {
        return {
          unavailable: "copilot CLI not found — install GitHub Copilot CLI then re-run",
        };
      }
      // Version guard: the Copilot CLI has a history of silent breaking auto-updates
      // (github/copilot-cli#1606 removed `--headless --stdio`). If we cannot determine the
      // version we proceed but surface a warning so the caller can message the user.
      const version = (probe.version ?? copilotVersion)("copilot");
      const warning = version
        ? undefined
        : "could not determine `copilot --version`; verify `copilot -p` still works (github/copilot-cli#1606)";
      // `--allow-all-tools` is REQUIRED for non-interactive `-p` mode; without it the CLI
      // blocks waiting for per-tool approval that never comes (verified against copilot docs).
      return { cmd: "copilot", args: ["-p", "--allow-all-tools"], warning };
    }
  }
}

/** Build the dispatch prompt and append the required JSON-summary contract. */
export function buildEnginePrompt(engine: Engine, ctx: ProjectContext, units: UnitBrief[]): string {
  return [
    dispatchPrompt(engine, ctx, units),
    "When finished, emit a single fenced JSON block as the LAST thing you output:",
    "```json",
    '{ "skills_used": [], "files_changed": [], "commands_run": [], "tests_run": [], "confidence": 0.0, "uncertainty": "" }',
    "```",
    "",
  ].join("\n");
}

/** Scan a string for balanced top-level `{...}` objects (string-aware so nested braces work). */
function extractJsonObjects(s: string): string[] {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objs.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objs;
}

/** Coerce a parsed JSON value into an EngineSummary, unwrapping the claude JSON envelope. */
function asSummary(parsed: unknown): EngineSummary | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  // claude -p --output-format json wraps free-form text in `.result`; the VibeFlow summary
  // is emitted inside that text, so recurse into it first.
  if (typeof obj.result === "string") {
    const inner = parseEngineSummary(obj.result);
    if (inner) return inner;
  }
  // `--json-schema` forces a structured object into `.structured_output`.
  if (obj.structured_output && typeof obj.structured_output === "object") {
    return obj.structured_output as EngineSummary;
  }
  if (obj.result && typeof obj.result === "object") return obj.result as EngineSummary;
  return obj as EngineSummary;
}

function tryParseSummary(block: string): EngineSummary | undefined {
  try {
    return asSummary(JSON.parse(block.trim()));
  } catch {
    return undefined;
  }
}

/**
 * Extract the engine summary from stdout, robust to three shapes (last valid wins):
 *  (a) a fenced ```json block, (b) the claude `--output-format json` envelope (`.result` /
 *  `.structured_output`), (c) a bare object. Uses balanced-brace scanning so nested objects
 *  parse correctly (the old `lastIndexOf("{")` slice broke on `{"a":{"b":1}}`).
 */
export function parseEngineSummary(stdout: string): EngineSummary | undefined {
  if (!stdout) return undefined;
  const fences = [...stdout.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const block of fences.reverse()) {
    const s = tryParseSummary(block);
    if (s) return s;
  }
  for (const block of extractJsonObjects(stdout).reverse()) {
    const s = tryParseSummary(block);
    if (s) return s;
  }
  return undefined;
}

interface DispatchOpts {
  engine: Engine;
  prompt: string;
  mode: "bridge" | "cli" | "dry";
  bridgeCmd?: string;
  /** Injectable PATH-presence probe so tests can force absent without spawning a real engine. */
  has?: (cmd: string) => boolean;
}

/** Resolve the CLI command for an engine, honouring an injected spawner (test mode). */
function resolveCli(
  engine: Engine,
  hasSpawner: boolean,
  has: (cmd: string) => boolean = hasCommand,
): { ok: true; cmd: string; args: string[]; warning?: string } | { ok: false; reason: string } {
  // With an injected spawner we never touch the real PATH, so treat the engine as present.
  const invocation = engineCommand(engine, hasSpawner ? { has: () => true } : { has });
  if (isUnavailable(invocation)) return { ok: false, reason: invocation.unavailable };
  if (!hasSpawner && !has(invocation.cmd)) {
    return { ok: false, reason: `${invocation.cmd} CLI not found` };
  }
  return { ok: true, cmd: invocation.cmd, args: invocation.args, warning: invocation.warning };
}

function bridgeCommand(opts: DispatchOpts): string | undefined {
  return opts.bridgeCmd ?? process.env.VIBEFLOW_AI;
}

function buildResult(
  opts: DispatchOpts,
  r: { status: number; stdout: string; timedOut?: boolean },
  failReason: string,
  warning?: string,
): DispatchResult {
  const ok = r.status === 0;
  return {
    engine: opts.engine,
    mode: opts.mode,
    ok,
    raw: r.stdout,
    summary: parseEngineSummary(r.stdout),
    reason: ok ? undefined : r.timedOut ? "timeout" : failReason,
    warning,
  };
}

/**
 * Dispatch a prompt to an engine (synchronous).
 *  - mode "bridge": pipe to $VIBEFLOW_AI (default, engine-agnostic, offline-friendly)
 *  - mode "cli":    shell out to the real engine CLI (opt-in)
 *  - mode "dry":    write the prompt only; run nothing
 */
export function runDispatch(opts: DispatchOpts & { spawner?: Spawner }): DispatchResult {
  const { engine, prompt, mode } = opts;
  const spawn = opts.spawner ?? defaultSpawner;
  if (mode === "dry") return { engine, mode, ok: true, raw: "" };
  if (mode === "bridge") {
    const cmd = bridgeCommand(opts);
    if (!cmd) return { engine, mode, ok: false, raw: "", reason: "VIBEFLOW_AI is not set" };
    // VIBEFLOW_AI is a shell command string (may include args) — spawn via shell unless a
    // test injected its own spawner.
    const bridgeSpawn =
      opts.spawner ??
      ((c: string, a: string[], input: string) => {
        const r = spawnSync(c, a, { input, encoding: "utf8", shell: true });
        return { status: r.status ?? 1, stdout: r.stdout ?? "" };
      });
    return buildResult(opts, bridgeSpawn(cmd, [], prompt), "bridge command failed");
  }
  const cli = resolveCli(engine, Boolean(opts.spawner), opts.has);
  if (!cli.ok) return { engine, mode, ok: false, raw: "", reason: cli.reason };
  return buildResult(opts, spawn(cli.cmd, cli.args, prompt), `${cli.cmd} failed`, cli.warning);
}

/**
 * Async variant of {@link runDispatch} for the parallel path: uses a non-blocking spawn so
 * lanes genuinely overlap under {@link runParallel} (spawnSync would serialize them). The
 * injectable {@link AsyncSpawner} keeps it testable without launching real engines.
 */
export async function runDispatchAsync(
  opts: DispatchOpts & { spawner?: AsyncSpawner },
): Promise<DispatchResult> {
  const { engine, prompt, mode } = opts;
  const spawn = opts.spawner ?? defaultAsyncSpawner;
  if (mode === "dry") return { engine, mode, ok: true, raw: "" };
  if (mode === "bridge") {
    const cmd = bridgeCommand(opts);
    if (!cmd) return { engine, mode, ok: false, raw: "", reason: "VIBEFLOW_AI is not set" };
    // VIBEFLOW_AI is a shell command string (may include args), consistent with aiGenerate's
    // shell:true spawn. Use a shell-aware spawner unless a test injected its own.
    const bridgeSpawn = opts.spawner ?? makeAsyncSpawner({ shell: true });
    return buildResult(opts, await bridgeSpawn(cmd, [], prompt), "bridge command failed");
  }
  const cli = resolveCli(engine, Boolean(opts.spawner), opts.has);
  if (!cli.ok) return { engine, mode, ok: false, raw: "", reason: cli.reason };
  return buildResult(
    opts,
    await spawn(cli.cmd, cli.args, prompt),
    `${cli.cmd} failed`,
    cli.warning,
  );
}

/** Persist a dispatch result as evidence inside a work unit's `evidence/` folder. */
export function persistDispatch(unitDir: string, result: DispatchResult): string {
  const rel = `evidence/${result.engine}.result.json`;
  writeFileSafe(join(unitDir, rel), JSON.stringify(result, null, 2));
  return rel;
}
