// src/commands/orchestrate-resolve.ts
//
// Pure resolver helpers extracted from orchestrate.ts (#186 PR7).
// The hardened orchestrate() dispatcher stays in the facade.
//
// Contents:
// - resolveMode: --yes → "cli", --dry → "dry", else bridge or dry
//   based on VIBEFLOW_AI env. Test seam.
// - resolveEngine: --engine flag if valid, else DEFAULT_ENGINE.
//   Test seam.
// - resolveRisk: --risk flag if valid, else "feature". Internal
//   helper; only used by orchestrate.
// - announceLaunch: pre-launch engine warning / availability
//   check. Returns skip:true when the engine CLI is unavailable.
//   Test seam (exported) because tests need to exercise the
//   unavailable + warning branches without launching a real engine.
// - readyStub: synthetic "ready" readiness used when a caller
//   injects its own dispatch spawner.
// - engineReady: the stronger pre-dispatch gate. A live preflight
//   probe of the single chosen engine.

import type { Engine, EngineReadiness, PreflightFn, RiskClass } from "./_shared.js";
import {
  DEFAULT_ENGINE,
  ENGINES,
  c,
  downgradeBannerText,
  engineCommand,
  isUnavailable,
  out,
  preflightAll,
} from "./_shared.js";

export function resolveMode(flags: Record<string, string | boolean>): "cli" | "bridge" | "dry" {
  if (flags.yes) return "cli";
  if (flags.dry) return "dry";
  return process.env.VIBEFLOW_AI ? "bridge" : "dry";
}

export function resolveEngine(flags: Record<string, string | boolean>): Engine {
  return typeof flags.engine === "string" && (ENGINES as string[]).includes(flags.engine)
    ? (flags.engine as Engine)
    : DEFAULT_ENGINE;
}

export function resolveRisk(flags: Record<string, string | boolean>): RiskClass {
  const valid: RiskClass[] = [
    "docs",
    "simple-code",
    "feature",
    "architecture",
    "security",
    "deploy",
  ];
  return typeof flags.risk === "string" && (valid as string[]).includes(flags.risk)
    ? (flags.risk as RiskClass)
    : "feature";
}

/**
 * Before launching a non-native engine, warn the user their guardrails are detection-only and
 * resolve the engine command. Returns `skip:true` when the engine CLI is genuinely unavailable
 * (so we never spawn a bogus command). Pure-stdout for "dry"/"bridge" (nothing to launch).
 */
// Test seam: exported so unit tests can exercise the no-skip,
// unavailable, and warning branches without invoking a real engine.
// The 4th param `engineCommandFn` lets tests inject a fake engineCommand
// to deterministically hit the unavailable and warning branches.
export function announceLaunch(
  engine: Engine,
  mode: "cli" | "bridge" | "dry",
  engineCommandFn: (e: Engine) => ReturnType<typeof engineCommand> = engineCommand,
): { skip: boolean } {
  if (mode !== "cli") return { skip: false };
  const banner = downgradeBannerText(engine);
  if (banner) out("vf", c.yellow(banner));
  const invocation = engineCommandFn(engine);
  if (isUnavailable(invocation)) {
    out("vf", c.yellow(`\n${engine} unavailable: ${invocation.unavailable}`));
    return { skip: true };
  }
  if (invocation.warning) out("vf", c.yellow(`! ${engine}: ${invocation.warning}`));
  return { skip: false };
}

/** A synthetic "ready" readiness used when a caller injects its own dispatch spawner. */
// Exported (not just internal) so the `run` subcommand
// (src/commands/run.ts, phase 6.5/14) can call it via the barrel
// (_shared.js) to mark an injected-spawner run as ready. Without
// this export, the run path would have to call `engineReady` with
// a hand-rolled stub; the export preserves the original wiring 1:1.
export function readyStub(engine: Engine): EngineReadiness {
  return { engine, level: "ready", detail: "ready (injected)", checkedAt: "" };
}

/**
 * The stronger pre-dispatch gate: a live preflight probe of the single chosen engine. Returns
 * true only when the engine is fully ready; otherwise prints the actionable detail and returns
 * false so the caller can refuse to dispatch. Dry/bridge modes skip the probe (nothing launches).
 * Injectable via `preflight` so tests never spawn a real engine.
 */
// Exported (not just internal) so the `run` subcommand
// (src/commands/run.ts, phase 6.5/14) can call it via the barrel.
// Without the export, the run path would re-implement the same gate.
export function engineReady(
  engine: Engine,
  mode: "cli" | "bridge" | "dry",
  preflight?: PreflightFn,
): boolean {
  if (mode !== "cli") return true;
  const probe = preflight ?? ((e: Engine[]) => preflightAll(e, { probe: true }));
  const [readiness] = probe([engine]);
  if (readiness?.level === "ready") return true;
  const detail = readiness?.detail ?? "engine not ready";
  out("vf", c.red(`\n${engine} not ready: ${detail}`));
  return false;
}
