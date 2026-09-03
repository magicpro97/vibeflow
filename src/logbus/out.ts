import { LOG_CHANNEL, LOG_LEVEL, type LogLevel, isLogLevel } from "../core/log-contract.js";
import { getLogbus } from "../logbus.js";
import { activeSpinner } from "../ui.js";
import type { Channel } from "./types.js";

// ---------------------------------------------------------------------------
// out() — the universal log helper
// ---------------------------------------------------------------------------

function joinParts(parts: unknown[]): string {
  return parts
    .map((p) => (typeof p === "string" ? p : p == null ? String(p) : safeJson(p)))
    .join(" ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Universal log helper. Joins `parts` with a single space (console.log semantics),
 *  fans the event onto the active bus.
 *
 *  No-bus fallback mirrors the console.log/console.error stream routing the codemod was
 *  designed on:
 *    - default level ("info")  → process.stdout (user-facing; strips the redundant [vf] prefix)
 *    - level "warn"|"error"|"debug" → process.stderr (diagnostic; keeps the [channel] prefix)
 *
 *  Bus-installed behavior:
 *    - "vf" channel: bus is the persistent sink AND the line is also tee'd to the console
 *      (so existing CLI/UX rendering and console-mocking tests keep working). The bus owns
 *      the durable record; the console owns the user-facing stream.
 *    - "engine-stdout" / "engine-stderr" / "user" / "hook": bus is the SOLE destination
 *      (M2 contract: engine stderr no longer leaks to the parent TTY — it is captured and
 *      surfaced via the M3 SSE endpoint / `vf logs`).
 *
 *  The trailing arg, if it is a plain object, is treated as an options bag that may carry:
 *    - `level`: "info" (default) | "debug" | "warn" | "error"  (codemod shape)
 *    - `unit`:  work-unit attribution  (M2: engine-stderr path forwards this)
 *    - `meta`:  Record<string, unknown>  (M2: engine-stderr path includes { engine, unit })
 *  The bag is consumed — it does NOT leak into the joined text.
 */
export function out(channel: Channel, ...rawParts: unknown[]): void {
  const { level, unit, meta, parts } = extractOptsAndParts(rawParts);
  const text = parts.length === 0 ? "" : joinParts(parts);
  const bus = getLogbus();
  if (bus) {
    try {
      bus.write({
        runId: (bus as unknown as { runId: string }).runId,
        channel,
        level,
        unit,
        meta,
        text,
      });
    } catch (err) {
      process.stderr.write(`[logbus.out] write failed: ${(err as Error).message}\n`);
    }
    // M2: the "vf" channel goes to the M3 SSE endpoint and to the
    // console. Engine-stdout / engine-stderr / user / hook channels
    // also tee to the console so a CLI user running headless (no UI)
    // can see what the engine is doing — without this, a parent
    // terminal would see nothing during a 5-minute AI run, which is
    // the worst possible UX. The M3 SSE endpoint still gets the
    // full bus stream (bus.write above) for the UI surface.
    //
    // Set VF_QUIET=1 to suppress engine-* output (for CI / piped
    // output where you want only the [vf] channel).
    if (channel === LOG_CHANNEL.VIBE_FLOW || process.env.VF_QUIET !== "1") {
      emitToConsole(channel, level, text);
    }
    return;
  }
  // No-bus fallback: mirror console.log/console.error stream routing.
  emitToConsole(channel, level, text);
}

function emitToConsole(channel: Channel, level: LogLevel, text: string): void {
  const toStderr =
    level === LOG_LEVEL.WARN || level === LOG_LEVEL.ERROR || level === LOG_LEVEL.DEBUG;
  const prefix = toStderr || channel !== LOG_CHANNEL.VIBE_FLOW ? `[${channel}] ` : "";
  const line = `${prefix}${text}`;

  // When a spinner is active, stop its animation and clear its line so
  // subsequent logs write cleanly without spinner interference.
  if (activeSpinner) {
    try {
      activeSpinner.deactivate();
      process.stderr.write(`${line}\n`);
    } catch {
      /* never throw out of out() */
    }
    return;
  }

  // Use console.log / console.error (not raw process.stdout/stderr.write) so that
  // test harnesses that mock console.log/console.error can capture the no-bus fallback.
  // In production, console.log writes to process.stdout and console.error to process.stderr,
  // so the user-visible stream routing is identical.
  const log = toStderr ? console.error : console.log;
  try {
    log(line);
  } catch {
    // Never throw out of out() — matches the prior round's invariant.
  }
}

function extractOptsAndParts(rawParts: unknown[]): {
  level: LogLevel;
  unit?: string;
  meta?: Record<string, unknown>;
  parts: unknown[];
} {
  if (rawParts.length > 0) {
    const last = rawParts[rawParts.length - 1];
    if (last !== null && typeof last === "object" && !Array.isArray(last)) {
      const bag = last as { level?: unknown; unit?: unknown; meta?: unknown };
      const candidate = bag.level;
      const hasLevel = isLogLevel(candidate);
      // Consume the bag as options only when it carries a recognized `level` field
      // (the codemod shape). A bare metadata object (e.g. {engine:"claude"}) is NOT
      // consumed — it falls through to be joined as text, matching the prior contract.
      if (hasLevel) {
        const out: {
          level: LogLevel;
          unit?: string;
          meta?: Record<string, unknown>;
          parts: unknown[];
        } = {
          level: candidate,
          parts: rawParts.slice(0, -1),
        };
        if (typeof bag.unit === "string") out.unit = bag.unit;
        if (bag.meta !== null && typeof bag.meta === "object" && !Array.isArray(bag.meta)) {
          out.meta = bag.meta as Record<string, unknown>;
        }
        return out;
      }
    }
  }
  return { level: LOG_LEVEL.INFO, parts: rawParts };
}
