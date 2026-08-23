// src/dispatch/env-filter.ts
//
// #556: scrub the host env before it is handed to a spawned engine subprocess.
// Every engine vf launches used to inherit the FULL `process.env`, leaking
// `AWS_*`, `STRIPE_*`, DB URLs and unrelated tokens to third-party agent CLIs.
// `filterEnv` is a pure, exhaustively-testable helper applied at both spawn
// sites (dispatch/spawners.ts + commands/coord.ts). No Docker, no new dep.

import type { Engine } from "../core.js";

/** Env-scrub policy for spawned engine subprocesses. Absent/empty = conservative default. */
export interface EnvPolicy {
  /** Extra var names/globs to DROP on top of the built-in secret denylist. */
  deny?: string[];
  /** When non-empty, STRICT mode: pass ONLY these globs (plus the always-keep essentials). */
  allow?: string[];
  /** Conversation-only provider selection. Presence enables strict mode and keeps only the
   * selected engine's auth variables; the legacy/default policy keeps every canonical auth. */
  selectedEngine?: Engine;
}

const conversationPolicies = new WeakSet<object>();

export interface EnvFilterResult {
  env: NodeJS.ProcessEnv;
  /** Sorted list of dropped var NAMES — never values (audit-safe). */
  dropped: string[];
}

/** POSIX essentials a child always needs to function. */
const KEEP_EXACT_POSIX = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
];

/** Engine auth vars: secret-shaped but REQUIRED by the agent CLIs — these WIN over any deny. */
const KEEP_AUTH = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GEMINI_API_KEY",
];

const ENGINE_AUTH: Record<Engine, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  copilot: ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"],
  opencode: ["OPENCODE_API_KEY"],
  antigravity: ["GEMINI_API_KEY"],
};

/** Windows essentials — only kept when platform === "win32". */
const KEEP_EXACT_WINDOWS = [
  "SYSTEMROOT",
  "PATHEXT",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
];

/** Name prefixes always kept: locale (LC_) + vf's own signalling vars (VF_ and VIBEFLOW_). */
const KEEP_PREFIXES = ["LC_", "VF_", "VIBEFLOW_"];

/** Human-readable union for `vf config env-policy status` + the UI summary. Globs shown with `*`. */
export const ALWAYS_KEEP: readonly string[] = [
  ...KEEP_EXACT_POSIX,
  ...KEEP_AUTH,
  ...KEEP_EXACT_WINDOWS,
  ...KEEP_PREFIXES.map((p) => `${p}*`),
];

/** Built-in secret-shaped denylist (globs). ALWAYS_KEEP overrides any match. */
export const DEFAULT_DENY: readonly string[] = [
  "AWS_*",
  "AZURE_*",
  "GCP_*",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "STRIPE_*",
  "TWILIO_*",
  "SLACK_*",
  "SENTRY_*",
  "NPM_TOKEN",
  "DOCKER_*",
  // Connection strings / DB creds — cover the common Postgres/MySQL/Redis/Mongo shapes,
  // not just DATABASE_URL (cross-review #575 P2: PGPASSWORD/DATABASE_URI et al. slipped).
  "DATABASE_URL",
  "DATABASE_URI",
  "REDIS_URL",
  "MONGODB_URI",
  "MONGO_URL",
  "PGPASSWORD",
  "PGUSER",
  "MYSQL_PWD",
  "KUBECONFIG",
  // Bare + suffixed secret shapes.
  "SECRET_KEY",
  "API_KEY",
  "ACCESS_TOKEN",
  "*_SECRET",
  "*_SECRET_KEY",
  "*_PRIVATE_KEY",
  "*_PASSWORD",
  "*_PASSWD",
  "*_TOKEN",
  "*_API_KEY",
  "*_ACCESS_KEY",
];

/**
 * Tiny glob matcher: `PREFIX_*` (prefix), `*_SUFFIX` (suffix), or exact only.
 * ponytail: no full glob engine — no `?`, no mid-string `*`, no char classes.
 *   That covers every DEFAULT_DENY/ALWAYS_KEEP pattern; upgrade to `micromatch`
 *   only if a real glob is ever configured.
 */
