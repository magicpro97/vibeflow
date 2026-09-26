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
});

test("the save control only acts on a view that actually loaded", async () => {
  const { typesafeSaveDisabled } = await import("../types-settings.js");
  // The form is seeded from the loaded view. If the GET failed, the form still holds
  // `emptyTypesafeForm()` (all zeros), and posting that makes the server refill the whole
  // block from DEFAULT_TYPESAFE_SETTINGS, silently discarding the user's real settings.
  expect(typesafeSaveDisabled({ saving: false, status: "error", thresholdError: "" })).toBe(true);
  expect(typesafeSaveDisabled({ saving: false, status: "loading", thresholdError: "" })).toBe(true);
  expect(typesafeSaveDisabled({ saving: false, status: "ready", thresholdError: "" })).toBe(false);
  // The two original guards still hold.
  expect(typesafeSaveDisabled({ saving: true, status: "ready", thresholdError: "" })).toBe(true);
  expect(
    typesafeSaveDisabled({ saving: false, status: "ready", thresholdError: "bad ordering" }),
  ).toBe(true);
});

test("the rows refetch when the active repo changes underneath them", async () => {
  const { typesafeNeedsReload } = await import("../types-settings.js");
  // POST /api/detect calls setActiveRepo server-side, and POST /api/settings writes to the
  // active repo. Without a refetch, Save writes the previous repo's block onto the new one.
  expect(typesafeNeedsReload("", "/repo/a")).toBe(false); // nothing loaded yet: first load owns it
  expect(typesafeNeedsReload("/repo/a", "/repo/a")).toBe(false);
  expect(typesafeNeedsReload("/repo/a", "/repo/b")).toBe(true);
});
