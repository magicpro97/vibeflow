// Pure-function tests for #689 curator settings UI.
// No Vue mount infra — tests shared lib wiring + static vectors.
// Backend parser parity tests live in test/curator-cron.test.ts.

import { isValidSchedule } from "../lib/curator-schedule.js";
import type { CuratorCounts, CuratorFindingView, CuratorSettings, CuratorView } from "../types.js";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean) {
  if (ok) {
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

function assertDeep(label: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) {
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(b)}`);
    console.error(`  actual:   ${JSON.stringify(a)}`);
    failed++;
  }
}

// ── 1. curator API client shape (#689) ──
function curatorApiUrl(): string {
  return "/api/skills/curator";
}

assert("curator API GET path", curatorApiUrl() === "/api/skills/curator");

function parseCuratorResponse(data: {
  ok: boolean;
  findings: CuratorFindingView[];
  counts: CuratorCounts;
  total: number;
}): CuratorView {
  return { findings: data.findings, counts: data.counts, total: data.total };
}

const sample = parseCuratorResponse({
  ok: true,
  findings: [
    { id: "a", type: "unpinned-registry", severity: "high", summary: "pinned" },
    { id: "b", type: "stale-anchor", severity: "low", summary: "stale" },
  ],
  counts: { "stale-anchor": 1, "duplicate-owner": 0, "unpinned-registry": 1 },
  total: 2,
});
assert("parseCuratorResponse total", sample.total === 2);
assert("parseCuratorResponse first severity", sample.findings[0]?.severity === "high");
assert("parseCuratorResponse counts", sample.counts["unpinned-registry"] === 1);

// Fixed counts object — all three keys always present, initialized 0.
function emptyCounts(): CuratorCounts {
  return { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 };
}
assertDeep("fixed counts object — all 3 keys present", emptyCounts(), {
  "stale-anchor": 0,
  "duplicate-owner": 0,
  "unpinned-registry": 0,
});
assert("fixed counts — exactly 3 keys", Object.keys(emptyCounts()).length === 3);

// ── 2. severity badge mapping (all three severities) ──
function severityBadge(sev: string): string {
  switch (sev) {
    case "high":
      return "bg-red-500/15 text-red-400 border border-red-500/30";
    case "medium":
      return "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30";
    default:
      return "bg-neutral-500/15 text-neutral-400 border border-neutral-500/30";
  }
}

assert("high badge red", severityBadge("high").includes("text-red-400"));
assert("medium badge yellow", severityBadge("medium").includes("text-yellow-400"));
assert("low badge neutral", severityBadge("low").includes("text-neutral-400"));
assert(
  "unknown severity falls back to neutral",
  severityBadge("nope").includes("text-neutral-400"),
);

// ── 3. shared schedule validator — wired from lib, not copied (parity in backend test) ──
assert("default schedule valid", isValidSchedule("0 9 * * 1"));
assert("valid: star + numerics", isValidSchedule("* * * * *"));
assert("valid: steps", isValidSchedule("*/15 8-18 * * 1-5"));
assert("valid: lists", isValidSchedule("0,15,30,45 * * * *"));
assert("valid: ranges", isValidSchedule("5-10/2 * * * *"));
assert("invalid: 99 99 99 99 99", !isValidSchedule("99 99 99 99 99"));
assert("invalid: 0 9 32 13 8", !isValidSchedule("0 9 32 13 8"));
assert("invalid: ? ? ? ? ?", !isValidSchedule("? ? ? ? ?"));
assert("invalid: reversed range", !isValidSchedule("10-5 * * * *"));
assert("invalid: zero step", !isValidSchedule("*/0 * * * *"));
assert("invalid: empty segment", !isValidSchedule("1, * * * *"));
assert("invalid: control char", !isValidSchedule("0 9 * * 1\u0000"));
assert("invalid: tab control", !isValidSchedule("0\t9 * * 1"));
assert("invalid: trailing newline", !isValidSchedule("0 9 * * 1\n"));
assert("invalid: empty", !isValidSchedule(""));
assert("invalid: four fields", !isValidSchedule("0 9 * *"));
assert("invalid: six fields", !isValidSchedule("0 9 * * 1 2"));
assert("invalid: alphanumeric", !isValidSchedule("0 9 * * mon"));
assert("invalid: overlong", !isValidSchedule("0 ".repeat(120)));

// step bounds parity — must match backend (#689): integer 1..max, unsafe rejects
assert("step: dom */31 valid", isValidSchedule("* * */31 * *"));
assert("step: dom */32 invalid", !isValidSchedule("* * */32 * *"));
assert("step: minute */60 invalid", !isValidSchedule("*/60 * * * *"));
assert("step: minute 1/60 invalid", !isValidSchedule("1/60 * * * *"));
assert("step: minute */59 valid", isValidSchedule("*/59 * * * *"));
assert("step: hour */24 invalid", !isValidSchedule("* */24 * * *"));
assert("step: hour */23 valid", isValidSchedule("* */23 * * *"));
assert("step: huge unsafe integer invalid", !isValidSchedule("* * */99999999999999999999 * *"));
assert(
  "step: huge unsafe integer minute invalid",
  !isValidSchedule("*/99999999999999999999 * * * *"),
);

// ── 4. enabled/mode label helper ──
function enabledLabel(c: CuratorSettings): string {
  const state = c.enabled ? "on" : "off";
  const mode = c.observeMode ? "observe-only" : "active";
  return `Curator ${state} · ${mode}`;
}

const defaults: CuratorSettings = {
  enabled: false,
  observeMode: true,
  schedule: "0 9 * * 1",
  severityThreshold: "medium",
};
assert("defaults label", enabledLabel(defaults) === "Curator off · observe-only");
assert(
  "enabled + active label",
  enabledLabel({ ...defaults, enabled: true, observeMode: false }) === "Curator on · active",
);

// ── 5. curator settings shape passes validation (worst-case severity) ──
function validateCurator(c: CuratorSettings): string[] {
  const errors: string[] = [];
  if (typeof c.enabled !== "boolean") errors.push("enabled must be boolean");
  if (typeof c.observeMode !== "boolean") errors.push("observeMode must be boolean");
  if (!isValidSchedule(c.schedule)) errors.push("invalid schedule");
  if (!["low", "medium", "high"].includes(c.severityThreshold))
    errors.push("invalid severityThreshold");
  return errors;
}

assert("defaults valid", validateCurator(defaults).length === 0);
const high: CuratorSettings = { ...defaults, severityThreshold: "high" };
assert("high threshold valid", validateCurator(high).length === 0);
const bad: CuratorSettings = { ...defaults, severityThreshold: "critical" as never };
assert(
  "unknown threshold caught",
  validateCurator(bad).some((e) => e.includes("severity")),
);

// ── 6. save-disabled wiring: invalid schedule blocks Save (#689) ──
function saveDisabled(valid: boolean, saving: boolean): boolean {
  return saving || !valid;
}
assert("invalid schedule → Save disabled", saveDisabled(false, false) === true);
assert("valid schedule + not saving → Save enabled", saveDisabled(true, false) === false);
assert("saving → Save disabled regardless of validity", saveDisabled(true, true) === true);

// ── Results ──
if (failed > 0) {
  console.error(`\nui-curator-689.test.ts: ${passed} passed, ${failed} failed ❌`);
} else {
  console.log(`\nui-curator-689.test.ts: ${passed} passed, ${failed} failed ✅`);
}
