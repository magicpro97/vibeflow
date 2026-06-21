---
name: verify
description: Common skill for the verify phase. Use when the user did not supply concrete input/output paths at init. The phase agent must run the end-to-end verification (build, lint, test, smoke) and confirm the phase outcomes meet the project's definition of done.
---

# Verify

## When to use

Apply this skill whenever the workflow reaches the **Verify** phase and no concrete input/output files were declared at init. Runs the end-to-end verification gate that decides whether the workflow outcomes are shippable.

## Goals

1. Run the **full verification suite**: build, lint, test, smoke (and any project-specific gate).
2. Confirm every previous phase's **definition of done** is satisfied.
3. Capture the verification evidence (commands + outputs) for the audit trail.
4. Issue a clear **pass / fail** decision with a written rationale.
5. On failure, produce an actionable list of follow-ups for the implement or testing phase.

## Inputs (auto-discover)

- Outputs from every previous phase (see `.vibeflow/WORKFLOW_STATE.json`).
- Build / lint / test / smoke commands from `package.json` or equivalent.
- `.vibeflow/PROJECT_CONTEXT.md` and `.vibeflow/ai-context/stack-evidence.md`.

## Execution Steps

1. Read every previous phase's outcome and definition of done.
2. Run the **full verification suite** in order: build, lint, test, smoke. Capture the output of each.
3. If a smoke script does not exist, run a representative end-to-end invocation (CLI command, HTTP probe, or equivalent) and capture the output.
4. For each previous phase, verify the declared outputs exist on disk and are non-empty.
5. If any gate fails, classify the failure: **blocker** (must fix before ship), **debt** (file a follow-up, ship acceptable), **noise** (e.g. flaky test, document and retry).
6. Issue a **pass / fail** decision with rationale. If fail, list the specific follow-ups (file path, command, expected fix).
7. Write the verification report to the configured output path.
8. Record evidence: report path, every command's exit code and tail output, the final decision.

## Outputs

- A verification report (Markdown) at the path declared in the phase definition.
- An evidence note with the report path and the final pass/fail decision.

## Definition of Done

- Verification report exists on disk and is non-empty.
- Every gate (build, lint, test, smoke) ran to completion with `exit 0`, OR the failure is explicitly classified as accepted debt.
- Every previous phase's outputs are verified to exist on disk.
- A pass/fail decision is recorded with rationale.
- On fail, the follow-up list is actionable (specific file / command / expected fix).

## Anti-Patterns

Do **NOT** do any of the following when applying this skill:

- **Embedding concrete phase names or output paths from a sample workflow** — the skill body must remain valid for the NEXT workflow. Use placeholders like `{{workflow.phases}}`, not `detail-design → implement → testing` or `P03_0001`.
- **Hardcoding build/test commands from the current project** — the skill says "run the project's build, lint, test, and smoke commands". It does NOT say `npm run typecheck && npm run test`. Project-specific commands belong in the stack-evidence or PROJECT_CONTEXT.md, not in the skill body.
- **Producing a "blocker" classification without an actionable fix** — a verification failure is useless unless the follow-up says which file to change, which command to run, and what the expected output looks like.
- **Skipping the smoke test when the project has no smoke script** — "no smoke script exists" means you write one, not that you skip the verification step. A representative end-to-end invocation always exists (CLI command, HTTP probe, database query).
- **Accepting "debt" for a failure that blocks the pipeline in CI** — debt classification is only valid when a human explicitly decides "ship with this bug". The verify phase cannot unilaterally downgrade a blocker to debt.
- **Producing a one-line pass/fail verdict** — every decision requires a written rationale. "pass: tests green" is not a rationale; "pass: all 4 gates green (build: exit 0, lint: 0 warnings, test: 342/342 pass, smoke: 200 OK)" is.
- **Marking a phase as "verified" without checking every declared output exists** — a phase's DoD is only satisfied if all its outputs are on disk and non-empty. Verifying the code review alone is insufficient.

---

Powered by VibeFlow
