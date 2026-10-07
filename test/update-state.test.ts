import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_STATE,
  type UpdateStateV1,
  readUpdateState,
  writeUpdateState,
} from "../src/update/update-state.js";

function inTmp(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `vf-state-${name}-`)), "update-state.json");
}

describe("update-state store", () => {
  test("round-trips a valid record", () => {
    const path = inTmp("rt");
    const state: UpdateStateV1 = {
      schema_version: 1,
      previous_version: "0.20.0",
      manager: "npm",
      at: 42,
    };
    writeUpdateState(state, path);
    expect(readUpdateState(path)).toEqual(state);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
  test("missing file reads as null", () => {
    expect(readUpdateState(inTmp("missing"))).toBeNull();
  });
  test("malformed JSON reads as null", () => {
    const path = inTmp("bad-json");
    writeFileSync(path, "{not json");
    expect(readUpdateState(path)).toBeNull();
  });
  test("wrong shape, bad version, unknown manager all read as null", () => {
    for (const value of [
      { schema_version: 2, previous_version: "0.20.0", manager: "npm", at: 1 },
      { schema_version: 1, previous_version: "not-a-version", manager: "npm", at: 1 },
      { schema_version: 1, previous_version: "0.20.0", manager: "yarn", at: 1 },
      { schema_version: 1, previous_version: "0.20.0", manager: "npm", at: "x" },
      [1, 2, 3],
    ]) {
      const path = inTmp("shape");
      writeFileSync(path, JSON.stringify(value));
      expect(readUpdateState(path)).toBeNull();
    }
  });
  test("creates the parent directory when missing", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-state-mkdir-"));
    const deep = join(base, "nested", "deeper", "update-state.json");
    writeUpdateState(
      {
        schema_version: UPDATE_STATE.SCHEMA_VERSION,
        previous_version: "0.20.9",
        manager: "npm",
        at: 7,
      },
      deep,
    );
    expect(readUpdateState(deep)).toEqual({
      schema_version: 1,
      previous_version: "0.20.9",
      manager: "npm",
      at: 7,
    });
    rmSync(base, { recursive: true, force: true });
  });
  test("schema_version is pinned to the frozen authority (a v2 record cannot typecheck)", () => {
    // @ts-expect-error — 2 is not assignable to the pinned literal 1
    const bad: UpdateStateV1["schema_version"] = 2;
    expect(bad as number).toBe(2);
  });
});
