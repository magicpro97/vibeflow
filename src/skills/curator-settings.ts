/** #689: curator finding severity thresholds. */
export type CuratorSeverity = "low" | "medium" | "high";

/** #689: background skill-audit preferences. */
export interface CuratorSettings {
  /** Master switch for the curator. */
  enabled: boolean;
  /** Observe-only mode: report, never mutate. Default true. */
  observeMode: boolean;
  /** Five-field cron schedule. Default: Mondays 9am. */
  schedule: string;
  /** Minimum finding severity to surface. Default: medium. */
  severityThreshold: CuratorSeverity;
}

/** Default curator policy. */
export const DEFAULT_CURATOR_SETTINGS: CuratorSettings = {
  enabled: false,
  observeMode: true,
  schedule: "0 9 * * 1",
  severityThreshold: "medium",
};

/** Per-field inclusive bounds in cron order: minute hour dom month dow. */
const FIELD_RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127) return true;
  }
  return false;
}

function isDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** Validate one cron field: atom/list/range/step, or `*`. */
function isValidField(field: string, [min, max]: readonly [number, number]): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part === "") return false;
    let base = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      base = part.slice(0, slash);
      const stepStr = part.slice(slash + 1);
      if (stepStr === "" || !isDigits(stepStr)) return false;
      step = Number(stepStr);
      if (!Number.isSafeInteger(step) || step < 1 || step > max) return false;
    }
    let lo = min;
    let hi = max;
    if (base !== "*") {
      const dash = base.indexOf("-");
      if (dash !== -1) {
        const a = base.slice(0, dash);
        const b = base.slice(dash + 1);
        if (!isDigits(a) || !isDigits(b)) return false;
        lo = Number(a);
        hi = Number(b);
      } else {
        if (!isDigits(base)) return false;
        lo = Number(base);
        hi = lo;
      }
      if (lo < min || hi > max || lo > hi) return false;
    }
  }
  return true;
}

/** #689: strict five-field cron validator (backend + UI mirror). */
export function isValidCuratorCron(s: string): boolean {
  if (typeof s !== "string" || s.length > 100 || hasControlChar(s)) return false;
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  for (let i = 0; i < 5; i++) {
    const field = parts[i] ?? "";
    const range = FIELD_RANGES[i] ?? [0, 0];
    if (!isValidField(field, range)) return false;
  }
  return true;
}

/** #689: validate a stored curator block → defaults on garbage/absent-field. */
export function coerceCuratorSettings(raw: unknown): CuratorSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: CuratorSettings = { ...DEFAULT_CURATOR_SETTINGS };
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  if (typeof obj.observeMode === "boolean") out.observeMode = obj.observeMode;
  if (
    obj.severityThreshold === "low" ||
    obj.severityThreshold === "medium" ||
    obj.severityThreshold === "high"
  ) {
    out.severityThreshold = obj.severityThreshold;
  }
  if (typeof obj.schedule === "string" && isValidCuratorCron(obj.schedule))
    out.schedule = obj.schedule;
  return out;
}

/** #689: read-path — materialize the curator block into `out` from stored `raw`. */
export function applyCuratorSettings(out: { curator?: CuratorSettings }, raw: unknown): void {
  const cur = coerceCuratorSettings(raw);
  if (cur) out.curator = cur;
}

/** #689: write-path — replace-on-write; keep the prior block when `next` omits it. */
export function mergeCuratorSettings(
  merged: { curator?: CuratorSettings },
  next: { curator?: CuratorSettings },
  current: { curator?: CuratorSettings },
): void {
  const curatorCfg = "curator" in next ? coerceCuratorSettings(next.curator) : current.curator;
  if (curatorCfg) merged.curator = curatorCfg;
}
