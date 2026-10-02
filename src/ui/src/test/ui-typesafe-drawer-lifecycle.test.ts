const { expect, test } = await import(String("bun:test"));
import { readFileSync } from "node:fs";

/**
 * The System One DRAWER lifecycle: which of the four states a load may paint, how a verdict
 * outlives (or does not) the rows it describes, and the reload generations that decide it.
 * Split from ui-typesafe-settings.test.ts, which keeps the SECTION's shape, copy and controls.
 * Every pin here reads the component source, so the header re-reads it the same way.
 */
const drawer = readFileSync(
  new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
  "utf8",
);

test("a stale verdict does not outlive a successful reload", () => {
  // `typesafeError` is bound to its own content, so any path that loads rows successfully clears it
  // - otherwise a 409 from a moved repository stays on screen above correct rows. The probe verdict
  // is repo-specific (`testConnection` sends one repo and names it in the text), so it is dropped
  // when the loaded rows belong to a DIFFERENT repo.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function loadTypesafe");
  const nextFn = drawer.indexOf("\nasync function", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  expect(body).toContain('typesafeError.value = "";');
  // The comparison is against the INCOMING `view.repo`, and it sits AFTER the `await`: comparing
  // before it read the PREVIOUS repo, which equals `typesafeProbeRepo` by construction, so the
  // wipe never fired and repo A's verdict stayed beside repo B's rows.
  expect(body).toContain(
    'if (typesafeProbeRepo !== "" && typesafeProbeRepo !== view.repo) typesafeProbe.value = "";',
  );
  const awaitAt = body.indexOf("await api.typesafe.view()");
  const clearAt = body.indexOf("typesafeProbeRepo !== view.repo");
  expect(awaitAt).toBeGreaterThan(-1);
  expect(clearAt).toBeGreaterThan(awaitAt);
});

test("an in-flight probe is visible to the wipe, and a superseded verdict is discarded", () => {
  // Three races around `testConnection`, each reproduced by reading the code as written:
  //   1. nothing checked, on resolution, that the rows still describe the repo that was probed.
  //   2. the stamp moved with the pending probe rather than with the TEXT, so a superseded probe
  //      could leave `typesafeProbeRepo` naming a repo with no verdict on screen.
  //   3. `loadTypesafe`'s failure arm left `typesafeRepo` holding the PREVIOUS repo, so an in-flight
  //      probe for it passed the superseded check (finding 1) and painted its verdict under the
  //      error, with an empty stamp that no later load could wipe.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function testConnection");
  const nextFn = drawer.indexOf("\nasync ", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  const stampAt = body.indexOf("typesafeProbeRepo = probed;");
  const awaitAt = body.indexOf("await api.typesafe.test(probed)");
  expect(awaitAt).toBeGreaterThan(-1);
  expect(stampAt).toBeGreaterThan(awaitAt); // stamped with the TEXT, past the await
  // Both resolution arms discard a superseded verdict: exactly one guard each, before the write.
  const guard = "if (seq !== typesafeLoadSeq || !rowsDescribe(probed)) return;";
  expect(body.indexOf(guard)).toBeGreaterThan(-1);
  const writeAt = body.indexOf("typesafeProbe.value = result.ok");
  expect(body.indexOf(guard)).toBeLessThan(writeAt);
  expect(body.lastIndexOf(guard)).toBeGreaterThan(writeAt);
  // The stamp must not be written before the call (that named the PENDING probe), nor on either
  // superseded path: the only stamp sits after the LAST guard, so a discarded verdict never
  // advances it.
  expect(body.slice(0, awaitAt)).not.toContain("typesafeProbeRepo =");
  // The probe carries its own generation: a save routes through `loadTypesafe`, which bumps it, so a
  // verdict issued before the save is discarded instead of painting over the confirmation.
  expect(body).toContain("const seq = typesafeLoadSeq;");
  expect(body.indexOf("typesafeProbeRepo = probed;")).toBeGreaterThan(body.lastIndexOf(guard));
  // The failure arm must NOT blank the repo: `typesafeNeedsReload("")` is always false, so blanking
  // it disabled `detect()`'s reload and pinned the section on the error until a re-open. The gate
  // reads `typesafeStatus` instead, which is why the helper is used rather than a value comparison.
  const loadAt = drawer.indexOf("async function loadTypesafe");
  const loadBody = drawer.slice(loadAt, drawer.indexOf("\nasync ", loadAt + 1));
  const catchAt = loadBody.indexOf("} catch (");
  expect(loadBody.slice(catchAt)).not.toContain('typesafeRepo.value = "";');
  expect(drawer).toContain(
    'return typesafeStatus.value === "ready" && typesafeRepo.value === repo;',
  );
});

test("a failed load clears the verdict, and the api union still forbids the bare key", () => {
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function loadTypesafe");
  const nextFn = drawer.indexOf("\nasync function", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  // The verdict renders regardless of `typesafeStatus`, so without these two lines a failed load
  // for repo B leaves "responded for A" directly above "connection failed".
  expect(body).toContain('typesafeProbe.value = "";');
  expect(body).toContain('typesafeProbeRepo = "";');
  // `typesafe?: never` on the non-writing arm is ENFORCEMENT, not decoration: probe-verified that
  // `{ memory: true, typesafe: {...} }` fails `tsc --strict` with it (TS2322 assigned, TS2345 as a
  // call argument) and compiles without it.
  const apiSrc = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
  expect(apiSrc).toContain("| { typesafe?: never; expectRepo?: string }");
});

test("the save confirmation only lands when the reload that follows it succeeded", () => {
  // `loadTypesafe` resolves normally even when it takes its FAILURE arm (blank verdict, blank stamp,
  // blank repo, `typesafeError` set), and the confirmation used to be written unconditionally after
  // it - re-creating the "System One settings saved." under a "connection failed" double render,
  // with a stamp naming a repo the blanked rows no longer describe.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function saveTypesafe");
  const nextFn = drawer.indexOf("\nfunction ", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  const gate = body.indexOf("if (applied)");
  const confirm = body.indexOf('typesafeProbe.value = "System One settings saved.";');
  expect(gate).toBeGreaterThan(-1);
  expect(confirm).toBeGreaterThan(gate); // the confirmation sits inside the landing check
});

test("only the latest load wins: the response is applied behind a generation token", () => {
  // Two loads are already in flight on first open (`load()` and the `detect()`-triggered reload),
  // and a repo change during either issues another. Without a token the slower response wins and
  // the rows and the `typesafeRepo` stamp describe the superseded repo - which the save guard then
  // blocks forever. Both arms are guarded, and the response is bound to a local so the guards are
  // the only way the refs are written.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function loadTypesafe");
  const nextFn = drawer.indexOf("\nasync function", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  expect(body).toContain("const seq = ++typesafeLoadSeq;");
  expect([...body.matchAll(/if \(seq !== typesafeLoadSeq\) return false;/g)]).toHaveLength(2);
  expect(body).not.toContain("typesafeView.value = await api.typesafe.view()");
  expect(drawer).toContain("let typesafeLoadSeq = 0;");
});

test("the cross-repo stamp is taken from the server response, not the local path", () => {
  // The guard compares `typesafeRepo` against the current path, so it is worth no more than where
  // `typesafeRepo` came from: assigning it the local `repoPath` would make the comparison always
  // agree and every string-level assertion stay green.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  expect(drawer).toContain("typesafeRepo.value = view.repo;");
});
