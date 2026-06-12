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
  // VibeFlow-specific (these are configuration, not secrets — safe to pass through)
  "VIBEFLOW_AI",
  "VIBEFLOW_AI_BRIDGE",
  "VIBEFLOW_LOG_LEVEL",
  // Engine auth keys: claude/codex/copilot binaries read these directly
  // from their own env. They MUST propagate to the child or auth fails.
  // Risk: a malicious child process can read them. Mitigation: only the
  // engine binary runs, not arbitrary code; the engine itself is trusted.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_BASE_URL",
  "GH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  // Node runtime
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
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
  // First check: known-safe allowlist (system keys + engine auth).
  // Engine auth keys are allowlisted because claude/codex/copilot
  // binaries MUST receive them in their env to authenticate.
  if (ALLOWLIST.has(key)) return true;
  // Then deny: any key matching a known-secret pattern is blocked.
  // This catches generic SECRET/TOKEN/PASSWORD/AUTH suffixes from
  // third-party services (AWS, Azure, custom cloud creds, etc.).
  for (const re of DENY_SUFFIXES) {
    if (re.test(key)) return false;
  }
  // Unknown keys are passed through; the deny list is the primary
  // defence for new unknown secrets. If you add a new secret prefix
  // (e.g. a new cloud provider), add a denylist regex above.
  return true;
}

export function filterChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isAllowedKey(k)) out[k] = v;
  }
  return out;
}
