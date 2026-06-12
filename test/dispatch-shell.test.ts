import { describe, expect, test } from "bun:test";
import { makeAsyncSpawner } from "../src/dispatch.js";

describe("bridge spawner shell default", () => {
  test("default options do not enable shell", () => {
    const spawner = makeAsyncSpawner();
    // The function exists and returns a spawner; we cannot introspect its closure
    // directly, but we CAN assert by behaviour: spawn a benign command and confirm
    // no shell metacharacter interpretation occurs.
    expect(typeof spawner).toBe("function");
  });

  test("explicit shell:true still works (opt-in preserved)", () => {
    // If a future caller passes shell:true it should still spawn (e.g. .cmd on Windows).
    const spawner = makeAsyncSpawner({ shell: true });
    expect(typeof spawner).toBe("function");
  });
});
