---
title: Engine CLI Compatibility
description: Which engine CLI versions the current code was verified against, and the invocation/output contract each integration assumes.
category: reference
last_updated: 2026-08-28
---

# Engine CLI Compatibility

VibeFlow dispatches work to external AI coding CLIs (claude, codex, copilot,
opencode, antigravity) and drives auxiliary tools (bun). Those CLIs change their
flags and output shapes without notice — a silent breaking change there becomes a silent breaking
change in VibeFlow. This file records **which CLI versions the current code was
verified against**, and **what shape each integration assumes**, so that when a
CLI is bumped you know exactly what to re-check.

> When you bump any engine CLI, re-run the verification steps below and update the
> "Verified" version + date. If a shape changed, fix the parser/invocation AND the
> fixture in the same PR.

## Verified versions

| Tool     | Verified version | Date       | Install source                    |
| -------- | ---------------- | ---------- | --------------------------------- |
| claude   | 2.1.207          | 2026-07-12 | npm `@anthropic-ai/claude-code`   |
| codex    | 0.144.1          | 2026-07-12 | brew `codex`                      |
| copilot  | 1.0.69           | 2026-07-12 | brew `copilot` (GitHub Copilot CLI) |
| opencode | 1.18.22          | 2026-08-27 | brew `anomalyco/tap/opencode`     |
| agy      | 1.1.4            | 2026-07-19 | `%LOCALAPPDATA%\\agy\\bin\\agy.exe` |
| bun      | 1.4.0            | 2026-08-26 | (runtime)                         |

## Per-engine integration contract

Source of truth: `src/dispatch.ts` (`engineCommand`) and `src/dispatch/prompt.ts`
(`parseEngineSummary`, `parseSessionId`).

### claude

