---
name: codex-global-hooks
description: "Update Codex CLI native hook wiring safely: global config scope, Bash-only enforcement, merge preservation, and test isolation."
metadata:
  scope: project
  project.id: magicpro97/vibeflow
  status: verified
  type: repo
  triggers:
    - Codex hooks
    - vf hooks emit
    - guardrail enforcement
---

# Codex global hook wiring

## When to use

Use when changing VibeFlow's Codex hook adapter or its guardrail setup.

## When not to use

Do not use for unrelated engine adapters or generic shell-command changes outside Codex hook wiring.

## Steps

1. Verify upstream Codex schema and feature requirements before coding. Codex reads
   `~/.codex/hooks.json`; it does not read a repo-local `.codex/hooks.json`.
2. State scope truthfully: `PreToolUse` blocks Bash/shell only. Edit, Write,
   apply_patch, and MCP calls need the existing apply-time diff gate.
3. Keep `vf hooks emit` dry-run by default. Print a global-scope warning in both
   dry-run and `--yes` paths, because global config affects every Codex repo.
4. Merge `PreToolUse` and `PostToolUse` into existing JSON. Preserve unrelated
   top-level and `hooks` keys. Invalid JSON must be left untouched.
5. Enable `[features] codex_hooks = true` in `~/.codex/config.toml` idempotently.
   Preserve unrelated TOML; do not add a parser dependency for this one boolean.
6. Tests must inject an isolated home directory. Never let test runs write real
   `~/.codex/` files. Cover merge preservation, corrupt JSON, and feature flag.
7. Keep docs, doctor output, generated engine instructions, and apply-gate wording
   aligned. Run typecheck, lint, affected tests, coverage gate, then `vf verify`.

## Verification

Confirm isolated-home tests cover merge preservation, corrupt JSON, and the feature flag before accepting hook changes.

## Pitfalls

- A native-bash-only tier is not full native coverage. Do not bypass Codex's
  apply-time diff gate.
- A global write needs an explicit user-visible warning even when `--yes` skips
  a dry-run first.
- Runtime code executes under Node after packaging. Guard `Bun` access and fall
  back to Node when Bun is unavailable.