export function matchesGlob(name: string, pattern: string): boolean {
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** True if any glob in `patterns` matches `name` (case-insensitively when `ci`). */
function anyGlob(name: string, patterns: readonly string[], ci: boolean): boolean {
  const n = ci ? name.toUpperCase() : name;
  return patterns.some((p) => matchesGlob(n, ci ? p.toUpperCase() : p));
}

/** True if `name` is in the never-drop set (essentials + auth + kept prefixes). */
function isAlwaysKept(name: string, ci: boolean, isWin: boolean, selectedEngine?: Engine): boolean {
  const n = ci ? name.toUpperCase() : name;
  if (KEEP_EXACT_POSIX.includes(n)) return true;
  if (selectedEngine && ENGINE_AUTH[selectedEngine].includes(n)) return true;
  if (KEEP_AUTH.includes(n)) {
    return !selectedEngine;
  }
  if (isWin && KEEP_EXACT_WINDOWS.includes(n)) return true;
  return KEEP_PREFIXES.some(
    (prefix) => n.startsWith(prefix) && (!selectedEngine || prefix === "LC_"),
  );
}

/** Materialize the strict credential policy for a conversation engine. The returned object is
 * fresh and mutation-safe for callers; non-conversation filtering remains unchanged. */
export function conversationEnvPolicy(engine: Engine): EnvPolicy {
  const policy: EnvPolicy = Object.freeze({ selectedEngine: engine });
  conversationPolicies.add(policy);
  return policy;
}

/** Runtime authority check used by the canonical conversation spawn factory. */
export function isConversationEnvPolicy(policy: EnvPolicy, engine?: Engine): boolean {
  return (
    conversationPolicies.has(policy) &&
    policy.selectedEngine !== undefined &&
    (engine === undefined || policy.selectedEngine === engine)
  );
}

/** Values that must be denied from public engine output; runtime essentials are not secrets. */
export function providerCredentialValues(env: NodeJS.ProcessEnv, engine: Engine): string[] {
  const names = new Set(ENGINE_AUTH[engine]);
  return Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && names.has(name.toUpperCase()) ? [value] : [],
  );
}

/**
 * Filter `source` into a child-safe env per `policy`.
 *
 * - **denylist (default):** keep every var UNLESS it matches DEFAULT_DENY or a `policy.deny`
 *   glob — but ALWAYS_KEEP always wins over a deny match.
 * - **allowlist (strict, when `policy.allow` is non-empty):** keep a var iff it is in
 *   ALWAYS_KEEP OR matches an `allow` glob. Drop everything else.
 * - **Windows** (`platform === "win32"`): name matching is case-insensitive (`Path` == `PATH`).
 *
 * Returns `{ env, dropped }`; `dropped` is the sorted list of dropped NAMES (never values).
 */
export function filterEnv(
  source: NodeJS.ProcessEnv,
  policy: EnvPolicy = {},
  platform: NodeJS.Platform = process.platform,
): EnvFilterResult {
  const ci = platform === "win32";
  const strict = policy.selectedEngine !== undefined || (policy.allow?.length ?? 0) > 0;
  const denyGlobs = [...DEFAULT_DENY, ...(policy.deny ?? [])];
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue; // never materialize an undefined hole
    if (isAlwaysKept(name, ci, ci, policy.selectedEngine)) {
      env[name] = value;
      continue;
    }
    if (policy.selectedEngine) {
      const normalized = ci ? name.toUpperCase() : name;
      const providerCredential = Object.values(ENGINE_AUTH).some((names) =>
        names.includes(normalized),
      );
      const inheritedControl = normalized.startsWith("VF_") || normalized.startsWith("VIBEFLOW_");
      if (providerCredential || inheritedControl || anyGlob(name, denyGlobs, ci)) {
        dropped.push(name);
        continue;
      }
    }
    // A selected conversation engine is a closed authority: caller-provided allow/deny
    // globs cannot widen or remove the canonical runtime/auth set.
    const keep = policy.selectedEngine
      ? false
      : strict
        ? anyGlob(name, policy.allow ?? [], ci)
        : !anyGlob(name, denyGlobs, ci);
    if (keep) env[name] = value;
    else dropped.push(name);
  }
  dropped.sort();
  return { env, dropped };
}
