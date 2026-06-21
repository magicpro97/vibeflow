// src/hooks/templates.ts
//
// Hook guardrail TEMPLATES + the per-repo hook POLICY they resolve into.
//
// A template is a named group of the built-in risk patterns scored in
// risk.ts (destructive commands, installs, secrets, protected config,
// workspace/scope escape). A repo's stored HookConfig — persisted under
// SETTINGS.json `hooks` — decides which templates stay active and adds any
// user-authored CUSTOM rules on top.
//
// Fail-safe contract (mirrors the rest of the guardrail layer):
//   - A MISSING or WRONG-TYPED config resolves to ALL templates enabled with
//     no custom rules — byte-identical to the pre-config behavior. A
//     guardrail is therefore only ever dropped by an EXPLICIT, well-formed
//     opt-out (the `vf init` menu writes a concrete list), never by
//     corruption or a parse error.
//   - A custom rule can only RAISE risk, never lower it, so a user can never
//     weaken a built-in guardrail through the custom surface — at worst they
//     disable a whole template, which is an explicit menu choice.
//   - An invalid custom rule (empty/oversized match, unknown risk) is DROPPED,
//     not fatal: scoring keeps running with the remaining rules.

import type { HookInput, RiskLevel } from "../core.js";

/** Stable IDs for the built-in guardrail groups. Array order = menu order. */
export const HOOK_TEMPLATE_IDS = [
  "block-destructive",
  "flag-installs",
  "protect-secrets",
  "protect-config",
  "workspace-guard",
] as const;

export type HookTemplateId = (typeof HOOK_TEMPLATE_IDS)[number];

const TEMPLATE_ID_SET = new Set<string>(HOOK_TEMPLATE_IDS);

const RISK_LEVELS = new Set<string>(["none", "low", "medium", "high", "critical"]);

/** A built-in guardrail group, as shown in the `vf init` hooks menu. */
export interface HookTemplate {
  id: HookTemplateId;
  label: string;
  description: string;
  /** Strongest decision this group can force, so the menu shows the stakes. */
  maxRisk: RiskLevel;
}

/**
 * The built-in templates. Each maps onto a cluster of the scoring functions in
 * risk.ts; `scoreRisk` consults the resolved policy before applying a cluster,
 * so disabling a template here silences exactly that cluster and nothing else.
 */
export const HOOK_TEMPLATES: HookTemplate[] = [
  {
    id: "block-destructive",
    label: "Block destructive commands",
    description:
      "rm -rf, git reset --hard / clean -f / branch -D, force-push, mkfs/dd, chmod -R 777, curl | sh, sudo.",
    maxRisk: "critical",
  },
  {
    id: "flag-installs",
    label: "Flag package installs",
    description: "npm/pnpm/yarn/bun/pip/cargo/go/gem install — warn on supply-chain side effects.",
    maxRisk: "medium",
  },
  {
    id: "protect-secrets",
    label: "Protect secrets + .git",
    description:
      "Reads/writes of .env, id_rsa/id_ed25519, *.pem, .ssh/, secret*/credential*, and the .git/ directory.",
    maxRisk: "critical",
  },
  {
    id: "protect-config",
    label: "Protect build/lint/hook config",
    description: "Edits to tsconfig*.json, biome.json, .githooks/, .eslintrc*, .prettierrc*.",
    maxRisk: "high",
  },
  {
    id: "workspace-guard",
    label: "Guard workspace + scope",
    description:
      "Commands or writes that escape the workspace root or a work unit's declared scope.",
    maxRisk: "high",
  },
];

/** Where a custom rule's pattern is tested: the command string, or file paths. */
export type CustomHookKind = "command" | "file";

/**
 * A user-authored rule that ADDS a restriction on top of the built-ins. It can
 * only raise risk; it can never lower a built-in decision.
 */
export interface CustomHookRule {
  /** Short human label, surfaced in the decision reason. */
  name: string;
  /** Match against the command string ("command") or the file paths ("file"). */
  kind: CustomHookKind;
  /**
   * Case-insensitive LITERAL SUBSTRING to look for (NOT a regex — see
   * MAX_CUSTOM_PATTERN_LEN for why). Empty/oversized => rule dropped.
   */
  pattern: string;
  /** Risk level to raise to when the pattern matches. */
  risk: RiskLevel;
  /** Optional reason text shown to the user / agent. */
  reason?: string;
}

/** The stored hook policy persisted under SETTINGS.json `hooks`. */
export interface HookConfig {
  /** Enabled built-in templates. A valid array is honored verbatim (empty = none). */
  templates: HookTemplateId[];
  /** Extra user rules, applied after the built-ins. */
  custom: CustomHookRule[];
}

/** The all-on default: every template, no custom rules — equals pre-config behavior. */
export function defaultHookConfig(): HookConfig {
  return { templates: [...HOOK_TEMPLATE_IDS], custom: [] };
}

/**
 * Bound on a custom MATCH string. Custom rules match by case-insensitive LITERAL
 * SUBSTRING (never regex) — so there is no pattern compilation and no
 * catastrophic-backtracking surface at all (CWE-1333 is structurally impossible
 * for `String.includes`). This cap is just a sane length guard against a typo'd
 * megabyte paste, not a ReDoS mitigation.
 */
