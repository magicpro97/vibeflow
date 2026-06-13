import { describe, expect, test } from "bun:test";
import { type QuotaSignal, backoffPlan, detectQuota } from "../src/safety/quota.js";

/** Deterministic rng for backoff jitter assertions. */
const rng = (v: number) => () => v;

/** Reference raw for default-options backoff test: baseMs=2000 (default), attempt=0 -> 2000*2^0=2000. */
const DEFAULT_TEST_RAW = 2000;

describe("detectQuota: typed claude stream-json (high confidence)", () => {
  test("api_retry event with rate_limit + retry_delay_ms", () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"system","subtype":"api_retry","error":{"type":"rate_limit_error"},"retry_delay_ms":4500}',
    ].join("\n");
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.kind).toBe("rate-limit");
    expect(sig.confidence).toBe("high");
    expect(sig.retryAfterMs).toBe(4500);
  });

  test("overloaded_error envelope maps to overloaded, high", () => {
    const stdout = '{"type":"result","error":{"type":"overloaded_error"}}';
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.kind).toBe("overloaded");
    expect(sig.confidence).toBe("high");
  });

  test("top-level obj.type as known token (no err/subtype)", () => {
    // Covers the obj.type branch in tokenFromObject: type=quota_exceeded recognized at top level.
    const stdout = '{"type":"quota_exceeded"}';
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.kind).toBe("quota-exhausted");
    expect(sig.confidence).toBe("high");
  });

  test("obj.type as unknown string token (typeof===string but not in KIND_BY_TOKEN)", () => {
    // type is a string, KIND_BY_TOKEN[type] is undefined → fall through. Must not match a token.
    const stdout = '{"type":"assistant","subtype":"some_msg"}';
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(false);
  });

  test("retry_after:null with retry_delay (number) — ?? falls through to retry_delay", () => {
    // retry_after is nullish (null) so ?? falls through to retry_delay; scaled by 1000.
    const stdout =
      '{"type":"system","subtype":"api_retry","error":{"type":"rate_limit_error"},"retry_after":null,"retry_delay":12}';
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.retryAfterMs).toBe(12_000);
  });

  test("retry_after:null with retry_delay missing — no retryAfterMs", () => {
    const stdout =
      '{"type":"system","subtype":"api_retry","error":{"type":"rate_limit_error"},"retry_after":null}';
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.retryAfterMs).toBeUndefined();
  });

  test("insufficient_quota maps to quota-exhausted, high, no retry", () => {
    const stdout = '{"error":{"type":"insufficient_quota"}}';
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.kind).toBe("quota-exhausted");
    expect(sig.confidence).toBe("high");
    expect(backoffPlan(sig, 0, { rng: rng(0.5) }).retry).toBe(false);
  });

  test("billing_error maps to quota-exhausted, high", () => {
    const sig = detectQuota({ status: 1, stdout: '{"subtype":"billing_error"}' });
    expect(sig.kind).toBe("quota-exhausted");
    expect(sig.confidence).toBe("high");
  });
});

describe("detectQuota: HTTP-style structured line (high confidence)", () => {
  test("429 Too Many Requests + Retry-After header (seconds -> ms)", () => {
    const stdout = "HTTP 429 Too Many Requests\nRetry-After: 30\n";
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.kind).toBe("rate-limit");
    expect(sig.confidence).toBe("high");
    expect(sig.retryAfterMs).toBe(30_000);
  });

  test("429 + Retry-After: HTTP-date → ms (Date.parse path)", () => {
    // Date 5 seconds in the future as HTTP-date (IMF-fixdate).
    const future = new Date(Date.now() + 5_000);
    const httpDate = future.toUTCString();
    const stdout = `HTTP 429 Too Many Requests\nRetry-After: ${httpDate}\n`;
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.retryAfterMs).toBeGreaterThan(0);
    expect(sig.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  test("429 + Retry-After: garbage → returns undefined (no retryAfterMs)", () => {
    // Non-numeric, non-date string. Date.parse returns NaN, falls through.
    const stdout = "HTTP 429 Too Many Requests\nRetry-After: soonish\n";
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.retryAfterMs).toBeUndefined();
  });

  test('structured "status":529 token -> overloaded high', () => {
    const sig = detectQuota({ status: 1, stdout: 'gateway said {"status":529}' });
    expect(sig.kind).toBe("overloaded");
    expect(sig.confidence).toBe("high");
  });
});

describe("detectQuota: prose is NOT trusted on success", () => {
  test("KEY: normal prose about a rate limiter with status 0 -> not limited", () => {
    const stdout = "I added a rate limiter to handle 429s and avoid too many requests.";
    const sig = detectQuota({ status: 0, stdout });
    expect(sig.limited).toBe(false);
    expect(sig.confidence).toBe("high");
  });

  test("prose 'rate limit exceeded' with status!=0 -> low-confidence advisory", () => {
    const sig = detectQuota({ status: 1, stdout: "Error: rate limit exceeded, giving up." });
    expect(sig.limited).toBe(true);
    expect(sig.confidence).toBe("low");
    expect(sig.kind).toBe("rate-limit");
    // caller must NOT auto-retry on a guess
    expect(backoffPlan(sig, 0, { rng: rng(0.5) }).retry).toBe(false);
  });
});

