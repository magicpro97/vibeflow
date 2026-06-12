/**
 * Env allowlist for child processes spawned by VibeFlow.
 *
 * Spreading `process.env` into a child is a secret-leak vector: any
 * API key, OAuth token, or cloud credential present in the parent
 * environment ends up in the child's env. We restrict the propagated
 * set to known-safe keys plus a denylist of suffix patterns.
 */

const ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "PWD",
  "OLDPWD",
  // VibeFlow-specific
  "VIBEFLOW_AI",
  "VIBEFLOW_AI_BRIDGE",
  "VIBEFLOW_LOG_LEVEL",
  // External tool integrations the agent may call
  "CONTEXT7_API_KEY",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NO_COLOR",
  "FORCE_COLOR",
  // Windows
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "PATHEXT",
  "COMSPEC",
]);

const DENY_SUFFIXES: readonly RegExp[] = [
  /_TOKEN$/i,
  /_SECRET$/i,
  /_KEY$/i,
  /_PASSWORD$/i,
  /_PASS$/i,
  /_CREDENTIALS?$/i,
  /_AUTH$/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^GCP$/i,
  /^GOOGLE_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^GITLAB_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^COHERE_/i,
  /^MISTRAL_/i,
  /^HF_TOKEN$/i,
  /^STRIPE_/i,
];

export function isAllowedKey(key: string): boolean {
  if (ALLOWLIST.has(key)) return true;
  for (const re of DENY_SUFFIXES) {
    if (re.test(key)) return false;
  }
  return true; // unknown keys are passed through; explicit denylist only blocks known patterns
}

export function filterChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isAllowedKey(k)) out[k] = v;
  }
  return out;
}
