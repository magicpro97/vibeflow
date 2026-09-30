// Server-side surface of the System One control-center section: the redacted
// settings view, its GET route, and the server-side "Test connection" probe.
// The browser never holds the key, so every assertion here is about what the
// wire DOES NOT carry as much as what it does.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_LAN_TOKEN_HEADER } from "../src/core/ui-cli-contract.js";
import { startServer } from "../src/server.js";
import {
  handleTypesafeReadRoute,
  handleTypesafeTestRoute,
  typesafeSettingsView,
} from "../src/server/routes-typesafe.js";
import { handleMutationRoute } from "../src/server/routes.js";
import { type VibeSettings, readSettings } from "../src/settings.js";
import { TYPESAFE_STATE } from "../src/typesafe-health-file.js";
import { resetCallBudget } from "../src/typesafe-health.js";
import type { TypesafeHealth } from "../src/typesafe-health.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  TYPESAFE_CALL_SITE_NAMES,
  type TypesafeSettings,
} from "../src/typesafe-settings.js";

const REPO = mkdtempSync(join(tmpdir(), "vf-typesafe-route-"));
const KEY = "tsk-do-not-leak-1234567890";

const BASE = readSettings(REPO);
const settings = (over: Partial<TypesafeSettings> = {}): VibeSettings => ({
  ...BASE,
  typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true, ...over },
});

function health(over: Partial<TypesafeHealth> = {}): TypesafeHealth {
  return {
    schema_version: 1,
    state: TYPESAFE_STATE.IDLE,
    fail_streak: 0,
    consecutive_trips: 0,
    cooldown_ms: 60_000,
    last_class: "none",
    ...over,
  };
}