describe("detectQuota: robustness", () => {
  test("invalid JSON does not throw and falls through to no-signal on success", () => {
    const sig = detectQuota({ status: 0, stdout: "{not json at all <<<" });
    expect(sig.limited).toBe(false);
  });

  test("clean success -> no quota signal, high confidence", () => {
    const sig = detectQuota({ status: 0, stdout: '{"result":"all good"}' });
    expect(sig.limited).toBe(false);
    expect(sig.confidence).toBe("high");
    expect(sig.evidence.toLowerCase()).toContain("no quota");
  });

  test("JSONL where first line is valid JSON but not an object (e.g. number) is skipped", () => {
    // Whole-string tryParse fails (multiline junk follows) so we fall to JSONL line loop.
    // The first line "42" parses to a number; isObject(42) is false -> not pushed to out.
    // No object parses, so no quota signal.
    const stdout = "42\nsome non-json line\n4";
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(false);
  });

  test("whole-string parse returns non-object (number) -> isObject(whole) false, no push", () => {
    // tryParse succeeds (whole !== undefined), isObject(number) false, branch on line 83 false.
    const stdout = "42";
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(false);
  });

  test('err is a string with non-token value — string check true, KIND_BY_TOKEN lookup false', () => {
    // tokenFromObject line 106: typeof err === "string" true, KIND_BY_TOKEN[err] false -> fall through.
    const stdout = '{"error":"some_other_error","type":"assistant"}';
    const sig = detectQuota({ status: 1, stdout });
    // No known token; fall through to prose — but status=1 + "error" is not in PROSE_PATTERNS
    // so it returns no-signal. (Object has no type, no subtype, prose misses.)
    expect(sig.limited).toBe(false);
  });

  test("evidence never echoes a token-like secret", () => {
    const secret = "sk-ant-api03-SECRETSECRETSECRETSECRET";
    const stdout = `{"error":{"type":"rate_limit_error","message":"key ${secret} throttled"}}`;
    const sig = detectQuota({ status: 1, stdout });
    expect(sig.limited).toBe(true);
    expect(sig.evidence).not.toContain(secret);
    expect(sig.evidence).not.toContain("sk-ant");
  });
});

describe("backoffPlan", () => {
  const base = { baseMs: 2000, capMs: 60_000, maxRetries: 2 };
  const rateLimit: QuotaSignal = {
    limited: true,
    kind: "rate-limit",
    confidence: "high",
    evidence: "x",
  };

  test("full jitter bounded by raw = baseMs * 2^attempt", () => {
    // attempt 1 -> raw = 2000 * 2 = 4000; rng 1 -> full raw
    expect(backoffPlan(rateLimit, 1, { ...base, rng: rng(1) }).delayMs).toBe(4000);
    // rng 0 -> zero delay
    expect(backoffPlan(rateLimit, 1, { ...base, rng: rng(0) }).delayMs).toBe(0);
    // rng 0.5 -> half of raw, within [0, raw]
    const d = backoffPlan(rateLimit, 1, { ...base, rng: rng(0.5) }).delayMs;
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(4000);
  });

  test("delay never exceeds capMs", () => {
    const plan = backoffPlan(rateLimit, 20, { ...base, rng: rng(1) });
    expect(plan.delayMs).toBeLessThanOrEqual(base.capMs);
  });

  test("honors retryAfterMs as a floor and forces retry", () => {
    const sig: QuotaSignal = { ...rateLimit, retryAfterMs: 30_000 };
    const plan = backoffPlan(sig, 0, { ...base, rng: rng(0) });
    expect(plan.retry).toBe(true);
    expect(plan.delayMs).toBe(30_000); // max(retryAfter, jittered=0)
  });

  test("attempt >= maxRetries -> no retry", () => {
    expect(backoffPlan(rateLimit, 2, { ...base, rng: rng(0.5) }).retry).toBe(false);
  });

  test("quota-exhausted -> no retry, zero delay", () => {
    const sig: QuotaSignal = {
      limited: true,
      kind: "quota-exhausted",
      confidence: "high",
      evidence: "x",
    };
    const plan = backoffPlan(sig, 0, { ...base, rng: rng(0.5) });
    expect(plan.retry).toBe(false);
    expect(plan.delayMs).toBe(0);
  });

  test("low-confidence signal -> no auto-retry", () => {
    const sig: QuotaSignal = {
      limited: true,
      kind: "rate-limit",
      confidence: "low",
      evidence: "x",
    };
    expect(backoffPlan(sig, 0, { ...base, rng: rng(0.5) }).retry).toBe(false);
  });

  test("no opts — uses all defaults (baseMs/capMs/maxRetries/rng)", () => {
    // Reach lines 227-230: every ?? falls back to default. Verify behavior is sane.
    const plan = backoffPlan(rateLimit, 0, {});
    // default baseMs=2000, attempt=0 -> raw=2000; rng=Math.random gives 0..2000.
    expect(plan.delayMs).toBeGreaterThanOrEqual(0);
    expect(plan.delayMs).toBeLessThanOrEqual(DEFAULT_TEST_RAW);
  });

  test("partial opts — only baseMs set, others fall back to defaults", () => {
    // With baseMs=1000, attempt=0 -> raw=1000; rng=0.5 -> delayMs=500.
    const plan = backoffPlan(rateLimit, 0, { baseMs: 1000, rng: rng(0.5) });
    expect(plan.delayMs).toBe(500);
  });

  test("partial opts — only capMs set, others fall back to defaults", () => {
    // baseMs default 2000, attempt=0 -> raw=min(capMs=1000, 2000) = 1000; rng=0.5 -> 500.
    const plan = backoffPlan(rateLimit, 0, { capMs: 1_000, rng: rng(0.5) });
    expect(plan.delayMs).toBe(500);
  });

  test("partial opts — only maxRetries set, others fall back to defaults", () => {
    // maxRetries=0, attempt=0 -> attempt < maxRetries is false -> no retry.
    const plan = backoffPlan(rateLimit, 0, { maxRetries: 0, rng: rng(0.5) });
    expect(plan.retry).toBe(false);
  });
});
