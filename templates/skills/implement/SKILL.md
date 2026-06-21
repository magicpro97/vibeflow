---
name: implement
description: Common skill for the implement phase. Use when the user did not supply concrete input/output paths at init. The phase agent must write the production code that satisfies the detail design, with evidence of build/lint passing.
---

# Implement

## When to use

Apply this skill whenever the workflow reaches the **Implement** phase and no concrete input/output paths were declared at init. Writes the production code that satisfies the detail design.

## Goals

1. Implement every component defined in the detail design.
2. Follow the **project's coding conventions** (from real code, not guesses).
3. Pass the **project's build, lint, and test** commands before declaring done.
4. Add or update **unit tests** alongside the implementation.
5. Capture **evidence** of completion (file paths, command output, test results).

## Inputs (auto-discover)

- Detail design document from the previous phase.
- `.vibeflow/PROJECT_CONTEXT.md`, `.vibeflow/ai-context/stack-evidence.md`.
- Build / lint / test commands from `package.json` or equivalent.

## Execution Steps

1. Read the detail design and project context.
2. Run the project's build, lint, and test commands once to capture the **baseline** output. Save it as evidence.
3. For each component in the detail design, implement the public interface, then the internals.
4. Add or update unit tests that cover at least: happy path, every documented error case, and any non-trivial algorithm.
5. After each meaningful change, run the build + lint to keep feedback tight.
6. At the end, run the **full** build, lint, and test suite. All three must pass.
7. Update the project's `CHANGELOG.md` or release notes if the project convention requires it.
8. Record evidence in the dispatch output: every new/edited file path, the final build/lint/test command output (tail), and the count of new tests.

## Outputs

- Production code at the paths declared in the phase definition.
- Updated or new tests covering the new code.
- An evidence note with file paths and command output.

## Definition of Done

- Every detail-design component has a corresponding implementation file.
- Build, lint, and test all pass (`exit 0`) when run via the project's documented commands.
- Unit tests cover happy path + every documented error case.
- No new lint warnings introduced.

## Anti-Patterns

Do **NOT** do any of the following when applying this skill:

- **Embedding concrete requirement IDs from a sample task** — the skill body must remain valid for the NEXT task. Use placeholders like `{{task.component_count}}` or `{{task.business_rule_count}}`, not real IDs from the current project.
- **Hardcoding file paths, package names, or class names from the current project** — the skill runs across many codebases. Use patterns like `{{project.src_dir}}/`, `{{project.test_dir}}/`, not the actual paths.
- **Listing specific business rules from the sample** — the skill says "implement every business rule from the detail design". It does NOT list the actual rules. The implementer reads the detail design to find them.
- **Using "9 concrete test classes" or any sample-specific number** — the test count belongs in the implementation evidence, not the skill body. The skill says "add tests covering happy path + every documented error case".
- **Skipping the baseline build/lint run** — implementing without a baseline means a failing build at the end might be a pre-existing issue, not your fault. Always capture the baseline first.
- **Treating "build passes" as the only DoD** — the implement phase must also satisfy the detail design's interface contract, error handling, and observability requirements. Build pass is necessary, not sufficient.
- **Hardcoding test data from a sample task** — test fixtures are per-task. The skill says "use realistic fixtures for the happy and error paths"; it does NOT say "use the P03_0001 fixture".

---

Powered by VibeFlow
