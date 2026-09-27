import { describe, expect, test } from "bun:test";
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
});
