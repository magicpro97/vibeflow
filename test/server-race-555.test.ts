// test/server-race-555.test.ts
//
// #555 — POST /api/race: the UI's entry point into the race. The handler owns
// validation (state present, task resolvable, engines parseable) and returns the
// ranked rows; dispatch is injected so no engine is ever launched here.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RaceOptions, RaceRunResult } from "../src/commands.js";
import { UI_LAN_TOKEN_HEADER } from "../src/core/ui-cli-contract.js";
import { startServer } from "../src/server.js";
import { handleRaceRoute, readRaceBody } from "../src/server/race-route.js";

interface Recorded {
  calls: RaceOptions[];
}

function repoWithState(goal: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-race-route-"));
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(dir, ".vibeflow", "WORKFLOW_STATE.json"),
    JSON.stringify({ task_id: "wf-555", goal, work_units: [], totals: {} }),
  );
  return dir;
}

function call(
  dir: string | null,
  body: Record<string, unknown>,
  recorded?: Recorded,
  result: RaceRunResult = { exitCode: 0, ranking: [], skipped: [] },
): Promise<Response> {
  return handleRaceRoute(
    {
      getActiveRepo: () => dir ?? join(tmpdir(), "vf-race-missing-repo"),
      raceFn: async (opts: RaceOptions) => {
        recorded?.calls.push(opts);
        return result;
      },
    },
    body,
  );
}

describe("POST /api/race (#555)", () => {
  test("no workflow state → 400 with the init hint", async () => {
    const dir = repoWithState("g");
    rmSync(join(dir, ".vibeflow"), { recursive: true, force: true });
    const res = await call(dir, { task: "t" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no workflow state");
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry by default; the task and parsed engines reach runRace", async () => {
    const dir = repoWithState("g");
    const recorded: Recorded = { calls: [] };
    const res = await call(
      dir,
      { task: "add a health endpoint", engines: ["codex", "claude"] },
      recorded,
    );
    expect(res.status).toBe(200);
    expect(recorded.calls).toEqual([
      { task: "add a health endpoint", base: dir, mode: "dry", engines: ["claude", "codex"] },
    ]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry:false runs for real (cli mode) and echoes the ranked rows", async () => {
    const dir = repoWithState("g");
    const recorded: Recorded = { calls: [] };
    const res = await call(dir, { dry: false }, recorded, {
      exitCode: 0,
      skipped: [{ engine: "copilot", reason: "copilot CLI not found" }],
      ranking: [
        {
          engine: "claude",
          ok: true,
          confidence: 0.9,
          tests_run: 2,
          files_changed: 1,
          branch: "vf-race-claude",
          worktree: join(dir, "..", "vf-wt-vf-race-claude"),
        },
      ],
    });
    const body = (await res.json()) as { ok: boolean; ranking: unknown[]; skipped: unknown[] };
    expect(recorded.calls[0]?.mode).toBe("cli");
    // The task falls back to the saved goal when the payload omits it.
    expect(recorded.calls[0]?.task).toBe("g");
    expect(recorded.calls[0]?.engines).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(body.ranking).toHaveLength(1);
    expect(body.skipped).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unparseable engines payload → 400 (never a silently ignored list)", async () => {
    const dir = repoWithState("g");
    const res = await call(dir, { task: "t", engines: "claude,gpt9" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("gpt9");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a malformed engine member → 400, never a silently narrowed list (#818)", async () => {
    const dir = repoWithState("g");
    const recorded: Recorded = { calls: [] };
    const res = await call(dir, { task: "t", engines: ["claude", 7] }, recorded);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "array members must be strings",
    );
    expect(recorded.calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no task and no saved goal → 400 (nothing to race)", async () => {
    const dir = repoWithState("");
    const res = await call(dir, { task: "   " });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("race needs a task");
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unrankable race reports ok:false without throwing", async () => {
    const dir = repoWithState("g");
    const res = await call(dir, { task: "t" }, undefined, {
      exitCode: 1,
      ranking: [],
      skipped: [],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the server wires POST /api/race behind the write guard into this handler", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const branch = server.slice(server.indexOf('path === "/api/race"'));
    expect(branch.length).toBeGreaterThan(0);
    expect(branch.slice(0, 300)).toContain("guarded(req)");
    expect(branch.slice(0, 500)).toContain("handleRaceRoute({ getActiveRepo: () => activeRepo }");
  });
});

describe("readRaceBody (#818): a bad body is the route's 400, never a fetch-handler throw", () => {
  const post = (raw: string) =>
    new Request("http://vf.test/api/race", { method: "POST", body: raw });

  test("malformed JSON, `null`, an array, and bare scalars → null (no throw)", async () => {
    for (const raw of ["{ not json", "null", '["claude"]', '"claude"', "42", ""]) {
      expect(await readRaceBody(post(raw))).toBeNull();
    }
  });

  test("a JSON object body is passed through unchanged", async () => {
    expect(await readRaceBody(post('{"task":"t","dry":false}'))).toEqual({ task: "t", dry: false });
  });
});

describe("POST /api/race over HTTP (#818): the fetch handler answers 400 instead of rejecting", () => {
  test("malformed JSON / `null` / array bodies → 400 with a JSON error body", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-race-http-"));
    const { server, url } = await startServer(0, { repoDir: repo });
    try {
      const page = await fetch(url);
      const token =
        (await page.text()).match(/<meta\s+name="vf-token"\s+content="([^"]+)"/i)?.[1] ?? "";
      expect(token).not.toBe("");
      const httpPost = (raw: string) =>
        fetch(`${url}/api/race`, {
          method: "POST",
          headers: { "content-type": "application/json", [UI_LAN_TOKEN_HEADER]: token },
          body: raw,
        });

      for (const raw of ["{ not json", "null", '["claude"]']) {
        const res = await httpPost(raw);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("JSON");
      }

      // A well-formed object still reaches the route: here its own no-state 400.
      const shaped = await httpPost('{"task":"t"}');
      expect(shaped.status).toBe(400);
      expect(((await shaped.json()) as { error: string }).error).toContain("no workflow state");
    } finally {
      await server.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
