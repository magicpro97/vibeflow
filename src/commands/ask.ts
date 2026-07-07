// src/commands/ask.ts
//
// #562: `vf ask <path>:<start>-<end> "<question>"` — inline code Q&A.
// Reads a line range, frames a fenced prompt, picks the first ready engine
// (or --engine), and streams the answer straight to the terminal via
// inherit-stdio. Reuses vf's readiness selection; no new dispatch path, no dep.
//
// ponytail: inherit-stdio instead of a streaming JSON parser — the engine writes
//   to the user's TTY directly, which IS streaming. Upgrade to a captured/parsed
//   stream only if `vf ask` ever needs its output in the logbus (it doesn't today).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ENGINES, type Engine, c } from "../core.js";
import { out } from "../logbus.js";
import { preflightAll } from "../preflight.js";
import type { EngineReadiness } from "../preflight/types.js";

/** Prompt delivery per engine: on stdin, or as a trailing argv token. */
type PromptMode = "stdin" | "arg";

export interface AskInvocation {
  cmd: string;
  args: string[];
  promptMode: PromptMode;
}

export interface AskDeps {
  /** Readiness probe (default: real preflightAll with a live probe). */
  readiness?: (engines: Engine[]) => EngineReadiness[];
  /** Spawn seam: run cmd with the prompt, stream to the terminal, return exit code. */
  spawn?: (inv: AskInvocation, prompt: string) => number;
  /** File reader (default: readFileSync utf8). */
  readText?: (path: string) => string;
}

export interface ParsedTarget {
  path: string;
  start: number;
  end: number;
}

/**
 * Parse `<path>:<start>[-<end>]`. Windows-safe: the line spec is the tail after
 * the LAST colon, so `C:\a\b.ts:3-4` keeps the drive letter in the path.
 * Returns a string (error message) on any malformed input.
 */
export function parseTarget(spec: string | undefined): ParsedTarget | string {
  if (!spec) return 'missing <path>:<lines> — e.g. `vf ask src/x.ts:5-12 "why?"`';
  const at = spec.lastIndexOf(":");
  if (at <= 0) return `invalid target "${spec}" — expected <path>:<start>[-<end>]`;
  const path = spec.slice(0, at);
  const range = spec.slice(at + 1);
  const m = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (!path || !m) return `invalid line spec "${range}" — expected <start>[-<end>]`;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1) return `invalid line range "${range}" — lines are 1-indexed`;
  if (end < start) return `invalid line range "${range}" — end before start`;
  return { path, start, end };
}

/** 1-indexed inclusive slice. Error string when the range exceeds the file. */
export function sliceRange(text: string, start: number, end: number): string | { snippet: string } {
  const lines = text.split("\n");
  if (start > lines.length) return `line ${start} is past end of file (${lines.length} lines)`;
  return { snippet: lines.slice(start - 1, end).join("\n") };
}

/** Map a file extension to a markdown fence tag; "" when unknown. */
export function langFence(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    toml: "toml",
    md: "markdown",
    sql: "sql",
    vue: "vue",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    lua: "lua",
    r: "r",
  };
  return map[ext] ?? "";
}

/** Frame the snippet + question into the engine prompt (mirrors #562's framing). */
export function framePrompt(
  path: string,
  start: number,
  end: number,
  lang: string,
  snippet: string,
  question: string,
): string {
  const lineRef = start === end ? `line ${start}` : `lines ${start}-${end}`;
  return `In file ${path}, ${lineRef}:\n\n\`\`\`${lang}\n${snippet}\n\`\`\`\n\n${question}`;
}

/** Plain (streamable) non-interactive invocation per engine — no JSON envelope. */
export function askInvocation(engine: Engine): AskInvocation {
  switch (engine) {
    case "claude":
      return { cmd: "claude", args: ["-p"], promptMode: "stdin" };
    case "codex":
      return { cmd: "codex", args: ["exec", "-"], promptMode: "stdin" };
    case "copilot":
      // copilot takes the prompt as an argv token (promptMode "arg"); --allow-all
      // is its omnibus permission flag (see dispatch.ts copilotCommand).
      return { cmd: "copilot", args: ["-p", "--allow-all"], promptMode: "arg" };
  }
}

/**
 * #562 multi-turn: continue the engine's MOST RECENT conversation so a follow-up
 * `vf ask --resume "q2"` has the prior turn's context. Engine-native, so vf stores
 * no session state — the engine tracks its own most-recent conversation.
 *   - claude: `-c -p` (continue most recent, print mode, prompt on stdin)
 *   - codex:  `exec resume --last -` (resume most recent, prompt on stdin)
 *   - copilot: no stable resume flag → returns a string (unsupported) so the caller errors.
 */
