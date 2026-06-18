// src/commands/_shared.ts
//
// Barrel of shared imports for the per-subcommand modules in src/commands/.
// Each subcommand file (`doctor.ts`, `init.ts`, `dispatch.ts`, etc.) imports
// from here instead of reaching back into the parent src/ tree. This keeps
// the per-subcommand files flat and makes the dependency graph inspectable.
//
// Per-subcommand files MUST NOT import anything from src/commands.ts
// (the facade) — that would create a cycle. They may import from this
// barrel, or from src/* directly for narrowly-scoped needs.
//
// Refs: issue #80 (split src/commands.ts).
//
// Implementation: each `export *` re-exports the values and types of one
// source module. We use `export *` per source rather than a single
// `export *` of everything because TS would otherwise be unable to
// re-export the same name from multiple sources (the first wins, silent
// overwrite of types).

// Re-export Node.js builtins we need, but be explicit to avoid
// `link`/`exists` collisions between node:fs and other modules.
export { spawnSync } from "node:child_process";
export { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
export { basename, isAbsolute, join, resolve } from "node:path";

export * from "../adapters.js";
export * from "../agents/detect-roles.js";
export * from "../agents/render.js";
export * from "../core.js";
export * from "../dispatch.js";
export * from "../gates.js";
export * from "../hooks/adapters.js";
export * from "../hooks/runner.js";
export * from "../hooks/selftest.js";
export * from "../init-intake.js";
export * from "../journal.js";
export * from "../orchestrator/investigate.js";
export * from "../orchestrator/run.js";
export * from "../preflight.js";
export * from "../safety/checkpoint.js";
export * from "../safety/quota.js";
export * from "../scanner.js";
export * from "../settings.js";
export * from "../skills/importer.js";
export * from "../skills/registry.js";
export * from "../skills/resolver.js";
export * from "../skills/sync.js";
export * from "../skills/validator.js";
export * from "../tools/index.js";
export * from "../ui.js";
export * from "../workflow-artifacts.js";
export * from "../workflow/lifecycle.js";
export * from "../workflow/merge.js";
export * from "../logbus.js";

// === Test seams + guardrail diagnostics re-exported from seams.ts ===
// (issue #80, phase 3/14) The doctor subcommand uses liveGuardrailArmed
// and guardrailOffNote. The cycle rule forbids doctor.ts from importing
// from a sibling (./seams.js), so we re-export the two names through
// this barrel. seam.ts is the only sibling allowed to be referenced
// from here because the facade pattern is the *only* legitimate way to
// expose a sibling to other subcommand files.
export { liveGuardrailArmed, guardrailOffNote } from "./seams.js";
