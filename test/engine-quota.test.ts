import { describe, expect, test } from "bun:test";
import { checkEngineQuota, parseQuotaOutput } from "../src/engine-quota";

describe("parseQuotaOutput", () => {
  test("claude: JSON {limit, used, remaining, resetAt}", () => {
    const r = parseQuotaOutput(
      "claude",
      JSON.stringify({ limit: 100, used: 80, remaining: 20, resetAt: "2026-06-13" }),
    );
    expect(r.remaining).toBe(20);
    expect(r.percentRemaining).toBe(20);
    expect(r.resetAt).toBe("2026-06-13");
  });

  test("codex: text 'quota: 5/100 (5% used, 95% remaining)'", () => {
    const r = parseQuotaOutput("codex", "quota: 5/100 (5% used, 95% remaining)");
    expect(r.percentRemaining).toBe(95);
  });

  test("copilot: JSON {quota_remaining, quota_total, reset_at}", () => {
    const r = parseQuotaOutput(
      "copilot",
      JSON.stringify({ quota_remaining: 5, quota_total: 100, reset_at: "2026-06-13" }),
    );
    expect(r.remaining).toBe(5);
    expect(r.percentRemaining).toBe(5);
    expect(r.resetAt).toBe("2026-06-13");
  });

  test("empty output → exhausted level", () => {
    expect(parseQuotaOutput("claude", "").level).toBe("exhausted");
  });

  test("unparseable output → exhausted level", () => {
    expect(parseQuotaOutput("claude", "???garbage???").level).toBe("exhausted");
  });

  test("malformed JSON → exhausted with error", () => {
    const r = parseQuotaOutput("claude", "{not valid json");
    expect(r.level).toBe("exhausted");
    expect(r.error).toBeDefined();
  });

  test("percentage-only text (no fraction, no JSON)", () => {
    const r = parseQuotaOutput("claude", "remaining: 50%");
    expect(r.percentRemaining).toBe(50);
    expect(r.level).toBe("ready");
  });

  test("fraction with limit=0 → exhausted", () => {
    const r = parseQuotaOutput("codex", "0/0");
    expect(r.level).toBe("exhausted");
    expect(r.error).toBe("zero limit");
  });

  test("JSON with limit=0 → percentRemaining undefined", () => {
    const r = parseQuotaOutput("claude", JSON.stringify({ remaining: 5, limit: 0 }));
    expect(r.percentRemaining).toBeUndefined();
    expect(r.level).toBe("ready");
  });

  test("JSON without remaining → percentRemaining undefined", () => {
    const r = parseQuotaOutput("claude", JSON.stringify({ limit: 100 }));
    expect(r.percentRemaining).toBeUndefined();
    expect(r.level).toBe("ready");
  });

  test("JSON with used_remaining + total keys (third fallback)", () => {
    const r = parseQuotaOutput(
      "gh",
      JSON.stringify({ used_remaining: 25, total: 100, used_count: 30 }),
    );
    expect(r.remaining).toBe(25);
    expect(r.limit).toBe(100);
    expect(r.used).toBe(30);
    expect(r.percentRemaining).toBe(25);
  });

  test("JSON with quota_remaining + quota_total keys (second fallback)", () => {
    const r = parseQuotaOutput(
      "claude",
      JSON.stringify({ quota_remaining: 10, quota_total: 100 }),
    );
    expect(r.remaining).toBe(10);
    expect(r.limit).toBe(100);
    expect(r.percentRemaining).toBe(10);
  });

  test("parsePercent with non-numeric capture falls back to undefined", () => {
    // Force m[1] to be nullish via String.prototype.match override
    const orig = String.prototype.match;
    String.prototype.match = function (re: RegExp) {
      // fraction regex inside parseQuotaOutput — return null so parsePercent is reached
      if (re.source.includes("\\/")) {
        return null;
      }
      // percent regex inside parsePercent — return match with null capture group
      if (re.source.includes("\\s*%")) {
        return ["xx%", undefined as unknown as string];
      }
      return orig.call(this, re);
    };
    try {
      const r1 = parseQuotaOutput("claude", "anything %");
      // parsePercent returns undefined → falls through to "unparseable output"
      expect(r1.level).toBe("exhausted");
    } finally {
      String.prototype.match = orig;
    }
  });

  test("fraction regex with null capture groups triggers zero limit path", () => {
    const orig = String.prototype.match;
    String.prototype.match = function (re: RegExp) {
      if (re.source.includes("\\/")) {
        // Return match with null capture groups → Number.parseInt(undefined ?? "0", 10) = 0
        return ["x/y", undefined as unknown as string, undefined as unknown as string];
      }
      return orig.call(this, re);
    };
    try {
      const r = parseQuotaOutput("codex", "x/y");
      expect(r.level).toBe("exhausted");
      expect(r.error).toBe("zero limit");
    } finally {
      String.prototype.match = orig;
    }
  });
});

describe("checkEngineQuota", () => {
  test("ready when remaining > 20%", () => {
    expect(checkEngineQuota({ percentRemaining: 50 }).level).toBe("ready");
  });

  test("warning when 5% < remaining <= 20%", () => {
    expect(checkEngineQuota({ percentRemaining: 10 }).level).toBe("warning");
  });

  test("exhausted when remaining <= 5%", () => {
    expect(checkEngineQuota({ percentRemaining: 1 }).level).toBe("exhausted");
  });

  test("ready when percentRemaining undefined (assume ok)", () => {
    expect(checkEngineQuota({}).level).toBe("ready");
  });

  test("rate-limited on HTTP 429 in stderr", () => {
    expect(checkEngineQuota({ stderr: "HTTP 429 too many requests" }).level).toBe("rate-limited");
  });

  test("forbidden on HTTP 403 in stderr", () => {
    expect(checkEngineQuota({ stderr: "HTTP 403 forbidden" }).level).toBe("forbidden");
  });

  test("not-logged-in when stderr mentions login", () => {
    expect(checkEngineQuota({ stderr: "not logged in" }).level).toBe("not-logged-in");
  });

  test("stderr signal overrides percentRemaining", () => {
    expect(checkEngineQuota({ percentRemaining: 80, stderr: "HTTP 429 too many" }).level).toBe(
      "rate-limited",
    );
  });
});
