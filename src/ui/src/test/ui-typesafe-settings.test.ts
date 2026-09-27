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

test("status states include text and ARIA, not colour alone", () => {
  for (const snippet of [
    "No System One key configured",
    "Loading System One settings",
    "System One connection failed",
    'role="status"',
    'aria-live="polite"',
    'role="alert"',
  ]) {
    expect(drawer).toContain(snippet);
  }
});

test("the drawer never renders a secret: no key value, only a source label", () => {
  expect(drawer).toContain("keySource");
  expect(drawer).not.toMatch(/TYPESAFE_API_KEY\s*[:=]\s*["'`]/);
  expect(drawer).not.toContain("Bearer");
});

test("every call site is individually toggleable", () => {
  for (const site of TYPESAFE_CALL_SITE_NAMES) {
    expect(drawer).toContain(`typesafe-callsite-${site}`);
  }
});

test("configured and state are separate rows, and an open breaker warns with its resume time", () => {
  // `configured` answers "is a key set"; `state` answers "is it working". Rendering
  // only the first would paint a tripped 15-minute breaker green.
  expect(drawer).toContain("state");
  expect(drawer).toContain("configured");
  expect(drawer).toContain("cooldownUntil");
  expect(drawer).toContain('data-state="open"');
});

test("thresholds come from settingsForm.typesafe, never from literals in the component", () => {
  expect(drawer).toContain("settingsForm.typesafe");
  expect(drawer).toContain("emptyTypesafeForm");
  // Effective model/timeout come from the server view, never from a local copy. The save path
  // binds `typesafeView.value` to a local first, so the payload can never be built from
  // `undefined` and silently refilled from the defaults.
  expect(drawer).toContain("typesafeView.model");
  expect(drawer).toContain("const view = typesafeView.value");
  expect(drawer).toContain("...view.settings");
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
  const start = drawer.indexOf("async function saveTypesafe");
  expect(start).toBeGreaterThan(-1);
  const nexts = ["\nasync function", "\nfunction", "\nconst "]
    .map((marker) => drawer.indexOf(marker, start + 1))
    .filter((at) => at !== -1);
  const call = drawer.slice(start, nexts.length ? Math.min(...nexts) : drawer.length);
  expect(call.split("\n").length).toBeLessThan(40);
  // And it has to be inside the request payload, not merely somewhere in the function.
  const payloadStart = call.indexOf("api.settings.set(");
  const payloadEnd = call.indexOf("});", payloadStart);
  expect(payloadStart).toBeGreaterThan(-1);
  expect(payloadEnd).toBeGreaterThan(payloadStart);
  expect(call.slice(payloadStart, payloadEnd)).toContain("expectRepo: view.repo");
});

test("the generic settings panel does not write the System One block", () => {
  // That panel has no System One UI and its `form` is a snapshot of the WHOLE settings taken when
  // its dialog opened, so posting it back wrote a stale judge configuration - enabled flag, model,
  // thresholds, call-site toggles - into whatever repo was active by then, which the panel never
  // names and cannot see change. `mergeTypesafeSettings` is replace-on-write on mere key presence,
  // so the snapshot did not even have to be edited. The server now refuses the combination; this
  // pins the client half so the panel keeps working instead of returning 400.
  const panel = readFileSync(new URL("../components/SettingsPanel.vue", import.meta.url), "utf8");
  const start = panel.indexOf("const { typesafe: unmanaged, ...payload } = form.value;");
  expect(start).toBeGreaterThan(-1);
  expect(panel.slice(start, start + 220)).toContain("api.settings.set(payload)");
});