describe("typesafeSettingsView", () => {
  test("reports off, no key, and never the key itself", () => {
    const view = typesafeSettingsView(REPO, {
      settings: { ...BASE, typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: false } },
      env: {},
      health: health(),
    });
    expect(view.state).toBe(TYPESAFE_STATE.OFF);
    expect(view.enabled).toBe(false);
    expect(view.configured).toBe(false);
    expect(view.keySource).toBe("none");
    expect(JSON.stringify(view)).not.toContain("tsk-");
    expect(JSON.stringify(view)).not.toContain("TYPESAFE_API_KEY");
  });

  test("reports unconfigured when enabled but no key resolves", () => {
    const view = typesafeSettingsView(REPO, {
      settings: settings(),
      env: {},
      health: health(),
    });
    expect(view.state).toBe(TYPESAFE_STATE.UNCONFIGURED);
    expect(view.configured).toBe(false);
  });

  test("reports idle with an env key and defaults the settings-owned values", () => {
    const view = typesafeSettingsView(REPO, {
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      health: health(),
    });
    expect(view.state).toBe(TYPESAFE_STATE.IDLE);
    expect(view.configured).toBe(true);
    expect(view.keySource).toBe("env");
    expect(view.model).toBe(DEFAULT_TYPESAFE_SETTINGS.model);
    expect(view.timeoutMs).toBe(DEFAULT_TYPESAFE_SETTINGS.timeoutMs);
    expect(view.thresholds).toEqual({
      run: DEFAULT_TYPESAFE_SETTINGS.runAtConfidence,
      accept: DEFAULT_TYPESAFE_SETTINGS.acceptAtConfidence,
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  test("surfaces the recorded breaker, cooldown and last call", () => {
    const view = typesafeSettingsView(REPO, {
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      health: health({
        state: TYPESAFE_STATE.OPEN,
        last_class: "budget",
        last_status: 429,
        calls: 7,
        cooldown_until: "2026-09-21T20:42:11.000Z",
        last_call: { at: "2026-09-21T20:40:11.000Z", caller: "risk", status: 429, ms: 480 },
      }),
    });
    expect(view.state).toBe(TYPESAFE_STATE.OPEN);
    expect(view.cooldownUntil).toBe("2026-09-21T20:42:11.000Z");
    expect(view.lastClass).toBe("budget");
    expect(view.calls).toBe(7);
    expect(view.lastCall).toEqual({
      at: "2026-09-21T20:40:11.000Z",
      caller: "risk",
      status: 429,
      ms: 480,
    });
  });

  test("keeps a half-open probe visible instead of collapsing it to idle", () => {
    const view = typesafeSettingsView(REPO, {
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      health: health({ state: TYPESAFE_STATE.HALF_OPEN }),
    });
    expect(view.state).toBe(TYPESAFE_STATE.HALF_OPEN);
  });

  test("projects every call site from the shared authority, defaulting an absent block", () => {
    const view = typesafeSettingsView(REPO, {
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      health: health(),
    });
    expect(Object.keys(view.callSites).sort()).toEqual([...TYPESAFE_CALL_SITE_NAMES].sort());
    for (const site of TYPESAFE_CALL_SITE_NAMES) {
      expect(view.callSites[site]).toBe(DEFAULT_TYPESAFE_SETTINGS.callSites[site]);
    }
  });

  test("falls back to the defaults when settings carry no typesafe block", () => {
    const view = typesafeSettingsView(REPO, {
      settings: { ...BASE, typesafe: undefined },
      env: {},
      health: health(),
    });
    expect(view.state).toBe(TYPESAFE_STATE.OFF);
    expect(view.model).toBe(DEFAULT_TYPESAFE_SETTINGS.model);
  });
});

describe("handleTypesafeReadRoute", () => {
  test("serves the redacted view for /api/typesafe", async () => {
    const res = handleTypesafeReadRoute("/api/typesafe", REPO, {
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      health: health(),
    });
    expect(res).not.toBeNull();
    const body = (await (res as Response).json()) as Record<string, unknown>;
    expect(body.keySource).toBe("env");
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  test("returns null for every other path so the caller keeps dispatching", () => {
    expect(handleTypesafeReadRoute("/api/settings", REPO, { settings: BASE, env: {} })).toBeNull();
  });
});

describe("handleTypesafeTestRoute", () => {
  // Two pieces of state leak between tests here now that the probe goes through the guard.
  // `callsThisRun` is PROCESS-global (src/typesafe-health.ts:243), and the breaker lives in the
  // health FILE under `userRoot` — so a root shared by the whole file carries the previous test's
  // classified failures forward, trips `failStreakLimit`, and makes the next probe report a
  // refusal instead of the answer under test. A fresh root per test also keeps the suite off the
  // developer's real ~/.vibeflow, which is where these tests used to write their health records.
  let root = "";
  beforeEach(() => {
    resetCallBudget();
    root = mkdtempSync(join(tmpdir(), "vf-typesafe-probe-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("refuses while the judge is disabled, without opening a socket", async () => {
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: REPO,
      userRoot: root,
      settings: { ...BASE, typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: false } },
      env: { TYPESAFE_API_KEY: KEY },
      judge: async () => {
        throw new Error("judge must not be reached");
      },
    });
    expect((await res.json()) as unknown).toEqual({
      ok: false,
      error: "System One judge is disabled",
    });
  });

  test("names the missing key instead of probing", async () => {
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: REPO,
      userRoot: root,
      settings: settings(),
      env: {},
      judge: async () => {
        throw new Error("judge must not be reached");
      },
    });
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("key missing — set TYPESAFE_API_KEY or run vf config typesafe key");
  });

  test("pays the same call-budget toll as every other call site", async () => {
    // The probe used to call `judgeAssessment` directly, which left it outside the per-process
    // call budget and outside the file-backed breaker — both live in `withTypesafeGuard`. A
    // client holding the page token could therefore loop this route and issue unbounded billed
    // requests, even while the breaker was open for every real call site. `maxCalls: 0` is the
    // cheapest way to show the guard is on the path: the judge must not be reached at all.
    let reached = 0;
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: REPO,
      userRoot: root,
      settings: {
        ...BASE,
        typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true, maxCalls: 0 },
      },
      env: { TYPESAFE_API_KEY: KEY },
      judge: async () => {
        reached += 1;
        return null;
      },
    });
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(reached).toBe(0);
    expect(body.ok).toBe(false);
    // A refusal is not a judge failure: reporting one would send the user hunting for a key or
    // network problem that does not exist.
    expect(body.error).toBe("refused by the call budget or an open circuit breaker");
  });

  test("returns the score, confidence and latency of a live probe", async () => {
    let clock = 1_000;
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: REPO,
      userRoot: root,
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      now: () => {
        const value = clock;
        clock += 42;
        return value;
      },
      judge: async (state, inject) => {
        expect(state).toContain("diff:");
        expect(inject?.goal).toBe("the change adds a compute-confidence function");
        return { covers: { score: 0.9, confidence: 0.8 } };
      },
    });
    expect((await res.json()) as unknown).toEqual({
      ok: true,
      model: DEFAULT_TYPESAFE_SETTINGS.model,
      ms: 42,
      score: 0.9,
      confidence: 0.8,
    });
  });

  test("omits the confidence the API did not return", async () => {
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: REPO,
      userRoot: root,
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      now: () => 5,
      judge: async () => ({ covers: { score: 0.5 } }),
    });
    expect((await res.json()) as unknown).toEqual({
      ok: true,
      model: DEFAULT_TYPESAFE_SETTINGS.model,
      ms: 0,
      score: 0.5,
    });
  });

  test("reports a classified failure with its status", async () => {
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: REPO,
      userRoot: root,
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      now: () => 7,
      judge: async (_state, inject) => {
        inject?.onOutcome?.({ ok: false, class: "auth", status: 401 }, 5);
        return null;
      },
    });
    expect((await res.json()) as unknown).toEqual({
      ok: false,
      model: DEFAULT_TYPESAFE_SETTINGS.model,
      ms: 0,
      status: 401,
      error: "judge call failed (auth)",
    });
  });

  test("distinguishes a silent no-verdict from a classified failure", async () => {
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: REPO,
      userRoot: root,
      settings: settings(),
      env: { TYPESAFE_API_KEY: KEY },
      now: () => 7,
      judge: async () => null,
    });
    expect((await res.json()) as unknown).toEqual({
      ok: false,
      model: DEFAULT_TYPESAFE_SETTINGS.model,
      ms: 0,
      error: "no verdict returned",
    });
  });

  test("reads its own settings when the caller injects none", async () => {
    const res = await handleTypesafeTestRoute({ repo: REPO, expectRepo: REPO, env: {} });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});

