# ADR-005: Canary tests — human-authored verification for the confident-wrongness ceiling

**Status:** Accepted (2026-07-03)
**Deciders:** magicpro97 (user decision, verification-hardening plan)
**Related:** ADR-003 (goal-eval), ADR-004 (machine-verifiable evidence), computed-confidence gate (#513)

## Context

VibeFlow's gates certify that tests *exist and pass*, build is clean, lint is
clean, and an independent LLM reviewer approved. They do **not** certify that the
tests are *adequate*. The failure mode they cannot catch is **confident
wrongness**: the implementer and the reviewer are both LLMs, and when they share
a training blind spot they will *agree* on a wrong answer. Every gate then goes
green on a shared error — cleanly, confidently, and wrong (SWE-bench,
arXiv:2310.06770, documents this class of agreed-upon miss).

Self-generated tests inherit the same blind spot: an LLM that misunderstands a
domain edge (an off-by-one boundary, a business rule, a known regression, a
security payload shape) will write a test that *confirms its misunderstanding*.
The gate loop is closed and self-referential. No amount of extra LLM review
breaks it, because every reviewer is drawn from the same distribution.

## Decision

**Canary tests are a first-class verification feature, not advisory.**

1. **Convention** — a canary is a behavioral test at `test/**/*.canary.test.ts`,
   committed by a human, encoding domain knowledge an LLM cannot self-generate.
   It declares its scope via a `// canary-scope: <path>,<path>` header.

2. **State** — `WorkUnit.canary?: { file, author, linkedAt }` records the linked
   canary, its git-blame author, and when it was linked (`vf canary link`).

3. **Author constraint** — the canary author **must differ from the unit's
   dispatch engine identity** (`u.owner_agent`). A canary the agent wrote itself
   is not a canary; it re-closes the loop. `vf canary link` refuses when the
   git author equals the dispatch engine.

4. **Gate (FAILURE, not warning)** — a `knowledge_heavy === true` unit in status
   `done` with no covering canary **cannot close**. This is a hard failure in
   `policyGates`, surfaced by `vf verify` and the web UI policy panel. `=== true`
   is deliberate: legacy/undefined units (pre-feature) are skipped, not gated.

5. **Command** — `vf canary list | link <unit> <file> | check` manages the
   feature standalone; `check` reports the same gap the gate blocks on.

## Consequences

- **Breaks the self-generated-test loop** for domain knowledge: the one signal
  in the pipeline that does not come from the same model distribution is a human
  behavioral test. This is the intended human-in-the-loop escape hatch for the
  ceiling.
- **Cost**: a human writes ≥1 canary test per knowledge-heavy unit. Deliberate,
  scoped to `knowledge_heavy` units only (not every unit).
- **Scope-overlap matching** (`canaryForUnit`) links a canary to a unit when
  their scopes overlap, so `vf canary list` shows coverage without a manual link
  for the common case; `vf canary link` is the explicit override + author check.
- **Honest ceiling**: this does not prove the canary is *correct* or *complete*,
  only that a human — a different distribution from the agent — authored it. It
  raises the ceiling; it does not remove it.
