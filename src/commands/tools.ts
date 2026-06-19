// `vf tools` cluster extracted from src/commands.ts (issue #80, phase 8/14).
// Pure byte-equivalent move: body preserved verbatim. Tools.ts is the final
// big chunk and currently overshoots the 400-line target (~516 lines) — see
// "tools.ts deviation" note in .vibeflow/plans/issue-80-split-commands.md.
// All imports come through `./_shared.js` per the ESM cycle rule (no sibling
// imports).
//
// Exported public surface (also re-exported by src/commands.ts facade):
//   - ToolchainPlan (type)
//   - detectToolchain
//   - verify
//   - StepSpawner (type, test seam)
//   - repoLanguages
//   - ensureToolIndex
//   - tools
//   - toolsSync
//
// Private helpers (file-scoped, not re-exported):
//   - VALID_TOOLS, isToolName, renderPriority, toolsStatus
//   - CLAUDE_MCP_FILE, CODEX_MCP_FILE, ClaudeMcpFile (interface)
//   - managedClaudeServerNames, readClaudeMcp, writeClaudeMcp
//   - tomlSection, gateCodexEntries, writeCodexMcp, printCopilotMcp
//   - writeToolConfigs, toolsToggle, runToolSteps, provisionTool, toolsInstall

import {
  TOOLS,
  appendJournal,
  c,
  cwd,
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  existsSync,
  hasCommand,
  join,
  out,
  policyGates,
  priorityRank,
  readFileSync,
  readSettings,
  readState,
  resolveTools,
  rmSync,
  scanRepo,
  settingsPath,
  spawnSync,
  writeFileSafe,
  writeSettings,
} from "./_shared.js";
import type {
  Engine,
  JsonMcpEntry,
  StdioServer,
  TomlMcpEntry,
  ToolName,
  ToolTier,
  VibeSettings,
} from "./_shared.js";

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

export function verify(inject: { spawner?: typeof spawnSync; journal?: boolean } = {}): number {
  let failed = 0;
  const base = cwd();
  // `vf verify` is a READ-ONLY gate by default (issue #154): it must not
  // mutate the tree it audits. The journal append is opt-in via
  // `journal: true` (wired to a `--journal` flag) so the default invocation
  // an agent is told to run before "claiming done" leaves git status clean.
  const writeJournal = inject.journal === true;
  const runGate = (label: string, cmd: string, args: string[], dir = base) => {
    out("vf", c.cyan(`▶ ${label}`));
    // Test seam: tests inject a fake spawner to avoid the 28s
    // gradle download on CI. Production callers fall through to
    // the real spawnSync.
    const r = (inject.spawner ?? spawnSync)(cmd, args, { stdio: "inherit", cwd: dir });
    if (r.status !== 0) {
      failed++;
      out("vf", c.red(`✗ ${label} failed`));
    } else {
      out("vf", c.green(`✓ ${label}`));
    }
  };

  // Toolchain gates — detect the project's build system instead of assuming npm.
  const plan = detectToolchain(base);
  if (plan.kind === "npm") {
    for (const gate of plan.gates)
      runGate(`${plan.runner} run ${gate}`, plan.runner, ["run", gate]);
    if (plan.gates.length === 0)
      out("vf", c.dim("package.json has no typecheck/lint/test scripts."));
  } else if (plan.kind === "gradle") {
    runGate(`${plan.cmd} check`, plan.cmd, ["check"]);
  } else if (plan.kind === "monorepo") {
    const label = plan.dir.split("/").pop();
    for (const gate of plan.gates)
      runGate(`(${label}) ${plan.runner} run ${gate}`, plan.runner, ["run", gate], plan.dir);
  } else {
    out(
      "vf",
      c.yellow(
        "⚠ no package.json or Gradle build found — skipping toolchain gates (unsupported build system)",
      ),
    );
  }

  // Policy gates (confidence / evidence / scope) over the workflow ledger.
  const report = policyGates(readState());
  for (const ok of report.passed) out("vf", c.green(`✓ ${ok}`));
  for (const w of report.warnings) out("vf", c.yellow(`⚠ ${w}`));
  for (const f of report.failures) {
    failed++;
    out("vf", c.red(`✗ ${f}`));
  }

  // e2e advisory gates — non-fatal warnings only.
  for (const w of e2eUnicodeSelectorWarning(base)) out("vf", c.yellow(`⚠ ${w}`));
  for (const w of e2eEvaluateDynamicImportWarning(base)) out("vf", c.yellow(`⚠ ${w}`));

  if (failed > 0) {
    out("vf", c.red(`\n${failed} gate(s) failed.`));
    if (writeJournal) {
      appendJournal(base, "verify", "fail", [
        `${failed} gate(s) failed`,
        ...report.failures.map((f) => `- ${f}`),
      ]);
    }
    return 1;
  }
  out("vf", c.green("\nAll configured gates passed."));
  if (writeJournal) {
    appendJournal(base, "verify", "pass", [
      `${report.passed.length} gate(s) passed`,
      ...(report.warnings.length ? [`${report.warnings.length} warning(s)`] : []),
    ]);
  }
  return 0;
}

