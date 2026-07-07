import { describe, expect, test } from "bun:test";
import type { AskInvocation } from "../src/commands/ask.js";
import type { EngineReadiness } from "../src/preflight/types.js";
import {
  type AskRunDeps,
  askResponse,
  resolveAskTarget,
  runAskRequest,
} from "../src/server/ask-route.js";

const REPO = "/repo";

function ready(engine: string, level: EngineReadiness["level"] = "ready"): EngineReadiness {
  return { engine: engine as EngineReadiness["engine"], level, detail: "", checkedAt: "t" };
}

const okBody = { path: "src/x.ts", start: 2, end: 4, question: "why?" };

/** Narrow to the error branch for message assertions. */
function errOf(r: ReturnType<typeof resolveAskTarget>): string {
  return (r as { error: string }).error;
}

describe("resolveAskTarget — validation", () => {
  test("valid in-repo path resolves under activeRepo", () => {
    const r = resolveAskTarget(REPO, okBody);
    expect(r).toEqual({
      absPath: "/repo/src/x.ts",
      start: 2,
      end: 4,
      question: "why?",
      engine: undefined,
      resume: false,
    });
  });

  test("optional engine accepted when valid; resume flag threaded", () => {
    const r = resolveAskTarget(REPO, { ...okBody, engine: "codex", resume: true });
    expect(r).toMatchObject({ engine: "codex", resume: true });
  });

  test("non-object body → 400", () => {
    expect(resolveAskTarget(REPO, "nope")).toEqual({ error: "invalid request body", status: 400 });
  });

  test("null body → 400", () => {
    expect(resolveAskTarget(REPO, null)).toEqual({ error: "invalid request body", status: 400 });
  });

  test("missing path → 400", () => {
    expect(resolveAskTarget(REPO, { ...okBody, path: "  " })).toMatchObject({ status: 400 });
    expect(errOf(resolveAskTarget(REPO, { start: 1, end: 1, question: "q" }))).toMatch(/path/);
  });

  test("missing question → 400", () => {
    const r = resolveAskTarget(REPO, { path: "a.ts", start: 1, end: 1 });
    expect(r).toEqual({ error: "question is required", status: 400 });
  });

  test("over-cap question → 400", () => {
    const r = resolveAskTarget(REPO, { ...okBody, question: "x".repeat(10_001) });
    expect(r).toMatchObject({ status: 400, error: expect.stringMatching(/too long/) });
  });

  test("bad range (non-int, <1, end<start) → 400", () => {
    expect(resolveAskTarget(REPO, { ...okBody, start: 0 })).toMatchObject({ status: 400 });
    expect(errOf(resolveAskTarget(REPO, { ...okBody, start: 5, end: 2 }))).toMatch(/range/);
  });

  test("bad engine → 400", () => {
    const r = resolveAskTarget(REPO, { ...okBody, engine: "gpt" });
    expect(r).toMatchObject({ status: 400, error: expect.stringMatching(/invalid engine/) });
  });

  // --- SECURITY: path traversal guard (#562 §5) ---
  test("rejects '../../etc/passwd' traversal", () => {
    const r = resolveAskTarget(REPO, { ...okBody, path: "../../etc/passwd" });
    expect(r).toEqual({ error: "path escapes repo", status: 400 });
  });

  test("rejects absolute '/etc/passwd'", () => {
    const r = resolveAskTarget(REPO, { ...okBody, path: "/etc/passwd" });
    expect(r).toEqual({ error: "path escapes repo", status: 400 });
  });

  test("accepts a legit in-repo relative path", () => {
    const r = resolveAskTarget(REPO, { ...okBody, path: "src/deep/nested.ts" });
    expect(r).toMatchObject({ absPath: "/repo/src/deep/nested.ts" });
  });
});

describe("runAskRequest — orchestration (injected seams, never spawns a real engine)", () => {
  const deps = (over: Partial<AskRunDeps> = {}): AskRunDeps => ({
    readiness: () => [ready("claude")],
    readText: () => "l1\nl2\nl3\nl4\nl5",
    spawn: () => ({ code: 0, text: "ANSWER" }),
    ...over,
  });

  test("happy path: reads, slices, frames, spawns, returns answer", () => {
    let seen: { inv: AskInvocation; prompt: string } | undefined;
    const r = runAskRequest(
      REPO,
      okBody,
      deps({
        spawn: (inv, prompt) => {
          seen = { inv, prompt };
          return { code: 0, text: "ANSWER" };
        },
      }),
    );
    expect(r).toEqual({ ok: true, engine: "claude", answer: "ANSWER", code: 0 });
    expect(seen?.inv.cmd).toBe("claude");
    expect(seen?.prompt).toContain("l2\nl3\nl4"); // sliced 2-4
    expect(seen?.prompt).toContain("why?");
  });

  test("validation error passes straight through", () => {
    expect(runAskRequest(REPO, { path: "a.ts", start: 1, end: 1 }, deps())).toEqual({
      error: "question is required",
      status: 400,
    });
  });

  test("unreadable file → 400", () => {
    const r = runAskRequest(
      REPO,
      okBody,
      deps({
        readText: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(r).toEqual({ error: "cannot read file", status: 400 });
  });

  test("range past EOF → 400", () => {
    const r = runAskRequest(REPO, { ...okBody, start: 50, end: 60 }, deps());
    expect(r).toMatchObject({ status: 400 });
  });

  test("no ready engine → 400", () => {
    const r = runAskRequest(
      REPO,
      okBody,
      deps({ readiness: () => [ready("claude", "no-binary")] }),
    );
    expect(r).toMatchObject({ status: 400 });
  });

  test("default deps arrows are allocated (readText/readiness/spawn ?? fallbacks)", () => {
    // Omit readText → default readFileSync arrow runs and throws on the fake abs
    // path → 400. Proves the ?? fallback line executes without injecting it.
    const r = runAskRequest(REPO, okBody, {
      readiness: () => [ready("claude", "no-binary")],
    });
    expect(r).toMatchObject({ status: 400 });
  });
});

describe("askResponse — Response wrapper", () => {
  const good: AskRunDeps = {
    readiness: () => [ready("claude")],
    readText: () => "a\nb\nc\nd\ne",
    spawn: () => ({ code: 0, text: "OK" }),
  };

  test("error → JSON with its status", async () => {
    const res = askResponse(REPO, { path: "a.ts", start: 1, end: 1 }, good);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("question is required");
  });

  test("ok → 200 { ok, engine, answer, code }", async () => {
    const res = askResponse(REPO, okBody, good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, engine: "claude", answer: "OK", code: 0 });
  });
});
