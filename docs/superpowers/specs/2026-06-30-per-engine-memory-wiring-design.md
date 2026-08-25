# Per-Engine Memory Wiring — Design

**Date:** 2026-06-30
**Status:** Approved design, pending spec review
**Goal (verbatim):** Khi cài đặt, mặc định không có memory. Lúc on lên thì hỏi dùng cho platform nào, chọn thì cài cho phù hợp. Telemetry off (enterprise). Claude + Codex dùng bảng claude-mem bản cũ — không nhập email/account, cài phát là xong. Nếu chỉ có bản claude-mem mới thì dùng bản mới nhất sao cho lúc cài hỏi ít nhất / tự fill giá trị.

## Summary

Today `vf init` Phase 1.55 (`runMemoryPhase`) prompts once, then wires `claude-mem@latest` **uniformly** for every chosen engine. This redesign makes memory **per-engine**:

- **Default OFF** (already true — `settings.memory: false`).
- **`vf memory on`** asks *which platforms*, then wires each per its own strategy.
- **claude + codex** → `claude-mem` pinned to **`12`** (newest version before the account/email/`better-auth` era). One shared `~/.claude-mem` store. No email, install-and-done.
- **copilot** → **no claude-mem**. Uses copilot's native `/memory` feature; vf writes a one-line instruction telling the agent/user to run `/memory on` (it is interactive-only, not scriptable headless).
- **Fallback** when only a *new* claude-mem is installable: use `latest` with `--provider claude --no-auto-start` plus pre-filled env so the installer asks the fewest possible questions.

## Research findings (claude-mem npm landscape, latest = 13.9.1)

Established by unpacking published tarballs. Recorded in memory `claude-mem-version-landscape`.

| Band | codex-cli / copilot-cli id | 37777 worker server | account/email (`better-auth`) | telemetry |
|------|---------------------------|---------------------|-------------------------------|-----------|
| ≤ 10.6.3 | **No** (claude-code / gemini-cli / opencode only) | No | No | None |
| 10.7.0 | **Yes** (boundary) | **Yes** (same release) | No | None |
| 11.x – 12.x | Yes | Yes (autostart TTY-gated) | **No** | None |
| 13.0.0+ | Yes | Yes | **Yes** (`better-auth` + `pg`) | None |

Decisive facts:

1. **No telemetry beacon exists in ANY version** — no posthog/segment/mixpanel. The enterprise concern ("telemetry off") is satisfied by default; the real enterprise risk is the **account login + cloud** that enters at 13.x. Avoiding 13.x avoids it.
2. **`codex-cli`/`copilot-cli` ids and the 37777 worker landed together in v10.7.0.** No version supports codex without the worker — so a "truly serverless + codex" version does not exist. Resolution: pin **12** (codex works; worker present but autostart is gated on `process.stdin.isTTY`, so a headless spawn never starts it).
3. **Old versions ignore unknown flags** (argv `indexOf` parsing). Passing `--provider`/`--no-auto-start` to ≤12.x is a harmless no-op; `--provider`/`--no-auto-start` only *function* at ≥13.0.0.
4. `--ide` takes a **single** id (`selectedIDEs=[options.ide]`); N engines = N installer invocations over one shared store.
5. `npm view 'claude-mem@12' version` → resolves to newest 12.x (`12.7.5`). Pinning the major `12` tracks 12.x patches without crossing into 13.x.

## Decisions

- **Version pin: single `12`** for both claude and codex (user-approved). Not a split 10/12 — two installer majors over one shared `~/.claude-mem` store risks schema drift.
- Copilot is **not** wired through claude-mem at all. Its memory is the copilot-native `/memory` slash command.

## Architecture

Five seams change. Each unit keeps its current single responsibility.

### 1. `src/settings.ts` — record chosen engines (back-compat safe)

Keep `memory: boolean` **unchanged** (every existing reader/writer/test stays valid). Add an **optional sibling**:

```ts
/** Engines memory was enabled for (claude-mem for claude/codex; native for copilot).
 *  Absent on pre-existing files → treated as "all chosen engines" for back-compat. */
memoryEngines?: Engine[];
```

`coerce()` reads it only when present and well-formed (filter to valid `Engine` ids), mirroring the existing `lspServers` pattern (settings.ts:144). No change to `DEFAULT_SETTINGS` other than leaving `memoryEngines` absent.

### 2. `src/memory.ts` — per-engine strategy split