describe("POST /api/typesafe/test through the mutation dispatcher", () => {
  test("routes to the probe handler", async () => {
    const req = new Request("http://127.0.0.1/api/typesafe/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const res = await handleMutationRoute(
      { getActiveRepo: () => REPO, setActiveRepo: () => {} },
      "POST",
      "/api/typesafe/test",
      req,
      new URL(req.url),
    );
    expect(res).not.toBeNull();
    const body = (await (res as Response).json()) as { ok: boolean };
    // No key in this environment: the route must answer, not throw, and never hold one.
    expect(typeof body.ok).toBe("boolean");
  });
});

describe("POST /api/typesafe/test is on the server's write surface", () => {
  test("the running server reaches the probe instead of falling through to the bare 404", async () => {
    // Calling handleMutationRoute directly bypasses the `isWrite` allowlist in server.ts, so a
    // route that is missing from that allowlist still looks green here. Drive the real server.
    const server = await startServer(0, { repoDir: REPO });
    try {
      const page = await (await fetch(`${server.url}/`)).text();
      const token = /<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i.exec(page)?.[1] ?? "";
      expect(token).not.toBe("");

      // The probe is a write, so the CSRF guard must refuse it without the token.
      const unguarded = await fetch(`${server.url}/api/typesafe/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(unguarded.status).toBe(403);

      // With the token it must reach the probe and answer JSON. Before the allowlist entry it
      // fell through to `new Response("not found", { status: 404 })`, which made the control
      // centre's "Test connection" button fail on every install.
      // The client names the repository its view was read from, and the server compares it against the
      // live active repo (parity with the save path). An unnamed probe is refused, so this also pins
      // that the probe route reads the field.
      const guarded = await fetch(`${server.url}/api/typesafe/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [UI_LAN_TOKEN_HEADER]: token },
        body: JSON.stringify({ expectRepo: REPO }),
      });
      expect(guarded.status).toBe(200);
      expect(guarded.headers.get("content-type")).toContain("application/json");
      const body = (await guarded.json()) as { ok: boolean; error?: string };
      expect(typeof body.ok).toBe("boolean");
      // No key is configured in this repo, so the probe reports the refusal rather than a result.
      expect(body.ok).toBe(false);
    } finally {
      await server.server.stop(true);
    }
  });
});

afterAll(() => {
  rmSync(REPO, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

describe("the probe names the repository it was read from", () => {
  test("a stale repo is refused, and the judge is never called", async () => {
    // The probe resolves the process-global active repo server-side, so with no comparison a drawer
    // opened on repo A bills a call against whatever repo another client has since made active and
    // prints the result under rows describing A. The drawer's own guard compares two of ITS mirrors,
    // so it stays open - the server has to compare, as the save path does.
    let calls = 0;
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      expectRepo: `${REPO}-other`,
      userRoot: mkdtempSync(join(tmpdir(), "typesafe-probe-")),
      env: { TYPESAFE_API_KEY: "sk-test" },
      judge: async () => {
        calls += 1;
        return { verdict: "allow", reason: "", risk: "low", goalCoverage: "full" } as never;
      },
    } as never);
    expect(res.status).toBe(409);
    expect(calls).toBe(0);
    expect(((await res.json()) as { error: string }).error).toContain("reload before testing");
  });

  test("an unnamed probe is refused too, so the field cannot be omitted into the hole", async () => {
    const res = await handleTypesafeTestRoute({
      repo: REPO,
      userRoot: mkdtempSync(join(tmpdir(), "typesafe-probe-")),
      env: {},
    } as never);
    expect(res.status).toBe(409);
  });
});
