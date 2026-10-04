// src/typesafe-status-report.ts
//
// The `vf config typesafe status` REPORT: the exact line order, every on-disk path it names, and
// the three bucket records it reads. Split out of config-typesafe.ts when the fixes for round 43
// pushed that file past the 400-line cap - and the seam is real rather than a slice: this module
// only FORMATS what it is handed, while config-typesafe.ts is the write/dispatch authority. The
// one direction of the dependency is status -> shared helpers, never back.
//
// Two rules shape the output:
//
//   1. NAME EVERY ARTIFACT. An `enabled` install can leave four files (`typesafe.env`,
//      `typesafe-health.json`, `typesafe-health.probe.json`, `typesafe-health.goal.json`); a
//      removal command that lists fewer leaves state on disk while the docs call it complete.
//   2. SAY WHAT WAS OBSERVED. The key file's permission is measured through `hasPrivateMode` - the
//      same authority the writer enforces - so "owner-only" is a verdict, not a restatement of the
//      filename. `existsSync(...) ? "present 0600"` reported a world-readable key as protected.
import { constants, closeSync, existsSync, fstatSync, openSync, statSync } from "node:fs";
import { hasPrivateMode } from "./durability/posix-fs-semantics.js";
import { TYPESAFE_EGRESS_LINES } from "./typesafe-egress.js";
import {
  GOAL_HEALTH_FILE,
  PROBE_HEALTH_FILE,
  TYPESAFE_BUDGET_BUCKET,
  TYPESAFE_STATE,
  fileForBucket,
  healthPath,
  readHealth,
  typesafeHealthPath,
} from "./typesafe-health.js";
import {
  TYPESAFE_CALL_SITE_NAMES,
  type TypesafeSettings,
  resolveTypesafeKey,
  typesafeEnvPath,
} from "./typesafe-settings.js";

/** The clock seam, so a countdown is testable. */
export interface StatusDeps {
  env?: NodeJS.ProcessEnv;
  userRoot?: string;
  now?: () => number;
}

const clock = (deps: StatusDeps): number => (deps.now ?? Date.now)();
const mmss = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
const fileStamp = (path: string): string => {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return "absent";
  }
};

/** The third artifact's absolute path. `status` used to name only the enforcement record and the
 *  key file, so an operator following the printed removal command left the probe record behind. */
const probeFilePath = (deps: StatusDeps): string =>
  healthPath(deps.userRoot, fileForBucket(TYPESAFE_BUDGET_BUCKET.PROBE));

/** The fourth artifact's absolute path - the same lesson again. The goal record is written by
 *  the judged route, the one a page token can loop, so it is the likeliest record to exist and
 *  a report that does not name it hands the operator an incomplete `rm -f`. */
const goalFilePath = (deps: StatusDeps): string =>
  healthPath(deps.userRoot, fileForBucket(TYPESAFE_BUDGET_BUCKET.GOAL_COVERAGE));

/**
 * The key file's own line, with the permission actually observed.
 *
 * `hasPrivateMode` is the authority the write path uses (owner-only mode bits on POSIX; a
 * protected owner-only DACL on Windows), so the answer comes from the same rule that enforces it -
 * and a file that is not owner-only is called out instead of being reported as protected.
 */
