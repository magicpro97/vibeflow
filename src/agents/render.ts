import type { RoleModel, RoleSpec, ToolIntent } from "./role.js";

/** Engine keys consumed by `renderForEngine` / `agentFilePath`. */
export type AgentEngine = "claude" | "codex" | "copilot" | "opencode" | "antigravity";

/** Map from engine-agnostic `ToolIntent` to Claude Code's tool names. */
const CLAUDE_TOOL_MAP: Record<ToolIntent, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  web: "WebFetch",
};

/** Map from canonical role model identifiers to Codex model identifiers.
 * Claude-only values (`haiku`, `sonnet`, `opus`) map to the closest
 * Codex equivalent. Codex-specific identifiers pass through unchanged. */
const CODEX_MODEL_MAP: Record<string, string> = {
  haiku: "gpt-5.4-mini",
  sonnet: "gpt-5.4",
  opus: "gpt-5.4",
};

/** Strip Claude-only model aliases when rendering Codex TOML. Codex
 * identifiers are kept as-is. */
function codexModel(model: RoleModel): string {
  if (model.startsWith("gpt-")) return model;
  return CODEX_MODEL_MAP[model] ?? model;
}

/** Quote a TOML basic string. Disallows control chars and ensures
 * newlines/tabs are not used (basic strings must be a single line). For
 * multi-line content use `"""..."""` instead. */
