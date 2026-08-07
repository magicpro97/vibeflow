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

## Web UI interactive approval

When running via web UI (vf ui + vf orchestrate from browser):
- require_approval → HookApprovalModal appears in browser
- Engine blocked at vf hook subprocess — waits indefinitely for user click
- UI reconnect: GET /api/hook/pending restores pending modals

## Auto-pilot modes (vf orchestrate flags)

- (default): ask user via modal
- --auto-pilot: LLM evaluates false positive independently (fresh engine call)
  - confidence >= 0.9 AND is_false_positive: true → allow
  - else → block (fail-safe)
  - Model: same engine being dispatched, independent context
- --yolo / --allow-all: blind allow-all (use only for throwaway experiments)

## Audit log

Location: .vibeflow/knowledge/hook-audit.log
Format: append-only JSONL
Fields: mode, decision, input {tool,command,files}, result {risk,reasons}, aiDecision?, at (ISO timestamp)

## Agent guidance

- User present at computer → default mode (modal)
- Automated/unattended run, trusted repo → --auto-pilot
- Throwaway branch, low-risk experiments → --yolo
- NEVER use --yolo in production or on repos with sensitive data

## Verifiable evidence format (ADR-004)

When recording evidence with `vf units evidence <name> --add`, use machine-verifiable format:
- `bun test 2>&1 | tail -3 → "12 pass, 0 fail"` ✓
- `src/gates.ts:47 — added isVerifiableEvidence()` ✓
- `commit abc1234 — feat: add gate` ✓
- `"tests pass"` ✗ — free text, triggers unverifiable-evidence warning

`vf verify` warns on free-text evidence (phase 1). Will fail in phase 2.
