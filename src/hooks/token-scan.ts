/** Content-aware secret detection for hook write/edit bodies (issue #357).
 *  Known-credential regexes only — near-zero false positive. Pure + synchronous
 *  so scoreRisk stays a pure function.
 *  ponytail: known-token regexes only; add an entropy heuristic when a concrete
 *  leak slips past the anchored patterns (issue #357 Task 4, deferred). */

export interface SecretHit {
  /** The credential type (e.g. "AWS access key id"). NEVER carries any
   *  substring of the matched secret — reasons are surfaced verbatim via
   *  presentDecision, so leaking even a redacted excerpt would echo secret
   *  material back into agent/UI logs. Report the type only. */
  label: string;
}

/** Known credential token shapes. Anchored where the shape allows so a stray
 *  substring of normal code does not match. */
const TOKEN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "OpenAI key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    label: "private key block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

export function scanSecrets(content: string | undefined): SecretHit[] {
  if (!content) return [];
  const hits: SecretHit[] = [];
  for (const { label, re } of TOKEN_PATTERNS) {
    if (re.test(content)) hits.push({ label });
  }
  return hits;
}