- **Change default version** `"latest"` → **`"12"`** in `installForEngine` (the `opts.version ?? env ?? "latest"` chain → `?? "12"`). Override order unchanged: `opts.version` → `VF_CLAUDE_MEM_VERSION` → `"12"`.
- **`ENGINE_IDE`** unchanged (claude→claude-code, codex→codex-cli). Drop **copilot** from the claude-mem path entirely (see below).
- New pure helper `buildCopilotMemoryGuide()` returning the markdown block instructing `/memory on`, plus its appender (reuse the idempotent `appendMemoryGuide` mechanism, keyed on a distinct header `## Memory: GitHub Copilot`).
- `ensureInstalledForEngines(engines, opts)` partitions: **copilot** → guidance-only (no install); **claude/codex** → `installForEngine` as today. Returns the same `MemoryWireResult` shape, with copilot reported as wired-via-guidance (not an installer success).
- **Guide-append rule:** the existing `## Memory: claude-mem` search guide (`appendMemoryGuide`, about `claude-mem search`) appends only when a **claude-mem engine** (claude/codex) wired successfully. The `## Memory: GitHub Copilot` guide appends only when **copilot** is selected. A copilot-only run never adds the claude-mem search guide, and a claude/codex-only run never adds the copilot guide.

### 3. `src/commands/init-memory.ts` — platform prompt

`runMemoryPhase` gains a platform-selection step after the yes/no:
- On accept, if >1 engine available, prompt **which platforms** (default = all chosen engines). Injection seam `askEngines?: (engines: Engine[]) => Promise<Engine[]>` so unit tests drive it without a TTY; non-TTY path keeps all engines (back-compat).
- Persist `{ memory: true, memoryEngines: selected }`.
- Wire only `selected`. Copilot in the selection triggers the guidance append; claude/codex trigger installs.

### 4. `vf memory` command + `cli.ts` dispatch

New top-level `case "memory":` in `cli.ts` mapping to a `memory(sub, rest)` handler. It is the **runtime** counterpart to init:
- `vf memory on` → same platform prompt + wiring as Phase 1.55, against the current repo. Writes `memory:true` + `memoryEngines`.
- `vf memory off` → `memory:false` (leaves `memoryEngines` recorded for re-enable).
- `vf memory status` → prints enabled + per-engine wiring (claude-mem@12 for claude/codex; native `/memory` for copilot).

Keep `vf config memory <on|off|status>` working as a thin alias (delegates to the same handler) — it is documented and tested. Help text (`src/commands/help.ts`) gains the `vf memory` entry.

### 5. Copilot guidance content

Appended to `.vibeflow/WORKFLOW_POLICY.md` (same file + idempotent mechanism as the existing claude-mem guide), header `## Memory: GitHub Copilot (VibeFlow)`:

> When running in GitHub Copilot CLI, enable session memory by typing `/memory on` at the start of your session. VibeFlow cannot enable this for you — it is an interactive command. Memory persists across this project's sessions once enabled.

(We do **not** edit inside the `vibeflow:start/end` fences of `.github/copilot-instructions.md` — those are owned by the ai-init instruction writer.)

## Data flow

```
vf init ─► Phase 1.55 runMemoryPhase(base, flags, chosenEngines, inject)
            │  resolveDecision (flag/TTY) ─► false/null ⇒ stop
            │  askEngines(chosenEngines)  ─► selected[]
            │  writeSettings { memory:true, memoryEngines:selected }
            └─ ensureInstalledForEngines(selected)
                 ├─ copilot ─► appendCopilotMemoryGuide(base)   (no install)
                 └─ claude|codex ─► installForEngine(e, {version:"12"})
                                       npx -y claude-mem@12 install --ide <id> \
                                         --provider claude --no-auto-start

vf memory on ─► same wiring against cwd()  (runtime re-entry)
vf memory off ─► writeSettings { memory:false }
vf memory status ─► read settings, print per-engine
```

## Error handling

Unchanged philosophy: memory is enrichment, never a gate. Per-engine best-effort — a failed claude-mem install warns and continues; a missing WORKFLOW_POLICY.md makes the copilot guide a silent no-op (returns false). `vf memory` returns 0 even on partial wiring failure (warns per engine), `2` only on bad usage (`vf memory frobnicate`).

## Testing

- `test/memory.test.ts`: default version is `12`; `--provider claude --no-auto-start` present; copilot routed to guidance (no spawn); claude/codex spawn with correct `--ide`; version override chain (`opts` > env > `12`).
- `test/init-memory.test.ts`: platform prompt drives selection; non-TTY keeps all engines; settings persist `memoryEngines`; copilot-only selection performs no install.
- New `test/commands/memory-command.test.ts` (or extend config tests): `on`/`off`/`status` exit codes + settings writes; `vf config memory` alias parity.
- Back-compat: a settings file with `memory:true` and **no** `memoryEngines` reads cleanly and treats all engines as enabled.
- Conventions: `spawnSync` array args, inject seams (not mock.module), normalize path separators.

## Out of scope (YAGNI)

- No automation of copilot `/memory on` (interactive-only; no headless equivalent exists).
- No per-engine *version* override (single `12` pin; `VF_CLAUDE_MEM_VERSION` still global).
- No migration of existing `~/.claude-mem` stores installed by `latest`.
- No telemetry opt-out flag (no telemetry exists to disable).
