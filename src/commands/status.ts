// src/commands/status.ts
//
// `vf status` — a crash-recovery view of the persisted per-unit markers.
//
// The orchestrator writes a marker (~/.vibeflow/markers/<unit>.json) for every
// unit it dispatches, and an append-only timeline ledger next to it. Those
// files are the source of truth for "what was the engine doing when the
// process died". `vf status` reads them back (it never re-runs anything) so a
// human can see, after a crash, which units were running/failed/done and
// whether a done unit actually published evidence.
//
// The formatter (formatStatus) is pure — no fs — so it is unit-testable
// without touching the filesystem. The command entry (status) does the I/O
// via listMarkers()/readTimeline() and the shared `out` logbus sink.

import { c } from "../core.js";
import { out } from "../logbus.js";
import { type DispatchMarker, MARKER_STATUS, listMarkers } from "../orchestrator/marker.js";
import { readTimeline } from "../orchestrator/timeline.js";

/** Relative "2m ago" style age from an epoch-ms timestamp. Pure. */
export function relAge(updatedAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Build the status table rows (pure — no I/O). Highlights running (crash point) +
 *  flags status=done markers with no published evidence (agent claimed done, never pushed). */
export function formatStatus(markers: DispatchMarker[], now: number = Date.now()): string {
  if (markers.length === 0) return "no orchestration state found";
  const header = ["UNIT", "STATUS", "CONF", "EVID", "UPDATED", "ISSUE"];
  const raw = markers.map((m) => [
    m.unit,
    m.status,
    // Running/pending units have no confidence yet — render a dash, never "0.00".
    m.status === MARKER_STATUS.RUNNING || m.status === MARKER_STATUS.PENDING
      ? "—"
      : m.confidence.toFixed(2),
    String(m.evidence?.length ?? 0),
    relAge(m.updatedAt, now),
    m.issueUrl ?? "—",
  ]);
  const grid = [header, ...raw];
  // Column widths from the raw (uncolored) cells so ANSI codes never skew padding.
  const widths = header.map((_, i) => Math.max(...grid.map((r) => (r[i] ?? "").length)));
  const colorStatus = (s: string): string =>
    s === MARKER_STATUS.RUNNING
      ? c.yellow(s)
      : s === MARKER_STATUS.FAILED || s === MARKER_STATUS.BLOCKED
        ? c.red(s)
        : s;
  const lines = grid.map((r, ri) =>
    r
      .map((cell, i) => {
        // Header row: bold every cell. Body rows: colorize only the STATUS column.
        const text = ri === 0 ? c.bold(cell) : i === 1 ? colorStatus(cell) : cell;
        return text.padEnd(widths[i] ?? 0);
      })
      .join("  "),
  );
  return lines.join("\n");
}

/** vf status entry. sub = undefined → table; sub === "--timeline"/positional unit → timeline dump.
 *  flags.json → JSON. Reads ~/.vibeflow/markers via listMarkers()/readTimeline(). */
export function status(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
): number {
  if (flags.json === true) {
    out("vf", JSON.stringify(listMarkers(), null, 2));
    return 0;
  }
  // `vf status timeline <unit>` — explicit timeline subcommand.
  if (sub === "timeline" || typeof flags.timeline === "string") {
    const unit = typeof flags.timeline === "string" ? flags.timeline : rest[0];
    if (!unit) {
      out("vf", "usage: vf status timeline <unit>");
      return 1;
    }
    const entries = readTimeline(unit);
    out(
      "vf",
      entries.length
        ? entries.map((e) => `${new Date(e.at).toISOString()}  ${e.status}`).join("\n")
        : `no timeline for ${unit}`,
    );
    return 0;
  }
  out("vf", formatStatus(listMarkers()));
  return 0;
}
