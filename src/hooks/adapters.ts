/**
 * Hook adapters: project the single VibeFlow hook protocol onto each engine's native
 * hook configuration. Every generated config delegates to one entrypoint — `vf hook` —
 * which reads a JSON event on stdin and returns an allow/warn/require_approval/block
 * decision (see hooks/runner.ts). One source of truth, four engines + git.
 *
 * Enforcement honesty: Claude Code (PreToolUse), GitHub Copilot CLI (preToolUse),
 * AND opencode (`tool.execute.before` plugin that throws to block) all expose a
 * native pre-action vetoing hook for ALL tool calls. Codex CLI's PreToolUse fires
 * for the Bash/shell tool only — we wire it as NATIVE-BASH-ONLY and surface a
 * downgrade banner noting that Edit/Write/apply_patch are not natively blocked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../core.js";
import { antigravityHookConfig } from "./antigravity.js";
import { cliPath, gitPostCheckout, gitPostMerge, gitPreCommit, gitPrePush } from "./git-hooks.js";

export { cliPath, gitPostCheckout, gitPostMerge, gitPreCommit, gitPrePush } from "./git-hooks.js";

/** Stable marker the generator emits in the opencode plugin so the live-
 *  guardrail probe can distinguish generator output from a hand-rolled file
 *  that happens to mention `vf hook`. Kept in sync with `src/commands/doctor.ts`. */
const GUARDRAIL_SENTINEL = "vibeflow-guardrail";

/** Prefer Bun; safe under Node; injectable for tests. */
export function hookRuntime(which?: (name: string) => string | null): "bun" | "node" {
  const lookup = which ?? (typeof Bun === "undefined" ? () => null : Bun.which);
  try {
    return lookup("bun") ? "bun" : "node";
  } catch {
    return "node";
  }
}

/** Detect a generated opencode plugin whose hard-coded CLI path is stale. */
export function opencodePluginStale(
  base: string,
): { stale: boolean; expected: string; actual: string | null } | null {
  const pluginPath = join(base, ".opencode", "plugins", "vf-guard.ts");
  let raw: string;
  try {
    raw = readFileSync(pluginPath, "utf8");
  } catch {
    return null;
  }
  if (!raw.includes(GUARDRAIL_SENTINEL)) return null;
  // Extract the absolute path from `const VF_CLI = "...";`
  const match = /const\s+VF_CLI\s*=\s*"([^"]+)"/.exec(raw);
  if (!match || !match[1]) {
    // Plugin is malformed — count as stale with a clear signal.
    return { stale: true, expected: cliPath(), actual: null };
  }
  const expected = cliPath();
  const actual = JSON.parse(`"${match[1]}"`) as string;
  return { stale: actual !== expected, expected, actual };
}

/** Whether an engine can veto an action before it runs, or only detect after the fact. */
export interface EngineEnforcementCapability {
  preActionBlocking: "native" | "native-bash-only" | "post-hoc-only";
}

const ENFORCEMENT: Record<Engine, EngineEnforcementCapability> = {
  claude: { preActionBlocking: "native" },
  codex: { preActionBlocking: "native-bash-only" },
  copilot: { preActionBlocking: "native" },
  // opencode exposes a plugin system with `tool.execute.before` that can
  // throw to block a tool call before it runs — semantically equivalent to
  // Claude Code's PreToolUse and Copilot CLI's preToolUse.
  opencode: { preActionBlocking: "native" },
  antigravity: { preActionBlocking: "post-hoc-only" },
};

/** Report whether an engine enforces guardrails natively or post-hoc only. */
export function engineEnforcement(engine: Engine): EngineEnforcementCapability {
  return ENFORCEMENT[engine];
}

/**
 * Reusable warning shown when an engine cannot veto actions before they run. Empty for
 * engines with native blocking. commands.ts calls this to print the banner.
 */
export function downgradeBannerText(engine: Engine): string {
  const cap = engineEnforcement(engine).preActionBlocking;
  if (cap === "native") return "";
  if (cap === "post-hoc-only") {
    return `! ${engine}: detection-only guardrails. This engine has no vetoing pre-action hook, so VibeFlow can only flag risky actions after they happen (post-command/post-write/verify-result), not block them beforehand. Use Claude Code for native blocking.`;
  }
  return `! ${engine}: native blocking for Bash/shell only; non-Bash tool calls are unguarded. Use Claude Code for full native blocking.`;
}

/** Per-command warning for detection-only engines. Empty for native engines. */
export function perCommandWarning(engine: Engine): string {
  const cap = engineEnforcement(engine).preActionBlocking;
  if (cap === "native") return "";
  if (cap === "post-hoc-only") {
    return `! ${engine}: detection-only — this action was flagged but NOT blocked. Use Claude Code for native blocking.`;
  }
  return `! ${engine}: this action was detected but may NOT be natively blocked (only Bash/shell has native blocking). Use Claude Code for full native blocking.`;
}

