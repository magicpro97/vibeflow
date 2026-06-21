---
name: testing
description: Common skill for the testing phase (unit + integration). Use when the user did not supply concrete input/output paths at init. The phase agent must design, run, and document a test pass that exercises the implemented features.
---

# Testing (UT/IT)

## When to use

Apply this skill whenever the workflow reaches the **Testing** phase and no concrete input/output files were declared at init. Designs, runs, and documents the unit + integration test pass that proves the implementation works end-to-end.

## Goals

1. Verify every functional requirement has at least one **passing** test.
2. Verify every non-functional requirement has a **measurable** test (or a documented gap).
3. Run the project's full test suite and document the results.
4. Surface any failing or flaky tests as work-unit evidence, not silent pass.
5. Capture coverage and quality metrics the verify phase can review.

## Inputs (auto-discover)

- Implemented code from the previous phase.
- Detail design document (for requirement → test traceability).
- `.vibeflow/PROJECT_CONTEXT.md` and `.vibeflow/ai-context/stack-evidence.md`.

## Execution Steps

1. Read the detail design to enumerate the requirements that need test coverage.
2. For every requirement, identify the existing test(s) that cover it; create missing tests.
3. Author or extend **integration tests** that exercise the major data flows from the basic design.
4. Run the project's full test suite. Save the full output.
5. If the project ships a coverage tool, run it and capture the report.
6. If any test fails, classify each failure as: **flaky** (re-run, decide), **real bug** (file an evidence note, do not silently pass), or **environment** (document, retry).
7. Write a test report at the configured output path with: requirements covered, requirements without coverage, test count, pass/fail count, coverage numbers.
8. Record evidence: test report path, full test command output (tail), coverage report path.

## Outputs

- A test report (Markdown) at the path declared in the phase definition.
- New/updated test files covering previously-uncovered requirements.
- An evidence note with the report path and key metrics.

## Definition of Done

- Test report exists on disk and is non-empty.
- Every functional requirement is covered by at least one test, OR explicitly marked as a documented gap with rationale.
- Final test-suite run ends with `exit 0` and zero unaddressed failures.
- Coverage report (if produced) is captured as evidence.

## Anti-Patterns

Do **NOT** do any of the following when applying this skill:

- **Embedding concrete requirement IDs from a sample task** — the skill body must remain valid for the NEXT task. Use placeholders like `{{task.requirement_ids}}`, not real IDs (BR-001, AC-032, E-014) from the current project.
- **Hardcoding test class names or test file paths from the sample** — the skill runs across many codebases. Use patterns like `{{project.test_dir}}/{{component}}Test.java`, not `brain/common/src/test/.../BulkUploadValidatorTest.java`.
- **Listing "9 concrete test classes" or any sample-specific count** — the test class count belongs in the test report OUTPUT, not the skill body. The skill says "author one test class per validation concern"; it does NOT say "author 9 classes".
- **Copying the error-code table from a sample input** — error codes are task-specific. The skill says "enumerate all error codes from the detail design and write a negative test for each"; it does NOT list the actual codes.
- **Treating a flaky pass as a real pass** — a test that fails and then passes on retry is not "green". It's a flaky test that must be classified (flaky / real bug / environment) before the report is closed.
- **Skipping the traceability matrix in the report** — the test report must show requirement→test mapping. Without it, the verify phase can't confirm full coverage.
- **Producing a test report that says "all tests pass" without the actual command output** — the report must include the test command and its exit code + tail output. A bare "pass" claim is not evidence.

---

Powered by VibeFlow
