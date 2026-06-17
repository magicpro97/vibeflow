export type QuotaLevel =
  | "ready"
  | "warning"
  | "exhausted"
  | "rate-limited"
  | "forbidden"
  | "not-logged-in";

export interface QuotaStatus {
  level: QuotaLevel;
  remaining?: number;
  limit?: number;
  used?: number;
  percentRemaining?: number;
  resetAt?: string;
  error?: string;
}

export interface QuotaProbe {
  remaining?: number;
  limit?: number;
  used?: number;
  percentRemaining?: number;
  resetAt?: string;
  stderr?: string;
  stdout?: string;
}

function parsePercent(s: string): number | undefined {
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return undefined;
  const parsed = Number.parseFloat(m[1] ?? "");
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Parse engine-specific output. Format is engine-specific; verified against docs. */
export function parseQuotaOutput(engine: string, out: string): QuotaStatus {
  const text = out.trim();
  if (!text) return { level: "exhausted", error: "empty output" };

  // JSON variants (claude; `gh api user/copilot_billing` for individual copilot quota;
  // `gh api copilot` is the Copilot Business admin endpoint and is NOT per-user quota)
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const remaining = (j.remaining ?? j.quota_remaining ?? j.used_remaining) as
        | number
        | undefined;
      const limit = (j.limit ?? j.quota_total ?? j.total) as number | undefined;
      const used = (j.used ?? j.used_count) as number | undefined;
      const resetAt = (j.resetAt ?? j.reset_at) as string | undefined;
      const percentRemaining =
        remaining !== undefined && limit ? (remaining / limit) * 100 : undefined;
      return {
        level: classify({ percentRemaining }),
        remaining,
        limit,
        used,
        percentRemaining,
        resetAt,
      };
    } catch (err) {
      return { level: "exhausted", error: (err as Error).message };
    }
  }

  // codex text: "quota: 5/100 (5% used, 95% remaining), resets 2026-06-13"
  const fraction = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const used = Number.parseInt(fraction[1] ?? "0", 10);
    const limit = Number.parseInt(fraction[2] ?? "0", 10);
    if (limit === 0) return { level: "exhausted", error: "zero limit" };
    const remaining = limit - used;
    return {
      level: classify({ percentRemaining: (remaining / limit) * 100 }),
      remaining,
      limit,
      used,
      percentRemaining: (remaining / limit) * 100,
    };
  }

  // Fallback: try a percentage match anywhere
  const pct = parsePercent(text);
  if (pct !== undefined) {
    return { level: classify({ percentRemaining: pct }), percentRemaining: pct };
  }

  return { level: "exhausted", error: "unparseable output" };
}

function classify(p: { percentRemaining?: number }): QuotaLevel {
  const pct = p.percentRemaining;
  if (pct === undefined) return "ready";
  if (pct <= 5) return "exhausted";
  if (pct <= 20) return "warning";
  return "ready";
}

export function checkEngineQuota(probe: QuotaProbe): QuotaStatus {
  const stderr = probe.stderr ?? "";
  if (/\bHTTP\s*429\b|\b429\s+(too many|rate limit|quota)/i.test(stderr)) {
    return {
      level: "rate-limited",
      remaining: probe.remaining,
      limit: probe.limit,
      percentRemaining: probe.percentRemaining,
      error: "HTTP 429",
    };
  }
  if (/\bHTTP\s*403\b|\b403\s+forbidden/i.test(stderr)) {
    return { level: "forbidden", error: "HTTP 403" };
  }
  if (/not logged in|login required|not authenticated|please login/i.test(stderr)) {
    return { level: "not-logged-in", error: stderr.slice(0, 200) };
  }

  if (probe.percentRemaining !== undefined) {
    return {
      level: classify(probe),
      remaining: probe.remaining,
      limit: probe.limit,
      percentRemaining: probe.percentRemaining,
    };
  }
  return { level: "ready" };
}