const keyFileStamp = (path: string): string => {
  if (!existsSync(path)) return "absent";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const private_ = hasPrivateMode(stat, 0o777, 0o600, path, fd);
    return private_
      ? "present owner-only"
      : "present NOT owner-only — run `vf config typesafe key`";
  } catch {
    // Unreadable (a directory at that name, a link, EACCES) is not "absent": the entry exists.
    return "present (unreadable)";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** `off` when the user never enabled it, `unconfigured` when enabled with no key, else the
 *  breaker's own state — so an open breaker is never mistaken for a healthy one. */
const breakerState = (
  settings: TypesafeSettings,
  deps: StatusDeps,
  health: ReturnType<typeof readHealth>,
): string => {
  if (!settings.enabled) return TYPESAFE_STATE.OFF;
  const key = resolveTypesafeKey({ env: deps.env, userRoot: deps.userRoot });
  if (key === null) return TYPESAFE_STATE.UNCONFIGURED;
  if (health.state !== TYPESAFE_STATE.OPEN) return health.state;
  const until = health.cooldown_until ? Date.parse(health.cooldown_until) : Number.NaN;
  const remaining = Number.isFinite(until) ? until - clock(deps) : 0;
  return `${TYPESAFE_STATE.OPEN} (resumes in ${mmss(remaining)})`;
};

const keySourceLine = (deps: StatusDeps): string => {
  const key = resolveTypesafeKey({ env: deps.env, userRoot: deps.userRoot });
  if (key === null) return "key source: none";
  return key.source === "env"
    ? "key source: env TYPESAFE_API_KEY"
    : "key source: ~/.vibeflow/typesafe.env";
};

/** Shared by both audit lines; only the LABEL differs, so a change to the shape lands once. */
const callLine = (label: string, health: ReturnType<typeof readHealth>): string => {
  const call = health.last_call;
  if (!call) return `${label}: never`;
  return `${label}: ${call.at} caller=${call.caller} status=${call.status ?? "none"} ms=${call.ms}`;
};

export const thresholdsLine = (s: TypesafeSettings): string =>
  `thresholds: run=${s.runAtConfidence} accept=${s.acceptAtConfidence}`;

const sitesLine = (s: TypesafeSettings): string =>
  `call sites: ${TYPESAFE_CALL_SITE_NAMES.map((n) => `${n}=${s.callSites[n] ? "on" : "off"}`).join(" ")}`;

/**
 * Print the whole status contract, in order. `print` is the same line sink the CLI passes every
 * other subcommand, so the output stays one stream.
 */
export function printStatus(
  print: (message: string) => void,
  settings: TypesafeSettings,
  deps: StatusDeps,
): void {
  const health = readHealth({ userRoot: deps.userRoot });
  const healthPath = typesafeHealthPath(deps.userRoot);
  const envPath = typesafeEnvPath(deps.userRoot);
  print(`calls: ${health.calls ?? 0}/${settings.maxCalls} last run`);
  print(`enabled: ${String(settings.enabled)}`);
  print(keySourceLine(deps));
  print(`model: ${settings.model}`);
  print(thresholdsLine(settings));
  print(`breaker state: ${breakerState(settings, deps, health)}`);
  print(
    `breaker: failStreakLimit=${settings.failStreakLimit} cooldownBaseMs=${settings.cooldownBaseMs} cooldownCapMs=${settings.cooldownCapMs} hookTimeoutMs=${settings.hookTimeoutMs}`,
  );
  print(sitesLine(settings));
  print(callLine("last call", health));
  // Operator probes have their own record (PROBE_HEALTH_FILE), so they cannot transition the
  // enforcement breaker - and they get their own section here for the same reason.
  const probeHealth = readHealth({ userRoot: deps.userRoot, healthFile: PROBE_HEALTH_FILE });
  print(`probe breaker: ${breakerState(settings, deps, probeHealth)}`);
  print(callLine("last probe", probeHealth));
  // Same reason the probe has one: the GOAL bucket's breaker can refuse every goal call on
  // its own, and a breach that `reset` recovers must be visible before it is recovered.
  const goalHealth = readHealth({ userRoot: deps.userRoot, healthFile: GOAL_HEALTH_FILE });
  print(`goal breaker: ${breakerState(settings, deps, goalHealth)}`);
  print(callLine("last goal", goalHealth));
  const probePath = probeFilePath(deps);
  const goalPath = goalFilePath(deps);
  print(`health file: ${healthPath} (${fileStamp(healthPath)})`);
  print(`probe file: ${probePath} (${fileStamp(probePath)})`);
  print(`goal file: ${goalPath} (${fileStamp(goalPath)})`);
  print(`key file: ${envPath} (${keyFileStamp(envPath)})`);
  // Every artifact this integration can write, so the documented uninstall is complete: the probe
  // record was a THIRD file and the goal record is a FOURTH, and a `rm -f` that names fewer
  // leaves state behind.
  print(`remove all: rm -f ${healthPath} ${probePath} ${goalPath} ${envPath}`);
  for (const line of TYPESAFE_EGRESS_LINES) print(line);
}
