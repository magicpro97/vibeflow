// src/server/routes-typesafe.ts — the System One (Jev) surface the web control
// center reads. Two rules shape this file:
//
//   1. The key NEVER crosses the wire. `/api/typesafe` reports where the key came
//      from (`keySource`), never the key or a prefix of it, and the probe runs
//      HERE, server-side, so the browser never holds a credential.
//   2. `state` is a required row, not decoration. `configured` answers "is a key
//      set"; `state` answers "is it working". Without the second the drawer would
//      render a tripped breaker green for the whole `cooldownCapMs` while every
//      judge call short-circuits to null.
import { PROBE_GOAL, PROBE_STATE } from "../commands/config-typesafe.js";
import { outBusOnly } from "../logbus.js";
import { type VibeSettings, readSettings } from "../settings.js";
import {
  type FailureClass,
  TYPESAFE_BUDGET_BUCKET,
  TYPESAFE_STATE,
  type TypesafeHealth,
  type TypesafeState,
  fileForBucket,
  outcomeProbe,
  readHealth,
  resetCallBudget,
  tuningFor,
  withTypesafeGuard,
} from "../typesafe-health.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  TYPESAFE_CALL_SITE_NAMES,
  type TypesafeCallSiteName,
  type TypesafeCallSites,
  type TypesafeKeySource,
  type TypesafeSettings,
  isTypesafeEnabled,
  resolveTypesafeKey,
} from "../typesafe-settings.js";
import type { judgeAssessment } from "../typesafe.js";

/** What `/api/typesafe` and `GET /api/settings` expose. Redacted by construction. */
export interface TypesafeSettingsView {
  /** The repo the server READ this view from. The client stamps its "which repo do these rows
   *  describe" ref from THIS, never from its own text field: the field is live and mutable while
   *  the request is in flight, so a stamp taken from it after the `await` would describe whatever
   *  the user typed next rather than what the server answered for. Kept in sync with the UI copy
   *  in src/ui/src/types-settings.ts. */
  repo: string;
  state: TypesafeState;
  cooldownUntil?: string;
  /** The PROBE's own recorded breaker, read from its own health file. The probe runs through
   *  the PROBE bucket, which reads and writes
   *  `typesafe-health.probe.json`, so `state` above (the enforcement record) says NOTHING about
   *  whether "Test connection" will be refused: at the shipped default the two records routinely
   *  disagree, and the section used to show `idle` with an enabled button while every click came
   *  back "refused by the call budget or an open circuit breaker". */
  probeState: TypesafeState;
  probeCooldownUntil?: string;
  lastClass?: FailureClass;
  calls?: number;
  enabled: boolean;
  configured: boolean;
  keySource: "env" | "file" | "none";
  model: string;
  timeoutMs: number;
  thresholds: { run: number; accept: number };
  callSites: TypesafeCallSites;
  lastCall?: { at: string; caller: string; status?: number; ms: number };
  /** The effective, coerced block, for DISPLAY. The control center posts only the four editable
   *  fields on save, and the write path re-coerces them onto the STORED block
   *  (`mergeTypesafeSettings`), so the unsent fields come from disk — echoing this snapshot would
   *  revert anything changed out of band (e.g. `vf config typesafe model`). */
  settings: TypesafeSettings;
}

export interface TypesafeViewInject {
  settings?: VibeSettings;
  env?: NodeJS.ProcessEnv;
  userRoot?: string;
  health?: TypesafeHealth;
  /** The PROBE record, injected by a test; production reads it off disk like `health`. */
  probeHealth?: TypesafeHealth;
}

/** Every call-site toggle, projected off the ONE shared authority — never restated here. */
function callSiteView(raw: TypesafeCallSites | undefined): TypesafeCallSites {
  const out = {} as TypesafeCallSites;
  for (const name of TYPESAFE_CALL_SITE_NAMES) {
    const site: TypesafeCallSiteName = name;
    out[site] = raw?.[site] === true;
  }
  return out;
}

/** `off`/`unconfigured` are decided here, not read off disk: the health record may
 *  name them from an earlier run under different settings, and a recorded breaker
 *  state (`open`/`half-open`) only means something once a key actually resolves. */
