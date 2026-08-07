# VibeFlow Guardrails (hooks) — safety, not bureaucracy

The guardrail hooks are the safety layer `vf` arms around every engine. Load this when a
task touches hook arming, the live gate, or you need to reason about whether a destructive
command will actually be blocked.

## Commands

- `vf hooks status` — show per-engine hook arming (ON/OFF). `vf doctor` also reports it.
- `vf hooks install` — wire the git hooks into the repo.
- `vf hooks emit --yes` — ARM the live PreToolUse gate.

## The live gate — block vs. detect (read this carefully)

The live PreToolUse gate does NOT behave the same across engines:

- **Claude** — the gate BLOCKS. A denied command does not run.
- **Codex / Copilot** — the hook configs are **detection-only**: they observe and log,
  they do **not** block.

**Never assume a destructive command is blocked when driving Codex or Copilot.** Treat the
gate as advisory there and apply your own caution (dry-run first, scoped writes, `--auto-wip`).

## If a hook returns deny/ask

Do NOT bypass it. A `deny` or `ask` result means the approach tripped a guardrail — fix the
approach (narrow the scope, choose a non-destructive path) or get explicit approval. Working
around a hook defeats the safety layer and is a tracked anti-pattern (see `pitfalls.md`).

## Verifying hooks are armed

`vf doctor` reports hook arming alongside engine readiness. After `vf hooks emit --yes`,
re-run `vf doctor` (or `vf hooks status`) and confirm the gate shows armed before you rely
on it.

## Pre-push review evidence

`vf hooks install` installs both pre-commit and pre-push. Pre-push verifies exact current
HEAD with local commit evidence and fails closed with a repair command. It does not call
LLMs, GitHub, or the network. `git push --no-verify` bypasses local feedback only; required
remote `review-thread-gate` remains authority. Existing user-owned hooks are preserved and
need manual integration.

Powered by VibeFlow.
