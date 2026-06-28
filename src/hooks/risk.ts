import { resolve, sep } from "node:path";
import type { HookInput, RiskLevel } from "../core.js";
import {
  type ForceKind,
  anyMatch,
  expandSubCommands,
  gitPushForce,
  isRecursiveRm,
  pathArgs,
  stripQuoteChars,
  stripQuotedContent,
  tokenize,
} from "./risk-shell.js";
import { type ResolvedHookPolicy, applyCustomRules, resolveHookPolicy } from "./templates.js";
import { scanSecrets } from "./token-scan.js";

/** Other destructive/irreversible command patterns — critical risk. */
const DANGEROUS_COMMAND = [
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/,
  /\b(drop\s+(database|table)|truncate\s+table)\b/i,
  /\b(mkfs|dd\s+if=|:\(\)\s*\{)/,
  /\bchmod\s+-R\s+777\b/,
  /\bcurl\b.*\|\s*(sh|bash)\b/,
  /\bsudo\b/,
];

/** Package-install commands — medium risk (supply-chain, side effects). */
const INSTALL_COMMAND = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/,
  /\bpip\s+install\b/,
  /\b(go\s+get|cargo\s+add|gem\s+install)\b/,
];

/** Highly sensitive secrets — reading or writing these is critical (block). */
const SECRET_CRITICAL = [/(^|[\s/])\.env(\.[\w-]+)?($|[\s/])/i, /\bid_rsa\b/i, /\bid_ed25519\b/i];

/** Other secret-ish material — high risk (require approval). */
const SECRET_HIGH = [/\.pem\b/i, /(^|\/)\.ssh\//i, /\bsecrets?\b/i, /\bcredentials?\b/i];

/** Paths that should never be edited without explicit approval (file-based events). */
// All entries use the `i` flag for uniform case-insensitive matching: hooks
// must catch `.ENV`, `.GIT/HEAD`, `ID_RSA`, `.SSH/...` the same as their
// lowercase canonical forms (issue #84 — pre-fix only `secrets?` and
// `credentials?` were case-insensitive, so the dotfile/key patterns were
// trivially bypassed with a single uppercase letter).
const PROTECTED_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git\//i,
  /(^|\/)(id_rsa|id_ed25519|.*\.pem)$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)secrets?\b/i,
  /(^|\/)credentials?\b/i,
];

/**
 * Build/lint/hook config files — editing these can silently weaken the guardrails that
 * protect every other change, so a write to them needs explicit approval (high). We can only
 * match by PATH here: HookInput carries files[] but never diff content, so "weakening" cannot
 * be detected semantically — protecting the path is the conservative, false-positive-free line.
 */
const CONFIG_PROTECTED = [
  /(^|\/)tsconfig[\w.-]*\.json$/i,
  /(^|\/)biome\.jsonc?$/i,
  /(^|\/)\.githooks\//i,
  /(^|\/)\.eslintrc[\w.-]*$/i,
  /(^|\/)\.prettierrc[\w.-]*$/i,
];

const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/** True when a path argument resolves outside the workspace root. */
function escapesWorkspace(filePath: string, workspace: string): boolean {
  if (filePath.startsWith("~")) return true;
  const target = resolve(workspace, filePath);
  const root = resolve(workspace);
  if (target === root) return false;
  // ponytail: case-fold for case-insensitive filesystems (macOS default)
  return !target.toLowerCase().startsWith(`${root}${sep}`.toLowerCase());
}

/**
 * Score the risk of a hook event from its command, files, and declared scope.
 * The optional `policy` gates which guardrail clusters run and layers user custom
 * rules on top; it DEFAULTS to all-on, so existing callers (and the self-test
 * corpus) score exactly as before — a cluster is only silenced by a validated opt-out.
 */
