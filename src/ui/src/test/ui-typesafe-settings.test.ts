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
    // The remediation must NAME the variable: "set the environment variable" sent the operator
    // hunting for its name, which the server's own message already spells out.
    "TYPESAFE_API_KEY",
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

test("the System One styles use the theme variables, never literal colours", () => {
  // The scoped block shipped literal dark-theme hexes. In light mode (`--home-panel: #ebe7de`) that
  // put the egress disclosure and the circuit warning at 1.2-2.0:1 contrast - the two most
  // safety-critical strings in the section, below the 4.5:1 WCAG 2.1 AA floor, while every other
  // rule in this drawer reads `var(--home-*)` and home.css ships a real dark variant.
  const drawerSrc = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const style = drawerSrc.slice(drawerSrc.indexOf("<style scoped>"));
  expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no literal colour anywhere in the block
  expect(style).toContain("color: var(--home-muted)");
  expect(style).toContain("color: var(--home-amber)"); // the warning/circuit colour
  expect(style).toContain("color: var(--home-ink)");
});

test("the browser discloses what leaves the machine, from the SAME authority the CLI prints", () => {
  // `vf config typesafe on` prints `TYPESAFE_EGRESS_LINES` before it writes the setting, and
  // `status` prints it unconditionally. The browser toggles are the same act: without this the only
  // surface that let an operator switch on egress - including the `risk` site, which sends the raw
  // shell command with any secret typed inline - was the one that never said so.
  const drawerSrc = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  expect(drawerSrc).toContain(
    'import { TYPESAFE_EGRESS_LINES } from "../../../typesafe-egress.js";',
  );
  const at = drawerSrc.indexOf('v-if="settingsForm.typesafe.enabled"');
  expect(at).toBeGreaterThan(-1); // shown the moment the block can egress, not only when it does
  const notice = drawerSrc.slice(at, at + 400);
  expect(notice).toContain("TYPESAFE_EGRESS_LINES");
  // The import must be the shared constant, never a hand-copied string: the CLI prints `state`
  // verbatim, so its tests and the docs break together if this is re-inlined.
  expect(drawerSrc).not.toContain("raw shell command");
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
  // The probe has its OWN bucket and health file, so the enforcement banner must not claim to
  // silence the test (it does not: an open enforcement breaker leaves the probe runnable). The
  // probe's own breaker gets its own line, gated on `probeState`.
  expect(drawer).not.toContain("including this test");
  expect(drawer).toContain("typesafeView?.probeState === 'open'");
  expect(drawer).toContain("the probe's own breaker is");
});

test("a refusal is worded as a refusal, never as a failed connection", () => {
  const drawer = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  // At the shipped default (`enabled: false`) every probe answers the disabled refusal; rendering
  // it through "System One connection failed" sends the operator hunting for a network problem
  // that does not exist. The discriminator is the server's typed flag, not the error string.
  expect(drawer).toContain('result.refused === true ? "System One did not run the test for"');
  expect(drawer).toContain('"System One connection failed for"');
  // ...and the same wording on the THROWN path: `req` discards the body's `refused` flag, so the
  // moved-repository refusal (the route's only 409) is recognised by its status.
  expect(drawer).toContain("(cause as { status?: number }).status === 409");
  // And the flag exists on the wire: the route marks every precondition/breaker refusal.
  const route = readFileSync(
    new URL("../../../server/routes-typesafe.ts", import.meta.url),
    "utf8",
  );
  expect([...route.matchAll(/refused: true,/g)]).toHaveLength(4);
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
  const probeButton = /<button type="button" :disabled="([^"]*)" @click="testConnection"/.exec(
    drawer,
  );
  expect(probeButton?.[1]).toContain("typesafeSaveBlocked()");
  // The button's gate follows the PROBE's own breaker: the probe runs through
  // the PROBE bucket (its own health file), so an OPEN ENFORCEMENT breaker does not refuse it
  // and gating on `state` disabled the one control that could report a healthy probe.
  expect(probeButton?.[1]).toContain("typesafeView?.probeState === 'open'");
  expect(probeButton?.[1]).not.toContain("typesafeView?.state === 'open'");
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
  // its dialog opened - so the block rode along on BOTH of its save paths, and (because
  // `mergeTypesafeSettings` is replace-on-write on mere key presence) saving anything at all -
  // Memory, toolPriority, or an envPolicy change through the preview/apply route - rewrote the
  // judge from a stale copy, into whichever repo was active by then. One projection at load covers
  // both branches; a per-branch guard would repeat on the policy-apply route, which it does not cover.
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

test("coerceEditableDefaults never writes through its parameter", async () => {
  // The panel seeds `original` with a clone of what it also hands to `coerceEditableDefaults`.
  // While that helper merged IN PLACE it refilled the very object the clone existed to protect:
  // `form` and `original` aliased the same nested `envPolicy`/`curator`, so the `JSON.stringify`
  // dirty check read equal after an edit (no prompt for real edits) and unequal before one (a
  // prompt with no edits) - wrong both ways, and invisible to any string pin about the SHAPE.
  const { coerceEditableDefaults } = await import("../settings-form-helpers.js");
  const api = { envPolicy: undefined, curator: undefined };
  const out = coerceEditableDefaults(api as never);
  expect(out).not.toBe(api);
  expect(api.envPolicy).toBeUndefined();
  expect(api.curator).toBeUndefined();
  expect(out.envPolicy).toEqual({});
  expect(out.curator?.severityThreshold).toBe("medium");
});
