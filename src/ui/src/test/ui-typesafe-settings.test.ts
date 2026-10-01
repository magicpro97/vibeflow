const { expect, test } = await import(String("bun:test"));
import { readFileSync } from "node:fs";
import { TYPESAFE_CALL_SITE_NAMES } from "../../../typesafe-contract.js";

const drawer = readFileSync(
  new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
  "utf8",
);
const settingsTypes = readFileSync(new URL("../types-settings.ts", import.meta.url), "utf8");
const legacyTypes = readFileSync(new URL("../types.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");

test("control center exposes a System One section with the four states and accessible controls", () => {
  for (const snippet of [
    "System One",
    "typesafe",
    "Enable System One judge",
    "Run judge at confidence",
    "Accept verdict at confidence",
    "Test connection",
    'aria-labelledby="typesafe-title"',
    'aria-busy="true"',
    'role="alert"',
    "focus-visible",
    "@blur",
    "aria-describedby",
    'label for="typesafe-enabled"',
    'label for="typesafe-run-threshold"',
    'label for="typesafe-accept-threshold"',
    ...TYPESAFE_CALL_SITE_NAMES.map((site) => `label for="typesafe-callsite-${site}"`),
    'role="status"',
    'aria-live="polite"',
    "No System One key configured",
    "Loading System One settings",
    "System One connection failed",
    "key missing",
    "loading",
    "error",
  ]) {
    expect(drawer).toContain(snippet);
  }
});

test("each state is announced as TEXT inside a live-region element, not by colour alone", () => {
  // Asserting those six strings again proved nothing: every one of them is already asserted by the
  // test above against the same `drawer` constant, so this could not fail while that one passed.
  // The claim in the name is about the pairing - a role AND literal text - so pin the pairing.
  // `[^<{]` is the load-bearing part: replace the text with an interpolation and the state is no
  // longer announced, which the old version could not see.
  expect(drawer).toMatch(/role="status"[^>]*>\s*[A-Z][^<{]{5,}/);
  expect(drawer).toMatch(/role="alert"[^>]*>\s*[A-Z][^<{]{5,}/);
});

test("the drawer never renders a secret: no key value, only a source label", () => {
  expect(drawer).toContain("typesafeView.keySource");
  // What holds this property is that the SOURCE LABEL is the only key-related field the drawer
  // reads off the view. Greps for a literal could not fail: adding `{{ typesafeView.keyPreview }}`
  // to the template matched neither negative regex, so a key value could be rendered while this
  // stayed green.
  const viewFields = new Set([...drawer.matchAll(/typesafeView[?.]?\.(\w+)/g)].map((m) => m[1]));
  expect([...viewFields].filter((f) => /key|secret|token|credential/i.test(f ?? ""))).toEqual([
    "keySource",
  ]);
  expect(drawer).not.toMatch(/TYPESAFE_API_KEY\s*[:=]\s*["'`]/);
  expect(drawer).not.toContain("Bearer");
  // The enumeration above reads `typesafeView.<field>`, which is what the TEMPLATE does. A key could
  // still reach the screen through an interpolated local (`const k = ...` then `{{ k }}`), so pin the
  // interpolation expressions too: the source label must be the only key-ish thing rendered.
  const interpolations = [...drawer.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => (m[1] ?? "").trim());
  expect(interpolations.filter((e) => /key|secret|token|credential/i.test(e))).toEqual([
    "typesafeView.keySource",
  ]);
});

test("every call site is individually toggleable", () => {
  // Each site needs its OWN input bound to its OWN key. The previous version asserted only that the
  // string `typesafe-callsite-<site>` appears somewhere in the drawer, which another assertion in this
  // file already implies - so dropping a site's toggle, or pointing two sites at one key, left it green.
  // Pin the binding: the input whose id names the site must bind that site's own callSites key.
  const markup = drawer.split("\n").map((l) => l.trim());
  for (const site of TYPESAFE_CALL_SITE_NAMES) {
    const at = markup.findIndex((l) => l.startsWith(`<label for="typesafe-callsite-${site}"`));
    expect(at).toBeGreaterThan(-1);
    expect(markup[at]).toContain(`id="typesafe-callsite-${site}"`);
    expect(markup[at]).toContain(`settingsForm.typesafe.callSites.${site}`);
  }
});

test("configured and state are separate rows, and an open breaker warns with its resume time", () => {
  // `configured` answers "is a key set"; `state` answers "is it working". Rendering
  // only the first would paint a tripped 15-minute breaker green.
  // `state` and `configured` on their own appear elsewhere in the file (an MCP note uses
  // "configured"), so asserting the bare words passes without either row existing. These are the
  // expressions that only the two rows produce.
  // These four strings all appear elsewhere in the same file (the breaker banner, the
  // "no key configured" branch, and a CSS selector), so deleting both ROWS left this green. The
  // rows themselves are what the name claims, so pin the row markup.
  expect(drawer).toContain("<dt>configured</dt><dd>{{ typesafeView.configured");
  expect(drawer).toContain("<dt>state</dt><dd");
  // Whole lines, and the banner's PLACE in the chain. A substring match on the markup survived the
  // defect: it was a `v-else-if` chained to the independent `typesafeError` line instead of the status
  // chain, so any failed save (the 409 "the active repository changed", HomeControlCenterDrawer.vue:241)
  // hid the reason the judge was paused, at the moment the operator needed it.
  const markup = drawer.split("\n").map((l) => l.trim());
  const configuredAt = markup.findIndex((l) =>
    l.startsWith('<p v-else-if="typesafeView && !typesafeView.configured"'),
  );
  const circuitAt = markup.findIndex((l) => l.includes("Circuit open"));
  expect(circuitAt).toBe(configuredAt + 1);
  // `open` and `half-open` share the line: half-open refuses every call too (a lone probe is in
  // flight), so a banner that only fired on `open` left the operator with a fully inert judge and
  // no explanation. The CSS and the `state` row already anticipated both.
  expect(markup[circuitAt]).toStartWith(
    "<p v-else-if=\"typesafeView?.state === 'open' || typesafeView?.state === 'half-open'\"",
  );
  expect(drawer).toContain("cooldownUntil");
});

test("thresholds come from settingsForm.typesafe, never from literals in the component", () => {
  expect(drawer).toContain("settingsForm.typesafe");
  expect(drawer).toContain("emptyTypesafeForm");
  // Effective model/timeout come from the server view, never from a local copy. The save path
  // binds `typesafeView.value` to a local first, so the payload can never be built from
  // `undefined` and silently refilled from the defaults.
  expect(drawer).toContain("typesafeView.model");
  expect(drawer).toContain("const view = typesafeView.value");
  // The panel sends ONLY the fields it owns. It used to spread the 17-field `view.settings` snapshot
  // because a partial block was re-coerced onto the DEFAULTS; commit 216a04f gave the coercion a
  // `base` and the merge passes the stored block, so the spread became purely destructive - open the
  // panel, change `model` from the CLI, tick a box here, save, and the CLI change is reverted.
  // Scoped to the PAYLOAD, not the component: the form seeding a local from the view is fine, and a
  // whole-component check would either pass over the real defect or fail on legitimately reading it.
  const save = drawer.slice(drawer.indexOf("async function saveTypesafe"));
  const payload = save.slice(
    save.indexOf("api.settings.set("),
    save.indexOf("});", save.indexOf("api.settings.set(")),
  );
  expect(payload).not.toContain("...view.settings");
  // The browser must not import the node-only settings module into the bundle.
  expect(drawer).not.toContain('from "../../../typesafe-settings.js"');
  expect(drawer).toContain("validateThresholds");
  // The save control is blocked by the shared guard, which also covers a view that never loaded.
  expect(drawer).toMatch(/typesafe-save[^>]*:disabled="typesafeSaveBlocked\(\)"/);
});

test("the browser talks to the two redacted server endpoints and never holds the key", () => {
  expect(api).toContain('"/api/typesafe"');
  expect(api).toContain('"/api/typesafe/test"');
  expect(drawer).toContain("api.typesafe");
});

test("the settings subtree moved to types-settings.ts and mirrors the call-site vocabulary", () => {
  expect(settingsTypes).toContain("interface VibeSettings");
  expect(settingsTypes).toContain("typesafe?: TypesafeSettings");
  // `import type` only: the vite bundle must never pull node:fs into the browser.
  expect(settingsTypes).toMatch(
    /import type \{[^}]*TypesafeCallSites[^}]*TypesafeReviewerEnginePolicy[^}]*\} from "\.\.\/\.\.\/typesafe-contract\.js"/,
  );
  // The lifted block is gone from the legacy module, not re-exported as a shim.
  expect(legacyTypes).not.toContain("interface VibeSettings");
  expect(legacyTypes).not.toContain("interface HookConfig");
});

test("emptyTypesafeForm seeds every field so the form cannot start undefined", async () => {
  const { emptyTypesafeForm } = await import("../types-settings.js");
  // The drawer seeds `settingsForm.typesafe` from this before the first GET resolves, so every
  // field must be present: a missing one would render as an unset input instead of a default.
  expect(emptyTypesafeForm()).toEqual({
    enabled: false,
    runAtConfidence: 0,
    acceptAtConfidence: 0,
    callSites: { reviewer: false, risk: false, goalCoverage: false, planner: false },
  });
});

test("the threshold invariant admits the shipped defaults and rejects an accept floor below the run floor", async () => {
  const { typesafeThresholdError } = await import("../types-settings.js");
  // The engine reads both values as lower floors: dispatch-reviewer-llm.ts accepts an answer
  // once confidence reaches `run`, then lets it act once confidence reaches `accept`. So an
  // accept floor above the run floor is the meaningful configuration, not an error, and the
  // shipped default (run 0.7 / accept 0.85) must load clean.
  expect(typesafeThresholdError({ runAtConfidence: 0.7, acceptAtConfidence: 0.85 })).toBe("");
  // An accept floor BELOW the run floor makes the accept gate unreachable: every answer that
  // exists may also act. That is the configuration worth rejecting.
  expect(typesafeThresholdError({ runAtConfidence: 0.85, acceptAtConfidence: 0.7 })).not.toBe("");
  // Equal floors are degenerate but coherent: every answer that exists may act.
  expect(typesafeThresholdError({ runAtConfidence: 0.7, acceptAtConfidence: 0.7 })).toBe("");
  // A CLEARED input does not arrive as 0: `v-model.number` falls back to the raw string when
  // `parseFloat` is NaN, so the field holds `""`. `"" < 0.85` is false, so the ordering check alone
  // would pass it, the save guard would open, and the server would reject the string and restore
  // the default — the user's edit gone with no message. Cast because the declared type says
  // `number`, which is exactly the lie the runtime check exists to cover.
  expect(
    typesafeThresholdError({ runAtConfidence: "", acceptAtConfidence: 0.85 } as never),
  ).not.toBe("");
  expect(
    typesafeThresholdError({ runAtConfidence: 0.7, acceptAtConfidence: Number.NaN } as never),
  ).not.toBe("");
  // Out of range is rejected too, and for the same reason: `min`/`max` on the inputs do not
  // constrain typing (no <form>, no reportValidity), so the field can hold 5. The ordering test
  // passes it, the POST carries 5, and the server clamps it to 1 on the reload — the edit gone.
  expect(typesafeThresholdError({ runAtConfidence: 5, acceptAtConfidence: 9 })).not.toBe("");
  expect(typesafeThresholdError({ runAtConfidence: -1, acceptAtConfidence: 0.85 })).not.toBe("");
  expect(typesafeThresholdError({ runAtConfidence: 0.7, acceptAtConfidence: 1 })).toBe("");
});

test("the save control only acts on a view that actually loaded", async () => {
  const { typesafeSaveDisabled } = await import("../types-settings.js");
  const ready = { saving: false, status: "ready", thresholdError: "", rowsAreStale: false };
  // The form is seeded from the loaded view. If the GET failed, the form still holds
  // `emptyTypesafeForm()` (all zeros), and posting that makes the server refill the whole
  // block from DEFAULT_TYPESAFE_SETTINGS, silently discarding the user's real settings.
  expect(typesafeSaveDisabled({ ...ready, status: "error" })).toBe(true);
  expect(typesafeSaveDisabled({ ...ready, status: "loading" })).toBe(true);
  expect(typesafeSaveDisabled(ready)).toBe(false);
  // The two original guards still hold.
  expect(typesafeSaveDisabled({ ...ready, saving: true })).toBe(true);
  expect(typesafeSaveDisabled({ ...ready, thresholdError: "bad ordering" })).toBe(true);
  // And the repo-mismatch guard, which is the one that closes the cross-repo race: the rows on
  // screen describe a repo the server is about to stop writing to.
  expect(typesafeSaveDisabled({ ...ready, rowsAreStale: true })).toBe(true);
});

test("the cross-repo guard is wired at its production call site, not only as a predicate", async () => {
  const { typesafeNeedsReload } = await import("../types-settings.js");
  // POST /api/detect calls setActiveRepo server-side and POST /api/settings writes to the active
  // repo, so the moment the Repository field blurs, a click on Save posts the PREVIOUS repo's
  // loaded block onto the new one. The predicate alone fixes nothing: `typesafeNeedsReload` was
  // already used for the post-`detect()` reload, and that reload runs after the write it was
  // supposed to prevent. The button binding is the actual defence, and this repo has no mount
  // harness (the drawer is read as text), so pin the wiring by name — deleting it must fail here.
  expect(typesafeNeedsReload("/repo/a", "/repo/b")).toBe(true);
  expect(drawer).toContain("rowsAreStale: typesafeNeedsReload(typesafeRepo.value, repoPath.value)");
  expect(drawer).toContain(':disabled="typesafeSaveBlocked()"');
  // The probe acts on the server's PROCESS-GLOBAL active repo too, so it needs the same staleness
  // guard Save has: without it, a probe clicked from a stale panel bills and reports against
  // whichever repo is active by then, under rows that describe the one it was opened for.
  expect(drawer).toMatch(/:disabled="typesafeTesting[^"]*typesafeSaveBlocked\(\)"/);
  expect(drawer).toContain('@click="saveTypesafe"');
});

test("the save names the repository its rows describe, so the server can refuse a moved target", () => {
  // The server-side comparison is only reachable if the panel actually sends the repo the block
  // was read from. Without this the 409 guard never fires and the cross-repo write is back.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  // Bound the slice to the function AND assert the bound. The previous version ended the slice at
  // the first `};`, which sits 136 lines further down, so the window covered load, detect,
  // initialize and loadSkills — moving `expectRepo` to any of those satisfied the test while the
  // call site no longer sent it.
  // The window is the save function's OWN body: the previous `nexts` list also matched the
  // `\nconst ` of a destructuring inside it, which would have truncated the call. Bounded by
  // counting the lines up to the next top-level `async function`, and the bound is asserted so a
  // move cannot silently widen it.
  const start = drawer.indexOf("async function saveTypesafe");
  expect(start).toBeGreaterThan(-1);
  const nextFn = drawer.indexOf("\nasync function", start + 1);
  const call = drawer.slice(start, nextFn === -1 ? drawer.length : nextFn);
  expect(call.split("\n").length).toBeLessThan(60);
  // And it has to be inside the request payload, not merely somewhere in the function.
  const payloadStart = call.indexOf("api.settings.set(");
  const payloadEnd = call.indexOf("});", payloadStart);
  expect(payloadStart).toBeGreaterThan(-1);
  expect(payloadEnd).toBeGreaterThan(payloadStart);
  expect(call.slice(payloadStart, payloadEnd)).toContain("expectRepo: view.repo");
});

test("the generic settings panel never carries the System One block into its form", () => {
  // That panel has no System One UI, and its `form` is a snapshot of the WHOLE settings taken when
  // its dialog opened. The block used to ride along on BOTH of its save paths and, because
  // `mergeTypesafeSettings` is replace-on-write on mere key presence, saving anything at all -
  // Memory, toolPriority, or an envPolicy change through the preview/apply route - rewrote the
  // judge from a stale copy, into whichever repo was active by then. One projection at load covers
  // both branches; a guard per branch would have to be repeated on the policy-apply route too,
  // which does not go through the settings route at all.
  //
  // The projection is a shared helper now (settings-form-helpers.ts) because the re-seed path
  // needed it too: `POST /api/settings` answers with the block present, so assigning that response
  // to `original` raw made `isDirty` true forever. Every assignment to `form`/`original` goes
  // through it, which this pins by counting the call sites.
  const panel = readFileSync(new URL("../components/SettingsPanel.vue", import.meta.url), "utf8");
  const helpers = readFileSync(new URL("../settings-form-helpers.ts", import.meta.url), "utf8");
  expect(helpers).toContain("export function withoutTypesafe");
  expect(helpers).toContain("export function coerceEditableDefaults");
  // Wire-format claim, unchanged: the direct save posts the panel's own form, and the block can
  // only be absent from a payload the form never carried.
  expect(panel).toContain("api.settings.set(withoutTypesafe(form.value))");
  expect(panel).toContain("{ ...nonPolicy }");
  // BOTH save paths re-seed through the projection, and the initial load projects both sides.
  // Pinned as a count: adding a raw `original.value = clone(...)` anywhere fails here.
  expect([
    ...panel.matchAll(/original\.value = coerceEditableDefaults\(withoutTypesafe\(/g),
  ]).toHaveLength(3);
  expect(panel).not.toContain("original.value = clone(savedSettings)");
  expect(panel).not.toContain("JSON.parse(JSON.stringify(savedSettings))");
});

test("the System One save refusal renders on its own content", () => {
  // `typesafeError` was rendered only under `typesafeStatus === 'error'`, which a failed SAVE can
  // never set: the button only renders once the status is `ready`. The message was written to a ref
  // nothing showed. The paragraph is bound to its own content now.
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const at = drawer.indexOf("typesafeError && typesafeStatus !== 'error'");
  expect(at).toBeGreaterThan(-1);
  expect(drawer.slice(at, at + 200)).toContain("{{ typesafeError }}");
});

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
  const guard = "if (!rowsDescribe(probed)) return;";
  expect(body.indexOf(guard)).toBeGreaterThan(-1);
  const writeAt = body.indexOf("typesafeProbe.value = result.ok");
  expect(body.indexOf(guard)).toBeLessThan(writeAt);
  expect(body.lastIndexOf(guard)).toBeGreaterThan(writeAt);
  // The stamp must not be written before the call (that named the PENDING probe), nor on either
  // superseded path: the only stamp sits after the LAST guard, so a discarded verdict never
  // advances it.
  expect(body.slice(0, awaitAt)).not.toContain("typesafeProbeRepo =");
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
  // `{ memory: true, typesafe: {...} }` fails `tsc --strict` with it (TS2345, naming only arm 1's
  // missing `expectRepo`) and compiles without it.
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
  const gate = body.indexOf("if (rowsDescribe(view.repo))");
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
  expect([...body.matchAll(/if \(seq !== typesafeLoadSeq\) return;/g)]).toHaveLength(2);
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