export function resumeInvocation(engine: Engine): AskInvocation | string {
  switch (engine) {
    case "claude":
      return { cmd: "claude", args: ["-c", "-p"], promptMode: "stdin" };
    case "codex":
      return { cmd: "codex", args: ["exec", "resume", "--last", "-"], promptMode: "stdin" };
    case "copilot":
      return "resume is not supported for copilot — omit --resume to ask a fresh question";
  }
}

/** Choose the engine: an explicit override must be ready; else first ready in ENGINES order. */
export function pickEngine(
  readiness: EngineReadiness[],
  override: string | undefined,
): Engine | string {
  if (override) {
    if (!(ENGINES as string[]).includes(override)) {
      return `unknown engine "${override}" — valid: ${ENGINES.join(", ")}`;
    }
    const r = readiness.find((x) => x.engine === override);
    if (!r || r.level !== "ready") {
      return `engine "${override}" is not ready${r ? ` (${r.detail})` : ""} — run \`vf doctor --probe\``;
    }
    return override as Engine;
  }
  const ready = ENGINES.find((e) => readiness.find((x) => x.engine === e && x.level === "ready"));
  if (!ready) return "no ready engine — run `vf doctor --probe` or pass --engine <name>";
  return ready;
}

/** Default spawn: stream the engine's answer straight to the terminal. */
export function inheritSpawn(inv: AskInvocation, prompt: string): number {
  const args = inv.promptMode === "arg" ? [...inv.args, prompt] : inv.args;
  const r = spawnSync(inv.cmd, args, {
    input: inv.promptMode === "stdin" ? prompt : undefined,
    stdio: [inv.promptMode === "stdin" ? "pipe" : "ignore", "inherit", "inherit"],
  });
  return r.status ?? 1;
}

/**
 * Captured runner: like inheritSpawn but COLLECTS stdout instead of streaming to
 * the TTY. The Web-UI /api/ask route needs this — a browser has no TTY. onChunk
 * fires ONCE with the full text; spawnSync is not incrementally streaming, so true
 * token streaming (SSE) is a follow-up. #556 env-filtering is also a follow-up:
 * spawnSync inherits process.env, acceptable for a local third-party engine CLI.
 */
export function captureSpawn(
  inv: AskInvocation,
  prompt: string,
  onChunk?: (s: string) => void,
): { code: number; text: string } {
  const args = inv.promptMode === "arg" ? [...inv.args, prompt] : inv.args;
  const r = spawnSync(inv.cmd, args, {
    input: inv.promptMode === "stdin" ? prompt : undefined,
    stdio: [inv.promptMode === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const text = r.stdout ?? "";
  onChunk?.(text);
  return { code: r.status ?? 1, text };
}

function fail(msg: string): number {
  out("vf", c.red(`ask: ${msg}`), { level: "error" });
  return 2;
}

export async function ask(
  positionals: string[],
  flags: Record<string, string | boolean> = {},
  deps: AskDeps = {},
): Promise<number> {
  const resume = flags.resume === true;

  // Resolve the engine first (both paths need it).
  const readiness = (deps.readiness ?? ((e: Engine[]) => preflightAll(e, { probe: true })))(
    ENGINES,
  );
  const engine = pickEngine(readiness, typeof flags.engine === "string" ? flags.engine : undefined);
  if (typeof engine === "string" && !(ENGINES as string[]).includes(engine)) return fail(engine);
  const eng = engine as Engine;

  const spawn = deps.spawn ?? inheritSpawn;

  // --resume: continue the engine's most-recent conversation with just a follow-up
  // question — no target/snippet needed (the prior turn already has the code context).
  if (resume) {
    const question = positionals.join(" ").trim();
    if (!question) return fail('missing question — e.g. `vf ask --resume "and why is that safe?"`');
    const inv = resumeInvocation(eng);
    if (typeof inv === "string") return fail(inv);
    out("vf", c.dim(`ask: ${eng} · continuing previous conversation`));
    return spawn(inv, question);
  }

  // Fresh ask: <path>:<lines> "<question>".
  const target = parseTarget(positionals[0]);
  if (typeof target === "string") return fail(target);
  const question = positionals.slice(1).join(" ").trim();
  if (!question) return fail('missing question — e.g. `vf ask src/x.ts:5-12 "what does this do?"`');

  const readText = deps.readText ?? ((p: string) => readFileSync(p, "utf8"));
  let text: string;
  try {
    text = readText(target.path);
  } catch {
    return fail(`no such file: ${target.path}`);
  }
  const sliced = sliceRange(text, target.start, target.end);
  if (typeof sliced === "string") return fail(sliced);

  const lang = langFence(target.path);
  const prompt = framePrompt(target.path, target.start, target.end, lang, sliced.snippet, question);
  const inv = askInvocation(eng);
  out("vf", c.dim(`ask: ${eng} · ${target.path}:${target.start}-${target.end}`));
  return spawn(inv, prompt);
}
