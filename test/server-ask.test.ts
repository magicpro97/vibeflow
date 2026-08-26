import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AskInvocation } from "../src/commands/ask.js";
import { captureSpawnAsync, resumeInvocation, streamSpawnAsync } from "../src/commands/ask.js";
import type { OwnedAiRouteRequest, OwnedAiRouteRunner } from "../src/dispatch/owned-ai-route.js";
import type { AsyncSpawner } from "../src/dispatch/types.js";
import type { EngineReadiness } from "../src/preflight/types.js";
import { startServer } from "../src/server.js";
import {
  type AskRunDeps,
  askResponse,
  askStreamResponse,
  prepareAsk,
  realpathWithinRepo,
  resolveAskTarget,
  runAskRequest,
} from "../src/server/ask-route.js";
import { writeSettings } from "../src/settings.js";

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
      absPath: resolve(REPO, "src/x.ts"),
      start: 2,
      end: 4,
      question: "why?",
      engine: undefined,
    });
  });

  test("optional engine accepted when valid", () => {
    const r = resolveAskTarget(REPO, { ...okBody, engine: "codex" });
    expect(r).toMatchObject({ engine: "codex" });
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

  test("oversized line range → 400 (snippet-span cap, DoS guard)", () => {
    const r = resolveAskTarget(REPO, { ...okBody, start: 1, end: 5000 });
    expect(r).toMatchObject({ status: 400, error: expect.stringMatching(/too large/) });
    // exactly at the cap (2000 lines) is allowed
    expect(resolveAskTarget(REPO, { ...okBody, start: 1, end: 2000 })).not.toHaveProperty("error");
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
    expect(r).toMatchObject({ absPath: resolve(REPO, "src/deep/nested.ts") });
  });
});

