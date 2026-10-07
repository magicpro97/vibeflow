import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_HANDOFF,
  clearUpdateRequest,
  handoffStatePath,
  isHandoffStale,
  parseHandoffState,
  parseUpdateRequest,
  readHandoffState,
  readUpdateRequest,
  updateRequestPath,
  writeHandoffState,
  writeUpdateRequest,
} from "../src/update/update-contract.js";

const request = {
  schema_version: "1.0" as const,
  request_id: "req-1",
  requested_at: 1_700_000_000_000,
  target_version: "0.21.0",
  requested_by_pid: 42,
};

const state = {
  schema_version: "1.0" as const,
  request_id: "req-1",
  state: "drained" as const,
  from_version: "0.20.0",
  target_version: "0.21.0",
  at: 1_700_000_000_000,
};

describe("parseUpdateRequest", () => {
  test("accepts a well-formed request", () => {
    expect(parseUpdateRequest(request)).toEqual(request);
  });
  test("rejects junk", () => {
    for (const bad of [
      null,
      [],
      { ...request, schema_version: "2.0" },
      { ...request, request_id: "" },
      { ...request, request_id: 7 },
      { ...request, requested_at: Number.NaN },
      { ...request, requested_at: Number.POSITIVE_INFINITY },
      { ...request, requested_at: "soon" },
      { ...request, target_version: "0.21.0\u001b[31m" },
      { ...request, target_version: "v0.21.0" },
      { ...request, requested_by_pid: 0 },
      { ...request, requested_by_pid: -1 },
      { ...request, requested_by_pid: 1.5 },
      { ...request, requested_by_pid: Number.NaN },
    ])
      expect(parseUpdateRequest(bad)).toBeNull();
  });
  test("accepts the valid side of each gate", () => {
    // zero is finite; pid 1 is the smallest legal pid; suffixed versions are valid
    expect(parseUpdateRequest({ ...request, requested_at: 0 })).not.toBeNull();
    expect(parseUpdateRequest({ ...request, requested_by_pid: 1 })).not.toBeNull();
    expect(parseUpdateRequest({ ...request, target_version: "0.21.0-rc.1" })).not.toBeNull();
  });
});

describe("parseHandoffState", () => {
  test("accepts drained and failed states", () => {
    expect(parseHandoffState(state)?.state).toBe("drained");
    expect(
      parseHandoffState({ ...state, state: "failed", failure: "replacement timed out" })?.failure,
    ).toBe("replacement timed out");
  });
  test("rejects unknown state and malformed optional fields", () => {
    for (const bad of [
      null,
      { ...state, schema_version: "2.0" },
      { ...state, request_id: "" },
      { ...state, state: "bogus" },
      { ...state, from_version: "0.20" },
      { ...state, target_version: "" },
      { ...state, replacement_pid: -1 },
      { ...state, replacement_pid: 1.5 },
      { ...state, replacement_pid: Number.NaN },
      { ...state, failure: 7 },
      { ...state, at: "soon" },
      { ...state, at: Number.NaN },
      { ...state, at: Number.POSITIVE_INFINITY },
    ])
      expect(parseHandoffState(bad)).toBeNull();
  });
  test("accepts the valid side of each gate", () => {
    const full = UPDATE_HANDOFF.SCHEMA_VERSION;
    expect(parseHandoffState({ ...state, schema_version: full })).not.toBeNull();
    expect(parseHandoffState({ ...state, state: "replacement_started" })?.state).toBe(
      "replacement_started",
    );
    expect(parseHandoffState({ ...state, at: 0 })?.at).toBe(0);
    expect(parseHandoffState({ ...state, from_version: "0.20.0-rc.1" })).not.toBeNull();
    expect(parseHandoffState({ ...state, replacement_pid: 1 })?.replacement_pid).toBe(1);
  });
});

describe("files", () => {
  test("paths live under the project context dir", () => {
    expect(updateRequestPath("/repo")).toBe("/repo/.vibeflow/.update-request.json");
    expect(handoffStatePath("/repo")).toBe("/repo/.vibeflow/.update-handoff.json");
  });
  test("write/read round-trips and clear is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-update-contract-"));
    try {
      writeUpdateRequest(dir, request);
      expect(readUpdateRequest(dir)).toEqual(request);
      expect(readFileSync(updateRequestPath(dir), "utf8")).toContain("req-1");
      clearUpdateRequest(dir);
      clearUpdateRequest(dir); // second rm must not throw
      expect(readUpdateRequest(dir)).toBeNull();
      writeHandoffState(dir, state);
      expect(readHandoffState(dir)?.state).toBe("drained");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("reads of unreadable files return null, never throw", () => {
    expect(
      readUpdateRequest("/nope", {
        readFileSync: () => {
          throw new Error("boom");
        },
      }),
    ).toBeNull();
    expect(readHandoffState("/nope", { readFileSync: () => "{not json" })).toBeNull();
  });
});

describe("isHandoffStale", () => {
  test("drained is never stale; old non-drained states are", () => {
    expect(isHandoffStale(state, state.at + UPDATE_HANDOFF.STALE_MS * 10)).toBe(false);
    expect(
      isHandoffStale(
        { ...state, state: "replacement_started" },
        state.at + UPDATE_HANDOFF.STALE_MS + 1,
      ),
    ).toBe(true);
    expect(
      isHandoffStale(
        { ...state, state: "replacement_started" },
        state.at + UPDATE_HANDOFF.STALE_MS,
      ),
    ).toBe(false);
  });
  test("failed ages like any non-drained state: fresh is not stale, past the threshold is", () => {
    const failed = { ...state, state: "failed" as const, failure: "replacement timed out" };
    expect(isHandoffStale(failed, failed.at + UPDATE_HANDOFF.STALE_MS)).toBe(false);
    expect(isHandoffStale(failed, failed.at + UPDATE_HANDOFF.STALE_MS + 1)).toBe(true);
  });
});