function effectiveState(enabled: boolean, configured: boolean, recorded: TypesafeState) {
  if (!enabled) return TYPESAFE_STATE.OFF;
  if (!configured) return TYPESAFE_STATE.UNCONFIGURED;
  return recorded === TYPESAFE_STATE.OPEN || recorded === TYPESAFE_STATE.HALF_OPEN
    ? recorded
    : TYPESAFE_STATE.IDLE;
}

export function typesafeSettingsView(
  repo: string,
  inject: TypesafeViewInject = {},
): TypesafeSettingsView {
  const settings = inject.settings ?? readSettings(repo);
  const resolved = settings.typesafe ?? DEFAULT_TYPESAFE_SETTINGS;
  const enabled = isTypesafeEnabled(settings);
  const health = inject.health ?? readHealth({ userRoot: inject.userRoot });
  // A SEPARATE read of a SEPARATE file: the probe's breaker is its own, so the section can only
  // report truthfully about the button it shows by reading the record the button's call writes.
  const probeHealth =
    inject.probeHealth ??
    readHealth({
      userRoot: inject.userRoot,
      healthFile: fileForBucket(TYPESAFE_BUDGET_BUCKET.PROBE),
    });
  const key: TypesafeKeySource = resolveTypesafeKey({
    env: inject.env,
    userRoot: inject.userRoot,
  });
  return {
    repo,
    state: effectiveState(enabled, key !== null, health.state),
    ...(health.cooldown_until ? { cooldownUntil: health.cooldown_until } : {}),
    probeState: effectiveState(enabled, key !== null, probeHealth.state),
    ...(probeHealth.cooldown_until ? { probeCooldownUntil: probeHealth.cooldown_until } : {}),
    ...(health.last_class ? { lastClass: health.last_class } : {}),
    ...(typeof health.calls === "number" ? { calls: health.calls } : {}),
    enabled,
    configured: key !== null,
    keySource: key ? key.source : "none",
    model: resolved.model,
    timeoutMs: resolved.timeoutMs,
    thresholds: { run: resolved.runAtConfidence, accept: resolved.acceptAtConfidence },
    callSites: callSiteView(resolved.callSites),
    settings: resolved,
    ...(health.last_call
      ? {
          lastCall: {
            at: health.last_call.at,
            caller: health.last_call.caller,
            ...(health.last_call.status !== undefined ? { status: health.last_call.status } : {}),
            ms: health.last_call.ms,
          },
        }
      : {}),
  };
}

/** `GET /api/typesafe`. Returns null for any other path so the caller keeps dispatching. */
export function handleTypesafeReadRoute(
  path: string,
  repo: string,
  inject: TypesafeViewInject = {},
): Response | null {
  if (path !== "/api/typesafe") return null;
  return Response.json(typesafeSettingsView(repo, inject));
}

export interface TypesafeTestInject extends TypesafeViewInject {
  /** The repository the caller read its view from; compared against the live active repo. */
  expectRepo: string;
  repo: string;
  now?: () => number;
  judge?: typeof judgeAssessment;
}

const describeFailure = (failure: FailureClass | undefined): string =>
  failure ? `judge call failed (${failure})` : "no verdict returned";

/**
 * `POST /api/typesafe/test` — the control center's "Test connection" button. The
 * probe is a REAL production invocation with the fixed literal state from
 * § Data egress (no repository content leaves the machine), run here so the key
 * stays server-side. It resolves the live client with a DYNAMIC import: the
 * module that owns the only socket in the repo must not be in the static import
 * graph of anything a disabled run loads.
 */
