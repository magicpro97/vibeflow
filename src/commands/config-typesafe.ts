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

import { statSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { out } from "../logbus.js";
import { type VibeSettings, readSettings, writeSettings } from "../settings.js";
import { TYPESAFE_EGRESS_LINES } from "../typesafe-egress.js";
import {
  FAILURE_CLASS,
  type FailureClass,
  TYPESAFE_BUDGET_BUCKET,
  fileForBucket,
  healthPath,
  idleHealth,
  outcomeProbe,
  readHealth,
  tuningFor,
  typesafeHealthPath,
  withTypesafeGuard,
  writeHealth,
} from "../typesafe-health.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  TYPESAFE_CALL_SITE_NAMES,
  type TypesafeCallSiteName,
  type TypesafeSettings,
  coerceTypesafeSettings,
  typesafeEnvPath,
  writeTypesafeEnv,
} from "../typesafe-settings.js";
import { printStatus, thresholdsLine } from "../typesafe-status-report.js";
import type { judgeAssessment } from "../typesafe.js";

// `TYPESAFE_EGRESS_LINES` is re-exported (not re-declared): it moved to
// src/typesafe-egress.ts when this file hit the 400-line cap, and the CLI, the
// tests and the docs all import it from HERE, so the name stays. Its home is the egress module.
export { TYPESAFE_EGRESS_LINES };
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
/** A file's mtime, or `absent`. `reset` reports where the record it just wrote lives. */
const mtimeStamp = (path: string): string => {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return "absent";
  }
};

async function resetAllBreakers(
  settings: TypesafeSettings,
  deps: ConfigTypesafeDeps,
): Promise<void> {
  await resetBreaker(settings, deps);
  await resetBreaker(settings, deps, TYPESAFE_BUDGET_BUCKET.PROBE);
}

/** Overwrite ONE breaker with a fresh `idle` record. `bucket` decides WHICH record: the CLI probe
 *  resets its own, so a passing probe cannot clear the enforcement breaker the hook/verify/review
 *  seams depend on - that cross-bucket write is exactly what the separate record files exist to
 *  prevent.
 *
 *  The probe bucket KEEPS its `last_call`/`calls` audit: dropping them made `status` print
 *  `last probe: never` for a probe that had just run, which is the same class of lie as reporting
 *  a world-readable key as protected.
 *
 *  The operator paths (`reset`, `key`) clear BOTH records through `resetAllBreakers` above: a
 *  tripped PROBE breaker is otherwise unrecoverable, since the probe is refused before it can prove
 *  itself. This function stays the internal single-record primitive. */
async function resetBreaker(
  settings: TypesafeSettings,
  deps: ConfigTypesafeDeps,
  bucket?: (typeof TYPESAFE_BUDGET_BUCKET)[keyof typeof TYPESAFE_BUDGET_BUCKET],
): Promise<void> {
  const file = bucket === undefined ? undefined : fileForBucket(bucket);
  const idle = idleHealth(tuningFor(settings).cooldownBaseMs);
  const previous =
    file === undefined ? undefined : readHealth({ userRoot: deps.userRoot, healthFile: file });
  await writeHealth(
    {
      ...idle,
      ...(previous?.last_call === undefined ? {} : { last_call: previous.last_call }),
      ...(previous?.calls === undefined ? {} : { calls: previous.calls }),
    },
    {
      userRoot: deps.userRoot,
      now: () => clock(deps),
      ...(file === undefined ? {} : { healthFile: file }),
    },
  );
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
    // The whole report lives in its own module (typesafe-status-report.ts): it only formats, while
    // this file owns the writes, and the extraction is what keeps both under the 400-line cap.
    printStatus(print, current, {
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.userRoot === undefined ? {} : { userRoot: deps.userRoot }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    return 0;
  }

  if (sub === "on" || sub === "off") {
    const enabled = sub === "on";
    if (enabled) for (const line of TYPESAFE_EGRESS_LINES) print(line);
    const next = write(base, { expectRepo: base, typesafe: { ...current, enabled } });
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
    write(base, { expectRepo: base, typesafe: { ...current, model: id } });
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
    const next = write(base, { expectRepo: base, typesafe: { ...current, [field]: raw } });
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
      expectRepo: base,
      typesafe: { ...current, callSites: { ...current.callSites, [name]: mode === "on" } },
    });
    print(`call site: ${name}=${mode}`);
    return 0;
  }

  if (sub === "key") {
    // ANY argument is refused, not just a `--` one. The old arm only caught `--key`, so
    // `vf config typesafe key sk-live-XXXX` still put the secret in shell history and `ps` output,
    // then silently discarded it and prompted anyway - the exact leak the refusal exists to stop,
    // reachable through the syntax the guard did not name.
    if (rest[1] !== undefined) {
      print(
        "refusing a key argument (visible in shell history and ps) — pipe the key on stdin instead",
      );
      return 2;
    }
    const ask = deps.ask ?? promptHidden;
    const value = (await ask("TypeSafe API key (input hidden): ")).trim();
    if (!value) {
      print("TypeSafe API key must be provided via hidden stdin");
      return 2;
    }
    const path = writeTypesafeEnv(value, { userRoot: deps.userRoot });
    // A breaker that tripped on `auth` would otherwise keep refusing a freshly rotated key — both
    // records, because the probe has its own breaker and a refusal there is not self-healing.
    await resetAllBreakers(current, deps);
    print(`key stored: ${path} (0600)`);
    print("breaker: idle");
    return 0;
  }

  if (sub === "reset") {
    await resetAllBreakers(current, deps);
    const healthFile = typesafeHealthPath(deps.userRoot);
    const probeFile = healthPath(deps.userRoot, fileForBucket(TYPESAFE_BUDGET_BUCKET.PROBE));
    print("breaker: idle");
    print(`health file: ${healthFile} (${mtimeStamp(healthFile)})`);
    print(
      `note: reset clears the breaker, it does not delete the file — rm -f ${healthFile} ${probeFile} ${typesafeEnvPath(deps.userRoot)}`,
    );
    return 0;
  }

  if (sub === "test") return await probe(print, current, deps);

  print(USAGE);
  return 2;
}

