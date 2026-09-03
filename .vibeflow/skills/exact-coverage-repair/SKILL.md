---
name: exact-coverage-repair
description: Repair VibeFlow coverage, review-proof, or exact-head verification regressions by fixing path identity and evidence freshness instead of waiving the gate or rerunning blindly.
scope: project
project.id: magicpro97/vibeflow
status: verified
capabilities:
  - repair canonical report identity
  - regenerate evidence for changed head
  - bind test result to repository path
  - fix structured runner artifact parsing
  - restore confidence gate without waiver
triggers:
  - wrong file after rebase
  - maps to wrong file
  - test report to the wrong file
  - playwright result mapped incorrectly
  - proof stale
  - current sha uses old coverage artifact
  - repair exact-head gate
requires:
  filesystem: write
  network: false
  shell: true
---

# Exact Coverage Repair

Use this skill when the gate is failing because coverage or review evidence no
longer maps cleanly to the exact head under test.

## When to use

- coverage dropped because a structured report no longer maps to the exact test
  identity
- review evidence or verify output is stale after a repair
- Playwright, Bun, or another runner is producing parseable artifacts but the
  gate is reading the wrong stream or wrong path namespace
- a root-cause fix is required before rerunning the full confidence gate

## When not to use

- the task is to change product behavior unrelated to coverage or verification
- a documented waiver already covers the path and no regression was introduced
- you only need to explain coverage output without changing the gate

## Steps

1. Reproduce the failing gate on the current head and capture the exact failing
   artifact or log before editing anything.
2. Trace test identity through structured data. Prefer canonical file path plus
   leaf test title over fuzzy suffix matching, and bind path resolution to the
   repository authority used by both sync and async callers.
3. For runners with structured output, write a deterministic artifact such as
   Playwright JSON and parse that artifact instead of scraping mixed stdout.
4. Keep path semantics explicit across platforms. Accept only exact canonical
   matches for the current authority, and treat drive, UNC, namespace, or share
   mismatches as separate cases that need tests.
5. After any edit, regenerate review evidence and rerun final verify on the new
   exact head. Do not trust prior digests, run ids, or coverage reports after
   the SHA changes.
6. Reach for a waiver only when the repo already defines one for that path and
   the new work did not widen the exemption.

## Verification

- the focused reproduction passes on the repaired exact head
- structured reports resolve to the correct canonical path and test title
- fresh review evidence and final verify evidence match the current SHA
- the full coverage gate passes without adding an unjustified waiver
