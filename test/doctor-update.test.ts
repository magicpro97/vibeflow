import { describe, expect, test } from "bun:test";
import { type DoctorUpdateSeams, printDoctorUpdate } from "../src/commands/doctor-update.js";

const handoff = (
  state: "replacement_started" | "drained" | "failed",
  at: number,
): DoctorUpdateSeams["handoffs"] => [
  {
    base: "/repo-a",
    state: {
      schema_version: "1.0",
      request_id: "req-1",
      state,
      from_version: "0.20.0",
      target_version: "0.21.0",
      at,
    },
  },
];

function capture(over: DoctorUpdateSeams = {}) {
  const lines: string[] = [];
  const seams: DoctorUpdateSeams = {
    current: "0.20.0",
    latest: "0.21.0",
    servers: [],
    handoffs: [],
    now: () => 1_700_000_000_000,
    outFn: (line: string) => lines.push(line),
  };
  Object.assign(seams, over);
  printDoctorUpdate(seams);
  return lines.join("\n");
}

describe("printDoctorUpdate", () => {
  test("reports an available update", () => {
    expect(capture()).toContain("latest: v0.21.0 (run vf update)");
  });
  test("reports up to date", () => {
    const upToDate = capture({ latest: "0.20.0" });
    expect(upToDate).toContain("installed: v0.20.0 · latest");
    expect(upToDate).not.toContain("run vf update");
    expect(capture({ latest: null })).toContain("installed: v0.20.0");
  });
  test("no servers", () => {
    expect(capture()).toContain("ui servers: none running");
  });
  test("stale and current generations", () => {
    const text = capture({
      servers: [
        { base: "/repo-a", pid: 1, port: 7799, app_version: "0.19.0" },
        { base: "/repo-b", pid: 2, port: 7800, app_version: "0.20.0" },
        { base: "/repo-c", pid: 3, port: 7801 },
      ],
    });
    expect(text).toContain("/repo-a  pid 1  v0.19.0 (stale generation)");
    expect(text).toContain("/repo-b  pid 2  v0.20.0");
    expect(text).toContain("/repo-c  pid 3  version unknown (stale generation)");
  });
  test("stale handoff advice; a drained handoff is skipped", () => {
    const text = capture({ handoffs: handoff("replacement_started", 1_699_999_000_000) });
    expect(text).toContain("replacement_started");
    expect(text).toContain("stale — safe to delete");
    const drained = capture({ handoffs: handoff("drained", 1_699_999_000_000) });
    expect(drained).not.toContain("safe to delete");
  });
  test("defaults: reads handoff state via the seam and writes via out (no outFn)", () => {
    const seen: string[] = [];
    printDoctorUpdate({
      current: "0.20.0",
      latest: null,
      servers: [],
      handoffs: undefined,
      readHandoff: (base) => {
        seen.push(base);
        return {
          schema_version: "1.0",
          request_id: "req-1",
          state: "drained",
          from_version: "0.20.0",
          target_version: "0.21.0",
          at: 0,
        };
      },
      now: () => 0,
    });
    expect(seen.length).toBeGreaterThan(0);
  });
  test("defaults: dedups server bases when reading handoff state", () => {
    const seen: string[] = [];
    capture({
      handoffs: undefined,
      servers: [
        { base: "/repo-a", pid: 1, port: 7799, app_version: "0.20.0" },
        { base: "/repo-a", pid: 2, port: 7800, app_version: "0.20.0" },
      ],
      readHandoff: (base) => {
        seen.push(base);
        return null;
      },
    });
    expect(seen.filter((base) => base === "/repo-a").length).toBe(1);
    expect(seen.length).toBe(2);
  });
});