function tomlQuote(s: string): string {
  if (/[\n\r\t\0\b\f\v]/.test(s)) {
    throw new Error("tomlQuote: use triple-string for multi-line content");
  }
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Quote a scalar string for YAML frontmatter. Wraps in double quotes only
 * when needed (value contains `:`, `#`, `&`, `*`, `!`, `>`, `<`, `-`, `[`, `]`,
 * `{`, `}`, or begins with `?`/`-`/`!`). Escapes embedded `"` and `\` per
 * the YAML 1.2 spec.
 *
 * Defect (round-2 review): the old SAFE class included `\s` which matched
 * `\n`, so a description with a newline emitted broken YAML frontmatter.
 * The new code rejects any ASCII control char (\x00-\x1f) with a clear
 * error message. Caller (RoleSpec build) must pre-clean values.
 *
 * Exported for direct test coverage. */
export function yamlQuote(s: string): string {
  // No scalar in YAML 1.2 can contain a literal control char unquoted
  // (YAML 1.2 §7.3.3 explicitly lists the printable char set). Reject all
  // C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F) controls. Biome rejects
  // control chars in regex literals, so we use a charCodeAt loop.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      throw new Error(
        `yamlQuote: control char in value (code=${code}) — caller must pre-clean (was: ${JSON.stringify(s.slice(0, 40))})`,
      );
    }
  }
  // Safe to emit unquoted: only letters, digits, _, -, ., /, and a single
  // space (no newlines, no colons, no special indicators).
  // The SAFE class deliberately excludes \s (whitespace includes \n).
  const SAFE = /^[A-Za-z0-9_\-./][A-Za-z0-9_\-./ ]*$/;
  const HAS_SPECIAL = /[:#&*!<>{}\[\]?,|`'%@]/;
  if (SAFE.test(s) && !HAS_SPECIAL.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Sanitize an agent name to a path-safe segment. Strips path traversal
 * sequences (`.` segments that are path components, not name parts) and
 * directory separators. Preserves legit `.` characters within names like
 * "v1.0" or "role..v1". Returns `_invalid` for inputs that reduce to
 * nothing (single dot, parent references, empty). */
export function safeAgentName(name: string): string {
  if (name.length === 0) return "_invalid";
  // Replace path separators with a private sentinel we can later split on
  // without confusing the result with names that legitimately contain
  // underscores. The sentinel char NUL is not a valid filename char on
  // any supported OS so collision risk is zero.
  const SENTINEL = "\0";
  const segments = name
    .replace(/[\\/]+/g, SENTINEL)
    .split(SENTINEL)
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..")
    // Join with single underscore — preserves adjacent underscores in the
    // original (they remain as part of the joined segments).
    .join("_");
  if (segments.length === 0) return "_invalid";
  // Defence-in-depth: if the result happens to be exactly "_invalid" (a
  // legit-looking name that happens to match the placeholder), prefix
  // to disambiguate. Without this, a caller cannot tell whether
  // `safeAgentName("_invalid")` returned because the user supplied a
  // role literally named "_invalid" or because the input was invalid.
  if (segments === "_invalid") return "u_invalid";
  return segments;
}

/** Render a Claude Code agent file: Markdown + YAML frontmatter.
 * Path on disk: `.claude/agents/<name>.md`. */
export function renderClaudeAgent(spec: RoleSpec): string {
  const tools = spec.tools.map((t) => CLAUDE_TOOL_MAP[t]).join(", ");
  return [
    "---",
    `name: ${yamlQuote(spec.name)}`,
    `description: ${yamlQuote(spec.description)}`,
    `tools: ${tools}`,
    `model: ${spec.model}`,
    "permissionMode: default",
    "---",
    "",
    spec.body,
  ].join("\n");
}

/** Render a Codex agent file: TOML config. Path: `.codex/agents/<name>.toml`.
 * Body content goes inside a `developer_instructions = """..."""` block.
 * Per the TOML spec, inside a literal multi-line string `"""` terminates
 * the string early — escape any `"""` substring to `""\"`. Backslashes
 * are also escaped. We do the `"""` escape FIRST so we don't double-escape
 * the backslashes we just inserted. */
export function renderCodexAgent(spec: RoleSpec): string {
  const model = codexModel(spec.model);
  const sandbox = spec.sandbox ? `sandbox_mode = "${spec.sandbox}"\n` : "";
  // Per TOML spec (https://toml.io/en/v1.0.0#string), inside a literal
  // multi-line basic string, the only way to embed the closing delimiter
  // is `""\"`. The 2-quote + backslash + 1-quote pattern lets the parser
  // consume `""` as data, the `\` as a literal backslash (no escapes are
  // processed in multi-line basic strings), and the final `"` terminates
  // the embedded `"""` token without closing the string.
  //
  // Defect: the old 2-pass backslash-then-triple-quote replace double-
  // escaped the backslashes. The first commit's 4-quote embed was also
  // wrong — smol-toml parser rejects `""""` (it needs `""\"`, not
  // `""""`). Verified empirically with a parse-roundtrip test.
  // Multi-line basic strings DO process escape sequences, so we must also
  // double up literal backslashes (otherwise `\c` or `\d` etc. are rejected
  // as "unrecognized escape sequence"). Order: embed `"""` first, then
  // escape backslashes (escaping backslashes first would double-escape
  // the backslash we just inserted in step 1).
  // Order matters:
  //   1. Escape literal backslashes (\ -> \\). This is needed because
  //      multi-line basic strings process escape sequences, and unknown
  //      ones (\c, \x, etc.) are rejected. Any backslash in the body
  //      must be doubled so it survives the TOML parser as 1 data char.
  //   2. Embed the closing delimiter (""" -> ""\"). This pattern is per
  //      TOML spec. The inserted \ is a literal backslash (it is itself
  //      NOT escaped further because backslash-escape was step 1).
  //
  // Doing step 2 first would over-escape: the inserted \ would become
  // \\ (4 chars in raw output = 2 data backslashes) instead of 1.
  // Per TOML spec (https://toml.io/en/v1.0.0#string), inside a multi-line
  // basic string, the only way to embed the closing delimiter is `""\"`.
  // Escape backslashes FIRST (so unknown TOML escape sequences in the body
  // are not rejected), then embed `"""`. To preserve the body byte-for-
  // byte we let the auto-trim rule do its thing on the first newline
  // (a newline immediately after `"""` is trimmed by the parser). The
  // previous attempt added a `\` after the opener to suppress this trim,
  // but that ate any leading whitespace in the body (round-trip failure
  // for markdown starting with `# ` or a blank line).
  // Per TOML spec, the closer-on-same-line form (`${body}"""`) means
  // the body's trailing newline (if any) is implicitly consumed by the
  // closer placement — a body that originally ended in `\n` would lose
  // it. The closer-on-own-line form (separate `"""` on the next line)
  // preserves the trailing newline.
  //
  // Convention: closer on its own line. This means bodies WITHOUT a
  // trailing newline will gain one on round-trip (the auto-trim of the
  // leading newline doesn't apply, but the closer placement adds a
  // terminating newline). Documented limitation; harmless for markdown
  // and matches the typical "body ends in \n" usage.
  const escaped = spec.body.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
  return [
    `name = "${tomlQuote(spec.name)}"`,
    `description = "${tomlQuote(spec.description)}"`,
    `developer_instructions = """`, // parser auto-trims the first newline (TOML spec)
    escaped,
    `"""`,
    `model = "${model}"`,
    sandbox,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Render a GitHub Copilot agent file: Markdown + YAML frontmatter, but
 * with `tools` as a YAML list (Copilot's schema differs from Claude's
 * comma-separated string). No `model` field — Copilot doesn't expose one.
 * Path: `.github/agents/<name>.md`. */
export function renderCopilotAgent(spec: RoleSpec): string {
  const toolsList = spec.tools.map((t) => `  - ${CLAUDE_TOOL_MAP[t]}`).join("\n");
  return [
    "---",
    `name: ${yamlQuote(spec.name)}`,
    `description: ${yamlQuote(spec.description)}`,
    "tools:",
    toolsList,
    "---",
    "",
    spec.body,
  ].join("\n");
}

/** Render an OpenCode agent file: Markdown + YAML frontmatter (opencode.ai/docs/agents).
 * No `name` field — opencode derives the agent name from the filename. No `tools` field
 * either — opencode's schema is `permission` (per-tool allow/deny), not a tool allowlist;
 * RoleSpec's `tools` here means "needs full access", which is opencode's default, so we
 * omit `permission` and let it fall through to allow-everything. Path: `.opencode/agents/<name>.md`. */
export function renderOpencodeAgent(spec: RoleSpec): string {
  return [
    "---",
    `description: ${yamlQuote(spec.description)}`,
    "mode: subagent",
    "---",
    "",
    spec.body,
  ].join("\n");
}

export function renderAntigravityAgent(spec: RoleSpec): string {
  return [
    "---",
    `name: ${yamlQuote(spec.name)}`,
    `description: ${yamlQuote(spec.description)}`,
    "---",
    "",
    spec.body,
  ].join("\n");
}

/** Render the agent file body for a given engine. */
export function renderForEngine(engine: AgentEngine, spec: RoleSpec): string {
  switch (engine) {
    case "claude":
      return renderClaudeAgent(spec);
    case "codex":
      return renderCodexAgent(spec);
    case "copilot":
      return renderCopilotAgent(spec);
    case "opencode":
      return renderOpencodeAgent(spec);
    case "antigravity":
      return renderAntigravityAgent(spec);
  }
}

/** The canonical path on disk for an agent file, per engine. Throws
 * when the supplied name reduces to `_invalid` (caller is expected to
 * filter out invalid role names from the registry or the user input
 * BEFORE calling this; silently writing to `_invalid.md` would mask
 * collisions and lose data on re-init). */
export function agentFilePath(engine: AgentEngine, name: string): string {
  const safe = safeAgentName(name);
  if (safe === "_invalid") {
    throw new Error(
      `agentFilePath: invalid name '${name}' sanitises to '_invalid' placeholder; fix the input`,
    );
  }
  switch (engine) {
    case "claude":
      return `.claude/agents/${safe}.md`;
    case "codex":
      return `.codex/agents/${safe}.toml`;
    case "copilot":
      return `.github/agents/${safe}.md`;
    case "opencode":
      return `.opencode/agents/${safe}.md`;
    case "antigravity":
      return `.agents/agents/${safe}/agent.md`;
  }
}
