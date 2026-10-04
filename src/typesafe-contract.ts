// src/typesafe-contract.ts — the closed System One vocabularies, in a module with
// ZERO runtime imports.
//
// Why this file exists: `src/typesafe-settings.ts` resolves the API key and
// `~/.vibeflow/typesafe.env`, so it pulls `node:fs` and, through the durability
// layer, `bun:ffi`. A type-only import of it is erased by the transpiler but is
// still followed by the web build's type-checker (`vue-tsc` under
// `src/ui/tsconfig.json`, which sets `"types": []`), which then fails on
// `Cannot find module 'bun:ffi'`. These two frozen arrays carry no I/O, so the
// control center can import them without dragging a Node runtime into the browser
// bundle. `src/typesafe-settings.ts` re-exports them, so a Node caller keeps
// importing them from the one module it already imports — the authority is still
// declared exactly once.
/** Which VibeFlow call sites may consult the judge. ONE frozen runtime authority;
 *  the type is INFERRED from it, so adding a site is a single edit here and every
 *  consumer (coerce loop, `vf config typesafe call-site`, the `/api/typesafe` view,
 *  the UI) narrows against it. No `enum`, no second member list in any module. */
export const TYPESAFE_CALL_SITE_NAMES = Object.freeze([
  "reviewer",
  "risk",
  "goalCoverage",
  "planner",
] as const);
export type TypesafeCallSiteName = (typeof TYPESAFE_CALL_SITE_NAMES)[number];
/** Each site fails open. Total by construction: a new tuple member is a compile
 *  error in `DEFAULT_TYPESAFE_SETTINGS` until it is given a default. */
export type TypesafeCallSites = Record<TypesafeCallSiteName, boolean>;

/** Reviewer engine policy vocabulary — same one-authority rule. */
export const TYPESAFE_REVIEWER_ENGINE_POLICIES = Object.freeze(["unit", "global"] as const);
export type TypesafeReviewerEnginePolicy = (typeof TYPESAFE_REVIEWER_ENGINE_POLICIES)[number];
