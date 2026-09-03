---
name: typed-protocol-contracts
scope: common
description: Centralize persisted, transport, CLI, and UI protocol literals in typed runtime contracts. Use when adding or changing statuses, event kinds, error codes, limits, environment keys, exit codes, or cross-platform identity prefixes so implementations and validators cannot drift.
status: verified
triggers:
  - protocol contract
  - hardcoded status
  - error code
  - event kind
  - cross-platform process
---

# typed-protocol-contracts

## Why this exists
Repeated string and number literals let persisted records, HTTP validation, CLI adapters, and UI
projections silently disagree. A single runtime value must also be the source of its TypeScript type.

Prefer a frozen `as const` object plus an inferred value union over a TypeScript `enum`. The object is
plain JavaScript, has no emitted reverse mapping, keeps wire values explicit, and can be consumed by
runtime validators. An `enum` is appropriate only when its emitted runtime object is itself the
deliberate external contract; that is not the case for VibeFlow's JSON and persisted protocols.

## Evidence
- `biome.json` enables `noEnum` and `noConstEnum`; `bun run lint:enum-contract` covers source,
  tests, E2E, scripts, Playwright config, and landing code instead of relying on review memory.
- `src/dispatch/owned-process-contract.ts` closes process scope, proof strength, status phase,
  failure code, and exit-code values with `as const` runtime contracts and inferred unions.
- `bun test test/dispatch-owned-process.test.ts test/dispatch-owned-process-windows.test.ts
  test/dispatch-owned-process-output.test.ts` exercises persistence, Windows containment, and
  output-drain boundaries.

## When to use
Apply this before changing any closed vocabulary or bound that crosses two or more layers: storage,
validation, transport, runtime, CLI, or UI. Also apply it when a review finds repeated semantic
literals even if the current tests are green.

## When not to use
Do not create a protocol contract for prose, a one-off local branch label, test fixture content, or a
value that has no closed membership semantics. Constants should expose real authority, not disguise
ordinary text or move every literal into a miscellaneous constants file.

## Steps
1. Inventory every producer, parser, validator, comparison, renderer, and test for the protocol.
2. Create one dependency-light contract module containing frozen values and bounds with `as const`.
   A browser-consumed wire contract must not import server durability, filesystem, or native modules.
3. Infer union types from runtime values; do not maintain a second handwritten string union. Add
   compile-time `SameKeys`/`SameUnion` assertions where independent record or producer types meet.
4. Export exact field tuples and focused membership guards when untrusted input is narrowed at
   runtime. Validate both shape and state-dependent semantics before a cast or state mutation.
5. Import the same contract in storage, service, HTTP, CLI, and UI code instead of mirroring values.
   Derived subsets and transition maps must be total, frozen, and built from canonical members.
6. Treat a record's self-digest as integrity, not approval authority. Recompute the enclosing
   approved plan or envelope digest from the persisted record and compare it with the authorized
   parent digest before append, fold, read, replay, or recovery.
7. Keep legacy compatibility explicit and one-way; never widen the current contract to accept an
   unqualified legacy state.
8. Add positive, unknown-value, prototype-key, cross-layer parity, semantic-correlation, and
   migration regression tests. Include a re-digested malformed persisted record when applicable.
9. Run the browser build for browser-facing contracts, then search again for duplicate raw literals
   and justify any occurrence that remains protocol text.

## Verification
Run focused contract tests, `bun run typecheck`, `bun run lint`, `bun run file-size:check`,
`git diff --check`, and every affected build. If the protocol is normative, refresh and run
`bun run normative:check`. Before completion, run the repository's full `vf verify` confidence gate.

> VERIFIED — reviewed against the runtime-contract migration and enforced by focused regressions.
