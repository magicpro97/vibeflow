---
name: plan-debate
description: "Resolve contested artifacts (plans, designs, claims) via a structured cross-debate with evidence, not opinion. Trigger when 2+ plausible designs clash, a claim is disputed, or a review flags a design-level disagreement that code alone cannot settle."
---

# Plan Debate

When an artifact is contested — two plausible designs, a disputed claim, or a review
flagging a design-level disagreement — the coordinator dispatches a cross-debate.
The debate resolves on **evidence**, not rhetorical skill.

## When to use

Use when two plausible designs or a design-level claim require evidence-based resolution.

## When not to use

Do not use for style preferences, local naming choices, or fix-level patches where behavior is already the test.

## 1. When to trigger

- 2+ workable designs for the same problem (e.g., event-sourcing vs CRUD for a
  transaction log).
- A review flags a design decision as "wrong direction" (not just a style nit).
- A claim in a plan, brief, or commit message is challenged (e.g. "covers all edge
  cases" → reviewer says "misses concurrent writes").
- The coordinator cannot dispatch because two engines disagree on approach.

Do NOT trigger for style preferences, naming that is locally consistent, or
`fix`-level patches where behavior is the test.

## Steps

Every debate follows exactly 4 steps. Skipping a step = bikeshedding.

### Step 1 — Claim
State the assertion precisely. Include:
- **What** the claim asserts (one sentence).
- **Where** it applies (file, module, or system boundary).
- **Why** it matters (impact if wrong — security, perf, correctness, maintainability).

### Step 2 — Counter
The strongest opposing argument:
- A concrete failure case the claimant has not addressed.
- No "what about X?" without a real scenario.
- Counter must reference the same **Where** scope as the Claim.

### Step 3 — Evidence
One of these settles it:
- A `file:line` reference (existing code that proves/disproves the claim).
- A command output (typecheck, test run, bench, `git log` showing real prior
  art).
- A minimal reproducer (≤ 20 lines that demonstrate the failure case).

Evidence is a FACT, not an argument. If evidence is missing, the debate is
not settled — mark it `BLOCKED` in §6 of the brief and escalate to the user.

### Step 4 — Resolution
Record:
- **Which side won** and why (cite the evidence).
- **The decision** in one sentence.
- **Anchored evidence**: the exact `file:line`, command, or repro that closed
  the debate.

Resolution format:
```
RESOLVED: <decision>
WINNER: <claimant | counter>
EVIDENCE: <file:line | command output excerpt>
```

## 3. Worked example

**Scenario**: Two designs for storing work unit state — SQLite vs JSON file.

**Claim** (SQLite): "SQLite gives atomic writes and queryability. JSON file
loses state on concurrent dispatch."

**Counter** (JSON): "Single-worktree write avoids concurrency; the DB adds
a schema migration surface for no gain. Less code, fewer deps."

**Evidence**: `git log --oneline -- .vibeflow/state/` shows 4 corruption
events in the last 30 days from concurrent `vf orchestrate` runs. SQLite's
WAL journal recovers them; JSON can't.

**Resolution**:
```
RESOLVED: Use SQLite via better-sqlite3 for work unit state.
WINNER: Claimant (SQLite)
EVIDENCE: git log -- .vibeflow/state/ → 4 corruption events in 30 days;
          concurrent dispatch is possible under any engine.
```

## Verification

Accept a debate only when its resolution records a winner and anchored evidence; otherwise mark it `BLOCKED`.

## 4. Pitfalls

- **Debating without evidence = bikeshedding.** If neither side can produce
  a file:line, command output, or reproducer, stop and escalate to the user
  with both positions summarized.
- **Claiming "obvious" without evidence.** "Clearly SQLite is better" is not
  a claim — it's a vibe. Make the failure mode concrete.
- **Letting the loudest engine win.** The engine that argues hardest is not
  the one that is right. Evidence is the tiebreaker, not verbosity.
- **Scope drift.** The Counter must address the same Where as the Claim.
  "What about a completely different system?" is a new debate — open a new
  issue.
- **Unresolved debates pile up in §6.** Capped at 3 open debates per brief.
  At 3, stop dispatching and escalate.