export function scoreRisk(
  input: HookInput,
  policy: ResolvedHookPolicy = resolveHookPolicy(undefined),
): { risk: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let risk: RiskLevel = "none";
  const bump = (level: RiskLevel) => {
    if (RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(risk)) risk = level;
  };

  scoreCommand(input, policy.enabled, bump, reasons);
  scoreFiles(input, policy.enabled, bump, reasons);
  scoreContent(input, policy.enabled, bump, reasons);
  scoreToolDeny(input, bump, reasons);
  // Custom rules layer on top of the built-ins (they can only raise risk).
  for (const hit of applyCustomRules(policy.custom, input)) {
    bump(hit.risk);
    reasons.push(hit.reason);
  }

  if (reasons.length === 0) reasons.push("no risk signals detected");
  return { risk, reasons };
}

/** Risk signals from the command string (destructive ops, secrets, workspace escape). */
function scoreCommand(
  input: HookInput,
  enabled: ResolvedHookPolicy["enabled"],
  bump: (l: RiskLevel) => void,
  reasons: string[],
): void {
  const cmd = input.command ?? "";
  if (!cmd) return;
  const subs = expandSubCommands(cmd);
  const subTokens = subs.map((s) => tokenize(stripQuoteChars(s)));

  if (enabled.has("block-destructive")) {
    scoreDestructive(cmd, subs, subTokens, bump, reasons);
    scoreForcePush(subTokens, bump, reasons);
  }

  if (enabled.has("protect-secrets")) {
    if (anyMatch(SECRET_CRITICAL, cmd)) {
      bump("critical");
      reasons.push("command reads/writes a sensitive secret");
    } else if (anyMatch(SECRET_HIGH, cmd)) {
      bump("high");
      reasons.push("command touches secret material");
    }
  }

  if (enabled.has("workspace-guard")) scoreWorkspaceCommand(input, subTokens, bump, reasons);

  // Floor: any command is at least low risk (low never blocks, so this is not a
  // guardrail and stays unconditional). Install detection only bumps when enabled.
  if (enabled.has("flag-installs") && anyMatch(INSTALL_COMMAND, cmd)) {
    bump("medium");
    reasons.push("package install has side effects");
  } else {
    bump("low");
  }
}

/**
 * Destructive-op signal across every sub-command. Recursive `rm` is detected on tokens; the
 * DANGEROUS_COMMAND regex runs against quote-STRIPPED text of the whole command AND each
 * surfaced sub-command. Stripping quoted content (not raw matching) is the deliberate choice
 * that keeps `git commit -m "drop table users"` benign while wrapper payloads like
 * `bash -c "git reset --hard"` still fire (the payload is surfaced as its own sub-command).
 */
function scoreDestructive(
  rawCmd: string,
  subs: string[],
  subTokens: string[][],
  bump: (l: RiskLevel) => void,
  reasons: string[],
): void {
  const destructiveText = [stripQuotedContent(rawCmd), ...subs.map(stripQuotedContent)];
  const recursiveRm = subTokens.some(isRecursiveRm);
  const dangerous = destructiveText.some((s) => anyMatch(DANGEROUS_COMMAND, s));
  if (recursiveRm || dangerous) {
    bump("critical");
    reasons.push(`destructive command: ${rawCmd.slice(0, 80)}`);
  }
}

/** Force-push signal: the strongest force kind seen across all sub-commands wins. */
function scoreForcePush(
  subTokens: string[][],
  bump: (l: RiskLevel) => void,
  reasons: string[],
): void {
  let kind: ForceKind = "none";
  for (const tokens of subTokens) {
    const force = gitPushForce(tokens);
    if (force === "force") kind = "force";
    else if (force === "lease" && kind !== "force") kind = "lease";
  }
  if (kind === "force") {
    bump("critical");
    reasons.push("force push overwrites remote history");
  } else if (kind === "lease") {
    bump("high");
    reasons.push("force-with-lease push needs approval");
  }
}