/** Claude Code `.claude/settings.json` hooks section. */
export function claudeHookConfig(): string {
  const cmd = cliPath();
  const runtime = hookRuntime();
  // Exec form preserves a CLI path containing shell metacharacters.
  const delegate = [{ type: "command", command: runtime, args: [cmd, "hook"] }];
  const config = {
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write", hooks: delegate },
        { matcher: "Bash", hooks: delegate },
      ],
      PostToolUse: [{ matcher: "Edit|Write", hooks: delegate }],
      Stop: [{ matcher: "", hooks: delegate }],
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Shell-escape a path for safe embedding in a POSIX shell string.
 *  Wraps in single quotes; escapes embedded single quotes via '\''. */
function shellEscape(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** PowerShell-escape a path for safe embedding in a PowerShell string.
 *  Wraps in single quotes; escapes embedded single quotes by doubling (''). */
function powershellEscape(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

/** Codex native hooks: PreToolUse blocks Bash/shell only. */
export function codexHookConfig(): string {
  const cmd = cliPath();
  const runtime = hookRuntime();
  const delegate = `${runtime} ${shellEscape(cmd)} hook`;
  const config = {
    hooks: {
      PreToolUse: [{ command: delegate }],
      PostToolUse: [{ command: delegate }],
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Build a shell command that runs `vf hook` with the absolute CLI path.
 *  Path is single-quoted to survive spaces, $, backticks, and other shell metachars.
 *  For PowerShell, `powershellHookCommand()` uses ''-escaping instead.
 *  The trailing `# vibeflow-guardrail` marker is consumed as a bash/sh comment and is
 *  also the stable string the `liveGuardrailArmed` probe matches against (issue #79
 *  re-review: the previous `vf hook` substring never appeared in real generated configs
 *  because generators emit `node "<abs>" hook`, not `vf hook`). */
function hookCommand(): string {
  return `${hookRuntime()} ${shellEscape(cliPath())} hook # vibeflow-guardrail`;
}

/** PowerShell variant: uses ''-escaping instead of '\''-escaping. */
function powershellHookCommand(): string {
  return `${hookRuntime()} ${powershellEscape(cliPath())} hook # vibeflow-guardrail`;
}

/** Copilot `.github/hooks/copilot.json` — NATIVE enforcement via preToolUse (fail-closed).
 *  Per docs.github.com/en/copilot/reference/hooks-reference:
 *    - preToolUse: non-zero exit DENIES the tool call (fail-closed)
 *    - postToolUse: can inject additionalContext
 *  Schema: {version:1, hooks:{<camelCaseEvent>:[{type:"command", bash, powershell, timeoutSec}]}}
 *  `bash` covers POSIX, `powershell` covers Windows — Copilot picks by host OS. */
export function copilotHookConfig(): string {
  const bash = hookCommand();
  const ps = powershellHookCommand();
  const config = {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", bash, powershell: ps, timeoutSec: 60 }],
      postToolUse: [{ type: "command", bash, powershell: ps, timeoutSec: 30 }],
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Opencode `.opencode/plugins/vf-guard.ts` — NATIVE enforcement via the plugin
 *  system. Opencode auto-loads any `*.ts` / `*.js` under `.opencode/plugins/` (the
 *  official, documented directory — note the plural; opencode never loads a
 *  singular `.opencode/plugin/`) and
 *  exposes a `tool.execute.before` hook that can MUTATE args and THROW to block
 *  a tool call before it runs (semantically equivalent to Claude Code's
 *  PreToolUse and Copilot CLI's preToolUse). The generated plugin shells out
 *  to `vf hook` with a JSON payload and surfaces the decision:
 *    - block / require_approval → throw an Error → opencode aborts the tool call
 *    - allow / warn             → return silently
 *  Plugin source is TypeScript; opencode runs it via bun/ts-node. The path to
 *  the CLI is hard-coded as an absolute path so the plugin works regardless of
 *  the user's cwd or PATH. */
export function opencodePluginSource(): string {
  const cmd = cliPath();
  // We use a top-of-file marker that the live-guardrail probe matches, so
  // `doctor` and `hooks status` recognize the plugin as armed.
  return `// VibeFlow guardrail plugin for opencode (auto-loaded from .opencode/plugins/).
// Generated by \`vf hooks emit --yes\`. Do not edit by hand — re-run the
// generator after upgrading VibeFlow.
// # vibeflow-guardrail
//
// Block semantics: a decision of "block" or "require_approval" from the
// \`vf hook\` runner is surfaced as a thrown Error, which opencode treats as
// a hard veto of the tool call. "allow" and "warn" return silently.
import { spawnSync } from "node:child_process";

// Absolute path to the VibeFlow CLI that owns the risk model. Hard-coded
// at generate-time so the plugin does not depend on the user's PATH or cwd.
const VF_CLI = ${JSON.stringify(cmd)};

interface BeforeInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}
interface BeforeOutput {
  args: unknown;
}
interface AfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}
interface AfterOutput {
  title: string;
  output: string;
  metadata: unknown;
}

/** Map an opencode tool name + args to the VibeFlow hook input schema. */
function buildEvent(
  event: "pre-tool-use" | "post-tool-use",
  input: BeforeInput | AfterInput,
  output: BeforeOutput | AfterOutput,
): Record<string, unknown> {
  const args = (output as BeforeOutput).args;
  const filePath =
    typeof args === "object" && args !== null && "filePath" in args
      ? (args as { filePath?: string }).filePath
      : undefined;
  const content =
    typeof args === "object" && args !== null && "content" in args
      ? (args as { content?: string }).content
      : undefined;
  const command =
    typeof args === "object" && args !== null && "command" in args
      ? (args as { command?: string }).command
      : undefined;
  return {
    event,
    tool: input.tool,
    workspace: process.cwd(),
    ...(filePath ? { files: [filePath] } : {}),
    ...(typeof content === "string" ? { content } : {}),
    ...(typeof command === "string" ? { command } : {}),
  };
}

/** Map the \`vf hook\` runner's permissionDecision envelope to the internal
 *  block/allow semantics the plugin uses to decide whether to throw. The
 *  runner is intentionally Copilot-schema-shaped so a single source of truth
 *  serves every engine adapter; the plugin is the only consumer that needs
 *  to unpack it. */
function callHook(event: Record<string, unknown>): {
  decision: "allow" | "warn" | "require_approval" | "block" | "error";
  reasons: string[];
} {
  try {
    const r = spawnSync("node", [VF_CLI, "hook"], {
      input: JSON.stringify(event),
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r.status !== 0) {
      return { decision: "block", reasons: [\`vf hook exit \${r.status}\`] };
    }
    // The runner prints the JSON envelope on the first line and a free-form
    // "[hook] ..." log on the second line; parse only the first line so the
    // trailing log does not poison JSON.parse.
    const firstLine = (r.stdout || "").split("\\n", 1)[0]?.trim() ?? "";
    const parsed = JSON.parse(firstLine || "{}") as {
      hookSpecificOutput?: {
        permissionDecision?: "allow" | "ask" | "deny";
        permissionDecisionReason?: string;
      };
    };
    const perm = parsed.hookSpecificOutput?.permissionDecision ?? "allow";
    const reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? "";
    const decision =
      perm === "deny" ? "block" : perm === "ask" ? "require_approval" : "allow";
    return {
      decision,
      reasons: reason ? [reason] : [],
    };
  } catch (e) {
    return { decision: "block", reasons: [\`vf hook threw: \${(e as Error).message}\`] };
  }
}

const VfGuard = async () => ({
  "tool.execute.before": async (
    input: BeforeInput,
    output: BeforeOutput,
  ): Promise<void> => {
    const event = buildEvent("pre-tool-use", input, output);
    const { decision, reasons } = callHook(event);
    if (decision === "block" || decision === "require_approval") {
      const why = reasons.length > 0 ? \`: \${reasons.join("; ")}\` : "";
      throw new Error(\`VibeFlow hook \${decision}\${why}\`);
    }
    // allow / warn: no-op, opencode proceeds with the tool call.
  },
  "tool.execute.after": async (
    _input: AfterInput,
    _output: AfterOutput,
  ): Promise<void> => {
    // Post-tool observation is a future expansion. Today, pre-tool covers
    // the destructive/secret/workspace-escape attack surface; post-tool is
    // reserved for emission (audit log, knowledge write-back) so the gate
    // stays fail-closed.
  },
});

export default VfGuard;
`;
}

export function engineHookFiles(engines?: Engine[]): Record<string, string> {
  return {
    ...(!engines || engines.includes("claude")
      ? { ".claude/settings.json": claudeHookConfig() }
      : {}),
    ...(!engines || engines.includes("codex") ? { ".codex/hooks.json": codexHookConfig() } : {}),
    ...(!engines || engines.includes("copilot")
      ? { ".github/hooks/copilot.json": copilotHookConfig() }
      : {}),
    ...(!engines || engines.includes("opencode")
      ? { ".opencode/plugins/vf-guard.ts": opencodePluginSource() }
      : {}),
    ...(!engines || engines.includes("antigravity")
      ? { ".agents/hooks.json": antigravityHookConfig(cliPath()) }
      : {}),
    ".githooks/pre-commit": gitPreCommit(),
    ".githooks/pre-push": gitPrePush(),
    ".githooks/post-checkout": gitPostCheckout(),
    ".githooks/post-merge": gitPostMerge(),
  };
}
