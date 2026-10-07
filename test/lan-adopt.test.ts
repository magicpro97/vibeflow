import { describe, expect, test } from "bun:test";
import { LAN_ADOPT_ENV, lanAdoptEnv, readLanAdoptEnv } from "../src/update/lan-adopt.js";

const snapshot = {
  pages: ["a".repeat(64)],
  bootstrap: ["b".repeat(64)],
  session: "c".repeat(64),
};

describe("lanAdoptEnv", () => {
  test("no authority means no extra environment", () => {
    expect(lanAdoptEnv(null)).toEqual({});
  });
  test("a snapshot rides in one env var as JSON", () => {
    const env = lanAdoptEnv(snapshot);
    expect(Object.keys(env)).toEqual([LAN_ADOPT_ENV]);
    expect(JSON.parse(env[LAN_ADOPT_ENV] as string)).toEqual(snapshot);
  });
});

describe("readLanAdoptEnv", () => {
  test("missing, empty and unparsable values read as undefined", () => {
    expect(readLanAdoptEnv({})).toBeUndefined();
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: "" })).toBeUndefined();
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: "{not json" })).toBeUndefined();
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: "null" })).toBeUndefined();
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: '"just a string"' })).toBeUndefined();
  });
  test("round-trips a snapshot", () => {
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: JSON.stringify(snapshot) })).toEqual(snapshot);
  });
  test("filters non-string list entries and normalizes a non-string session", () => {
    const raw = JSON.stringify({ pages: ["x", 7, "y"], bootstrap: [null, "z"], session: 5 });
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: raw })).toEqual({
      pages: ["x", "y"],
      bootstrap: ["z"],
      session: null,
    });
  });
  test("omits list keys that are absent or not arrays", () => {
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: JSON.stringify({ pages: "x" }) })).toEqual({
      session: null,
    });
    expect(readLanAdoptEnv({ [LAN_ADOPT_ENV]: JSON.stringify({}) })).toEqual({ session: null });
  });
});
