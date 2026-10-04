// Dynamic import on purpose: src/ui/tsconfig sets `types: []`, so a static `bun:test` import is
// unresolvable for `vue-tsc --noEmit` and fails the UI typecheck half of `bun run check`. The other
// UI tests in this directory do the same for the same reason.
const { describe, expect, test } = await import(String("bun:test"));
import { readFileSync } from "node:fs";

/** Field names declared on a TS interface body, in order of appearance. */
function fields(src: string, iface: string): string[] {
  const start = src.indexOf(`interface ${iface} {`);
  if (start === -1) throw new Error(`no interface ${iface}`);
  const body = src.slice(start + `interface ${iface} {`.length, src.indexOf("\n}", start));
  return [...body.matchAll(/^\s{2}([a-zA-Z][\w]*)\??:/gm)].map((m) => m[1] ?? "");
}

describe("the UI's System One types are a mirror, and this is what keeps it honest", () => {
  test("every field the UI mirror declares still exists on the server type", () => {
    // The drawer may not import the server module, so the mirror is hand-written and nothing in the
    // type system notices a server-side rename. Without this the UI keeps compiling against a field
    // that no longer exists and the value silently reads `undefined`.
    const ui = readFileSync(new URL("../types-settings.ts", import.meta.url), "utf8");
    const server = readFileSync(
      new URL("../../../../src/typesafe-settings.ts", import.meta.url),
      "utf8",
    );
    // `TypesafeCallSites` is not mirrored - both sides import it from the shared contracts module -
    // so `TypesafeSettings` is the one with drift risk and the one worth holding to the server.
    const serverFields = new Set(fields(server, "TypesafeSettings"));
    const mirrored = fields(ui, "TypesafeSettings");
    expect(mirrored.length).toBeGreaterThan(0);
    expect(mirrored.filter((f) => !serverFields.has(f))).toEqual([]);
  });

  test("the view the drawer reads is held to the server's, including the repo stamp", () => {
    // `TypesafeSettingsView` carries `repo`, which the whole cross-repo guard is built on: the UI
    // stamps `expectRepo` from it. It was outside this test, so a rename there compiled fine and
    // `expectRepo` serialized as absent - every save then refused. Fail-closed, but silent.
    const ui = readFileSync(new URL("../types-settings.ts", import.meta.url), "utf8");
    const serverView = readFileSync(
      new URL("../../../../src/server/routes-typesafe.ts", import.meta.url),
      "utf8",
    );
    const serverFields = new Set(fields(serverView, "TypesafeSettingsView"));
    const uiFields = fields(ui, "TypesafeSettingsView");
    expect(uiFields).toContain("repo");
    expect(uiFields.filter((f) => !serverFields.has(f))).toEqual([]);
  });

  test("the state vocabulary is the server's, not a bare string", () => {
    // `state: string` accepted any value, so a sixth server state would have compiled and rendered
    // as whatever the string happened to be.
    const ui = readFileSync(new URL("../types-settings.ts", import.meta.url), "utf8");
    const health = readFileSync(
      new URL("../../../../src/typesafe-health-file.ts", import.meta.url),
      "utf8",
    );
    // The authority is a frozen object, not an array: `Object.freeze({ OFF: "off", ... } as const)`.
    const body = health.slice(health.indexOf("TYPESAFE_STATE = Object.freeze({"));
    const members = [...body.slice(0, body.indexOf("} as const")).matchAll(/: "([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(members.length).toBeGreaterThan(0);
    const state = ui.match(/^\s{2}state: (.+);$/m)?.[1] ?? "";
    expect(state).not.toBe("string");
    const uiMembers = [...state.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect([...new Set(uiMembers)].sort()).toEqual([...new Set(members)].sort());

    // `lastClass` had the same exposure and did not get the same treatment: the union written into
    // the mirror was invented - four members the server cannot produce - and nothing checked it,
    // because only `state` was held to the server. Both pins compare whole sets now, so an extra
    // member (the invented-union defect above) fails exactly like a missing one.
    const failures = health.slice(health.indexOf("FAILURE_CLASS = Object.freeze({"));
    const classes = [
      ...failures.slice(0, failures.indexOf("} as const")).matchAll(/: "([^"]+)"/g),
    ].map((m) => m[1] ?? "");
    expect(classes.length).toBeGreaterThan(0);
    const lastClass = ui.match(/^\s{2}lastClass\?:\n([\s\S]*?);$/m)?.[1] ?? "";
    expect(lastClass).not.toBe("");
    const uiClasses = [...lastClass.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect([...new Set(uiClasses)].sort()).toEqual([...new Set(classes)].sort());
  });
});