describe("runAskRequest — orchestration (injected seams, never spawns a real engine)", () => {
  const deps = (over: Partial<AskRunDeps> = {}): AskRunDeps => ({
    readiness: () => Promise.resolve([ready("claude")]),
    readText: () => "l1\nl2\nl3\nl4\nl5",
    spawn: () => Promise.resolve({ code: 0, text: "ANSWER" }),
    // identity realpath = no symlink escape (paths already under the repo). Real
    // symlink handling is covered in the dedicated realpathWithinRepo suite below.
    realpath: (p: string) => p,
    ...over,
  });

  test("happy path: reads, slices, frames, spawns, returns answer", async () => {
    let seen: { inv: AskInvocation; prompt: string } | undefined;
    const r = await runAskRequest(
      REPO,
      okBody,
      deps({
        spawn: (inv, prompt) => {
          seen = { inv, prompt };
          return Promise.resolve({ code: 0, text: "ANSWER" });
        },
      }),
    );
    expect(r).toEqual({ ok: true, engine: "claude", answer: "ANSWER", code: 0 });
    expect(seen?.inv.cmd).toBe("claude");
    expect(seen?.prompt).toContain("l2\nl3\nl4"); // sliced 2-4
    expect(seen?.prompt).toContain("why?");
  });

  test("validation error passes straight through", async () => {
    expect(await runAskRequest(REPO, { path: "a.ts", start: 1, end: 1 }, deps())).toEqual({
      error: "question is required",
      status: 400,
    });
  });

  test("unreadable file → 400", async () => {
    const r = await runAskRequest(
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

  test("range past EOF → 400", async () => {
    const r = await runAskRequest(REPO, { ...okBody, start: 50, end: 60 }, deps());
    expect(r).toMatchObject({ status: 400 });
  });

  test("no ready engine → 400", async () => {
    const r = await runAskRequest(
      REPO,
      okBody,
      deps({ readiness: () => Promise.resolve([ready("claude", "no-binary")]) }),
    );
    expect(r).toMatchObject({ status: 400 });
  });

  test("default deps arrows are allocated (readText/readiness/spawn/realpath ?? fallbacks)", async () => {
    // Omit every dep → the default realpath (realpathSync) runs first on the fake
    // abs path, which does not exist → the symlink guard returns 400. Proves the
    // ?? fallback arrows execute without injection.
    const r = await runAskRequest(REPO, okBody, {});
    expect(r).toMatchObject({ status: 400 });
  });
});

describe("realpathWithinRepo — symlink escape guard (#562 security)", () => {
  test("in-repo real path → safe (true)", () => {
    const rp = (p: string) => p; // identity: no symlink indirection
    expect(realpathWithinRepo("/repo", "/repo/src/x.ts", rp)).toBe(true);
  });

  test("repo root itself → safe (rel === '')", () => {
    expect(realpathWithinRepo("/repo", "/repo", (p) => p)).toBe(true);
  });

  test("symlink pointing OUT of repo → unsafe (false)", () => {
    // A file that resolves (via symlink) to /etc/passwd escapes the repo.
    const rp = (p: string) => (p === "/repo/leak.txt" ? "/etc/passwd" : p);
    expect(realpathWithinRepo("/repo", "/repo/leak.txt", rp)).toBe(false);
  });

  test("realpath throwing (missing target) → unsafe (false)", () => {
    const rp = (p: string) => {
      if (p.endsWith("gone")) throw new Error("ENOENT");
      return p;
    };
    expect(realpathWithinRepo("/repo", "/repo/gone", rp)).toBe(false);
  });

  test("runAskRequest rejects a symlink escape via the injected realpath", async () => {
    const r = await runAskRequest(REPO, okBody, {
      readiness: () => Promise.resolve([ready("claude")]),
      readText: () => "x",
      spawn: () => Promise.resolve({ code: 0, text: "A" }),
      realpath: (p) => (p === resolve(REPO, "src/x.ts") ? "/etc/passwd" : p),
    });
    expect(r).toEqual({ error: "path escapes repo", status: 400 });
  });
});

describe("askResponse — Response wrapper", () => {
  const good: AskRunDeps = {
    readiness: () => Promise.resolve([ready("claude")]),
    readText: () => "a\nb\nc\nd\ne",
    spawn: () => Promise.resolve({ code: 0, text: "OK" }),
    realpath: (p: string) => p, // identity: in-repo, no symlink escape
  };

  test("error → JSON with its status", async () => {
    const res = await askResponse(REPO, { path: "a.ts", start: 1, end: 1 }, good);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("question is required");
  });

  test("ok → 200 { ok, engine, answer, code }", async () => {
    const res = await askResponse(REPO, okBody, good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, engine: "claude", answer: "OK", code: 0 });
  });

  test("non-zero engine exit → ok:false (honesty, not a fake success)", async () => {
    const res = await askResponse(REPO, okBody, {
      ...good,
      spawn: () => Promise.resolve({ code: 1, text: "" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, engine: "claude", answer: "", code: 1 });
  });
});

describe("captureSpawnAsync — async capture seam (#584)", () => {
  test("happy path: spawner {status:0, stdout:'hi'} → {code:0, text:'hi'}", async () => {
    const r = await captureSpawnAsync(
      { cmd: "echo", args: ["-n", "hi"], promptMode: "arg" },
      "",
      () => Promise.resolve({ status: 0, stdout: "hi" }),
    );
    expect(r).toEqual({ code: 0, text: "hi" });
  });

  test("stderr fallback when stdout empty", async () => {
    const r = await captureSpawnAsync(
      { cmd: "sh", args: ["-c", "exit 1"], promptMode: "arg" },
      "",
      () => Promise.resolve({ status: 1, stdout: "", stderr: "boom" }),
    );
    expect(r).toEqual({ code: 1, text: "boom" });
  });

  test('arg promptMode passes "" as input to the spawner', async () => {
    let receivedInput: string | undefined;
    await captureSpawnAsync(
      { cmd: "claude", args: ["-p"], promptMode: "arg" },
      "hello",
      (_cmd, _args, input) => {
        receivedInput = input;
        return Promise.resolve({ status: 0, stdout: "ok" });
      },
    );
    expect(receivedInput).toBe("");
  });

  test("stdin promptMode passes the prompt as input to the spawner", async () => {
    let receivedInput: string | undefined;
    await captureSpawnAsync(
      { cmd: "claude", args: ["-p"], promptMode: "stdin" },
      "hello",
      (_cmd, _args, input) => {
        receivedInput = input;
        return Promise.resolve({ status: 0, stdout: "ok" });
      },
    );
    expect(receivedInput).toBe("hello");
  });

  test("materializeArgs: arg-mode flags are expanded before spawn", async () => {
    const spy: AsyncSpawner = (cmd, args) => Promise.resolve({ status: 0, stdout: args.join(" ") });
    const r = await captureSpawnAsync(
      { cmd: "copilot", args: ["-p", "--allow-all"], promptMode: "arg" },
      "test question",
      spy,
    );
    expect(r.text).toContain("test question");
    expect(r.text).toContain("-p");
    expect(r.text).toContain("--allow-all");
  });

  test("default owned route receives the configured env policy and a cloned source env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-envpol-"));
    const cwd0 = process.cwd();
    const origVar = process.env.MY_ASK_CUSTOM_VAR;
    let request: OwnedAiRouteRequest | undefined;
    try {
      writeSettings(dir, { envPolicy: { deny: ["MY_ASK_CUSTOM_VAR"] } });
      process.chdir(dir);
      process.env.MY_ASK_CUSTOM_VAR = "leak-me";
      const r = await captureSpawnAsync(
        { cmd: "claude", args: ["-p"], promptMode: "stdin" },
        "",
        undefined,
        async (value) => {
          request = value;
          return {
            attemptId: "ask-capture",
            status: 0,
            stdout: "SCRUBBED",
            stderr: "",
            timedOut: false,
          };
        },
      );
      expect(r.text).toBe("SCRUBBED");
      expect(request?.envPolicy).toEqual({ deny: ["MY_ASK_CUSTOM_VAR"] });
      expect(request?.sourceEnv).not.toBe(process.env);
      expect(request?.sourceEnv?.MY_ASK_CUSTOM_VAR).toBe("leak-me");
    } finally {
      process.chdir(cwd0);
      // biome-ignore lint/performance/noDelete: restore to truly-absent when the var wasn't set
      if (origVar === undefined) delete process.env.MY_ASK_CUSTOM_VAR;
      else process.env.MY_ASK_CUSTOM_VAR = origVar;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prepareAsk — extracted orchestration (#580)", () => {
  const deps = {
    readiness: () => Promise.resolve([ready("claude")]),
    readText: () => "l1\nl2\nl3\nl4\nl5",
    realpath: (p: string) => p,
  };

  test("happy path → { eng, inv, prompt } shape", async () => {
    const r = await prepareAsk(REPO, okBody, deps);
    if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.eng).toBe("claude");
    expect(r.inv.cmd).toBe("claude");
    expect(r.prompt).toContain("l2\nl3\nl4");
    expect(r.prompt).toContain("why?");
  });

  test("validation error → AskError (no spawning)", async () => {
    const r = await prepareAsk(REPO, { path: "a.ts", start: 1, end: 1 }, deps);
    expect(r).toEqual({ error: "question is required", status: 400 });
  });

  test("symlink escape → AskError", async () => {
    const r = await prepareAsk(REPO, okBody, {
      ...deps,
      realpath: (p) => (p === resolve(REPO, "src/x.ts") ? "/etc/passwd" : p),
    });
    expect(r).toEqual({ error: "path escapes repo", status: 400 });
  });

  test("no ready engine → AskError", async () => {
    const r = await prepareAsk(REPO, okBody, {
      ...deps,
      readiness: () => Promise.resolve([ready("claude", "no-binary")]),
    });
    expect(r).toMatchObject({ status: 400 });
  });

  test("existing runAskRequest tests still pass (thin wrapper over prepareAsk)", async () => {
    // Prove prepareAsk is the same logic runAskRequest was before the refactor
    const spawn = () => Promise.resolve({ code: 0, text: "OK" });
    const r = await runAskRequest(REPO, okBody, { ...deps, spawn });
    expect(r).toEqual({ ok: true, engine: "claude", answer: "OK", code: 0 });
  });
});

describe("streamSpawnAsync — SSE onChunk relay (#580)", () => {
  test("wires onChunk into the default owned route", async () => {
    const chunks: string[] = [];
    const route: OwnedAiRouteRunner = async (request) => {
      request.onChunk?.("hello-stream");
      return {
        attemptId: "ask-stream",
        status: 0,
        stdout: "hello-stream",
        stderr: "",
        timedOut: false,
      };
    };
    const r = await streamSpawnAsync(
      { cmd: "codex", args: ["exec", "-"], promptMode: "stdin" },
      "",
      (s) => chunks.push(s),
      undefined,
      route,
    );
    expect(chunks.join("")).toBe("hello-stream");
    expect(r).toEqual({ code: 0, text: "hello-stream" });
  });

  test("maps status→code and returns accumulated text (injected spawner)", async () => {
    const r = await streamSpawnAsync(
      { cmd: "test", args: ["-p"], promptMode: "stdin" },
      "prompt",
      () => {},
      (cmd: string) => {
        expect(cmd).toBe("test");
        return Promise.resolve({ status: 0, stdout: "chunk1chunk2" });
      },
    );
    expect(r).toEqual({ code: 0, text: "chunk1chunk2" });
  });

  test("stderr fallback when stdout empty", async () => {
    const r = await streamSpawnAsync(
      { cmd: "fail", args: [], promptMode: "arg" },
      "",
      () => {},
      () => Promise.resolve({ status: 1, stdout: "", stderr: "oops" }),
    );
    expect(r).toEqual({ code: 1, text: "oops" });
  });

  test("default owned stream route receives envPolicy and cloned source env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-stream-envpol-"));
    const cwd0 = process.cwd();
    const origVar = process.env.MY_ASK_STREAM_VAR;
    let request: OwnedAiRouteRequest | undefined;
    try {
      writeSettings(dir, { envPolicy: { deny: ["MY_ASK_STREAM_VAR"] } });
      process.chdir(dir);
      process.env.MY_ASK_STREAM_VAR = "leak-me";
      const r = await streamSpawnAsync(
        { cmd: "opencode", args: ["run", "-"], promptMode: "stdin" },
        "",
        () => {},
        undefined,
        async (value) => {
          request = value;
          return {
            attemptId: "ask-stream",
            status: 0,
            stdout: "SCRUBBED",
            stderr: "",
            timedOut: false,
          };
        },
      );
      expect(r.text).toBe("SCRUBBED");
      expect(request?.envPolicy).toEqual({ deny: ["MY_ASK_STREAM_VAR"] });
      expect(request?.sourceEnv).not.toBe(process.env);
      expect(request?.sourceEnv?.MY_ASK_STREAM_VAR).toBe("leak-me");
    } finally {
      process.chdir(cwd0);
      // biome-ignore lint/performance/noDelete: restore to truly-absent
      if (origVar === undefined) delete process.env.MY_ASK_STREAM_VAR;
      else process.env.MY_ASK_STREAM_VAR = origVar;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/ask/stream — SSE endpoint (#580)", () => {
  async function csrfToken(url: string): Promise<string> {
    const res = await fetch(url);
    const html = await res.text();
    const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
    if (!m) throw new Error("CSRF token not found");
    return m[1] as string;
  }

  test("403 on bad token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-sse-403-"));
    const cwd0 = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const res = await fetch(
          `${url}/api/ask/stream?path=x.ts&start=1&end=1&question=q&token=bad-token`,
        );
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(cwd0);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("400 on missing params (before stream opens)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-sse-400-"));
    const cwd0 = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        const res = await fetch(
          `${url}/api/ask/stream?path=&start=1&end=1&question=&token=${encodeURIComponent(token)}`,
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBeDefined();
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(cwd0);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("header guards: 403 on missing token query param", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-sse-notok-"));
    const cwd0 = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const res = await fetch(`${url}/api/ask/stream?path=x.ts&start=1&end=1&question=q`);
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(cwd0);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("askStreamResponse — SSE stream body (#580)", () => {
  const prepDeps = {
    readiness: () => Promise.resolve([ready("claude")]),
    readText: () => "l1\nl2\nl3\nl4\nl5",
    realpath: (p: string) => p,
  };

  async function readSSE(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const dec = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    return out;
  }

  test("relays token frames then a done frame (ok=true)", async () => {
    const spawn = (
      _inv: AskInvocation,
      _prompt: string,
      onChunk: (s: string) => void,
    ): Promise<{ code: number; text: string }> => {
      onChunk("hel");
      onChunk("lo");
      return Promise.resolve({ code: 0, text: "hello" });
    };
    const res = await askStreamResponse(REPO, okBody, spawn, prepDeps);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const sse = await readSSE(res);
    expect(sse).toContain(": vibeflow-ask-1");
    expect(sse).toContain(`event: token\ndata: ${JSON.stringify({ text: "hel" })}`);
    expect(sse).toContain(`event: token\ndata: ${JSON.stringify({ text: "lo" })}`);
    expect(sse).toContain(
      `event: done\ndata: ${JSON.stringify({ engine: "claude", code: 0, ok: true })}`,
    );
  });

  test("newline-containing token is JSON-escaped (frame not broken)", async () => {
    const spawn = (
      _inv: AskInvocation,
      _prompt: string,
      onChunk: (s: string) => void,
    ): Promise<{ code: number; text: string }> => {
      onChunk("a\nb");
      return Promise.resolve({ code: 0, text: "a\nb" });
    };
    const sse = await readSSE(await askStreamResponse(REPO, okBody, spawn, prepDeps));
    expect(sse).toContain(`event: token\ndata: ${JSON.stringify({ text: "a\nb" })}`);
  });

  test("non-zero engine exit → done frame ok=false", async () => {
    const spawn = (): Promise<{ code: number; text: string }> =>
      Promise.resolve({ code: 2, text: "boom" });
    const sse = await readSSE(await askStreamResponse(REPO, okBody, spawn, prepDeps));
    expect(sse).toContain(
      `event: done\ndata: ${JSON.stringify({ engine: "claude", code: 2, ok: false })}`,
    );
  });

  test("spawn rejection → error frame", async () => {
    const spawn = (): Promise<{ code: number; text: string }> =>
      Promise.reject(new Error("spawn failed"));
    const sse = await readSSE(await askStreamResponse(REPO, okBody, spawn, prepDeps));
    expect(sse).toContain(`event: error\ndata: ${JSON.stringify({ error: "spawn failed" })}`);
  });

  test("non-Error rejection is stringified (never a {} frame)", async () => {
    const spawn = (): Promise<{ code: number; text: string }> => Promise.reject("boom-string");
    const sse = await readSSE(await askStreamResponse(REPO, okBody, spawn, prepDeps));
    expect(sse).toContain(`event: error\ndata: ${JSON.stringify({ error: "boom-string" })}`);
  });

  test("prep error → 400 JSON before stream opens", async () => {
    const res = await askStreamResponse(
      REPO,
      { path: "a.ts", start: 1, end: 1 },
      () => Promise.resolve({ code: 0, text: "" }),
      prepDeps,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("client disconnect (reader.cancel) stops the heartbeat without throwing", async () => {
    // spawn never resolves → the stream stays open on the heartbeat; cancelling
    // the reader must invoke ReadableStream.cancel() (clearInterval) cleanly.
    let resolveSpawn: (() => void) | undefined;
    const spawn = (): Promise<{ code: number; text: string }> =>
      new Promise((res) => {
        resolveSpawn = () => res({ code: 0, text: "" });
      });
    const response = await askStreamResponse(REPO, okBody, spawn, prepDeps);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    // Read the prelude frame, then disconnect.
    await reader.read();
    await reader.cancel(); // must not throw; clears the heartbeat via cancel()
    resolveSpawn?.(); // let the dangling spawn settle so no unhandled promise
  });
});

// #581: prepareAsk resume branch
describe("prepareAsk — resume (#581)", () => {
  const deps = {
    readiness: () => Promise.resolve([ready("claude"), ready("codex")]),
    readText: () => "",
    realpath: (p: string) => p,
  };

  test("claude resume → { eng, inv: resumeInvocation, prompt: question }", async () => {
    const r = await prepareAsk(
      REPO,
      { resume: true, question: "and then?", engine: "claude" },
      deps,
    );
    if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.eng).toBe("claude");
    expect(r.inv.cmd).toBe("claude");
    expect(r.inv.args).toContain("-c");
    expect(r.prompt).toBe("and then?");
  });

  test("codex resume → invocation includes resume args", async () => {
    const r = await prepareAsk(
      REPO,
      { resume: true, question: "what next?" },
      { ...deps, readiness: () => Promise.resolve([ready("codex")]) },
    );
    if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.eng).toBe("codex");
    expect(r.inv.cmd).toBe("codex");
    expect(r.inv.args).toContain("resume");
    expect(r.prompt).toBe("what next?");
  });

  test("copilot resume → 400 (resumeInvocation returns string)", async () => {
    const r = await prepareAsk(
      REPO,
      { resume: true, question: "why?", engine: "copilot" },
      { ...deps, readiness: () => Promise.resolve([ready("copilot")]) },
    );
    expect(r).toMatchObject({ status: 400, error: expect.stringMatching(/not supported/) });
  });

  test("auto-picked copilot resume → 400 (post-resolve guard)", async () => {
    // engine omitted + only copilot ready → resolveEngine returns copilot, then
    // resumeInvocation(copilot) is the unsupported string → 400. Exercises the
    // guard AFTER resolveEngine (the explicit-copilot fast-path is skipped here).
    const r = await prepareAsk(
      REPO,
      { resume: true, question: "why?" },
      { ...deps, readiness: () => Promise.resolve([ready("copilot")]) },
    );
    expect(r).toMatchObject({ status: 400, error: expect.stringMatching(/not supported/) });
  });

  test("missing question → 400", async () => {
    const r = await prepareAsk(REPO, { resume: true }, deps);
    expect(r).toEqual({ error: "question is required", status: 400 });
  });

  test("empty question → 400", async () => {
    const r = await prepareAsk(REPO, { resume: true, question: "  " }, deps);
    expect(r).toEqual({ error: "question is required", status: 400 });
  });

  test("question over cap → 400", async () => {
    const r = await prepareAsk(REPO, { resume: true, question: "x".repeat(10_001) }, deps);
    expect(r).toMatchObject({ status: 400, error: expect.stringMatching(/too long/) });
  });

  test("unready engine → 400", async () => {
    const r = await prepareAsk(
      REPO,
      { resume: true, question: "q", engine: "claude" },
      { ...deps, readiness: () => Promise.resolve([ready("claude", "no-binary")]) },
    );
    expect(r).toMatchObject({ status: 400 });
  });

  test("invalid engine → 400", async () => {
    const r = await prepareAsk(REPO, { resume: true, question: "q", engine: "gpt" }, deps);
    expect(r).toMatchObject({ status: 400, error: expect.stringMatching(/invalid engine/) });
  });

  test("auto-pick engine when engine omitted", async () => {
    const r = await prepareAsk(REPO, { resume: true, question: "auto-pick me" }, deps);
    if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.eng).toBe("claude"); // first ready in deps order
    expect(r.prompt).toBe("auto-pick me");
  });
});

// #581: prepareAsk fresh still includes inv
describe("prepareAsk — fresh still carries inv (#581)", () => {
  const deps = {
    readiness: () => Promise.resolve([ready("claude")]),
    readText: () => "l1\nl2\nl3\nl4\nl5",
    realpath: (p: string) => p,
  };

  test("fresh prepareAsk returns inv equal to askInvocation(eng)", async () => {
    const r = await prepareAsk(REPO, okBody, deps);
    if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.inv.cmd).toBe("claude");
    expect(r.inv.args).toContain("-p");
    expect(r.inv.args).not.toContain("-c");
  });
});

// #581: runAskRequest with resume=true uses resume invocation
describe("runAskRequest — resume (#581)", () => {
  const deps = (over: Partial<AskRunDeps> = {}): AskRunDeps => ({
    readiness: () => Promise.resolve([ready("claude")]),
    readText: () => "",
    spawn: () => Promise.resolve({ code: 0, text: "OK-RESUME" }),
    realpath: (p: string) => p,
    ...over,
  });

  test("resume=true passes resumeInvocation args to spawn", async () => {
    let seenArgs: string[] | undefined;
    const r = await runAskRequest(
      REPO,
      { resume: true, question: "continue?", engine: "claude" },
      deps({
        spawn: (inv) => {
          seenArgs = inv.args;
          return Promise.resolve({ code: 0, text: "OK" });
        },
      }),
    );
    expect(r).toEqual({ ok: true, engine: "claude", answer: "OK", code: 0 });
    expect(seenArgs).toContain("-c");
    expect(seenArgs).toContain("-p");
  });
});

// #581: askStreamResponse resume — token + done frames
describe("askStreamResponse — resume (#581)", () => {
  const prepDeps = {
    readiness: () => Promise.resolve([ready("claude")]),
    readText: () => "",
    realpath: (p: string) => p,
  };

  async function readSSE(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const dec = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    return out;
  }

  test("resume stream relays token + done frame", async () => {
    const spawn = (
      _inv: AskInvocation,
      _prompt: string,
      onChunk: (s: string) => void,
    ): Promise<{ code: number; text: string }> => {
      onChunk("resume-answer");
      return Promise.resolve({ code: 0, text: "resume-answer" });
    };
    const res = await askStreamResponse(
      REPO,
      { resume: true, question: "go on?", engine: "claude" },
      spawn,
      prepDeps,
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const sse = await readSSE(res);
    expect(sse).toContain(`event: token\ndata: ${JSON.stringify({ text: "resume-answer" })}`);
    expect(sse).toContain(
      `event: done\ndata: ${JSON.stringify({ engine: "claude", code: 0, ok: true })}`,
    );
  });

  test("copilot resume → 400 before stream opens", async () => {
    const res = await askStreamResponse(
      REPO,
      { resume: true, question: "q?", engine: "copilot" },
      () => Promise.resolve({ code: 0, text: "" }),
      { ...prepDeps, readiness: () => Promise.resolve([ready("copilot")]) },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not supported/);
  });

  test("missing question → 400 before stream opens", async () => {
    const res = await askStreamResponse(
      REPO,
      { resume: true },
      () => Promise.resolve({ code: 0, text: "" }),
      prepDeps,
    );
    expect(res.status).toBe(400);
  });
});

// #581: server GET /api/ask/stream?resume=true — integrated
describe("GET /api/ask/stream — resume (#581)", () => {
  async function csrfToken(url: string): Promise<string> {
    const res = await fetch(url);
    const html = await res.text();
    const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
    if (!m) throw new Error("CSRF token not found");
    return m[1] as string;
  }

  test("production resume rejects native-engine state without a durable conversation identity", async () => {
    // engine=copilot hits prepareAsk's explicit-copilot fast-path → 400 BEFORE
    // any readiness probe, so this real-server test stays fast + deterministic
    // regardless of which engines are installed. Proves the server parsed
    // resume=true + engine and threaded them into the resume branch.
    const dir = mkdtempSync(join(tmpdir(), "ask-sse-resume-"));
    const cwd0 = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      const token = await csrfToken(url);
      try {
        const res = await fetch(
          `${url}/api/ask/stream?resume=true&question=hello-resume&engine=copilot&token=${encodeURIComponent(token)}`,
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(cwd0);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resume=true 403 on bad token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-sse-resume-403-"));
    const cwd0 = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const res = await fetch(`${url}/api/ask/stream?resume=true&question=q&token=bad`);
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(cwd0);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
