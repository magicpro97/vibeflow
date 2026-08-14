---
title: Documentation
description: VibeFlow documentation index, organized by the Diátaxis framework.
category: reference
last_updated: 2026-06-24
---

# VibeFlow Documentation

Tài liệu được tổ chức theo [Diátaxis](https://diataxis.fr/) — 4 nhóm theo nhu cầu người đọc.

## 📖 Tutorials — học theo bước

- [User Guide](./USER_GUIDE.md) — Verifiable end-to-end walkthrough: install, mental model, web UI, CLI, and troubleshooting.

## 🔧 How-to Guides — giải quyết task

- [Workflow](./WORKFLOW.md) — End-to-end task flow: intake questions, context normalization, and output report.
- [Deployment](./DEPLOYMENT.md) — How to deploy VibeFlow to git and npm with versioning and tarball verification.
- [Self-Hosted Runner](./SELF_HOSTED_RUNNER.md) — Set up and manage a self-hosted GitHub Actions runner on macOS.
- [Hooks and Guardrails](./HOOKS_AND_GUARDRAILS.md) — Configure safety hooks across Claude Code, Codex, Copilot, OpenCode, and Antigravity.

## 📚 Reference — tra cứu

- [Command Reference](./COMMAND_REFERENCE.md) — Complete reference of all shipped `vf` CLI commands and their flags.
- [Engine CLI Compatibility](./ENGINE-COMPAT.md) — Which engine CLI versions the current code was verified against and the invocation/output contract per integration.
- [npm CLI Design](./NPM_CLI_DESIGN.md) — CLI design: startup flow, commands, package layout, and dependency policy.
- [Generated Files](./GENERATED_FILES.md) — All files the orchestrator may generate in a target repository.
- [Coverage](./COVERAGE.md) — CLI flags reference, coverage enforcement rules, and anti-patterns suite.
- [Coordination Template](./coordination-template.md) — Copy-pasteable template for coordinating sub-agents.
- [Master Spec](./MASTER_SPEC.md) — Master specification: design principles, engine support, and naming decisions.

## 💡 Explanation — hiểu khái niệm

- [Architecture](./ARCHITECTURE.md) — High-level architecture: four main layers from npm CLI launcher to tool adapters.
- [Security Model](./SECURITY_MODEL.md) — Safety posture, permission classes, protected paths, secrets handling, and audit log.
- [Agent Orchestration Policy](./AGENT_ORCHESTRATION_POLICY.md) — Confidence thresholds, debate rules, anti-hallucination, and verification policy.
- [Work-Unit Orchestration](./WORK_UNIT_ORCHESTRATION.md) — How tasks are decomposed into scoped, file-backed work units with quality gates.
- [Skill Discovery and Evolution](./SKILL_DISCOVERY_AND_EVOLUTION.md) — External discovery and internal evolution of skills from real project execution.
- [Skill Providers](./SKILL_PROVIDERS.md) — Provider-based discovery layer: Context7, Vercel find-skills, npm, and trust model.
- [Skills System](./SKILLS_SYSTEM.md) — Anthropic-style skill standard: format, metadata, categories, registry priority, and the curator subsystem.
- [Tool Adapters](./TOOL_ADAPTERS.md) — How canonical context is translated into engine-specific files for Claude, Codex, Copilot, OpenCode, and Antigravity.
- [Web UI Design](./WEB_UI_DESIGN.md) — Design specification for the web UI: screens, UX principles, and real-time updates.

---

**Related:** [Diátaxis Framework](https://diataxis.fr/) · [VibeFlow on GitHub](https://github.com/magicpro97/vibeflow)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/README.md)
