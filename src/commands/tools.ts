// `vf tools` cluster extracted from src/commands.ts (issue #80, phase 8/14).
// Split into three modules (issue #136): tools.ts holds the main CLI logic;
// tools-detect.ts holds engine detection; tools-mcp-config.ts holds MCP I/O.
// All imports come through `./_shared.js` per the ESM cycle rule (no sibling
// imports except the two extracted modules).
//
// Exported public surface (also re-exported by src/commands.ts facade):
//   - StepSpawner (type, test seam)
//   - toolsStatus
//   - probeIndexHealth
//   - provisionTool
//   - ensureToolIndex
//   - tools
//   - toolsSync
//
// Private helpers (file-scoped, not re-exported):
//   - VALID_TOOLS, isToolName, renderPriority
//   - toolsToggle, runToolSteps, toolsInstall

import {
  TOOLS,
  c,
  cwd,
  join,
  out,
  priorityRank,
  readSettings,
  settingsPath,
  spawnSync,
  writeSettings,
} from "./_shared.js";
import type { ToolName, ToolTier, VibeSettings } from "./_shared.js";
import { CLAUDE_MCP_FILE, repoLanguages, writeToolConfigs } from "./tools-mcp-config.js";

/** Spawn seam for tool installs — defaults to a real spawnSync, injectable for tests. */
export type StepSpawner = (cmd: string, args: string[]) => { status: number };
export const VALID_TOOLS: ToolName[] = ["codegraph", "lsp"];

function isToolName(v: string | undefined): v is ToolName {
  return v === "codegraph" || v === "lsp";
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
  out("vf", c.bold("Optional developer tools"));
  out("vf");
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
  out("vf");
  out("vf", `  priority: ${c.cyan(renderPriority(settings))}`);
  if (languages.length) out("vf", `  detected languages: ${c.dim(languages.join(", "))}`);
  out("vf");
  out("vf", c.dim("  Re-run `vf init` after changing tools to regenerate instructions."));
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
