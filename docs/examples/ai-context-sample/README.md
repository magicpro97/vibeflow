# AI-context sample

A **static, reviewed snapshot** of the files that `vf init --ai` writes into a
repo's `.vibeflow/ai-context/` directory. It illustrates the *shape* of the
AI-enriched context VibeFlow generates for a TypeScript/Bun project.

## Why this is here

The live `.vibeflow/ai-context/` directory is **gitignored** (see
`.vibeflow/.gitignore`): its contents are produced by an LLM enrichment pass +
a repo profile scan, so they are **non-deterministic** — they vary per run, per
engine, and per model. Committing the live copy would produce noisy, misleading
diffs on every `vf init`.

This snapshot is the one-time, human-reviewed reference so newcomers can see
what enriched context looks like without digging through git history.

## Important

- **Static — NOT regenerated.** Editing files here changes nothing in any repo;
  `vf init` writes to `.vibeflow/ai-context/`, never to `docs/`.
- It is a sample from one run on this repo; project metadata in the sample
  (name, version, goal) reflects that run, not the current repo state.
- Your repo's own enriched context lives in `.vibeflow/ai-context/` (gitignored)
  and is refreshed by `vf init --ai`.

## Files

| File | What `vf init --ai` puts in it |
|------|-------------------------------|
| `AGENTS.md`, `CLAUDE.md` | Engine instruction files (enriched variants) |
| `INSTRUCTIONS.md`, `INSTRUCTIONS_TEMPLATE.md` | Generated + template instruction bodies |
| `PROJECT_CONTEXT.md` | Project summary the agents read first |
| `project-profile.json` | Machine-readable repo profile (languages, stack) |
| `directory-listing.txt` | Snapshot of the repo tree at init time |
| `stack-evidence.md` | Detected stack with supporting file evidence |
| `SKILL_TAXONOMY.md`, `ANTHROPIC_SKILL_STANDARD.md` | Skill-system references copied in for the agents |
