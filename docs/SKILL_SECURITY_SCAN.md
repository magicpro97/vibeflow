---
title: Skill Security Scan
description: Optional static security scan gate that runs before a local skill is promoted to verified via vf skills verify.
category: explanation
last_updated: 2026-07-22
---

# Skill Security Scan (optional)

Static security scan gate that runs:
1. Before a local skill is promoted to `verified` via `vf skills verify <name>` (issue #632)
2. Before a registry skill is copied into the shared catalog via `vf skills registry install` (issue #651)

Wraps [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) as an **optional**
external tool.

## Why

`src/skills/validator.ts` only checks frontmatter schema (name, description,
angle brackets). It never inspects the `SKILL.md` body or `scripts/` for prompt
injection, exfiltration, or dangerous commands. After the shared catalog
(#631) a skill promoted once is trusted for **every project on the machine**, so
the promotion step is the right place to enforce an automated content review.

## Install

The scan is optional — VibeFlow works without it. To enable:

```bash
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

The AI enrichment prompt (`vf init`) surfaces this exact command so a running
engine can propose the install itself, subject to the existing
"installing dependencies requires approval" rule (`docs/SECURITY_MODEL.md`).

## Behavior

`vf skills verify <name>` runs, before writing `status: verified`:

```text
skillspector scan <dir> --no-llm --format json --baseline <path>
```

- **Absent → passes, flagged `not-scanned`.** An optional dependency never
  hard-blocks (same posture as the ctx7-absent fallback). Promotion proceeds
  and prints a `security scan skipped` notice.
- **`--no-llm` is hard-coded** by the wrapper (`src/skills/security-scan.ts`),
  not merely documented: static analysis only (regex/AST/YARA), no API key, no
  skill content sent over the network. Matches the "no silent network" posture.
- **Gate policy** (`scanBlocksPromotion`):

  | `risk_severity`      | Result                                        |
  | -------------------- | --------------------------------------------- |
  | HIGH / CRITICAL      | **blocked** — exit 1, `rule_id`/`message` shown |
  | MEDIUM               | warns, promotion allowed                      |
  | LOW / NONE / not-scanned | passes                                    |

- **Demotion (`--undo`) is never gated.**

### Registry install gate

`vf skills registry install <reg>/<name> --yes` runs the same scan after
frontmatter/path validation but before catalog copy and lock update:

- **Absent scanner** → install proceeds, `scan_summary: {scanned:false}` recorded
  in lock under the skill's entry.
- **HIGH/CRITICAL** → install **blocked** before catalog copy, lock unchanged.
  Finding `rule_id`/`message` printed.
- **MEDIUM** → warns, install continues.
- **LOW/NONE/not-scanned** → passes.

### Approval-card pre-scan

Agent dispatch may pre-scan an exact verified candidate from a configured pinned registry
cache to show truthful security scan status before approval. This read-only proposal step
does not fetch or install. Scanner absence is shown as `not-scanned`, never as pass;
HIGH/CRITICAL disables approval. An approved candidate is scanned again by the normal
registry install gate. Rejection or scan failure leaves a skill gap and agent dispatch
continues; approval does not create review proof or promote trust.
- Dry-run (`--yes` omitted) prints `security scan: skillspector scan <dir> --no-llm`
  as a planned action.
- Scan summary persisted in `SKILL_REGISTRY.lock.json` as `InstalledSkill.scan_summary`
  only after successful install.

## Baseline workflow

A per-skill baseline lives at `~/.vibeflow/security-baselines/<name>.yaml` —
deliberately **outside** the skill's own tree so a re-import can't wipe it and
re-flag already-triaged findings. SkillSpector reads/writes it via `--baseline`.
Re-scanning an already-baselined skill reports 0 new findings.

## Troubleshooting

**"Cannot verify — security scan risk=HIGH …"** — SkillSpector found a
HIGH/CRITICAL issue. Read the surfaced `rule_id`/`message`, fix the skill (or
triage a false positive into the baseline), then re-run `vf skills verify`.

**Scan never runs** — `skillspector` is not on `PATH`. Install it (above) or
accept the `not-scanned` flag; promotion still works.