/** Spawn seam for tool installs — defaults to a real spawnSync, injectable for tests. */
export type StepSpawner = (cmd: string, args: string[]) => { status: number };
const VALID_TOOLS: ToolName[] = ["codegraph", "lsp"];

function isToolName(v: string | undefined): v is ToolName {
  return v === "codegraph" || v === "lsp";
}

/** Languages detected in the active repo, used to build LSP install plans + entries. */
// Test seam: exported so unit tests can exercise the try/catch fallback
// (line 2293-2294) by injecting a throwing scanRepo.
export function repoLanguages(
  base: string,
  inject: { scanRepo?: (b: string) => { languages: string[] } } = {},
): string[] {
  const scan = inject.scanRepo ?? scanRepo;
  try {
    return scan(base).languages;
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

/** `vf tools status` — show enabled/installed/priority for each optional tool.
 * The optional `probeFn` parameter is a test seam: when provided it replaces the
 * default `probeIndexHealth` so unit tests can drive the "unhealthy" branch
 * without a real codegraph binary. */
export function toolsStatus(
  base: string,
  detectFn?: (name: ToolName) => boolean,
  probeFn?: (
    name: ToolName,
    base: string,
    healthy: (
      base: string,
      spawner: (cmd: string, args: string[]) => { status: number },
    ) => boolean,
  ) => true | false | "unhealthy" | null,
): number {
  const settings = readSettings(base);
  const languages = repoLanguages(base);
  out("vf", c.bold("Optional developer tools\n"));
  for (const name of VALID_TOOLS) {
    const tool = TOOLS[name];
    const enabled = settings.tools[name];
    const installed = (detectFn ?? tool.detect.bind(tool))(name);
    const en = enabled ? c.green("enabled") : c.dim("disabled");
    const inst = installed ? c.green("installed") : c.yellow("not installed");
    let tag = `[${en}, ${inst}`;
    if (tool.indexPresent) {
      const present = tool.indexPresent;
      const healthy = tool.indexHealthy ?? ((b: string) => present(b));
      const probed = installed ? (probeFn ?? probeIndexHealth)(name, base, healthy) : null;
      if (probed === true) tag += `, ${c.green("indexed")}`;
      else if (probed === "unhealthy") tag += `, ${c.red("index unhealthy")}`;
      else if (probed === false) tag += `, ${c.yellow("not indexed")}`;
    }
    tag += "]";
    out("vf", `  ${c.bold(tool.title)} ${tag}`);
    out("vf", `    ${c.dim(tool.description)}`);
    if (enabled && !installed) {
      out(
        "vf",
        c.yellow(
          `    ! enabled but binary not on PATH — MCP server won't start. Run \`vf tools install ${name}\`.`,
        ),
      );
    } else if (enabled && installed && tool.indexPresent) {
      const present = tool.indexPresent;
      const healthy = tool.indexHealthy ?? ((b: string) => present(b));
      const probed = (probeFn ?? probeIndexHealth)(name, base, healthy);
      if (probed === false) {
        out(
          "vf",
          c.yellow(
            `    ! enabled but index missing — MCP server will announce inactive. Run \`vf tools enable ${name} --yes\` to build it.`,
          ),
        );
      } else if (probed === "unhealthy") {
        out(
          "vf",
          c.yellow(
            `    ! enabled but index reports unhealthy (mismatched/corrupt db). Run \`vf tools enable ${name} --yes\` to rebuild.`,
          ),
        );
      }
    }
  }
  out("vf", `\n  priority: ${c.cyan(renderPriority(settings))}`);
  if (languages.length) out("vf", `  detected languages: ${c.dim(languages.join(", "))}`);
  out("vf", c.dim("\n  Re-run `vf init` after changing tools to regenerate instructions."));
  return 0;
}

/** Run a tool's optional `indexHealthy` check with a short-lived spawner that captures
 * stdout. Returns `true` (healthy), `false` (marker missing), `"unhealthy"` (marker
 * present but tool reports it unusable), or `null` (tool has no health check).
 * Exported for direct unit-test coverage of the PR129 probeIndexHealth path
 * (issue #80 rebase; previously a private function). The `deps.capture` parameter
 * is an optional test seam that overrides the internal spawner. */
export function probeIndexHealth(
  _name: ToolName,
  base: string,
  healthy: (base: string, spawner: (cmd: string, args: string[]) => { status: number }) => boolean,
  deps: {
    capture?: (cmd: string, args: string[]) => { status: number };
  } = {},
): true | false | "unhealthy" | null {
  const tool = TOOLS[_name];
  if (!tool.indexPresent) return null;
  const present = tool.indexPresent(base);
  if (!present) return false;
  let captured = "";
  type CaptureResult = { status: number; stdout?: string };
  const defaultCapture = (cmd: string, args: string[]): CaptureResult => {
    try {
      const proc = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      captured = proc.stdout ?? "";
      return { status: proc.status ?? 1, stdout: captured };
    } catch {
      captured = "";
      return { status: 1, stdout: "" };
    }
  };
  // Test seam: when `deps.capture` is provided, use it instead of the
  // real `spawnSync` and use the optional `stdout` field on its result
  // to populate the `captured` closure variable (the same contract the
  // default capture honors).
  type CaptureInput = (cmd: string, args: string[]) => { status: number; stdout?: string };
  const capture: (cmd: string, args: string[]) => { status: number } = deps.capture
    ? (cmd, args) => {
        const r: { status: number; stdout?: string } = (deps.capture as CaptureInput)(cmd, args);
        captured = r.stdout ?? "";
        return { status: r.status };
      }
    : defaultCapture;
  const ok = healthy(base, capture);
  if (ok) return true;
  // marker present but health check said no — distinguish "we couldn't verify" (no
  // health check ran) from "the tool itself reported unhealthy".
  return captured ? "unhealthy" : false;
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
    out(
      "vf",
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
  out("vf", c.bold("\nCopilot (run these — VibeFlow won't touch your secret ~/.copilot):"));
  let count = 0;
  for (const entry of merged.entries) {
    for (const [name, server] of Object.entries((entry as JsonMcpEntry).servers)) {
      const args = server.args.map((a) => JSON.stringify(a)).join(" ");
      out("vf", c.cyan(`  copilot mcp add ${name} -- ${server.command} ${args}`.trim()));
      count++;
    }
  }
  return count;
}

/**
 * Wire enabled tools into selected engines' MCP configs: write `.mcp.json` for claude and
 * copilot (both read the workspace-level file), `.codex/config.toml` for codex, and print
 * `copilot mcp add` commands for copilot's global config.
 * When `engines` is provided, only configs for those engines are written.
 * Pure tool modules build the entries; the WRITING lives here. Languages drive LSP entries.
 * Exported (not just used internally) because `vf init`'s SETTINGS ↔ MCP-config lockstep
 * needs to call it from src/commands.ts (see syncToolConfigs closure at line ~388).
 */
export function writeToolConfigs(
  base: string,
  settings: VibeSettings,
  engines?: readonly Engine[],
): void {
  const languages = repoLanguages(base);
  const needsMcpJson = !engines || engines.includes("claude") || engines.includes("copilot");
  if (needsMcpJson) writeClaudeMcp(base, settings, languages);
  if (!engines || engines.includes("codex")) writeCodexMcp(base, settings, languages);
  if (!engines || engines.includes("copilot")) printCopilotMcp(base, settings, languages);
}

/** `vf tools enable|disable <tool>` — flip the flag in SETTINGS.json and report. When enabling
 * with `--yes`, also PROVISION the tool (install the binary if missing, build the index if
 * absent) and report honest readiness, instead of only warning about a missing binary. */
function toolsToggle(
  base: string,
  name: ToolName,
  on: boolean,
  opts: { approved?: boolean; spawner?: StepSpawner; detect?: (name: ToolName) => boolean } = {},
): number {
  const settings = writeSettings(base, { tools: { ...readSettings(base).tools, [name]: on } });
  const word = on ? c.green("enabled") : c.yellow("disabled");
  out("vf", `${word} ${c.bold(TOOLS[name].title)} in ${settingsPath(base)}`);
  writeToolConfigs(base, settings);
  out("vf", `  wrote MCP config to ${join(base, CLAUDE_MCP_FILE)}`);
  if (on && !(opts.detect ?? TOOLS[name].detect.bind(TOOLS[name]))(name)) {
    // Enabling writes .mcp.json pointing at the tool's binary — but if that binary isn't on
    // PATH the MCP server can't start and dispatched engines silently get no navigation.
    if (opts.approved && opts.spawner) {
      const rc = provisionTool(base, name, opts.spawner);
      if (rc !== 0) {
        out(
          "vf",
          c.yellow(
            `  note: ${name} stays enabled in ${settingsPath(base)} but is NOT provisioned — re-run \`vf tools enable ${name} --yes\` after fixing the failure, or \`vf tools disable ${name}\`.`,
          ),
          {
            level: "error",
          },
        );
        return rc;
      }
    } else {
      out(
        "vf",
        c.yellow(
          `  ! ${TOOLS[name].title} binary not found on PATH — the MCP server will not start until it is installed.`,
        ),
      );
      out(
        "vf",
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
  out(
    "vf",
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
    out("vf", c.cyan(`\n▶ ${step.cmd} ${step.args.join(" ")}`));
    const { status } = spawner(step.cmd, step.args);
    if (status !== 0) {
      out("vf", c.red(`✗ step failed (${status}).`), {
        level: "error",
      });
      return false;
    }
  }
  return true;
}

/** Install a tool (its full install plan) then build its per-repo index if it has one.
 * Generic: reads installPlan/indexPlan off the registry descriptor. Returns an exit code.
 * Exported so the `init` flow in src/commands.ts can auto-provision codegraph
 * (issue #80 rebase; previously a private helper). */
export function provisionTool(base: string, name: ToolName, spawner: StepSpawner): number {
  const tool = TOOLS[name];
  const ctx = { workspace: base, languages: repoLanguages(base) };
  if (!runToolSteps(tool.installPlan(ctx).steps, spawner)) {
    out("vf", c.red(`  ${tool.title} is enabled but not provisioned.`), {
      level: "error",
    });
    return 1;
  }
  out("vf", c.green(`  ✓ ${tool.title} installed.`));
  return 0;
}

/** Build a tool's per-repo artifact only when its descriptor reports it absent. Tools with no
 * per-repo artifact (no indexPresent/indexPlan) are no-ops. Exported for direct testing. */
export function ensureToolIndex(base: string, name: ToolName, spawner: StepSpawner): number {
  const tool = TOOLS[name];
  if (!tool.indexPlan || !tool.indexPresent) return 0;
  if (tool.indexPresent(base)) {
    out("vf", c.dim(`  ${tool.title} index present.`));
    return 0;
  }
  const ctx = { workspace: base, languages: repoLanguages(base) };
  if (!runToolSteps(tool.indexPlan(ctx).steps, spawner)) return 1;
  out("vf", c.green(`  ✓ built ${tool.title} index.`));
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
  out("vf", c.bold(`Install plan for ${TOOLS[name].title}:`));
  for (const step of plan.steps) {
    out("vf", `  ${c.cyan(`${step.cmd} ${step.args.join(" ")}`)}\n    ${c.dim(step.description)}`);
  }
  if (!approved) {
    out("vf", c.yellow("\nNo changes made. Re-run with --yes to execute the plan."));
    return 0;
  }
  for (const step of plan.steps) {
    out("vf", c.cyan(`\n▶ ${step.cmd} ${step.args.join(" ")}`));
    const { status } = spawner(step.cmd, step.args);
    if (status !== 0) {
      out("vf", c.red(`✗ step failed (${status}). Stopping.`), {
        level: "error",
      });
      return 1;
    }
  }
  out(
    "vf",
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
  inject: { spawner?: StepSpawner; base?: string; detect?: (name: ToolName) => boolean } = {},
): number {
  const base = inject.base ?? cwd();
  if (sub === undefined || sub === "status") return toolsStatus(base, inject.detect);
  const name = rest[0];
  if ((sub === "enable" || sub === "disable" || sub === "install") && !isToolName(name)) {
    out("vf", c.red(`Usage: vf tools ${sub} <${VALID_TOOLS.join("|")}>`), {
      level: "error",
    });
    return 2;
  }
  const spawner: StepSpawner =
    inject.spawner ??
    ((cmd, args) => ({ status: spawnSync(cmd, args, { stdio: "inherit" }).status ?? 0 }));
  if (sub === "enable")
    return toolsToggle(base, name as ToolName, true, {
      approved: Boolean(flags.yes),
      spawner,
      detect: inject.detect,
    });
  if (sub === "disable")
    return toolsToggle(base, name as ToolName, false, { detect: inject.detect });
  if (sub === "install") {
    return toolsInstall(base, name as ToolName, Boolean(flags.yes), spawner);
  }
  if (sub === "sync") return toolsSync(base, spawner);
  out("vf", c.red(`Unknown: vf tools ${sub}`), {
    level: "error",
  });
  return 2;
}

/** `vf tools sync` — re-index every enabled tool whose binary is present and that has a
 * per-repo index. Called by the post-checkout/post-merge git hooks so a code graph never
 * goes stale across branch switches. A no-op (exit 0) when nothing is enabled/installed, so
 * it's safe to wire as a best-effort hook. Always rebuilds (the index is branch-specific). */
export function toolsSync(
  base: string,
  spawner: StepSpawner,
  inject: { detect?: (name: ToolName) => boolean } = {},
): number {
  const settings = readSettings(base);
  const detect = inject.detect ?? ((name: ToolName) => TOOLS[name].detect());
  let synced = 0;
  for (const name of VALID_TOOLS) {
    const tool = TOOLS[name];
    if (!settings.tools[name]) continue; // not enabled
    if (!tool.indexPlan || !tool.indexPresent) continue; // no per-repo index (e.g. lsp)
    if (!detect(name)) continue; // binary not installed — nothing to run
    out("vf", c.cyan(`▶ re-indexing ${tool.title}`));
    if (!runToolSteps(tool.indexPlan({ workspace: base, languages: [] }).steps, spawner)) {
      out("vf", c.red(`✗ ${tool.title} re-index failed.`), {
        level: "error",
      });
      return 1;
    }
    synced++;
  }
  out("vf", synced ? c.green(`✓ synced ${synced} tool index(es).`) : c.dim("nothing to sync."));
  return 0;
}
