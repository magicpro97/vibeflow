// src/server/ask-route.ts
//
// #562 Stage B: pure request-validation + orchestration for the Web-UI `vf ask`
// surface (POST /api/ask). Kept OUT of routes.ts so every risky bit — body
// validation, the path-traversal guard, slice, engine pick — is unit-testable
// WITHOUT a live server or a real engine spawn. The route branch is thin glue.

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type AskInvocation,
  askInvocation,
  captureSpawnAsync,
  framePrompt,
  langFence,
  pickEngine,
  sliceRange,
} from "../commands/ask.js";
import { ENGINES, type Engine } from "../core.js";
import { preflightAllAsync } from "../preflight.js";
import type { EngineReadiness } from "../preflight/types.js";

/** Match the /api/init string cap (#526) — bounds an untrusted UI field. */
const QUESTION_CAP = 10_000;

/** Cap the snippet span so a browser request can't force a huge file read / argv. */
const MAX_SNIPPET_LINES = 2_000;

export interface ResolvedAsk {
  absPath: string;
  start: number;
  end: number;
  question: string;
  engine?: string;
}

export interface AskError {
  error: string;
  status: number;
}

/**
 * Validate a POST /api/ask body and resolve its path INSIDE activeRepo.
 * SECURITY (#562 §5): reject any path that escapes the repo (traversal or an
 * absolute path) — resolve+relative is the canonical Node guard.
 */
export function resolveAskTarget(activeRepo: string, body: unknown): ResolvedAsk | AskError {
  if (typeof body !== "object" || body === null)
    return { error: "invalid request body", status: 400 };
  const b = body as Record<string, unknown>;
  if (typeof b.path !== "string" || !b.path.trim())
    return { error: "path is required", status: 400 };
  if (typeof b.question !== "string" || !b.question.trim())
    return { error: "question is required", status: 400 };
  if (b.question.length > QUESTION_CAP)
    return { error: "question too long (max 10,000 chars)", status: 400 };
  if (
    !Number.isInteger(b.start) ||
    !Number.isInteger(b.end) ||
    (b.start as number) < 1 ||
    (b.end as number) < (b.start as number)
  )
    return { error: "invalid line range — positive ints, end >= start", status: 400 };
  // Bound the snippet span: a browser-reachable route must not be coaxed into
  // reading/splitting a huge range or building an oversized argv prompt (copilot).
  if ((b.end as number) - (b.start as number) + 1 > MAX_SNIPPET_LINES)
    return { error: `line range too large (max ${MAX_SNIPPET_LINES} lines)`, status: 400 };
  if (
    b.engine !== undefined &&
    (typeof b.engine !== "string" || !(ENGINES as string[]).includes(b.engine))
  )
    return { error: `invalid engine — valid: ${ENGINES.join(", ")}`, status: 400 };
  // Path traversal guard: abs must stay under activeRepo.
  const abs = resolve(activeRepo, b.path);
  const rel = relative(activeRepo, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "path escapes repo", status: 400 };
  return {
    absPath: abs,
    start: b.start as number,
    end: b.end as number,
    question: b.question,
    engine: b.engine as string | undefined,
  };
}

/** Injected seams (mirrors AskDeps in ask.ts) so the orchestration is hermetic. */
export interface AskRunDeps {
  readiness?: (engines: Engine[]) => Promise<EngineReadiness[]>;
  spawn?: (inv: AskInvocation, prompt: string) => Promise<{ code: number; text: string }>;
  readText?: (path: string) => string;
  /**
   * Resolve symlinks for the traversal re-check. Default realpathSync. The string
   * guard in resolveAskTarget blocks `..`/absolute PATHS but not a symlink that
   * lives inside the repo and points OUT — resolve() doesn't follow links, only
   * realpath does. Tests inject a fake to stay off-disk.
   */
  realpath?: (p: string) => string;
}

export interface AskResult {
  ok: true;
  engine: Engine;
  answer: string;
  code: number;
}

/**
 * Post-resolve symlink guard: the file's REAL path (symlinks followed) must still
 * sit under the repo's real path. Closes the "symlink inside repo → /etc/passwd"
 * escape that the pure string guard cannot see. Returns true when safe.
 */
export function realpathWithinRepo(
  activeRepo: string,
  absPath: string,
  realpath: (p: string) => string,
): boolean {
  let realRepo: string;
  let realTarget: string;
  try {
    realRepo = realpath(activeRepo);
    realTarget = realpath(absPath);
  } catch {
    return false; // target does not exist / unreadable → treat as unsafe
  }
  const rel = relative(realRepo, realTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Orchestrate a FRESH ask (path+lines+question). Resume via the API is a
 * follow-up (Stage B keeps scope tight). Returns plain data — the caller wraps
 * it in a Response. Every step is injectable so tests never spawn a real engine.
 */
export async function runAskRequest(
  activeRepo: string,
  body: unknown,
  deps: AskRunDeps = {},
): Promise<AskResult | AskError> {
  const resolved = resolveAskTarget(activeRepo, body);
  if ("error" in resolved) return resolved;

  // Symlink escape guard (see realpathWithinRepo): the string guard in
  // resolveAskTarget can't see a symlink that points out of the repo.
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  if (!realpathWithinRepo(activeRepo, resolved.absPath, realpath))
    return { error: "path escapes repo", status: 400 };

  const readText = deps.readText ?? ((p: string) => readFileSync(p, "utf8"));
  let text: string;
  try {
    text = readText(resolved.absPath);
  } catch {
    return { error: "cannot read file", status: 400 };
  }
  const sliced = sliceRange(text, resolved.start, resolved.end);
  if (typeof sliced === "string") return { error: sliced, status: 400 };

  const readiness = await (
    deps.readiness ?? ((e: Engine[]) => preflightAllAsync(e, { probe: true }))
  )(ENGINES);
  const engine = pickEngine(readiness, resolved.engine);
  if (typeof engine === "string" && !(ENGINES as string[]).includes(engine))
    return { error: engine, status: 400 };
  const eng = engine as Engine;

  const lang = langFence(resolved.absPath);
  const prompt = framePrompt(
    resolved.absPath,
    resolved.start,
    resolved.end,
    lang,
    sliced.snippet,
    resolved.question,
  );
  const spawn = deps.spawn ?? captureSpawnAsync;
  const { code, text: answer } = await spawn(askInvocation(eng), prompt);
  return { ok: true, engine: eng, answer, code };
}

/** Route glue: run the ask and wrap the result in a JSON Response. */
export async function askResponse(
  activeRepo: string,
  body: unknown,
  deps?: AskRunDeps,
): Promise<Response> {
  const result = await runAskRequest(activeRepo, body, deps);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  // Honesty (codex review): a non-zero engine exit is NOT a success — report ok:false
  // so the UI surfaces it as a failure instead of rendering empty output as an answer.
  return Response.json({
    ok: result.code === 0,
    engine: result.engine,
    answer: result.answer,
    code: result.code,
  });
}
