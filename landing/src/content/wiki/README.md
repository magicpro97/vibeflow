---
title: Documentation
description: VibeFlow documentation index, organized by the Diátaxis framework.
category: reference
last_updated: 2026-08-27
---

# VibeFlow Documentation

Tài liệu được tổ chức theo [Diátaxis](https://diataxis.fr/) — 4 nhóm theo nhu cầu người đọc.

## Current product contract

`vf` and `vf ui` open AI-first Home on stable port `7799` (`--port 0` selects a free port): a searchable session rail, central chat, queue-aware composer, participant details, and inline capability actions. Messages sent while an agent is busy enter a durable FIFO queue; ArrowUp edits only the latest queued human message. Typed add-participant actions promote a direct route into coordinate through proposal, review, and commit, and removing the last executor collapses it back to direct. Participants can still be added or removed in chat, and visible messages support ordered quotes and restrained typed reactions. Only a transport-ambiguous request, or a typed admission error with `retryable: true` and `recovery_action: retry`, becomes an explicit retryable row and may replay its exact idempotency-bound request. A non-retryable collision retains its exact payload as **Needs action** for typed recovery or confirmed dismissal; it never auto-resends or overwrites a newer draft. Rejected rows are current Home UI state, not browser-storage persistence.

VibeFlow is the harness rather than another coding engine. The dynamic capability fabric
extends installed CLIs with reviewed skills, MCP servers, tools, hooks, roles, and settings,
using the same typed install, repair, rollback, and removal authority exposed in Home.

Claude, Codex, and OpenCode support exact by-id native resume; OpenCode uses `opencode run --session <validated-ses-id> --format json`. Copilot and Antigravity fail closed instead of claiming exact resume. Exact delivery keeps the selected CLI's own history and sends only new user/peer deltas. When supported native history reconciliation detects compacted context or exact proof is unavailable, VibeFlow revokes exact authority and the structured turn adds a bounded replay of the recipient's last eight public responses, each at most 2 KiB UTF-8, with provenance, digest, and count fields. Private file ranges travel in a separate one-shot structured payload. Owned CLI launches record process identity and release only after exit plus stream drain. Windows uses a Job Object with kernel-contained proof; Linux and macOS use a process group with cooperative-lineage proof. A live `windows-latest` CI smoke job is configured but must turn green before the current change can claim live Windows evidence; local non-Windows runs do not satisfy it.

## 📖 Tutorials — học theo bước

- [User Guide](./USER_GUIDE.md) — Verifiable end-to-end walkthrough: install, AI-first Home, CLI, and troubleshooting.

## 🔧 How-to Guides — giải quyết task

- [Workflow](./WORKFLOW.md) — End-to-end task flow: intake questions, context normalization, conversation runtime, and output report.
- [Deployment](./DEPLOYMENT.md) — How to deploy VibeFlow to git and npm with versioning and tarball verification.
- [Self-Hosted Runner](./SELF_HOSTED_RUNNER.md) — Set up and manage a self-hosted GitHub Actions runner on macOS.
- [Hooks and Guardrails](./HOOKS_AND_GUARDRAILS.md) — Configure safety hooks across Claude Code, Codex, Copilot, OpenCode, and Antigravity.

## 📚 Reference — tra cứu

- [Command Reference](./COMMAND_REFERENCE.md) — Complete reference of all shipped `vf` CLI commands, conversation semantics, and flags.
- [Engine CLI Compatibility](./ENGINE-COMPAT.md) — Which engine CLI versions the current code was verified against and the invocation/output contract per integration.
- [npm CLI Design](./NPM_CLI_DESIGN.md) — CLI design: startup flow, commands, package layout, and dependency policy.
- [Generated Files](./GENERATED_FILES.md) — All files the orchestrator may generate in a target repository.
- [Coverage](./COVERAGE.md) — CLI flags reference, coverage enforcement rules, and anti-patterns suite.
- [Coordination Template](./coordination-template.md) — Copy-pasteable template for coordinating sub-agents.
- [Master Spec](./MASTER_SPEC.md) — Master specification: design principles, engine support, and naming decisions.

## 💡 Explanation — hiểu khái niệm

- [Architecture](./ARCHITECTURE.md) — High-level architecture: AI-first Home, structured turn delivery, owned CLI execution, and typed capability fabric.
- [Security Model](./SECURITY_MODEL.md) — Safety posture, capability trust boundaries, private turn context, owned-process proof, secrets handling, and audit log.
- [Agent Orchestration Policy](./AGENT_ORCHESTRATION_POLICY.md) — Confidence thresholds, debate rules, anti-hallucination, and verification policy.
- [Work-Unit Orchestration](./WORK_UNIT_ORCHESTRATION.md) — How tasks are decomposed into scoped, file-backed work units with quality gates.
- [Skill Discovery and Evolution](./SKILL_DISCOVERY_AND_EVOLUTION.md) — External discovery and internal evolution of skills from real project execution.
- [Skill Providers](./SKILL_PROVIDERS.md) — Provider-based discovery layer: Context7, Vercel find-skills, npm, and trust model.
- [Skills System](./SKILLS_SYSTEM.md) — Anthropic-style skill standard: format, metadata, categories, registry priority, and the curator subsystem.
- [Tool Adapters](./TOOL_ADAPTERS.md) — How canonical context is translated into engine-specific files for Claude, Codex, Copilot, OpenCode, and Antigravity.
- [Web UI Design](./WEB_UI_DESIGN.md) — Design specification for AI-first Home, its queue/social interactions, inline actions, and real-time states.

---

**Related:** [Diátaxis Framework](https://diataxis.fr/) · [VibeFlow on GitHub](https://github.com/magicpro97/vibeflow)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/README.md)
