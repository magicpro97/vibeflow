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
      { ...request, requested_at: Number.NaN },
      { ...request, target_version: "0.21.0\u001b[31m" },
      { ...request, requested_by_pid: 0 },
      { ...request, requested_by_pid: 1.5 },
    ])
      expect(parseUpdateRequest(bad)).toBeNull();
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
      { ...state, state: "bogus" },
      { ...state, replacement_pid: -1 },
      { ...state, failure: 7 },
      { ...state, at: "soon" },
    ])
      expect(parseHandoffState(bad)).toBeNull();
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
});