const MAX_CUSTOM_PATTERN_LEN = 200;

/** Resolved policy: enabled templates as a set + the validated custom rules. */
export interface ResolvedHookPolicy {
  enabled: Set<HookTemplateId>;
  custom: CustomHookRule[];
}

/** Cap on custom rules honored from a stored config (defense-in-depth vs a hand-edited file). */
const MAX_STORED_CUSTOM_RULES = 32;

function coerceTemplates(raw: unknown): HookTemplateId[] | null {
  if (!Array.isArray(raw)) return null;
  // Any unknown id makes the whole list untrustworthy → fall back to all-on.
  if (!raw.every((t) => typeof t === "string" && TEMPLATE_ID_SET.has(t))) return null;
  // Dedupe, preserve canonical order.
  const seen = new Set(raw as HookTemplateId[]);
  return HOOK_TEMPLATE_IDS.filter((id) => seen.has(id));
}

/** True when a custom match string is usable: a non-empty, length-bounded string.
 *  No regex compilation — matching is literal substring, so there is nothing to
 *  compile and no ReDoS surface to validate against. */
export function isValidCustomPattern(pattern: string): boolean {
  return (
    typeof pattern === "string" && pattern.length > 0 && pattern.length <= MAX_CUSTOM_PATTERN_LEN
  );
}

/** Validate one custom rule; return a normalized copy or null if unusable. */
export function coerceCustomRule(raw: unknown): CustomHookRule | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const pattern = typeof obj.pattern === "string" ? obj.pattern.trim() : "";
  const kind = obj.kind === "file" ? "file" : obj.kind === "command" ? "command" : null;
  const risk =
    typeof obj.risk === "string" && RISK_LEVELS.has(obj.risk) ? (obj.risk as RiskLevel) : null;
  if (!name || !kind || !risk || !isValidCustomPattern(pattern)) return null;
  const reason =
    typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : undefined;
  return { name, kind, pattern, risk, reason };
}

function coerceCustom(raw: unknown): CustomHookRule[] {
  if (!Array.isArray(raw)) return [];
  // Cap the count BEFORE validating — a hand-edited SETTINGS.json could otherwise
  // carry thousands of rules, each matched on every hook call.
  return raw
    .slice(0, MAX_STORED_CUSTOM_RULES)
    .map(coerceCustomRule)
    .filter((r): r is CustomHookRule => r !== null);
}

/**
 * Validate + normalize a stored hooks block into a complete HookConfig.
 * Fail-safe: a missing block, a non-object, or an unknown template id all
 * resolve `templates` to the all-on default. Only an explicit, fully-valid
 * array can disable a guardrail. Invalid custom rules are dropped, not fatal.
 */
export function coerceHookConfig(raw: unknown): HookConfig {
  if (!raw || typeof raw !== "object") return defaultHookConfig();
  const obj = raw as Record<string, unknown>;
  const templates = coerceTemplates(obj.templates) ?? [...HOOK_TEMPLATE_IDS];
  return { templates, custom: coerceCustom(obj.custom) };
}

/**
 * Resolve a stored config (or undefined) into the policy `scoreRisk` consults.
 * The all-on default means an absent config never silences a guardrail.
 */
export function resolveHookPolicy(config: HookConfig | undefined): ResolvedHookPolicy {
  const resolved = config ?? defaultHookConfig();
  return { enabled: new Set(resolved.templates), custom: resolved.custom };
}

/** A single fired custom-rule signal, fed back into scoreRisk's bump/reasons. */
export interface CustomHookHit {
  risk: RiskLevel;
  reason: string;
}

/**
 * Apply the policy's custom rules to one hook event. Each rule matches by
 * case-insensitive LITERAL SUBSTRING against either the command string or every
 * file path, per its `kind`. A match yields the rule's risk + a reason.
 *
 * Literal `includes` (not regex) is a DELIBERATE security choice: the live
 * `vf hook` gate runs this on every tool call against attacker-influenced input
 * (the agent's command), and a regex surface would expose it to catastrophic
 * backtracking (CWE-1333). Substring matching is linear and un-wedgeable, and
 * covers the real guardrail need ("block commands containing `rm -rf`", "flag
 * writes to `package-lock`"). No pattern compilation, no timeout, no worker.
 */
export function applyCustomRules(
  rules: CustomHookRule[],
  input: Pick<HookInput, "command" | "files">,
): CustomHookHit[] {
  const hits: CustomHookHit[] = [];
  const command = (input.command ?? "").toLowerCase();
  const files = (input.files ?? []).map((f) => f.toLowerCase());
  for (const rule of rules) {
    const needle = rule.pattern.toLowerCase();
    const matched =
      rule.kind === "command"
        ? Boolean(command) && command.includes(needle)
        : files.some((f) => f.includes(needle));
    if (matched) {
      hits.push({
        risk: rule.risk,
        reason: `custom rule "${rule.name}"${rule.reason ? `: ${rule.reason}` : ""}`,
      });
    }
  }
  return hits;
}
