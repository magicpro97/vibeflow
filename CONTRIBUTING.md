# Contributing to VibeFlow

VibeFlow uses Bun 1.4 for development and testing while publishing a Node-targeted ESM CLI.

## Set up

```bash
bun ci
bun run build
bun run check
```

Use the version pinned by `packageManager`; do not substitute an unverified global runtime.
`bun ci` keeps `package.json` and `bun.lock` reproducible.

## Coding standard

Read [Bun and TypeScript Coding Conventions](docs/CODING_CONVENTIONS.md) before changing
source, tests, protocol values, subprocesses, or build configuration.

The short version:

- strict TypeScript and explicit ESM boundaries
- no TypeScript `enum` or `const enum`
- one frozen `as const` runtime authority for shared closed vocabularies
- no duplicated wire values or miscellaneous constants dumping ground
- Node compatibility for shipped code even though Bun drives tooling
- argv-based portable subprocesses and deterministic cleanup
- descriptive `bun:test` coverage for success, rejection, bounds, and teardown
- 400-line source cap; waivers require an issue, owner, reason, and expiry

A local one-use literal does not need a constant. Persisted/API/config/CLI/UI values shared
across layers do.

## Commits and verification

Use signed-off Conventional Commits, for example:

```text
feat(cli): add typed conversation export
fix(dispatch): release Windows process record handles
refactor(runtime): centralize process state authority
```

Run the smallest relevant checks while iterating. Any code edit requires the repository's
final `vf verify` confidence gate before it is complete. Pull requests must carry exact-head
review and CI evidence; a local macOS/Linux result cannot substitute for a native Windows job.
