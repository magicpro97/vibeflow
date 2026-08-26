---
name: typed-protocol-contracts
scope: common
description: Centralize persisted, transport, CLI, and UI protocol literals in typed runtime contracts. Use when adding or changing statuses, event kinds, error codes, limits, environment keys, exit codes, or cross-platform identity prefixes so implementations and validators cannot drift.
status: draft
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

## Evidence
- `src/dispatch/owned-process-contract.ts` closes process scope, proof strength, status phase,
  failure code, and exit-code values with `as const` runtime contracts and inferred unions.
- `bun test test/dispatch-owned-process.test.ts test/dispatch-owned-process-windows.test.ts
  test/dispatch-owned-process-output.test.ts` exercises persistence, Windows containment, and
  output-drain boundaries.
- The whole repository passed `7636 pass, 9 skip, 0 fail` before the follow-up audit exposed
  remaining uncaptured protocol surfaces, which is why duplicate-literal review remains a step.

## When to use
Apply this before changing any closed vocabulary or bound that crosses two or more layers: storage,
validation, transport, runtime, CLI, or UI. Also apply it when a review finds repeated semantic
literals even if the current tests are green.

## Steps
1. Inventory every producer, parser, validator, comparison, renderer, and test for the protocol.
2. Create one dependency-light contract module containing frozen values and bounds with `as const`.
3. Infer union types from the runtime values; do not maintain a second handwritten string union.
4. Export focused membership guards when untrusted input must be narrowed at runtime.
5. Import the contract in storage, service, HTTP, CLI, and UI code instead of mirroring literals.
6. Keep legacy compatibility explicit and one-way; never widen the current contract to accept an
   unqualified legacy state.
7. Add positive, unknown-value, cross-layer parity, and migration regression tests.
8. Search again for duplicate raw literals and justify any occurrence that remains protocol text.

## Verification
Run focused contract tests, `bun run typecheck`, `bun run lint`, `git diff --check`, and the relevant
build. If the protocol is normative, refresh and run `bun run normative:check`. Before completion,
run the repository's full `vf verify` confidence gate.

> DRAFT — captured from a real task. Review and refine before relying on it.
