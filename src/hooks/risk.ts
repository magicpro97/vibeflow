import { isAbsolute, resolve, sep } from "node:path";
import type { HookInput, RiskLevel } from "../core.js";
import { type ResolvedHookPolicy, applyCustomRules, resolveHookPolicy } from "./templates.js";

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
const SECRET_CRITICAL = [/(^|[\s/])\.env(\.[\w-]+)?($|[\s/])/, /\bid_rsa\b/, /\bid_ed25519\b/];

/** Other secret-ish material — high risk (require approval). */
const SECRET_HIGH = [/\.pem\b/, /(^|\/)\.ssh\//, /\bsecrets?\b/i, /\bcredentials?\b/i];

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
  /(^|\/)tsconfig[\w.-]*\.json$/,
  /(^|\/)biome\.jsonc?$/,
  /(^|\/)\.githooks\//,
  /(^|\/)\.eslintrc[\w.-]*$/,
  /(^|\/)\.prettierrc[\w.-]*$/,
];

const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

function anyMatch(patterns: RegExp[], value: string): boolean {
  return patterns.some((re) => re.test(value));
}

/** Split a shell command into whitespace-separated tokens. */
function tokenize(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

/** Basename of a program token (`/bin/rm` → `rm`). */
function programName(token: string | undefined): string {
  if (!token) return "";
  const parts = token.split("/");
  return parts[parts.length - 1] ?? "";
}

/** True when an `rm` invocation deletes recursively (the dangerous mode). */
function isRecursiveRm(tokens: string[]): boolean {
  if (programName(tokens[0]) !== "rm") return false;
  return tokens.slice(1).some((t) => {
    if (t === "--recursive") return true;
    // short flag cluster containing r or R, e.g. -r, -R, -rf, -fr, -Rf
    return /^-[a-z]*[rR][a-z]*$/i.test(t);
  });
}

type ForceKind = "none" | "force" | "lease";

/** Classify a `git push` force flag: hard force (critical) vs --force-with-lease (safer). */
function gitPushForce(tokens: string[]): ForceKind {
  if (programName(tokens[0]) !== "git" || tokens[1] !== "push") return "none";
  const rest = tokens.slice(2);
  if (rest.some((t) => t === "--force-with-lease")) return "lease";
  if (rest.some((t) => t === "-f" || t === "--force" || /^-[a-z]*f[a-z]*$/i.test(t)))
    return "force";
  return "none";
}

/** Path-like argument tokens (skip flags and plain words like subcommands). */
function pathArgs(tokens: string[]): string[] {
  return tokens
    .slice(1)
    .filter((t) => !t.startsWith("-") && (t.includes("/") || t.startsWith("~") || isAbsolute(t)));
}

/** True when a path argument resolves outside the workspace root. */
function escapesWorkspace(filePath: string, workspace: string): boolean {
  if (filePath.startsWith("~")) return true;
  const target = resolve(workspace, filePath);
  const root = resolve(workspace);
  if (target === root) return false;
  return !target.startsWith(`${root}${sep}`);
}

/** Expand the `$IFS` / `${IFS}` field-separator trick back to literal spaces. */
function expandIfs(cmd: string): string {
  return cmd.replace(/\$\{IFS\}/g, " ").replace(/\$IFS\b/g, " ");
}

/**
 * Split a command on UNQUOTED shell operators (`;`, `&&`, `||`, `|`) into segments. Quote
 * state is tracked so an operator inside a string is not a split point.
 */
function splitOperators(cmd: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(buf);
      buf = "";
      if (cmd[i + 1] === ch) i++; // collapse doubled operators (&& / ||)
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * Replace the CONTENT inside quotes with spaces, keeping structure. Backslash escapes are
 * intentionally NOT honored: a crafted escaped quote surfaces MORE text (fail-safe toward
 * over-blocking), never hides a destructive payload. Used for the destructive-regex check so a
 * quoted commit message (`-m "drop table users"`) cannot trip it.
 */
function stripQuotedContent(cmd: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        out += " ";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Remove quote characters (keeping their content) so a sub-command tokenizes cleanly. */
function stripQuoteChars(cmd: string): string {
  return cmd.replace(/['"]/g, " ");
}

/** Unwrap `bash -c "<payload>"` / `sh -c '<payload>'` / bare `-c "<payload>"` inline scripts. */
function unwrapDashC(segment: string): string[] {
  const out: string[] = [];
  for (const m of segment.matchAll(/(?:^|\s)-c\s+(['"])([\s\S]*?)\1/g)) {
    if (m[2]) out.push(m[2]);
  }
  return out;
}

/** Surface the inner bodies of `$(...)` and backtick command substitutions as commands. */
function unwrapSubshell(segment: string): string[] {
  const out: string[] = [];
  for (const m of segment.matchAll(/\$\(([^()]*)\)/g)) {
    const inner = m[1]?.trim();
    if (inner) out.push(inner);
  }
  for (const m of segment.matchAll(/`([^`]*)`/g)) {
    const inner = m[1]?.trim();
    if (inner) out.push(inner);
  }
  return out;
}

/** Bound on wrapper/subshell unwrap recursion (defense-in-depth against crafted nesting). */
const MAX_UNWRAP_DEPTH = 4;

/**
 * Expand a raw command into the list of sub-commands whose tokens must be scored: expand the
 * `$IFS` trick, split on unquoted operators, then recursively surface inline `-c` payloads and
 * `$(...)`/backtick bodies (bounded). Each sub-command is run through the existing token checks
 * so wrapper-based evasions (`bash -c "rm -rf /"`, `$(rm -rf /)`, `a | rm -rf x`) are caught.
 */
function expandSubCommands(raw: string): string[] {
  const collected = new Set<string>();
  const visit = (cmd: string, depth: number): void => {
    for (const segment of splitOperators(cmd)) {
      collected.add(segment);
      if (depth >= MAX_UNWRAP_DEPTH) continue;
      for (const inner of [...unwrapDashC(segment), ...unwrapSubshell(segment)]) {
        visit(inner, depth + 1);
      }
    }
  };
  visit(expandIfs(raw), 0);
  return [...collected];
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

/** Tool-deny-list enforcement (A1 FU #198). Reads VF_DENY_TOOLS from the
 *  environment and BLOCKS any PreToolUse event whose tool name appears in
 *  the comma-separated deny set. The env var is set by `vf coord` before
 *  spawning an engine; the hook receives it via the inherited environment.
 *
 *  A1 FU #198: this is the production enforcement path — the deny-list is
 *  no longer a test-only seam. When the engine's PreToolUse event routes
 *  through `vf hook`, this scorer blocks the tool natively. */
function scoreToolDeny(
  input: HookInput,
  bump: (l: RiskLevel) => void,
  reasons: string[],
): void {
  const denialEnv = process.env.VF_DENY_TOOLS;
  if (!denialEnv) return;
  const tool = input.tool;
  if (!tool) return;
  const denied = new Set(denialEnv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
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
