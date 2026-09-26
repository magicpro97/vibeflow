// src/commands/config-typesafe.ts
//
// `vf config typesafe <on|off|status|model|threshold|call-site|key|reset|test>` — the whole
// user-facing surface of the optional System One judge.
//
// Two invariants shape the file:
//
//   1. DISCLOSURE BEFORE ACTION. `on` prints the egress notice BEFORE it writes the setting, and
//      `status` prints it UNCONDITIONALLY, so a user auditing a disabled install still sees what
//      turning it on would transmit. The four payload descriptions live in ONE exported constant
//      (`TYPESAFE_EGRESS_LINES`) — never hand-inlined at a second call site.
//   2. THE CLIENT IS NEVER LOADED ON A DISABLED PATH. This module sits in the `src/cli.ts` static
//      import graph, so `judgeAssessment` is a TYPE-ONLY import and the live probe resolves the
//      module with a dynamic `import()` INSIDE the `test` branch (C27-c). A static import here
//      would evaluate the repo's only socket on every `vf` invocation.

import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { out } from "../logbus.js";
import { type VibeSettings, readSettings, writeSettings } from "../settings.js";
import {
  TYPESAFE_STATE,
  idleHealth,
  readHealth,
  tuningFor,
  typesafeHealthPath,
  writeHealth,
} from "../typesafe-health.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  TYPESAFE_CALL_SITE_NAMES,
  type TypesafeCallSiteName,
  type TypesafeSettings,
  coerceTypesafeSettings,
  resolveTypesafeKey,
  typesafeEnvPath,
  writeTypesafeEnv,
} from "../typesafe-settings.js";
import type { judgeAssessment } from "../typesafe.js";

/** What leaves the machine, per call site — the single runtime authority for the wording that
 *  `docs/SECURITY_MODEL.md` and the Control Center restate. `state` travels verbatim. */
export const TYPESAFE_EGRESS_LINES: readonly string[] = Object.freeze([
  "sends to https://api.typesafe.ai/v1/systemone (third party) when a call site is on:",
  "  reviewer     the unified diff of your changes + the goal text",
  "  goalCoverage the unified diff of your changes + the goal text",
  "  risk         the raw shell command, including any secret typed inline in it",
  "  planner      the work-unit name and its full spec text",
  "content is sent verbatim: not redacted, not truncated. the API key is a header, never payload.",
  "stop it: vf config typesafe call-site <name> off (one site) or vf config typesafe off (all four)",
]);

/** Fixed literals, never repository content: a probe must be safe to run BEFORE the feature is
 *  enabled. Both are named so the egress table can enumerate exactly what a probe sends. */
export const PROBE_STATE =
  "diff: src/gates.ts +12 -3\n+export function computeConfidence() { return 0.9; }";
export const PROBE_GOAL = "the change adds a compute-confidence function";

