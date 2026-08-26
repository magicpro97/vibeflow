import { ENGINES, type Engine, cwd } from "./core.js";
import { type OwnedAiRouteRunner, runOwnedAiRoute } from "./dispatch/owned-ai-route.js";
import { ENGINE_ARG_PROMPT_LIMIT_BYTES } from "./dispatch/prompt-limits.js";
import type { AsyncSpawner } from "./dispatch/types.js";
import type { EngineReadiness } from "./preflight/types.js";
import { readSettings } from "./settings.js";

type PromptMode = "stdin" | "arg";

export interface AskInvocation {
  cmd: string;
  args: string[];
  promptMode: PromptMode;
}

export interface ParsedTarget {
  path: string;
  start: number;
  end: number;
}

export function parseTarget(spec: string | undefined): ParsedTarget | string {
  if (!spec) return 'missing <path>:<lines> — e.g. `vf ask src/x.ts:5-12 "why?"`';
  const at = spec.lastIndexOf(":");
  if (at <= 0) return `invalid target "${spec}" — expected <path>:<start>[-<end>]`;
  const path = spec.slice(0, at);
  const range = spec.slice(at + 1);
  const match = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (!path || !match) return `invalid line spec "${range}" — expected <start>[-<end>]`;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1) return `invalid line range "${range}" — lines are 1-indexed`;
  if (end < start) return `invalid line range "${range}" — end before start`;
  return { path, start, end };
}

export function sliceRange(text: string, start: number, end: number): string | { snippet: string } {
  const lines = text.split("\n");
  if (start > lines.length) return `line ${start} is past end of file (${lines.length} lines)`;
  return { snippet: lines.slice(start - 1, end).join("\n") };
}

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

export function askInvocation(engine: Engine): AskInvocation {
  switch (engine) {
    case "claude":
      return { cmd: "claude", args: ["-p"], promptMode: "stdin" };
    case "codex":
      return { cmd: "codex", args: ["exec", "-"], promptMode: "stdin" };
    case "copilot":
      return { cmd: "copilot", args: ["-p", "--allow-all"], promptMode: "arg" };
    case "opencode":
      return { cmd: "opencode", args: ["run", "--format", "json", "-"], promptMode: "stdin" };
    case "antigravity":
      return { cmd: "agy", args: ["-p"], promptMode: "arg" };
  }
  throw new Error(`unreachable: unhandled engine ${engine satisfies never}`);
}

export function resumeInvocation(engine: Engine): AskInvocation | string {
  switch (engine) {
    case "claude":
      return { cmd: "claude", args: ["-c", "-p"], promptMode: "stdin" };
    case "codex":
      return { cmd: "codex", args: ["exec", "resume", "--last", "-"], promptMode: "stdin" };
    case "copilot":
      return "resume is not supported for copilot — omit --resume to ask a fresh question";
    case "opencode":
      return {
        cmd: "opencode",
        args: ["run", "--continue", "--format", "json", "-"],
        promptMode: "stdin",
      };
    case "antigravity":
      return { cmd: "agy", args: ["--continue", "-p"], promptMode: "arg" };
  }
  throw new Error(`unreachable: unhandled engine ${engine satisfies never}`);
}

export function pickEngine(
  readiness: EngineReadiness[],
  override: string | undefined,
): Engine | string {
  if (override) {
    if (!(ENGINES as string[]).includes(override))
      return `unknown engine "${override}" — valid: ${ENGINES.join(", ")}`;
    const ready = readiness.find((row) => row.engine === override);
    if (!ready || ready.level !== "ready")
      return `engine "${override}" is not ready${ready ? ` (${ready.detail})` : ""} — run \`vf doctor --probe\``;
    return override as Engine;
  }
  const ready = ENGINES.find((engine) =>
    readiness.find((row) => row.engine === engine && row.level === "ready"),
  );
  return ready ?? "no ready engine — run `vf doctor --probe` or pass --engine <name>";
}

