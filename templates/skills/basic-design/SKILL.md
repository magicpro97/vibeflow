---
name: basic-design
description: Common skill for the basic design phase. Use when the user did not supply concrete input/output paths at init. The phase agent must produce a high-level design (architecture, components, data flow, key trade-offs) that is enough to start detail design.
---

# Basic Design

## When to use

Apply this skill whenever the workflow reaches the **Basic Design** phase and no concrete input/output files were declared at init. Produces the high-level design that bridges requirements and detail design.

## Goals

1. Translate requirements into a **system architecture** (components, boundaries, deployment shape).
2. Define the **key data flows** between components.
3. Identify the **major trade-offs** and the rationale for the chosen approach.
4. List the **technology selections** (libraries, services, data stores) and why each fits.
5. Surface **risks** the detail-design phase must address.

## Inputs (auto-discover)

- Requirements document produced by the previous phase (see `.vibeflow/WORKFLOW_STATE.json`).
- `.vibeflow/PROJECT_CONTEXT.md` and `.vibeflow/ai-context/stack-evidence.md`.
- Existing source tree (`src/`, `app/`, `lib/`, etc.) for evidence of intended structure.

## Execution Steps

1. Read the requirements and project context.
2. Sketch the architecture as a small set of named components with a one-line responsibility each.
3. Document the **primary data flow** (request → processing → response) and any secondary flows (background jobs, events).
4. For each major decision (database choice, framework, auth model, deployment shape), record the **alternatives considered** and the **rationale** for the chosen option.
5. List **risks** that need to be addressed in detail design (e.g. scaling, consistency, security).
6. Produce a Mermaid diagram (or ASCII art) of the component graph inside the document.
7. Write the design document to the configured output path.
8. Record evidence in the dispatch output (output file path + component count + decision count).

## Outputs

- A basic design document (Markdown) at the path declared in the phase definition.
- An evidence note citing the output path and key decision IDs.

## Definition of Done

- Output file exists on disk and is non-empty.
- All components from the requirements have a corresponding design entry.
- Every major decision has rationale + alternatives.
- Risks are listed, not silently dropped.

## Anti-Patterns

Do **NOT** do any of the following when applying this skill:

- **Embedding concrete component names from a sample task** — the skill body must remain valid for the NEXT project. Use placeholders like `{{project.primary_component}}`, not real names from the current input file.
- **Hardcoding technology choices into the skill body** — the skill applies to any stack. Technology selections belong in the design OUTPUT, not in the skill STEPS. The skill says "list the technology selections"; the design doc says "we chose PostgreSQL because…".
- **Copying the architecture diagram of a sample input** — the diagram is project-specific evidence, not a reusable pattern. The skill describes HOW to draw the diagram (Mermaid component graph, request→processing→response flow), not WHAT the diagram contains.
- **Writing a "design" that is just a restatement of requirements** — basic design must add architecture, trade-offs, and data flow that the requirements don't already specify. If your design section could be moved to the requirements doc unchanged, it's not a design.
- **Listing risks without context** — "scalability risk" is useless. Each risk needs the trade-off it threatens and the detail-design question it raises.
- **Skipping the rationale for a chosen alternative** — "we chose X" without "over Y and Z because…" is not a decision, it's a guess. The detail-design phase can't inherit unexplained choices.
- **Producing a design without a component graph** — text-only designs hide integration boundaries. Even a 3-box ASCII diagram is better than nothing.

---

Powered by VibeFlow
