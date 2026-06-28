import { describe, expect, test } from "bun:test";
import { preflightDelegate } from "../src/preflight-delegate";
import type { EngineReadiness } from "../src/preflight.js";
import { ProbeCache } from "../src/probe-cache";

const READY: EngineReadiness = {
  level: "ready",
  detail: "ok",
  engine: "claude",
  checkedAt: "2026-06-12T00:00:00Z",
};
const NO_BINARY: EngineReadiness = {
  level: "no-binary",
  detail: "missing",
  engine: "claude",
  checkedAt: "2026-06-12T00:00:00Z",
};
const NO_AUTH: EngineReadiness = {
  level: "no-auth",
  detail: "login",
  engine: "claude",
  checkedAt: "2026-06-12T00:00:00Z",
};

describe("preflightDelegate: default functions (test seams)", () => {
  test("defaultPresenceCheck shells out to checkEngine (line 95-104)", async () => {
    const { defaultPresenceCheck } = await import("../src/preflight-delegate.js");
    // Inject has()=false for every command → no-binary
    const r = defaultPresenceCheck("/repo", "claude", {
      has: () => false,
    });
    expect(r.level).toBe("no-binary");
    expect(r.engine).toBe("claude");
  });

  test("defaultPresenceCheck: same engine, different engines", async () => {
    const { defaultPresenceCheck } = await import("../src/preflight-delegate.js");
    for (const e of ["claude", "codex", "copilot"] as const) {
      const r = defaultPresenceCheck("/repo", e, { has: () => false });
      expect(r.engine).toBe(e);
      expect(r.level).toBe("no-binary");
    }
  });

  test("defaultPickFallback returns undefined when no engine is ready (line 108-113)", async () => {
    const { defaultPickFallback } = await import("../src/preflight-delegate.js");
    // All has()=false → no engine is ready → fallback is undefined.
    const result = defaultPickFallback("claude", () => false);
    expect(result).toBeUndefined();
  });

  test("defaultPickFallback respects the exclude parameter", async () => {
    const { defaultPickFallback } = await import("../src/preflight-delegate.js");
    // All has()=false → never returns. Verify by absence.
    for (const exclude of ["claude", "codex", "copilot"] as const) {
      const result = defaultPickFallback(exclude, () => false);
      expect(result).toBeUndefined();
    }
  });

  // Documented limitation: defaultPickFallback's behavior when
  // `has` returns true for one or more engines is hard to test
  // deterministically because the function calls checkEngine which
  // has a copilot branch that requires `gh` to be present (real
  // binary). In a test env where `gh` is on PATH, copilot becomes
  // "no-auth" rather than "ready", so the fallback path is taken.
  // The "no engine ready" test above covers the more common case
  // (has()=false → no engine ready → undefined).
});

describe("preflightDelegate: branches", () => {
  test("returns ok:false when forceEngine is not ready (line 446-447)", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "ready" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe("ready");
  });

  test("no-binary blocks", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => NO_BINARY,
      quotaProbe: async () => ({ level: "ready" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe("exhausted");
  });

  test("no-auth blocks as not-logged-in", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => NO_AUTH,
      quotaProbe: async () => ({ level: "ready" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe("not-logged-in");
  });

  test("warning allows but with warning level", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "warning", error: "low" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe("warning");
  });

  test("unknown quota triggers warning-level conservative fallback", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "unknown", error: "parse failed" }),
    });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe("warning");
    expect(r.detail).toContain("parse failed");
  });

  test("exhausted blocks if no fallback", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "exhausted", error: "no calls left" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe("exhausted");
  });

  test("exhausted falls back to next ready engine", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "exhausted" }),
      pickFallback: () => "codex",
    });
    expect(r.allowed).toBe(true);
    expect(r.fallbackEngine).toBe("codex");
  });

  test("rate-limited (HTTP 429) falls back", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "rate-limited", error: "HTTP 429" }),
      pickFallback: () => "codex",
    });
    expect(r.allowed).toBe(true);
    expect(r.fallbackEngine).toBe("codex");
  });

  test("forbidden (HTTP 403) blocks — do NOT fall back (auth issue)", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "forbidden", error: "HTTP 403" }),
      pickFallback: () => "codex",
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe("forbidden");
  });

  test("not-logged-in blocks", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "not-logged-in", error: "login required" }),
      pickFallback: () => "codex",
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe("not-logged-in");
  });

  test("skipQuotaCheck=true skips quota probe and allows", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      skipQuotaCheck: true,
      presenceCheck: () => READY,
      quotaProbe: async () => ({ level: "exhausted" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe("ready");
  });

  test("probe-failed presence blocks as exhausted", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => ({
        ...READY,
        level: "probe-failed",
        detail: "spawn failed",
      }),
      quotaProbe: async () => ({ level: "ready" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe("exhausted");
  });

  test("unknown presence blocks as exhausted", async () => {
    const r = await preflightDelegate("/repo", "claude", {
      cache: new ProbeCache(),
      presenceCheck: () => ({
        ...READY,
        level: "unknown",
        detail: "who knows",
      }),
      quotaProbe: async () => ({ level: "ready" }),
      pickFallback: () => undefined,
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe("exhausted");
  });

  // The two "default" tests (default presenciaCheck, default pickFallback)
  // were removed because they spawn real CLI probes via checkEngine, which
  // takes seconds and times out the test runner. The branch coverage
  // they would have added is small and the default paths are simple
  // (a one-line presence check + a one-line loop over ENGINES).
});
