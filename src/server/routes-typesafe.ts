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
  TYPESAFE_STATE,
  type TypesafeHealth,
  type TypesafeState,
  readHealth,
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
  state: TypesafeState;
  cooldownUntil?: string;
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
  /** The effective, coerced block. The control center round-trips THIS on save:
   *  `coerceTypesafeSettings` fills a partial block from the DEFAULTS, so echoing
   *  only the edited fields would silently reset model, timeoutMs and the breaker. */
  settings: TypesafeSettings;
}

export interface TypesafeViewInject {
  settings?: VibeSettings;
  env?: NodeJS.ProcessEnv;
  userRoot?: string;
  health?: TypesafeHealth;
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
  const key: TypesafeKeySource = resolveTypesafeKey({
    env: inject.env,
    userRoot: inject.userRoot,
  });
  return {
    state: effectiveState(enabled, key !== null, health.state),
    ...(health.cooldown_until ? { cooldownUntil: health.cooldown_until } : {}),
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
  const settings = inject.settings ?? readSettings(inject.repo);
  const resolved = settings.typesafe ?? DEFAULT_TYPESAFE_SETTINGS;
  if (!isTypesafeEnabled(settings)) {
    return Response.json({ ok: false, error: "System One judge is disabled" });
  }
  if (!resolveTypesafeKey({ env: inject.env, userRoot: inject.userRoot })) {
    return Response.json({
      ok: false,
      error: "key missing — set TYPESAFE_API_KEY or run vf config typesafe key",
    });
  }
  const judge = inject.judge ?? (await import("../typesafe.js")).judgeAssessment;
  const now = inject.now ?? Date.now;
  let failure: FailureClass | undefined;
  let status: number | undefined;
  const startedAt = now();
  // The probe must go through the SAME choke point as every other call site. Calling
  // `judgeAssessment` directly left it outside the per-process call budget and outside the
  // file-backed breaker (both live in `withTypesafeGuard`), so a client holding the page token
  // could loop this route and issue unbounded billed requests — even while the breaker was open
  // for every real call site. The CLI probe has the same shape and stays a single human-initiated
  // command; this one is scriptable, so it pays the same toll.
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
        onOutcome: (outcome) => {
          if (!outcome.ok) failure = outcome.class;
          status = outcome.status;
        },
      });
    },
    {
      ...(inject.userRoot === undefined ? {} : { userRoot: inject.userRoot }),
      out: outBusOnly,
      tuning: tuningFor(resolved),
    },
  );
  const ms = now() - startedAt;
  // A refusal is not a judge failure, and reporting it as one would send the user hunting for a
  // key or network problem that does not exist. `attempted` is what separates the two: the guard
  // returns null both when it refuses and when the judge itself returned nothing.
  if (!attempted) {
    return Response.json({
      ok: false,
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
      ...(status !== undefined ? { status } : {}),
      error: describeFailure(failure),
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