export function materializeArgs(inv: AskInvocation, prompt: string): string[] {
  if (
    inv.cmd === "agy" &&
    inv.promptMode === "arg" &&
    Buffer.byteLength(prompt, "utf8") >= ENGINE_ARG_PROMPT_LIMIT_BYTES
  )
    throw new Error("Antigravity prompt too large for agy argv; shorten or split the task");
  if (inv.promptMode !== "arg") return inv.args;
  const flag = inv.args.findIndex((value) => value === "-p" || value === "--prompt");
  if (flag === -1) return [...inv.args, prompt];
  const args = [...inv.args];
  args.splice(flag + 1, 0, prompt);
  return args;
}

function invocationEngine(inv: AskInvocation): Engine {
  switch (inv.cmd) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "copilot":
      return "copilot";
    case "opencode":
      return "opencode";
    case "agy":
      return "antigravity";
    default:
      throw new Error(`unsupported ask engine command: ${inv.cmd}`);
  }
}

async function ownedAskSpawn(
  inv: AskInvocation,
  prompt: string,
  ownedRoute: OwnedAiRouteRunner,
  callbacks: {
    onChunk?: (text: string) => void;
    onStderrChunk?: (text: string) => void;
  } = {},
) {
  const base = cwd();
  return ownedRoute({
    engine: invocationEngine(inv),
    command: inv.cmd,
    args: materializeArgs(inv, prompt),
    input: inv.promptMode === "stdin" ? prompt : "",
    cwd: base,
    sourceEnv: { ...process.env },
    envPolicy: readSettings(base).envPolicy ?? {},
    ...(callbacks.onChunk ? { onChunk: callbacks.onChunk } : {}),
    ...(callbacks.onStderrChunk ? { onStderrChunk: callbacks.onStderrChunk } : {}),
  });
}

export async function inheritSpawn(
  inv: AskInvocation,
  prompt: string,
  ownedRoute: OwnedAiRouteRunner = runOwnedAiRoute,
): Promise<number> {
  const result = await ownedAskSpawn(inv, prompt, ownedRoute, {
    onChunk: (text) => process.stdout.write(text),
    onStderrChunk: (text) => process.stderr.write(text),
  });
  return result.status;
}

export async function captureSpawn(
  inv: AskInvocation,
  prompt: string,
  onChunk?: (s: string) => void,
  ownedRoute: OwnedAiRouteRunner = runOwnedAiRoute,
): Promise<{ code: number; text: string }> {
  const result = await ownedAskSpawn(inv, prompt, ownedRoute);
  const text = (result.stdout ?? "") || (result.stderr ?? "");
  onChunk?.(text);
  return { code: result.status, text };
}

export async function captureSpawnAsync(
  inv: AskInvocation,
  prompt: string,
  spawner?: AsyncSpawner,
  ownedRoute: OwnedAiRouteRunner = runOwnedAiRoute,
): Promise<{ code: number; text: string }> {
  const result = spawner
    ? await spawner(inv.cmd, materializeArgs(inv, prompt), inv.promptMode === "stdin" ? prompt : "")
    : await ownedAskSpawn(inv, prompt, ownedRoute);
  return { code: result.status, text: result.stdout || result.stderr || "" };
}

export async function streamSpawnAsync(
  inv: AskInvocation,
  prompt: string,
  onChunk: (s: string) => void,
  spawner?: AsyncSpawner,
  ownedRoute: OwnedAiRouteRunner = runOwnedAiRoute,
): Promise<{ code: number; text: string }> {
  const result = spawner
    ? await spawner(inv.cmd, materializeArgs(inv, prompt), inv.promptMode === "stdin" ? prompt : "")
    : await ownedAskSpawn(inv, prompt, ownedRoute, { onChunk });
  return { code: result.status, text: result.stdout || result.stderr || "" };
}
