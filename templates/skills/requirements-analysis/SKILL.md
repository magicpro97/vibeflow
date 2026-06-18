---
name: requirements-analysis
description: Common skill for the requirements analysis phase. Use when the user did not supply concrete input/output paths at init. The phase agent must gather, clarify, and document project requirements (business, functional, non-functional) before any design or implementation.
---

# Requirements Analysis

## When to use

Apply this skill whenever the workflow reaches the **Requirements Analysis** phase and no concrete input/output files were declared at init. The phase agent is responsible for producing a complete requirements package from scratch (or refining a stub) before design begins.

## Goals

1. Capture **business context** (problem, users, success metrics).
2. Elicit **functional requirements** (features, user stories, acceptance criteria).
3. Capture **non-functional requirements** (performance, security, reliability, compliance).
4. Resolve ambiguity by asking targeted questions or scanning the repository for clues.
5. Produce a requirements document the next phase (basic design) can consume directly.

## Inputs (auto-discover)

- `README.md`, `docs/`, `QUICKSTART.md` at the project root.
- Existing user-supplied description from `.vibeflow/PROJECT_CONTEXT.md`.
- Stack evidence at `.vibeflow/ai-context/stack-evidence.md`.

## Execution Steps

1. Read the inputs above to ground the requirements in the actual project context.
2. Produce the requirements document at the configured output path (see phase definition in `.vibeflow/WORKFLOW_STATE.json`).
3. Structure the document with these sections (omit any that genuinely do not apply):
   - **Business context** — problem, target users, success metrics.
   - **Functional requirements** — numbered list of user stories with acceptance criteria.
   - **Non-functional requirements** — performance budgets, security, reliability, compliance.
   - **Out of scope** — explicit non-goals.
   - **Open questions** — unresolved items for the design or implementation phase.
4. Mark each requirement with a stable ID (e.g. `FR-1`, `NFR-1`) so the design phase can trace back.
5. Cite the source for every non-obvious requirement (file path, line, or stakeholder reference).
6. Record evidence in the dispatch output (output path + line counts of each section).

## Outputs

- A requirements document (Markdown) at the path declared in the phase definition.
- A short evidence note in the work-unit outcome citing the output file path and section IDs.

## Definition of Done

- Output file exists on disk and is non-empty.
- All sections above are present (or explicitly marked "not applicable").
- Every requirement has a stable ID and acceptance criteria.
- Open questions are listed, not silently dropped.

## Anti-Patterns

Do **NOT** do any of the following when applying this skill:

- **Embedding concrete requirement IDs from a sample task** — the skill body must remain valid for the NEXT task. Use placeholders like `{{task.fr_count}}` or `{{task.primary_actor}}`, not real IDs from the current project.
- **Hardcoding file paths from the current project** — the skill runs across many repos. Use patterns like `{{project.docs_dir}}/requirements.md`, not `brain/docs/basic_designs/P03_0001_*.md`.
- **Copying the section structure of a specific input file** — if the input uses a non-standard layout, treat it as one possible shape among many. Describe the minimum sections any requirements doc must have.
- **Treating stakeholder citations as boilerplate** — every non-obvious requirement MUST cite a source. A requirements doc without traceable sources is just a wish list.
- **Skipping the "out of scope" section** — what the feature is NOT doing is as important as what it does. The next phase needs that boundary to make design trade-offs.
- **Resolving ambiguity with a guess** — if the input is unclear, the right move is an "Open Questions" entry, not a fabricated answer.
- **Producing prose without stable IDs** — every requirement must carry a stable ID (`FR-1`, `NFR-2`, etc.) so the design phase can trace back. A doc with no IDs is impossible to verify against.

---

Powered by VibeFlow
