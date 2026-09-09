---
name: bun-typescript-conventions
description: Apply VibeFlow's Bun-driven, Node-targeted TypeScript conventions when adding or refactoring source, tests, protocol values, subprocesses, modules, or build configuration.
scope: project
project.id: magicpro97/vibeflow
status: verified
capabilities:
  - centralize cross-layer runtime vocabulary
  - preserve Node-targeted Bun builds
  - enforce strict TypeScript boundaries
  - write deterministic Bun tests
  - keep subprocess behavior portable
triggers:
  - bun typescript conventions
  - new typescript module
  - hardcoded runtime vocabulary
  - magic string in protocol
  - raw bun spawn
  - bun.spawn call
  - bun test style
requires:
  filesystem: write
  network: false
  shell: true
---

# Bun TypeScript Conventions

Use this skill for code changes in VibeFlow's TypeScript/Bun toolchain. Bun drives
development, build, and tests, while the published CLI is bundled with
`--target=node` and must remain compatible with the declared Node runtime.

## When to use

- adding or restructuring a TypeScript source or test module
- introducing a persisted, API, CLI, UI, configuration, or error vocabulary
- changing process launch, filesystem, platform, async cleanup, or native seams
- changing Bun, TypeScript, Biome, build, lockfile, or test configuration

## When not to use

- copy-only or visual-only work with no TypeScript or toolchain effect
- a local one-off literal that has no shared semantic meaning
- dependency research that does not modify this repository

## Steps

1. Preserve the runtime boundary. Use Bun for scripts, builds, and `bun:test`,
   but keep shipped core code Node-compatible. A Bun-only production API needs
   an explicit adapter/external boundary and both build and runtime evidence.
2. Keep ESM explicit: `node:` built-in imports, `.js` relative import
   suffixes, `import type` for type-only dependencies, and no implicit global
   side-effect imports.
3. Treat untrusted data as `unknown`; validate shape, membership, bounds, and
   state before narrowing. Avoid new `any`, blind double casts, non-null
   assertions, and mutable public collections.
4. Do not use TypeScript `enum` or `const enum`. For a closed runtime
   vocabulary, declare one dependency-light `Object.freeze({ ... } as const)`
   authority, derive its union type, and use `satisfies Record<Union, ...>` for
   total projections. Route cross-layer work through `typed-protocol-contracts`.
5. Centralize semantic values, not every literal. Repeated wire values, limits,
   field names, exit codes, environment keys, and lifecycle states require a
   named authority near their domain. Prose and genuinely local one-use values
   stay local; never create a miscellaneous dumping-ground constants file.
6. Keep source modules within the 400-line gate by splitting along authority or
   responsibility boundaries. A waiver must carry an issue, owner, reason, and
   expiry; it is not a substitute for design.
7. Launch subprocesses with executable-plus-argv and `shell: false` by
   default. Use the existing launcher/owned-process abstractions for PID,
   identity, stream drain, cancellation, and orphan cleanup. Make Windows
   behavior explicit and use injectable native seams for non-Windows tests.
8. Make async ownership total: deterministic success/failure/cancel cleanup,
   preserved primary errors, bounded waits/reads, and no orphan handles,
   timers, listeners, processes, or temporary files.
9. Write descriptive `bun:test` cases for success, rejection, boundary,
   cleanup, and platform behavior. Prefer table-driven cases and specific
   matchers; never weaken a gate or add a retry to hide nondeterminism.
10. Keep `packageManager` and `bun.lock` authoritative. CI installs with
    `bun ci`; tool upgrades update declarations, locks, compatibility docs,
    and focused contract evidence together.

## Verification

Run these in order before claiming done — this is the exact gate order CI
enforces (`.github/workflows/ci.yml`), and every one of them has failed a
real PR when skipped:

1. `bun run fix` — Biome auto-format FIRST. CI's `lint` step fails on any
   unformatted file ("Formatter would" error); formatting after the fact
   changes test preimages and forces a proof-matrix refresh (see step 5).
2. `bun run check` — the full local gate: typecheck, lint, file-size,
   waiver, whole-repo tests, and the 100% per-file line coverage gate.
   This is what CI's `check` job runs; `vf verify` does NOT substitute
   for it on this repo.
3. `bun run build` — UI (vite) plus the node-targeted CLI bundle, and
   restart any local UI server with the fresh build before testing it.
4. When the diff touches UI/components/DTOs: run the focused e2e
   (`bunx playwright test e2e/conversation-home.spec.ts`) — contract
   tests assert markers that move between components, and e2e encodes
   exact draft values (e.g. a mention pick now ends with a trailing
   space: assert `"+role@engine "`, not `"+role@engine"`).
5. `bun run scripts/refresh-normative-proofs.ts` after ANY test or
   production change — the normative matrix digests test preimages and
   goes stale whenever tests change shape (even a Biome-only format of a
   test file). A stale matrix fails `normative:check` on CI.
6. `git diff --check`, then before pushing, produce review evidence
   against the remote merge-base (see `.vibeflow/skills/vf/references/pitfalls.md`
   — pre-push hook enforces it; base is the remote tip, not main).
7. Keep the 400-line file gate in mind while editing: it counts
   `split(/\r?\n/).length`, so a trailing newline pushes a 399-line file
   to 400 and fails `file-size:check`.
