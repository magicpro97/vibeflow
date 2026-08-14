---
title: Crystallize Update Proposal
description: How vf skills crystallize detects patterns matching an existing skill and prints a patch proposal instead of a draft.
category: explanation
last_updated: 2026-07-22
---

# Crystallize Update Proposal (Issue #664)

`vf skills crystallize <run-id>` now detects when extracted patterns match an
existing skill and prints a **PATCH PROPOSAL** (stdout only) instead of writing
a `crystallized-run-*` draft.

## Flow

1. Run `vf skills crystallize <run-id>` as before.
2. If patterns cross the threshold, `proposeCrystallizeUpdate()` checks each
   pattern against the skill catalog.
3. **Match found** → print proposal to stdout (diff preview, affected file,
   eval command). No file written.
4. **No match** → existing draft behavior unchanged (writes
   `.vibeflow/skills/crystallized-<slug>/SKILL.md`).

## Matching rules (conservative, deterministic)

A pattern matches a skill when its value equals **any** of (case-insensitive):

- Skill `name`
- `domain.id`
- `owns` fact key

**Never matched:**

- `failure` kind patterns (too generic)
- Generic terms: `bun build`, `bun test`, `echo`, `ls`, `cat`, `rm`, `cp`,
  `mv`, `mkdir`, `touch`, `cd`, `pwd`, `git status`, `git diff`, `git log`,
  `git add`, `npm install`, `npm run`, `node`, `npx`
- Generic failure signatures: `command not found...`, `permission denied...`,
  `no such file...`, `failed to...`

## Proposal output

```
PATCH PROPOSAL for skill "<name>"
────────────────────────────────────────────────────────────
Affected files: <path>
Eval: vf skills eval <name>

Proposed diff:
--- a/<path>
+++ b/<path>
@@ -1,3 +1,3 @@
+<!-- #664 crystallized from run <run-id> -->
+## Crystallized patterns
...
────────────────────────────────────────────────────────────
No draft written. Review the proposal above and apply manually.
```

## API

### `proposeCrystallizeUpdate(repo, patterns, runId, inject?)`

```ts
function proposeCrystallizeUpdate(
  repo: string,
  patterns: CrystallizedPattern[],
  runId: string,
  inject?: { discoverSkills?: (r: string) => Skill[] },
): CrystallizeProposalResult
```

Returns `{ hasProposal, proposal?, reason? }`.

### `buildProposal(skill, patterns, runId)`

```ts
function buildProposal(
  skill: Skill,
  patterns: CrystallizedPattern[],
  runId: string,
): CrystallizePatchProposal
```

Pure builder — no I/O, no LLM, no side effects.