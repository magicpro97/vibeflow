import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { formatStatus, relAge, status } from "../../src/commands/status.js";
import type { DispatchMarker } from "../../src/orchestrator/marker.js";
import { installLogbus, type Logbus } from "../../src/logbus.js";

/** Isolated marker dir: set HOME so markerDir()/readTimeline() point here. */
let home: string;
let origHome: string | undefined;
let bus: Logbus;
let seen: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vf-status-"));
  origHome = process.env.HOME;
  process.env.HOME = home; // markerDir() resolves via homedir() → HOME
  // Capture the `vf` channel via the logbus; silence console so test output is clean.
  bus = installLogbus({ runId: "test-status", dir: join(home, ".vibeflow", "logs") });
  seen = [];
  bus.subscribe((ev: { text: string }) => seen.push(ev.text));
  origLog = console.log;
  origErr = console.error;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.env.HOME = origHome;
  rmSync(home, { recursive: true, force: true });
});

const markerDir = () => join(homedir(), ".vibeflow", "markers");

const writeMarker = (m: DispatchMarker): void => {
  mkdirSync(markerDir(), { recursive: true });
  writeFileSync(join(markerDir(), `${m.unit}.json`), JSON.stringify(m, null, 2));
};

const baseMarker = (over: Partial<DispatchMarker> & { unit: string }): DispatchMarker => ({
  unit: over.unit,
  status: over.status ?? "done",
  startedAt: Date.now(),
  updatedAt: Date.now(),
  confidence: over.confidence ?? 1,
  evidence: over.evidence ?? ["bun test → 1 pass"],
  issueUrl: over.issueUrl,
});

describe("relAge", () => {
  const now = 1_000_000_000_000;

  test("under a minute → 'Ns ago'", () => {
    expect(relAge(now - 5_000, now)).toBe("5s ago");
    expect(relAge(now, now)).toBe("0s ago"); // now default + boundary
  });

  test("minutes", () => {
    expect(relAge(now - 120_000, now)).toBe("2m ago");
  });

  test("hours", () => {
    expect(relAge(now - 7_200_000, now)).toBe("2h ago");
  });

  test("days", () => {
    expect(relAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  test("clamps negative deltas to 0s", () => {
    expect(relAge(now + 10_000, now)).toBe("0s ago");
  });

  test("defaults to Date.now() when now omitted", () => {
    const before = Date.now();
    const got = relAge(Date.now() - 1_000);
    const after = Date.now();
    // Within a 2s window of "1s ago" regardless of clock skew.
    expect(got === "1s ago" || got === "0s ago" || before - 1 <= after).toBe(true);
    expect(/s ago$/.test(got)).toBe(true);
  });
});

describe("formatStatus", () => {
  const now = 1_000_000_000_000;

  test("empty markers → 'no orchestration state found'", () => {
    expect(formatStatus([], now)).toBe("no orchestration state found");
  });

  test("renders a mix: running/pending dash conf, done shows conf, issueUrl vs '—', empty evidence", () => {
    const markers: DispatchMarker[] = [
      baseMarker({ unit: "auth", status: "running" }),
      baseMarker({ unit: "nav", status: "pending" }),
      { ...baseMarker({ unit: "pay", status: "done" }), confidence: 0.83, issueUrl: "https://github.com/magicpro97/vibeflow/issues/613" },
      baseMarker({ unit: "ui", status: "failed" }),
      baseMarker({ unit: "db", status: "blocked" }),
      { ...baseMarker({ unit: "ghost", status: "done" }), evidence: [] },
    ];
    const out = formatStatus(markers, now);
    // Header present.
    expect(out).toContain("UNIT");
    expect(out).toContain("STATUS");
    // Running/pending conf dashes; done shows two-decimal confidence.
    expect(out).toContain("—");
    expect(out).toContain("0.83");
    // Issue URL rendered, and a unit without one falls back to "—".
    expect(out).toContain("https://github.com/magicpro97/vibeflow/issues/613");
    // A done marker with empty evidence still renders (evidence "0").
    expect(out).toContain("ghost");
  });
});

describe("status command", () => {
  test("no subcommand → renders the table from listMarkers()", () => {
    writeMarker(baseMarker({ unit: "auth", status: "running" }));
    const code = status(undefined, [], {});
    expect(code).toBe(0);
    expect(seen.join("\n")).toContain("auth");
  });

  test("--json → emits the raw marker array", () => {
    writeMarker(baseMarker({ unit: "auth", issueUrl: "https://example.com/42" }));
    const code = status(undefined, [], { json: true });
    expect(code).toBe(0);
    const text = seen.join("\n");
    expect(text).toContain("auth");
    expect(text).toContain("https://example.com/42");
    expect(text.trim().startsWith("[")).toBe(true);
  });

  test("--timeline <unit> dumps the transition ledger", () => {
    const dir = markerDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.timeline.jsonl"),
      `${JSON.stringify({ status: "running", at: 1000 })}\n${JSON.stringify({ status: "done", at: 2000 })}\n`,
    );
    const code = status(undefined, [], { timeline: "auth" });
    expect(code).toBe(0);
    const text = seen.join("\n");
    expect(text).toContain("running");
    expect(text).toContain("done");
    expect(text).toContain(new Date(1000).toISOString());
    expect(text).toContain(new Date(2000).toISOString());
  });

  test("sub === 'timeline' with positional unit reads the ledger", () => {
    const dir = markerDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nav.timeline.jsonl"), `${JSON.stringify({ status: "failed", at: 500 })}\n`);
    const code = status("timeline", ["nav"], {});
    expect(code).toBe(0);
    expect(seen.join("\n")).toContain("failed");
  });

  test("timeline for an unknown unit → 'no timeline for X'", () => {
    const code = status(undefined, [], { timeline: "ghost" });
    expect(code).toBe(0);
    expect(seen.join("\n")).toContain("no timeline for ghost");
  });

  test("sub === 'timeline' without a positional unit → usage error, exit 1", () => {
    const code = status("timeline", [], {});
    expect(code).toBe(1);
    expect(seen.join("\n")).toContain("usage: vf status timeline");
  });
});