export interface ConfigTypesafeDeps {
  out?: (message: string) => void;
  ask?: (question: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  userRoot?: string;
  judge?: typeof judgeAssessment;
  readSettings?: typeof readSettings;
  writeSettings?: typeof writeSettings;
  now?: () => number;
}

const USAGE = "Usage: vf config typesafe ...";
const MODEL_USAGE = "Usage: vf config typesafe model <id>";
const THRESHOLD_USAGE = "Usage: vf config typesafe threshold <run|accept> <0..1>";
const CALL_SITE_USAGE = `Usage: vf config typesafe call-site <${TYPESAFE_CALL_SITE_NAMES.join("|")}> <on|off>`;

/**
 * Read the key from stdin with the echo muted. A TTY gets the prompt on the REAL stdout and a
 * silent `readline` output; a pipe (CI, `cat key | vf config typesafe key`) has no echo to mute,
 * so it takes a single line and closes.
 */
export async function promptHidden(
  question: string,
  io: { input?: NodeJS.ReadStream; output?: NodeJS.WritableStream } = {},
): Promise<string> {
  const input = io.input ?? process.stdin;
  if (!input.isTTY) {
    const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const line = await new Promise<string>((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
    rl.close();
    return line;
  }
  (io.output ?? process.stdout).write(question);
  const rl = createInterface({
    input,
    terminal: true,
    output: new Writable({ write: (_c, _e, done) => done() }),
  });
  const answer = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  return answer;
}

const clock = (deps: ConfigTypesafeDeps): number => (deps.now ?? Date.now)();
const block = (base: string, read: typeof readSettings): TypesafeSettings =>
  coerceTypesafeSettings(read(base).typesafe) ?? DEFAULT_TYPESAFE_SETTINGS;
const mmss = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
const fileStamp = (path: string, io: ConfigTypesafeDeps): string => {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return "absent";
  }
};

/** `off` when the user never enabled it, `unconfigured` when enabled with no key, else the
 *  breaker's own state — so an open breaker is never mistaken for a healthy one. */
const breakerState = (
  settings: TypesafeSettings,
  deps: ConfigTypesafeDeps,
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

const keySourceLine = (deps: ConfigTypesafeDeps): string => {
  const key = resolveTypesafeKey({ env: deps.env, userRoot: deps.userRoot });
  if (key === null) return "key source: none";
  return key.source === "env"
    ? "key source: env TYPESAFE_API_KEY"
    : "key source: ~/.vibeflow/typesafe.env";
};

const thresholdsLine = (s: TypesafeSettings): string =>
  `thresholds: run=${s.runAtConfidence} accept=${s.acceptAtConfidence}`;

const sitesLine = (s: TypesafeSettings): string =>
  `call sites: ${TYPESAFE_CALL_SITE_NAMES.map((n) => `${n}=${s.callSites[n] ? "on" : "off"}`).join(" ")}`;

const lastCallLine = (health: ReturnType<typeof readHealth>): string => {
  const call = health.last_call;
  if (!call) return "last call: never";
  return `last call: ${call.at} caller=${call.caller} status=${call.status ?? "none"} ms=${call.ms}`;
};

/** Overwrite the breaker with a fresh `idle` record: the key-rotation recovery path. */
async function resetBreaker(settings: TypesafeSettings, deps: ConfigTypesafeDeps): Promise<void> {
  await writeHealth(idleHealth(tuningFor(settings).cooldownBaseMs), {
    userRoot: deps.userRoot,
    now: () => clock(deps),
  });
}

export async function configTypesafe(
  rest: string[],
  base: string,
  _flags: Record<string, string | boolean> = {},
  deps: ConfigTypesafeDeps = {},
): Promise<number> {
  const print = deps.out ?? ((message: string) => out("vf", message));
  const read = deps.readSettings ?? readSettings;
  const write = deps.writeSettings ?? writeSettings;
  const current = block(base, read);
  const sub = rest[0];

  if (sub === undefined || sub === "status") {
    const health = readHealth({ userRoot: deps.userRoot });
    const healthPath = typesafeHealthPath(deps.userRoot);
    const envPath = typesafeEnvPath(deps.userRoot);
    print(`calls: ${health.calls ?? 0}/${current.maxCalls} last run`);
    print(`enabled: ${String(current.enabled)}`);
    print(keySourceLine(deps));
    print(`model: ${current.model}`);
    print(thresholdsLine(current));
    print(`breaker state: ${breakerState(current, deps, health)}`);
    print(
      `breaker: failStreakLimit=${current.failStreakLimit} cooldownBaseMs=${current.cooldownBaseMs} cooldownCapMs=${current.cooldownCapMs} hookTimeoutMs=${current.hookTimeoutMs}`,
    );
    print(sitesLine(current));
    print(lastCallLine(health));
    print(`health file: ${healthPath} (${fileStamp(healthPath, deps)})`);
    print(`key file: ${envPath} (${existsSync(envPath) ? "present 0600" : "absent"})`);
    print(`remove both: rm -f ${healthPath} ${envPath}`);
    for (const line of TYPESAFE_EGRESS_LINES) print(line);
    return 0;
  }

  if (sub === "on" || sub === "off") {
    const enabled = sub === "on";
    if (enabled) for (const line of TYPESAFE_EGRESS_LINES) print(line);
    const next = write(base, { typesafe: { ...current, enabled } });
    print(`enabled: ${String(next.typesafe?.enabled ?? enabled)}`);
    print(thresholdsLine(coerceTypesafeSettings(next.typesafe) ?? current));
    if (!enabled) print("sends: nothing — all four call sites disabled");
    return 0;
  }

  if (sub === "model") {
    const id = rest[1]?.trim();
    if (!id) {
      print(MODEL_USAGE);
      return 2;
    }
    write(base, { typesafe: { ...current, model: id } });
    print(`model: ${id}`);
    return 0;
  }

  if (sub === "threshold") {
    const which = rest[1];
    const raw = Number(rest[2]);
    if ((which !== "run" && which !== "accept") || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      print(THRESHOLD_USAGE);
      return 2;
    }
    const field = which === "run" ? "runAtConfidence" : "acceptAtConfidence";
    const next = write(base, { typesafe: { ...current, [field]: raw } });
    print(thresholdsLine(coerceTypesafeSettings(next.typesafe) ?? current));
    return 0;
  }

  if (sub === "call-site") {
    const name = rest[1] as TypesafeCallSiteName | undefined;
    const mode = rest[2];
    if (
      name === undefined ||
      !TYPESAFE_CALL_SITE_NAMES.includes(name) ||
      (mode !== "on" && mode !== "off")
    ) {
      print(CALL_SITE_USAGE);
      return 2;
    }
    write(base, {
      typesafe: { ...current, callSites: { ...current.callSites, [name]: mode === "on" } },
    });
    print(`call site: ${name}=${mode}`);
    return 0;
  }

  if (sub === "key") {
    if (rest[1]?.startsWith("--")) {
      print("refusing --key (visible in shell history and ps) — pipe the key on stdin instead");
      return 2;
    }
    const ask = deps.ask ?? promptHidden;
    const value = (await ask("TypeSafe API key (input hidden): ")).trim();
    if (!value) {
      print("TypeSafe API key must be provided via hidden stdin");
      return 2;
    }
    const path = writeTypesafeEnv(value, { userRoot: deps.userRoot });
    // A breaker that tripped on `auth` would otherwise keep refusing a freshly rotated key.
    await resetBreaker(current, deps);
    print(`key stored: ${path} (0600)`);
    print("breaker: idle");
    return 0;
  }

  if (sub === "reset") {
    await resetBreaker(current, deps);
    const healthPath = typesafeHealthPath(deps.userRoot);
    print("breaker: idle");
    print(`health file: ${healthPath} (${fileStamp(healthPath, deps)})`);
    print(
      `note: reset clears the breaker, it does not delete the file — rm -f ${healthPath} ${typesafeEnvPath(deps.userRoot)}`,
    );
    return 0;
  }

  if (sub === "test") return await probe(print, current, deps);

  print(USAGE);
  return 2;
}

/** One live production invocation, with a FULL `JudgeInject` (a bare state string would always
 *  come back `null`, because `judgeAssessment` grades against `inject.goal`). The outcome seam
 *  is what separates "you have no key" (exit 2) from "the request failed" (exit 1). */
async function probe(
  print: (message: string) => void,
  settings: TypesafeSettings,
  deps: ConfigTypesafeDeps,
): Promise<number> {
  const judgeFn = deps.judge ?? (await import("../typesafe.js")).judgeAssessment;
  let unconfigured = false;
  const started = clock(deps);
  const verdict = await judgeFn(PROBE_STATE, {
    settings,
    env: deps.env ?? process.env,
    userRoot: deps.userRoot,
    goal: PROBE_GOAL,
    timeoutMs: settings.timeoutMs,
    onOutcome: (o) => {
      if (!o.ok && o.class === "unconfigured") unconfigured = true;
    },
  });
  if (!verdict) {
    if (unconfigured) {
      print("TypeSafe: no key configured");
      return 2;
    }
    print("TypeSafe: request failed — check key/quota");
    return 1;
  }
  const ms = clock(deps) - started;
  print(`HTTP 200 · model ${settings.model} · ${ms}ms`);
  print(
    `covers_goal = ${verdict.covers.score} (confidence ${verdict.covers.confidence ?? "unknown"})`,
  );
  // A passing probe must not leave a breaker stuck `open` behind a healthy key.
  await resetBreaker(settings, deps);
  print("breaker: idle");
  return 0;
}
