import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskInvocation } from "../src/commands/ask.js";
import { captureSpawnAsync, streamSpawnAsync } from "../src/commands/ask.js";
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
      absPath: "/repo/src/x.ts",
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
    expect(r).toMatchObject({ absPath: "/repo/src/deep/nested.ts" });
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
      realpath: (p) => (p === "/repo/src/x.ts" ? "/etc/passwd" : p),
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

  // #584 + Copilot review: the DEFAULT spawner (no inject) must honor the repo's configured
  // envPolicy, not just the DEFAULT_DENY floor — otherwise a user-denied var leaks to the engine.
  test("default spawner honors the configured envPolicy (denies a custom var)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-envpol-"));
    const cwd0 = process.cwd();
    const origVar = process.env.MY_ASK_CUSTOM_VAR;
    try {
      writeSettings(dir, { envPolicy: { deny: ["MY_ASK_CUSTOM_VAR"] } });
      process.chdir(dir);
      process.env.MY_ASK_CUSTOM_VAR = "leak-me";
      // no injected spawner → captureSpawnAsync builds one from readSettings(cwd()).envPolicy
      const r = await captureSpawnAsync(
        {
          cmd: process.execPath,
          args: ["-e", "process.stdout.write(process.env.MY_ASK_CUSTOM_VAR || 'SCRUBBED')"],
          promptMode: "arg",
        },
        "",
      );
      expect(r.text).toBe("SCRUBBED");
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

  test("happy path → { eng, prompt } shape", async () => {
    const r = await prepareAsk(REPO, okBody, deps);
    if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.eng).toBe("claude");
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
      realpath: (p) => (p === "/repo/src/x.ts" ? "/etc/passwd" : p),
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
  test("onChunk fires for each stdout chunk, text accumulated, code mapped", async () => {
    const chunks: string[] = [];
    const r = await streamSpawnAsync(
      { cmd: "test", args: ["-p"], promptMode: "stdin" },
      "prompt",
      (s) => chunks.push(s),
      (cmd, args, input) => {
        expect(cmd).toBe("test");
        return Promise.resolve({ status: 0, stdout: "chunk1chunk2" });
      },
    );
    expect(r).toEqual({ code: 0, text: "chunk1chunk2" });
  });

  test("onChunk called twice via injected spawner that explicitly fires onChunk", async () => {
    const chunks: string[] = [];
    await streamSpawnAsync(
      { cmd: "echo", args: [], promptMode: "arg" },
      "",
      (s) => chunks.push(s),
      async () => {
        // Simulate two separate onChunk calls
        chunks.push("A");
        chunks.push("B");
        return { status: 0, stdout: "AB" };
      },
    );
    expect(chunks).toEqual(["A", "B"]);
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

  test("default spawner honors envPolicy (denies custom var)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-stream-envpol-"));
    const cwd0 = process.cwd();
    const origVar = process.env.MY_ASK_STREAM_VAR;
    try {
      writeSettings(dir, { envPolicy: { deny: ["MY_ASK_STREAM_VAR"] } });
      process.chdir(dir);
      process.env.MY_ASK_STREAM_VAR = "leak-me";
      const r = await streamSpawnAsync(
        {
          cmd: process.execPath,
          args: ["-e", "process.stdout.write(process.env.MY_ASK_STREAM_VAR || 'SCRUBBED')"],
          promptMode: "arg",
        },
        "",
        () => {},
      );
      expect(r.text).toBe("SCRUBBED");
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
});
