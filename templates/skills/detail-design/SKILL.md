---
name: detail-design
description: Common skill for the detail design phase. Use when the user did not supply concrete input/output paths at init. The phase agent must produce a detailed, implementation-ready design (interfaces, contracts, algorithms, schemas, error handling) per component defined in basic design.
---

# Detail Design

## When to use

Apply this skill whenever the workflow reaches the **Detail Design** phase and no concrete input/output files were declared at init. Produces the implementation-ready design that engineers (or the implement phase agent) can follow without further clarification.

## Goals

1. Define **public interfaces** and contracts for every component from basic design.
2. Specify **data schemas** (fields, types, invariants, indexes).
3. Document **algorithms** that are non-trivial, including edge cases.
4. Specify **error handling** strategy (retry, circuit-breaker, fallback, user-facing messages).
5. Capture **observability** requirements (logs, metrics, traces).
6. Capture **test strategy** for each component (unit, integration, contract).

## Inputs (auto-discover)

- Basic design document from the previous phase.
- `.vibeflow/PROJECT_CONTEXT.md` and `.vibeflow/ai-context/stack-evidence.md`.

## Execution Steps

1. Read the basic design and project context.
2. For every component, write a section with: **responsibility**, **public interface(s)**, **dependencies**, **data schema(s)**, **algorithms**, **error handling**, **observability**, **test strategy**.
3. Use stable IDs that match the basic design component IDs (e.g. `DESIGN-C1`).
4. For any non-trivial algorithm, include pseudo-code or a numbered step list — never a hand-wave.
5. For external integrations, document the contract (request/response shape, auth, rate limits, error model).
6. Produce a traceability matrix: requirement ID → component → test strategy.
7. Write the design document to the configured output path.
8. Record evidence (output path + component count + interface count).

## Outputs

- A detail design document (Markdown) at the path declared in the phase definition.
- An evidence note citing the output path and component IDs covered.

## Definition of Done

- Output file exists on disk and is non-empty.
- Every basic-design component has a detail-design section.
- Every interface is fully typed (parameters, return, errors).
- Traceability matrix covers every functional requirement.
- Non-trivial algorithms include pseudo-code or a step list.

## Anti-Patterns

Do **NOT** do any of the following when applying this skill:

- **Embedding concrete requirement IDs from a sample task** — the skill body must remain valid for the NEXT task. Use placeholders like `{{task.requirement_id_pattern}}`, not real IDs (BR-001, AC-032, E-014) from the current project.
- **Hardcoding file paths or module names from the current project** — the skill runs across many repos. Use patterns like `{{project.src_dir}}/{{component_name}}/`, not `brain/common/src/main/java/jp/co/htft/`.
- **Copying business rules from the sample input into the skill body** — business rules are task-specific evidence, not reusable guidance. The skill says "document each business rule with ID, trigger, and enforcement point"; it does NOT say "BR-001 limits uploads to 100 files".
- **Using sample input/output as the canonical example** — treat the sample as ONE valid shape. The skill must describe the MINIMUM schema an output must satisfy, usable even for a completely different task.
- **Producing a hand-wave instead of pseudo-code** — "use a standard algorithm" is not a specification. Non-trivial code needs numbered steps or pseudo-code the implementer can follow literally.
- **Mixing observability requirements into the algorithm section** — observability, error handling, and algorithm are three separate concerns. A section that bundles all three is unreadable.
- **Forgetting the traceability matrix** — every functional requirement must trace to a component and a test strategy. Without the matrix, verification can't prove full coverage.

---

Powered by VibeFlow
