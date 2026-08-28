---
title: Bun and TypeScript Coding Conventions
description: Enforced source, protocol, runtime, testing, and portability conventions for VibeFlow contributors and coding agents.
category: reference
last_updated: 2026-08-28
---

# Bun and TypeScript Coding Conventions

VibeFlow uses Bun 1.4 for development, dependency installation, builds, and tests.
The published `vf` artifact is still a Node-targeted ESM bundle. Code must satisfy both
boundaries: fast Bun-native tooling and the declared Node runtime.

These rules are executable where practical. `tsconfig.json`, `biome.json`,
`bun.lock`, the file-size and waiver scripts, focused contract tests, and `vf verify`
are the authorities. This page explains why those gates exist.

## Runtime and modules

- Use ESM, `node:` built-in imports, `.js` suffixes for relative source imports, and
  `import type` for type-only dependencies.
- Source compiled into `dist/cli.js` must remain Node-compatible. Use a Bun-only API only
  behind a deliberate adapter or external build boundary with focused tests.
- Keep TypeScript strict. The project additionally enforces isolated modules, consistent
  path casing, total returns, checked indexed access and side-effect imports, override
  markers, and switch fallthrough protection.
- Parse external data as `unknown`. Prove shape, membership, bounds, and state before
  narrowing. New `any`, blind double casts, and non-null assertions require a real
  integration constraint and focused evidence.

Bun's current TypeScript guidance recommends strict mode, bundler resolution,
`verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noImplicitOverride`, and
`noFallthroughCasesInSwitch`. VibeFlow keeps `target: ES2022` instead of Bun's
`ESNext` suggestion because the released bundle deliberately targets Node rather than
the Bun runtime. See the [official Bun TypeScript guide](https://bun.sh/docs/runtime/typescript).

## Constants, unions, and hardcoded values

Do not add TypeScript `enum` or `const enum`. Biome rejects both. For closed values that
must exist at runtime, use one plain-JavaScript authority and derive the type:

```ts
export const TASK_STATE = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  FAILED: "failed",
} as const);

export type TaskState = (typeof TASK_STATE)[keyof typeof TASK_STATE];

export const TASK_STATE_LABEL = Object.freeze({
  [TASK_STATE.QUEUED]: "Queued",
  [TASK_STATE.RUNNING]: "Running",
  [TASK_STATE.FAILED]: "Failed",
} satisfies Record<TaskState, string>);
```

This matches Biome's recommendation to use JavaScript objects or TypeScript unions instead
of emitted enums. See the [official `noEnum` rule](https://biomejs.dev/linter/rules/no-enum/).

Centralize a value when it is a closed vocabulary, bound, field name, exit code,
environment key, lifecycle state, or wire literal shared by multiple layers. Import that
authority in storage, validators, services, CLI, and UI. Do not duplicate the same values
as a handwritten union or create a miscellaneous `constants.ts` dumping ground.

A local one-use branch label, prose string, fixture payload, or UI sentence is not a
protocol. Leaving it inline is clearer than manufacturing a constant with no authority.

Use the `typed-protocol-contracts` skill for persisted/API/config/CLI/UI vocabularies.

## Structure and ownership

- Keep ordinary source files at or below 400 lines. Split along authority and
  responsibility boundaries, not into arbitrary helper shards.
- New circular dependencies are not acceptable. Contract modules stay dependency-light
  and browser-safe when the UI consumes them.
- Public collections and protocol maps are immutable. Prefer `Readonly`,
  `ReadonlyArray`, `Object.freeze`, and total `satisfies Record<...>` projections.
- A file-size waiver needs an issue, owner, reason, and expiry. A waiver does not replace a
  concrete split plan.

## Processes, paths, and cleanup

- Launch executable plus argv; keep `shell: false` unless a proved platform shim requires
  a shell. Never interpolate untrusted input into a command string.
- Reuse the tracked launcher and owned-process abstractions instead of introducing an ad
  hoc `Bun.spawn`.
- Persist PID plus process-start identity. PID alone is not ownership.
- Make POSIX and Windows path semantics explicit. Avoid assuming slash, drive, UNC,
  symlink, reparse-point, hardlink, process-group, or signal behavior is portable.
- Every acquired resource has deterministic success, failure, cancellation, and crash
  cleanup. Preserve the primary error when cleanup also fails. Bound reads, waits,
  retries, output, and aggregate memory.

Use `runtime-portable-process-fixtures` for launcher/process work and
`deterministic-async-teardown` for lifecycle-heavy async changes.

## Tests

Use `bun:test` with descriptive behavior names and specific matchers. Cover success,
rejection, bounds, invalid external values, cleanup, and relevant platforms. Prefer
table-driven cases for vocabularies and boundary matrices.

Tests must be deterministic. Do not add retries, sleeps, global state, or weaker
assertions to hide a race. Native and platform adapters need injected seams locally plus a
real same-SHA CI job on the target OS. Bun documents test isolation, filtering,
randomized-order reproduction, teardown, and coverage in its
[official test runner guide](https://bun.sh/docs/test).

## Dependencies and reproducibility

`packageManager` and `bun.lock` define the Bun toolchain. CI uses `bun ci`, which is
equivalent to a frozen-lockfile install and fails when declarations and the lock disagree.
See the [official Bun install guide](https://bun.sh/docs/pm/cli/install).

Do not add a dependency when a small standard-library implementation is clearer. A tool
upgrade must update its declaration, lockfiles, compatibility documentation, and focused
contract evidence in the same change.

## Required verification

Run focused tests while iterating, then:

```bash
bun run typecheck
bun run lint
bun run file-size:check
bun run waiver:check
bun run build
git diff --check
```

Run affected UI, landing, E2E, native, or normative gates as applicable. Before claiming
completion after any code edit, run whole-repo `vf verify` and require confidence `1.0`.