/** One live production invocation, with a FULL `JudgeInject` (a bare state string would always
 *  come back `null`, because `judgeAssessment` grades against `inject.goal`). The outcome seam
 *  is what separates "you have no key" (exit 2) from "the request failed" (exit 1).
 *
 *  It runs through `withTypesafeGuard` with `bucket: PROBE`, exactly as the HTTP probe route does:
 *  a raw `judgeAssessment` call here was unbudgeted, outside the file-backed breaker, and recorded
 *  in neither health file - so the `probe breaker`/`last probe` section of `status` could never
 *  reflect a CLI probe, and the success path's `resetBreaker` wrote the ENFORCEMENT record (the
 *  cross-bucket leak the separate records exist to prevent). */
async function probe(
  print: (message: string) => void,
  settings: TypesafeSettings,
  deps: ConfigTypesafeDeps,
): Promise<number> {
  const judgeFn = deps.judge ?? (await import("../typesafe.js")).judgeAssessment;
  let refusal: FailureClass | undefined;
  const started = clock(deps);
  const outcome = outcomeProbe();
  let attempted = false;
  const verdict = await withTypesafeGuard(
    "probe",
    async () => {
      attempted = true;
      return judgeFn(PROBE_STATE, {
        settings,
        env: deps.env ?? process.env,
        userRoot: deps.userRoot,
        goal: PROBE_GOAL,
        timeoutMs: settings.timeoutMs,
        onOutcome: (o) => {
          outcome.onOutcome(o);
          if (!o.ok && o.class !== undefined) refusal = o.class;
        },
      });
    },
    {
      ...(deps.userRoot === undefined ? {} : { userRoot: deps.userRoot }),
      bucket: TYPESAFE_BUDGET_BUCKET.PROBE,
      tuning: tuningFor(settings),
      outcome: outcome.outcome,
      now: () => clock(deps),
    },
  );
  if (!verdict) {
    // Three distinct refusals, three distinct diagnoses. `disabled` used to print "check
    // key/quota" - a wrong answer for the documented "safe to run before enabling" flow, since
    // the real cause is that the feature is off.
    if (refusal === FAILURE_CLASS.UNCONFIGURED) {
      print("TypeSafe: no key configured");
      return 2;
    }
    if (refusal === FAILURE_CLASS.DISABLED) {
      print("TypeSafe: judge is disabled — run `vf config typesafe on` first");
      return 2;
    }
    if (!attempted) {
      print("TypeSafe: refused by the call budget or an open probe breaker");
      return 1;
    }
    print("TypeSafe: request failed — check key/quota");
    return 1;
  }
  const ms = clock(deps) - started;
  print(`HTTP 200 · model ${settings.model} · ${ms}ms`);
  print(
    `covers_goal = ${verdict.covers.score} (confidence ${verdict.covers.confidence ?? "unknown"})`,
  );
  // A passing probe must not leave ITS OWN breaker stuck `open` behind a healthy key. The
  // enforcement record is untouched on purpose: clearing it is the `key` subcommand's job.
  await resetBreaker(settings, deps, TYPESAFE_BUDGET_BUCKET.PROBE);
  print("breaker: idle");
  return 0;
}