- **Fresh invocation:** `claude -p --output-format json`
- **Resume:** `claude -p -r <session_id> --output-format json` (`-r` only works with `-p`/print)
- **Skip perms:** append `--dangerously-skip-permissions`
- **Output shape:** a single JSON envelope `{ "type": "result", "session_id": "...", "result": "<text>", "num_turns": N, "subtype": "success" }`. The VibeFlow summary is a fenced ```json block inside `.result`.
- **Session id:** `.session_id` on the `type: "result"` envelope (last JSON object → scanned in reverse).

### codex

- **Fresh invocation:** `codex exec --json -` (prompt on stdin via `-`)
- **Resume:** `codex exec resume <thread_id> --json -`
- **Output shape:** JSONL — one JSON **event** per line. Key events:
  - `{"type":"thread.started","thread_id":"<uuid>"}` — **first** line, carries the session id.
  - `{"type":"item.completed","item":{"type":"agent_message","text":"```json\n{...}\n```"}}` — the model's answer; the VibeFlow summary is the fenced block inside `item.text`.
  - `{"type":"item.completed","item":{"type":"reasoning","text":"..."}}` — ⚠️ **TRAP:** the reasoning event often echoes the same json. The parser MUST target `item.type === "agent_message"` specifically and never `reasoning`.
  - `{"type":"turn.completed","usage":{...}}` — last line; NOT a summary.
- **Session id:** `thread_id` on the `thread.started` event (first JSON object → scanned forward).
- **Why `--json` matters:** without it, `codex exec -` emits plain text and `parseEngineSummary` returns garbage (verified: it picked up the `turn.completed` event). The JSONL path in `parseEngineSummary` exists solely to dig the summary out of `agent_message` and bail (return undefined) if a codex stream had no `agent_message`, so the reasoning echo is never mistaken for the answer.
- **Fixture:** `test/fixtures/codex-json-stream.txt` — a real 6-line `--json` stream containing BOTH an `agent_message` and a `reasoning` echo, so the reasoning-trap regression is covered.

### copilot

- **Fresh invocation:** `copilot -p <prompt> --allow-all` (prompt is an argv value, not stdin; argv is ~32K-capped so large prompts are written to `.vibeflow/dispatch/<unit>.md` and a short pointer `Read <abs path> and follow it` is passed instead)
- **Resume:** exact by-id resume is not supported by VibeFlow. Latest-session shortcuts are not accepted as exact authority; a turn without a valid exact binding uses bounded structured own-history replay instead of silently omitting context.
- **Version guard:** the CLI has a history of silent breaking auto-updates (github/copilot-cli#1606 removed `--headless --stdio`); when `copilot --version` can't be read, dispatch proceeds with a warning.

### antigravity

- **Fresh invocation:** `agy -p <prompt>`; prompt is one argv value and output is plain text. VibeFlow parses a fenced JSON block when present; other prose has no structured summary.
- **Prompt limit:** VibeFlow rejects a UTF-8 prompt at or above 30 KiB before spawn. `agy` has no supported prompt-file/stdin replacement for print mode.
- **Resume:** unavailable in VibeFlow's exact-session authority. The adapter has no primary evidence for a safely captured and validated exact binding, so an exact claim fails closed. Fresh turn delivery uses bounded structured own-history replay; VibeFlow does not use latest-workspace shortcuts as exact authority.
- **Workspace files:** `AGENTS.md`, `.agents/agents/<name>/agent.md`, `.agents/skills/`, `.agents/mcp_config.json`.
- **Hooks (unproven):** `.agents/hooks.json` uses `PreToolUse` / `PostToolUse` in the emitted config, but the `agy 1.1.4` PreToolUse deny canary did not fire in headless test. VibeFlow classifies antigravity as **post-hoc-only** until native enforcement is proven. Hook config generation is preserved (forward-compatible if agy later honors it), but no native guardrail is advertised.
- **Auth / reliability:** Google OAuth/keyring is required; `vf doctor --probe` is the live readiness check. Authenticated `agy 1.1.4` fresh print and workspace-agent canaries passed on 2026-07-19. No safe exact-session binding is evidenced.

### opencode

- **Fresh work-unit invocation:** `opencode run --format json --auto` (prompt on stdin; no positional prompt sentinel)
- **Exact conversation resume:** `opencode run --session <validated ses_...> --format json` with the prompt on stdin. The opaque id must pass VibeFlow's native-session validator; latest-session `--continue` is not exact authority.
- **Auto perms:** work-unit dispatch may use `--auto`; the conversation session adapter removes it and rejects tool/sandbox claims it cannot enforce.
- **Output shape:** JSONL — one JSON event per line. Key events:
  - `{"type":"step_start","sessionID":"ses_..."}` — carries the session id.
  - `{"type":"text","part":{"type":"text","text":"..."}}` — the model's text response; VibeFlow summary is the fenced json block inside `text`.
  - `{"type":"step_finish","part":{"tokens":{...}}}` — last line, carries token usage.
- **Session id:** `sessionID` on the first `step_start` event (forward scan).
- **Fixture:** N/A (opencode output format is stable, no known traps).

## Conversation turn delivery

The conversation runtime prefixes every delivered turn with `VF-TURN/1` and materializes a
canonical JSON envelope for the selected participant. When exact resume authority is proven for
the same participant and interaction cursor, the runtime uses `delivery_mode: "exact-delta"` and
only re-sends newly applicable public user messages plus concise peer deltas. When that proof is
missing or stale, it falls back to `delivery_mode: "full-history"` and re-sends the full public
context. Exact by-id authority is limited to Claude, Codex, and OpenCode. Copilot and
Antigravity never silently claim exact resume. Native session histories remain inside the
selected CLI; VibeFlow only changes which public material is re-delivered.

Private file-range context is staged separately from the public turn envelope and is cleared after
use so the next turn does not inherit it accidentally. Its wire form is canonical JSON prefixed by
`VF-PRIVATE-FILE-RANGES/1`; it is never folded into public trace or browser persistence.

For an exact native resume, the recipient's own prior response is not repeated: it already
exists in that CLI's session. The envelope contains only newly applicable user messages and
peer-agent responses/reactions. Without valid exact authority, a full turn also includes a
bounded replay of the recipient's last eight public responses. Each summary is at most 2 KiB
UTF-8 and carries source digest, provenance, source/replayed counts, and truncation counts.
The turn may also include the content-addressed `VF-HANDOFF/1` shared handoff.

Prompt transport is not conversation memory. Claude, Codex, and OpenCode read stdin;
Copilot and Antigravity use native prompt argv. Copilot's large work-unit fallback writes
`.vibeflow/dispatch/<unit>.md` and passes a short absolute read pointer. Antigravity instead
rejects UTF-8 prompts at or above 30 KiB because its print mode has no supported file/stdin
replacement.

## Owned process portability

Every canonical owned launch persists supervisor and CLI PIDs, host, operation/attempt, and
exact process-start identity. Terminal release waits for exit/quiescence plus the
`streams-drained` stdout/stderr barrier.

| Platform | Scope | Proof strength | Process identity / containment |
|----------|-------|----------------|--------------------------------|
| Windows | `windows-job` | `kernel-contained` | Kill-on-close Job Object established before receipt/spawn; PowerShell/CIM creation ticks; no `/bin/ps`. |
| Linux | `posix-process-group` | `cooperative-lineage` | Isolated process group, boot id, and `/proc` start ticks. |
| macOS | `posix-process-group` | `cooperative-lineage` | Isolated process group and exact Darwin `libproc` seconds/microseconds. |

The POSIX proof is intentionally weaker because descendants can leave the process group.
`vf doctor --fix` repairs only exact proved orphans; live or identity-unprovable owners fail
closed. Injected platform tests cover the Windows Job Object and identity contracts. Live Windows
evidence is accepted only from a green, exact-SHA `windows-latest` smoke job; local macOS/Linux
evidence is not a Windows canary.

Windows portability is intentionally narrow at the persistence boundary. Owned-process records
use a stable deny-delete `CreateFileW` handle with `LockFileEx`, exact owner metadata, local-drive
path authority, and write-through atomic replacement through `MoveFileExW`. General POSIX
durability primitives remain unsupported on Win32 and continue to fail closed; this port does not
claim that the rest of the durability layer has native Windows semantics.

## Crash-resume (`vf orchestrate --resume`)

- Capture: dispatch persists a validated engine session id into `DispatchMarker.engineSessionId` for Claude (`session_id`), Codex (`thread_id`), and OpenCode (`sessionID`). Copilot and Antigravity persist no exact binding.
- Resume policy: `src/orchestrator/resume-policy.ts` `resolveResumeId` resumes only when `--resume` is set, the marker is non-terminal (`running`/`blocked`/`failed`, never `done`/`pending`), and it carries a valid id for an exact-resume engine. Unsupported engines never claim exact continuation.
- Conversation delivery separately guarantees bounded own-history replay whenever exact native proof is absent.

## How to re-verify after a CLI bump

1. **claude** — confirm resume flag + envelope shape:
   ```bash
   claude --help | grep -E "resume|output-format"
   echo "reply with a fenced json: {\"confidence\":1.0}" | claude -p --output-format json | tail -1
   ```
   Check the envelope still has `type: "result"` + `session_id`, and the summary lives in `.result`.

2. **codex** — confirm JSONL event names (the critical one):
   ```bash
   echo 'Reply with EXACTLY a fenced json block: {"confidence":1.0,"files_changed":[]}' \
     | codex exec --json --skip-git-repo-check -
   ```
   Confirm `thread.started`/`thread_id` (first line) and `item.completed`/`item.type=="agent_message"` still hold. If the event names changed, update `parseSessionId` + `parseEngineSummary` + `test/fixtures/codex-json-stream.txt` together. Also confirm `codex exec resume --help` still accepts a `[SESSION_ID]` positional and `--json`.

3. **copilot** — confirm `-p` + `--allow-all` still exist; do not adopt a resume path without a captured by-id contract and tests:
   ```bash
   copilot --help | grep -E "allow-all|continue|resume|-p"
   ```

4. **opencode** — confirm `--format json` plus exact `--session <ses_...>` work:
   ```bash
   echo 'Reply with exactly READY' | opencode run --format json
   ```
   Capture the first event's `sessionID`, validate its `ses_...` shape, then pipe a second prompt to `opencode run --session <captured-id> --format json`. Confirm the response text appears in a `type: "text"` event with `part.text` and belongs to that exact session.

5. **agy** — run authenticated scratch-directory canaries for fresh `agy -p`, `--agent <name>` with `.agents/agents/<name>/agent.md`, and a `PreToolUse` deny hook. Do not advertise exact resume unless a safe captured by-id binding and primary evidence are added together. Confirm plain output, native deny behavior, and no scratch files remain.

6. Run `bun run check`. The dispatch tests + codex fixture assert the shapes above; a red suite after a bump means the CLI changed its contract.

## Related surfaces that can drift with a CLI change

- **Hooks:** `src/commands/hooks.ts` — engine invocation is wrapped by dispatch, but permission/stall behavior depends on the engine's flags.
- **Skills / rules:** `.agents/skills/vf/` — the vf skill documents engine usage for the agent surface; keep it in sync with the flags here.
- **Schema:** `DispatchMarker` (`src/orchestrator/marker.ts`) — `engineSessionId` is the persisted contract for resume.