export async function handleTypesafeTestRoute(inject: TypesafeTestInject): Promise<Response> {
  // Parity with the save path (routes-settings.ts). The probe reads the process-global active repo here,
  // so a drawer opened on repo A in one tab can bill a call and print a readout for whatever repo
  // another client has since made active - the drawer's own client-side guard compares two of ITS
  // mirrors and, as its comment concedes, cannot see that move. The caller names the repository it was
  // read from, and the server compares. Required, like the save path: an unnamed probe is the hole.
  if (inject.expectRepo !== inject.repo) {
    return Response.json(
      { ok: false, refused: true, error: "the active repository changed; reload before testing" },
      { status: 409 },
    );
  }
  const settings = inject.settings ?? readSettings(inject.repo);
  const resolved = settings.typesafe ?? DEFAULT_TYPESAFE_SETTINGS;
  if (!isTypesafeEnabled(settings)) {
    return Response.json({ ok: false, refused: true, error: "System One judge is disabled" });
  }
  if (!resolveTypesafeKey({ env: inject.env, userRoot: inject.userRoot })) {
    return Response.json({
      ok: false,
      refused: true,
      error: "key missing — set TYPESAFE_API_KEY or run vf config typesafe key",
    });
  }
  const judge = inject.judge ?? (await import("../typesafe.js")).judgeAssessment;
  const now = inject.now ?? Date.now;
  const startedAt = now();
  // The probe must go through the SAME choke point as every other call site. Calling
  // `judgeAssessment` directly left it outside the per-process call budget and outside the
  // file-backed breaker (both live in `withTypesafeGuard`), so a client holding the page token
  // could loop this route issuing billed requests that never touched the breaker — even while the
  // breaker was open for every real call site. The CLI probe has the same shape and stays a single
  // human-initiated command; this one is scriptable, so it pays the same toll: its call feeds the
  // breaker and charges its own budget bucket, exactly as one `vf config typesafe test` does.
  // ("Same toll" is per click, NOT a shared allowance: the bucket restarts below because a click
  // IS its run — see that note.)
  //
  // `outcome: probe.outcome` is not decoration. The guard reads `inject.outcome?.()` and falls back
  // to `FAILURE_CLASS.NONE`, so a guard call that omits it stamps every vendor failure as a
  // SUCCESS: the streak/trip ladder becomes unreachable and a probe against a rotated-away key can
  // reset an open breaker to idle. `judgeAssessment` never throws (it collapses classified
  // failures to null), so the guard's catch arm cannot classify in its place. Mirrors
  // src/commands/dispatch-reviewer-llm.ts.
  // A CLICK is the run; this long-lived server is not. The counter is per process and
  // `resetCallBudget` had no production caller, so after `maxCalls` (default 20) clicks EVER
  // "Test connection" answered "refused by the call budget or an open circuit breaker" for the
  // rest of the process - and `vf config typesafe reset` only rewrites the JSON record, so it
  // cannot reach module memory. Only a server restart recovered it. Same shape as one
  // `vf config typesafe test` invocation, and the probe bucket alone, so a probe can never refund
  // the enforcement count.
  resetCallBudget(TYPESAFE_BUDGET_BUCKET.PROBE);
  const probe = outcomeProbe();
  let attempted = false;
  const verdict = await withTypesafeGuard(
    "probe",
    async () => {
      attempted = true;
      return judge(PROBE_STATE, {
        settings: resolved,
        env: inject.env,
        userRoot: inject.userRoot,
        goal: PROBE_GOAL,
        timeoutMs: resolved.timeoutMs,
        onOutcome: probe.onOutcome,
      });
    },
    {
      ...(inject.userRoot === undefined ? {} : { userRoot: inject.userRoot }),
      // The probe charges its OWN bucket: a caller holding a page token must not be able to spend
      // the budget the hook/verify/review seams depend on for their veto.
      bucket: TYPESAFE_BUDGET_BUCKET.PROBE,
      out: outBusOnly,
      tuning: tuningFor(resolved),
      outcome: probe.outcome,
    },
  );
  const ms = now() - startedAt;
  const signal = probe.outcome();
  // A refusal is not a judge failure, and reporting it as one would send the user hunting for a
  // key or network problem that does not exist. `attempted` is what separates the two: the guard
  // returns null both when it refuses and when the judge itself returned nothing.
  if (!attempted) {
    return Response.json({
      ok: false,
      refused: true,
      model: resolved.model,
      ms,
      error: "refused by the call budget or an open circuit breaker",
    });
  }
  if (!verdict) {
    return Response.json({
      ok: false,
      model: resolved.model,
      ms,
      ...(signal?.status === undefined ? {} : { status: signal.status }),
      error: describeFailure(signal?.cls),
    });
  }
  return Response.json({
    ok: true,
    model: resolved.model,
    ms,
    score: verdict.covers.score,
    ...(verdict.covers.confidence !== undefined ? { confidence: verdict.covers.confidence } : {}),
  });
}
