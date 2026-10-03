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
  // wipe never fired and repo A's verdict stayed beside repo B's rows. The wipe clears the STAMP
  // with the verdict (round 64): leaving the old-repo stamp made its own reload eat the next
  // verdict, so both refs fall together.
  expect(body).toContain(
    'if (typesafeProbeRepo !== "" && typesafeProbeRepo !== view.repo) { typesafeProbe.value = ""; typesafeProbeRepo = ""; }',
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

test("the save confirmation reports a failed refresh as a refresh failure, never as a failed save", () => {
  // `loadTypesafe` resolves normally even when it takes its FAILURE arm (blank view, "error" status,
  // `typesafeError` set), so the confirmation has to read `applied` rather than being written
  // unconditionally: the bare GET error rendered as "connection failed" for a write that had
  // SUCCEEDED, which read as a failed save and invited a duplicate.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function saveTypesafe");
  const nextFn = drawer.indexOf("\nfunction ", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  expect(body).toContain("const applied = await loadTypesafe()");
  expect(body).toContain("typesafeProbe.value = applied");
  expect(body).toContain("but these rows could not refresh");
});

test("every editable System One control is inert until the rows are ready", () => {
  // The load replaces `settingsForm.typesafe` wholesale, so an edit made during the round-trip is
  // discarded with no message. Gating only the buttons left all six inputs live; each now carries
  // the same readiness guard.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  for (const id of [
    "typesafe-enabled",
    "typesafe-run-threshold",
    "typesafe-accept-threshold",
    "typesafe-callsite-reviewer",
    "typesafe-callsite-risk",
    "typesafe-callsite-goalCoverage",
    "typesafe-callsite-planner",
  ]) {
    const input = new RegExp(`<input id="${id}"[^>]*/>`).exec(drawer);
    expect(input, `${id} should be present`).not.toBeNull();
    expect(input?.[0], `${id} must be gated on the rows being ready`).toContain(
      ":disabled=\"typesafeStatus !== 'ready'\"",
    );
  }
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

test("the repo wipe drops the verdict's stamp too", () => {
  // Round-64 (ui, medium, reproduced): the wipe cleared the verdict string but LEFT the stamp, so
  // after a repo change that fired the wipe the stamp still named the old repo. The next probe of
  // the NEW repo painted its verdict, and `testConnection`'s own reload then discarded it (the
  // stale stamp != incoming `view.repo`, so the wipe inside the reload fired again) - a silent
  // no-verdict, no-error dead end for the operator. Enumerate the wipe's effects: it must write
  // BOTH refs, or the reload it triggers eats the next verdict.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function loadTypesafe");
  const nextFn = drawer.indexOf("\nasync function", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  const wipeAt = body.indexOf('if (typesafeProbeRepo !== "" && typesafeProbeRepo !== view.repo)');
  expect(wipeAt).toBeGreaterThan(-1);
  const wipe = body.slice(wipeAt, body.indexOf("\n", wipeAt));
  expect(wipe).toContain('typesafeProbe.value = ""');
  expect(wipe).toContain('typesafeProbeRepo = ""');
});

test("a re-open that detect() already reloaded does not fire a second GET", () => {
  // On the error path (and on a repo change) `detect()` reloads the section itself, and `load()`
  // then issued a SECOND concurrent `GET /api/typesafe`; the `typesafeLoadSeq` guard discarded the
  // loser, so it was a doubled request on every error-path re-open. `detect()` now reports whether
  // it reloaded, and `load()` skips its own call when it did.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  expect(drawer).toContain("async function detect(): Promise<boolean>");
  expect(drawer).toContain("const reloaded = await detect();");
  expect(drawer).toContain("...(reloaded ? [] : [loadTypesafe()])");
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

test("the probe repaints the rows it just dirtied", () => {
  // `testConnection` bills the PROBE bucket server-side and can open the probe breaker. The rows on
  // screen were loaded BEFORE the click and still say idle/closed, so the detect button stayed
  // enabled against an open breaker (and its cooldown never appeared) until a re-open. The reload
  // sits after BOTH superseded guards (a discarded verdict triggers nothing), before the stamp
  // (the TEXT is what is stamped), and after the `finally` - not inside it, or a superseded probe
  // would reload the rows a newer load owns.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("async function testConnection");
  const nextFn = drawer.indexOf("\nasync ", at + 1);
  const body = drawer.slice(at, nextFn === -1 ? drawer.length : nextFn);
  const guard = "if (seq !== typesafeLoadSeq || !rowsDescribe(probed)) return;";
  const reloadAt = body.indexOf("await loadTypesafe();");
  expect(reloadAt).toBeGreaterThan(-1);
  expect(reloadAt).toBeGreaterThan(body.lastIndexOf(guard));
  expect(reloadAt).toBeLessThan(body.indexOf("typesafeProbeRepo = probed;"));
});