/** Workspace-escape signal: any path argument (in any sub-command) resolving outside root. */
function scoreWorkspaceCommand(
  input: HookInput,
  subTokens: string[][],
  bump: (l: RiskLevel) => void,
  reasons: string[],
): void {
  const ws = input.workspace;
  if (!ws) return;
  const escaped = new Set<string>();
  for (const tokens of subTokens) {
    for (const p of pathArgs(tokens)) if (escapesWorkspace(p, ws)) escaped.add(p);
  }
  if (escaped.size) {
    bump("medium");
    reasons.push(`command reads outside workspace: ${[...escaped].join(", ")}`);
  }
}

/** Risk signals from file targets (protected paths, scope/workspace escape). */
function scoreFiles(
  input: HookInput,
  enabled: ResolvedHookPolicy["enabled"],
  bump: (l: RiskLevel) => void,
  reasons: string[],
): void {
  const files = input.files ?? [];
  const flag = (patterns: RegExp[], label: string) => {
    const hits = files.filter((f) => anyMatch(patterns, f));
    if (hits.length) {
      bump("high");
      reasons.push(`${label}: ${hits.join(", ")}`);
    }
  };
  if (enabled.has("protect-secrets")) flag(PROTECTED_PATH, "touches protected path(s)");
  if (enabled.has("protect-config"))
    flag(CONFIG_PROTECTED, "edits build/lint/hook config (path-protected)");

  if (enabled.has("workspace-guard")) {
    const escaped = outOfScope(files, input.scope);
    if (escaped.length) {
      bump("high");
      reasons.push(`out of declared scope: ${escaped.join(", ")}`);
    }
    if (input.workspace) {
      const ws = input.workspace;
      const outside = files.filter((f) => escapesWorkspace(f, ws));
      if (outside.length) {
        bump("high");
        reasons.push(`write escapes workspace: ${outside.join(", ")}`);
      }
    }
  }
}

/** Content-aware secret signal (issue #357). Scans the Write/Edit body for
 *  known credential tokens; a hit is `critical` (writing a live secret into an
 *  otherwise-allowed file is at least as bad as reading .env, already critical).
 *  Gated by `protect-secrets` so the same opt-out silences path + content. */
function scoreContent(
  input: HookInput,
  enabled: ResolvedHookPolicy["enabled"],
  bump: (l: RiskLevel) => void,
  reasons: string[],
): void {
  if (!enabled.has("protect-secrets")) return;
  const hits = scanSecrets(input.content);
  if (hits.length) {
    bump("critical");
    // Report token TYPE only — never the secret substring (it surfaces verbatim
    // via presentDecision into agent/UI logs). Labels are non-leaking.
    reasons.push(`secret in file content: ${hits.map((h) => h.label).join(", ")}`);
  }
}

/** Tool-deny-list enforcement (A1 FU #198). Reads VF_DENY_TOOLS from the
 *  environment and BLOCKS any PreToolUse event whose tool name appears in
 *  the comma-separated deny set. The env var is set by `vf coord` before
 *  spawning an engine; the hook receives it via the inherited environment.
 *
 *  A1 FU #198: this is the production enforcement path — the deny-list is
 *  no longer a test-only seam. When the engine's PreToolUse event routes
 *  through `vf hook`, this scorer blocks the tool natively. */
function scoreToolDeny(input: HookInput, bump: (l: RiskLevel) => void, reasons: string[]): void {
  const denialEnv = process.env.VF_DENY_TOOLS;
  if (!denialEnv) return;
  const tool = input.tool;
  if (!tool) return;
  const denied = new Set(
    denialEnv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (denied.has(tool.toLowerCase())) {
    bump("critical");
    reasons.push(
      `coord mode refuses mutation tool "${tool}"; the shim is a read-only consultation surface. ` +
        `Blocked by VF_DENY_TOOLS=${denialEnv}. Use the engine outside \`vf coord\` to mutate state.`,
    );
  }
}

/** Files lying outside every declared scope prefix of the work unit. */
function outOfScope(files: string[], scope?: string[]): string[] {
  if (!scope || !scope.length) return [];
  const prefixes = scope.map((s) => s.replace(/\*+$/, "").replace(/\/$/, ""));
  return files.filter((f) => !prefixes.some((p) => p === "" || f.startsWith(p)));
}
