---
title: Security Model
description: Security model — default safety posture, permission classes, protected paths, secrets handling, and audit log.
category: explanation
last_updated: 2026-06-24
---

# Security Model

## Contents

- [Core Principle](#core-principle)
- [Default Safety Posture](#default-safety-posture)
- [Permission Classes](#permission-classes)
- [Approval Required Actions](#approval-required-actions)
- [Protected Paths](#protected-paths)
- [External Skill Trust Model](#external-skill-trust-model)
- [Shared Catalog Trust Boundary](#shared-catalog-trust-boundary)
- [External Skill Security Scan](#external-skill-security-scan-optional)
- [npm Package Risk Model](#npm-package-risk-model)
- [Hook Enforcement](#hook-enforcement)
- [Secrets Handling](#secrets-handling)
- [Local Web Server](#local-web-server)
- [Audit Log](#audit-log)

## Core principle

The tool runs locally and may access source code, files, shell commands, AI coding CLIs, and external connectors. Therefore, it must default to least privilege.

## Default safety posture

```text
- local-first
- read-only until user approves writes
- no public network exposure
- no silent package installation
- no source upload by default
- no auto-push
- no auto-merge
- no auto-deploy
```

## Permission classes

```text
read_workspace
write_workspace
read_external_source
network_access
shell_execute
install_dependency
modify_ci_cd
modify_auth
modify_security
push_code
open_pr
deploy
```

## Approval required actions

Approval is required before:

```text
- installing dependencies
- running unknown scripts
- modifying CI/CD
- changing authentication or authorization
- changing payment, billing, or security logic
- deleting files
- pushing commits
- opening pull requests
- deploying
- enabling external skills
- granting network/filesystem/credential access
```

## Protected paths

Default protected paths:

```text
.env
.env.*
**/secrets/**
**/credentials/**
.github/workflows/**
infra/**
terraform/**
k8s/**
auth/**
payments/**
billing/**
```

## External skill trust model

External skills are untrusted until verified.

```text
External skill → draft
Reviewed skill → experimental
Validated skill → verified
Old or unsafe skill → deprecated
```

Skills requiring shell, network, write access, or credentials must be explicitly approved.

### Dispatch-time skill acquisition

Before agent dispatch, VibeFlow searches only configured pinned registry caches for an
exact verified candidate. Building the approval card is read-only and performs no network
or catalog/lock mutation. The card shows bounded identity and security scan status, never
cache paths or registry credentials. `--yes`, an interactive TTY answer, or a Web UI card
may approve installation; non-TTY execution without consent skips acquisition without
hanging. HIGH/CRITICAL findings remain blocked, and approved candidates pass through the
authoritative install-time scan again. Approval is not review proof and does not promote
trust. Rejection or failure preserves a skill gap and agent dispatch continues.

## Vendor registry cache (read-only)

Installed vendor registries live at `~/.vibeflow/skill-registries/<url-hash>/` and are
identity-pinned by a detached commit OID plus a deterministic SHA-256 bundle hash over
all regular files in the installed skill directory. The bundle hash is computed during
`vf skills registry install` and stored in the lock file.

The vendor registry cache is **read-only for agent file writes**. VibeFlow's PreToolUse
hooks block `Write`/`Edit`/`patch` events targeting paths inside this cache. Agent
writes through the cache are blocked with a `critical` risk verdict.

### Escape hatch

To update or reinstall a registry skill:
```
vf skills registry update <id> --yes
vf skills registry install <id>/<skill> --on-collision=replace --yes
```

### verify-sync bundle hash check

`vf skills verify-sync --from-registry` compares each installed skill's bundle hash
against the lock entry. On mismatch, it reports an error stating the skill was modified
and prints the exact reinstall command. No automatic overwrite or restore is performed
in V1 — explicit reinstall is the only recovery path.

### V1 limitation: no shell-command mutation detection

Detecting shell commands that write into the vendor cache (e.g. `cp`, `echo >`, `tee`)
is deliberately excluded in V1. Shell-command mutation detection is bypass- and
false-positive-prone. Existing workspace/outside warnings remain unchanged. This
boundary is documented in `src/hooks/risk.ts`.

<!-- registry-release:start -->
### Registry release approval boundary

`vf skills registry release approve <proposal-id> --yes` checks the active identity and canonical
repository/base branch for each allowlisted target before creating an isolated checkout. It rejects
target pin drift, enforces a lock-only diff, runs `vf verify` before commit, push, or PR creation,
and emits sanitized evidence. Per-target failures continue; partial failure exits 1.
<!-- registry-release:end -->

## Shared catalog trust boundary

The shared skill catalog at `~/.vibeflow/skills/` is machine-wide: a skill promoted
in one project becomes available to every project on the same machine. This is a
deliberate tradeoff — re-discovery per project is eliminated, but trust granted in
project A extends to project B without a second review.

Mitigation: the security-scan gate (see below) blocks a skill with HIGH/CRITICAL
findings from being promoted to `verified`, so an untrusted skill (Context7
unauthenticated fallback, find-skills HTTP, community import) cannot silently become
trusted machine-wide. The gate is optional (degrades gracefully when the scanner is
absent), so when it is not installed, only manually-reviewed skills should be
promoted to `verified`.

## Curator shared synchronization

Curator scans are local-first. `vf skills curator scan` and
`vf skills curator scan --scope=local` write only an ignored local findings report;
they do not run Git, contact a remote, create issues, or publish findings.

`vf skills curator scan --scope=repo` requires a clean checkout and anchors the
scan to immutable `HEAD`. It still does not contact a remote. Add `--sync` to
preview the only possible shared operation. The preview names remote `origin`,
ref `refs/notes/vibeflow-curator`, sent fields, excluded fields, visibility risk,
and the exact `--scope=repo --sync --yes` confirmation command.

Only `--scope=repo --sync --yes` fetches and pushes that exact Git notes ref.
The note stores a commit OID, finding type, and SHA-256 fingerprint. It never
stores finding detail, finding keys, paths, source content, URLs, usernames, or
credentials. Remote readers may still infer that a matching finding existed, so
do not enable sync where that fact is sensitive.

Git notes are duplicate-reporting hints, not a security attestation. A collaborator
with Git write access can add a marker. Markers never approve a change, resolve a
finding, or bypass a security gate. GitHub Issues may project human-readable
reports later but are not curator deduplication authority.

## External skill security scan (optional)

`vf skills verify <name>` promotes a local skill to `verified`. Before the status is
written, VibeFlow runs an optional static scan via NVIDIA SkillSpector
(https://github.com/NVIDIA/skillspector) over the skill directory:

```text
skillspector scan <dir> --no-llm --format json --baseline <path>
```

- **Optional dependency.** If `skillspector` is not on `PATH`, promotion still
  proceeds and is flagged `not-scanned` — the gate never hard-blocks on a missing
  optional tool (same posture as the ctx7-absent fallback). Install to enable:
  `uv tool install git+https://github.com/NVIDIA/skillspector.git`.
- **Static only, no egress.** `--no-llm` is hard-coded by the wrapper (not merely
  documented), so no skill content is ever sent over the network and no API key is
  required — consistent with the "no silent network" posture above.
- **Gate policy.** HIGH/CRITICAL `risk_severity` blocks promotion (exit 1, findings'
  `rule_id`/`message` surfaced); MEDIUM warns but allows; LOW/NONE/not-scanned pass.
- **Baseline suppression.** A per-skill baseline is stored at
  `~/.vibeflow/security-baselines/<name>.yaml` — outside the skill's own tree, so a
  re-import cannot wipe it and re-flag already-triaged findings.

This gate closes the trust boundary opened by the shared catalog: a skill discovered
once and promoted becomes trusted for every project on the machine, so the promotion
step is the right place to enforce automated review.

## npm package risk model

npm packages are external executable dependencies, not trusted skills.

Safety checks:

```text
- verify package name
- inspect repository and maintainer
- pin version
- prefer --ignore-scripts
- run in sandbox when possible
- avoid packages requesting credentials
- log install reason
```

## Hook enforcement

Hooks must block only clearly unsafe actions. When uncertain, they should warn or require approval.

```text
allow → normal action
warn → low/medium risk
require_approval → elevated risk
block → clearly unsafe or irreversible
```

### Codex hook config is global, not per-repo

Codex's native hook configuration is owned by Codex at `~/.codex/hooks.json`, not by an
individual repository. `vf hooks emit --yes` merges VibeFlow's `PreToolUse` and `PostToolUse`
entries there and enables `[features] codex_hooks = true` in `~/.codex/config.toml`. This
affects every repository that uses Codex on that machine; VibeFlow warns before the write.

Codex's native veto covers Bash/shell tool calls only. Edit, Write, apply_patch, and MCP calls
are not intercepted by that hook, so VibeFlow retains its apply-time diff gate for Codex.

To revert, remove VibeFlow's `PreToolUse` and `PostToolUse` entries from
`~/.codex/hooks.json`, then remove or set `codex_hooks = false` under `[features]` in
`~/.codex/config.toml`.

### Review-thread gate (CI, read-only)

`.github/workflows/review-thread-gate.yml` is a read-only GitHub Actions gate that
blocks a merge while any review thread on the current PR head is unresolved. It honors
the least-privilege and no-code-execution posture:

- Job permissions are exactly `pull-requests: read`; the top-level `permissions` is
  `{}`. The only token used is `GITHUB_TOKEN` (no PAT, no `pull_request_target`).
- It never runs `actions/checkout` and never executes PR code. It queries GitHub GraphQL
  for the PR's live `headRefOid` and paginated `reviewThreads`, and compares
  `headRefOid` against the event `pull_request.head.sha` so a stale-queued success after
  a force-push fails closed.
- Never printed: the token, full event payload, comment body, or GraphQL request
  headers. Unresolved current threads are reported as `path:line — @author — url`.

### Pre-push review-evidence gate (local only)

The repository pre-push hook is deterministic local fast feedback. It binds verification
to the pushed current `HEAD`, reads only local commit evidence, and fails closed on missing,
stale, malformed, unreadable, or failed applicable evidence. It performs no network, LLM,
GitHub API, or Copilot call and never uploads/commits/attests local evidence. User-owned
hooks are preserved. `git push --no-verify` bypasses this local gate by Git design; the
separate required remote `review-thread-gate` remains authoritative.

## Secrets handling

Agents and hooks must not print or store secrets.

Rules:

```text
- never include tokens in prompts
- redact environment values
- block direct reads of .env unless explicitly approved
- do not store credentials in SKILL.md
- do not send secrets to external docs/skill services
```

## Spawned engine env scrub

Every engine subprocess vf launches (`claude`, `codex`, `copilot`, …) used to inherit
the **entire** host environment. An agent run to fix a CSS bug would receive
`AWS_SECRET_ACCESS_KEY`, `STRIPE_SECRET_KEY`, database URLs, and any other secret in the
operator's shell. VibeFlow now **filters the env** at both spawn sites
(`src/dispatch/spawners.ts`, `src/commands/coord.ts`) via a single `filterEnv()` helper —
no Docker, no new dependency.

**Default policy (conservative — drop known secrets, pass the rest):**

```text
ALWAYS KEEP (never dropped, even in strict mode):
  PATH HOME SHELL USER LOGNAME LANG TERM TMPDIR TMP TEMP PWD, LC_* prefix,
  vf's own VF_* / VIBEFLOW_* (so the VF_DENY_TOOLS hint survives),
  engine auth vars: ANTHROPIC_API_KEY OPENAI_API_KEY GH_TOKEN GITHUB_TOKEN GEMINI_API_KEY,
  (Windows also: SYSTEMROOT PATHEXT COMSPEC APPDATA LOCALAPPDATA USERPROFILE)

DEFAULT DENY (globs; ALWAYS_KEEP overrides any match):
  AWS_* AZURE_* GCP_* GOOGLE_APPLICATION_CREDENTIALS STRIPE_* TWILIO_* SLACK_*
  SENTRY_* NPM_TOKEN DOCKER_* DATABASE_URL
  *_SECRET *_SECRET_KEY *_PRIVATE_KEY *_PASSWORD *_TOKEN *_API_KEY
```

Note `*_TOKEN` / `*_API_KEY` are denied by default (secret-shaped) — the specific engine
auth vars above are in ALWAYS_KEEP, so they ride through while every other token/key is dropped.

**Configuring the policy** (per-repo, `.vibeflow/SETTINGS.json`, absent = default):

```bash
vf config env-policy status          # print the effective policy + what WOULD be dropped now
vf config env-policy deny 'MY_APP_*' # add a glob to drop on top of the built-in denylist
vf config env-policy allow 'MY_*'    # add a glob; a non-empty allow[] = STRICT pass-only mode
vf config env-policy reset           # clear config, back to the conservative default
```

In **strict mode** (any `allow` glob set) ONLY `ALWAYS_KEEP` + `allow`-matching vars pass;
everything else is dropped. On **Windows** name matching is case-insensitive (`Path` == `PATH`).

> **Trusted namespace caveat:** `VF_*` / `VIBEFLOW_*` are treated as vf's own signalling
> namespace and are kept unconditionally (so `VF_DENY_TOOLS` survives). Do not store an
> unrelated secret under a `VF_`/`VIBEFLOW_` name — the scrub will not drop it.

**Audit:** dropped variable NAMES (never values) are logged once per dispatch (the coord path
emits `{ kind: "coord-env-scrub", dropped }` to `vf logs`), matching the tool deny-list audit pattern.

The read-only policy summary is surfaced in the web UI Settings panel ("Env scrub").

## Verify Docker sandbox

`vf verify --sandbox docker` is an opt-in boundary for synchronous CLI toolchain and waiver
gates. Host execution remains default. Sandbox preflight requires a running Docker daemon,
a locally available digest-pinned image, one supported lockfile, a dependency volume whose
`vibeflow.lock-sha256` label exactly matches that lockfile, and a non-root host UID/GID.
Failure aborts; vf never silently retries on the host, pulls/builds an image, or installs
dependencies.

The container receives `--network none`, no `-e`/`--env-file`, no Docker socket or home
mount, `--cap-drop ALL`, `no-new-privileges`, PID/CPU/memory limits, and an explicit host
UID/GID. Exactly two mounts are supplied: a writable disposable source copy at `/w` and the
named dependency volume read-only at `/w/node_modules`. The active worktree and its `.git` metadata are not
mounted. The copy lives temporarily under `.vibeflow/sandbox-*` so Docker Desktop/Colima can
bind-mount it on macOS. A bounded gate timeout triggers best-effort `docker rm -f`; the copy
is removed after success or failure.

Residual trust remains: the operator-supplied image, dependency volume, Docker daemon, and
container-runtime isolation. Code can mutate its disposable copy. v1 does not sandbox the
web verify API, orchestrate per-unit gates, or arbitrary acceptance commands.

## Local web server

The `vf ui` server is the interactive console (intake → generate → dispatch). Because it now
exposes write actions, it is hardened as follows (implemented in `src/server.ts`):

```text
- binds 127.0.0.1 only — never 0.0.0.0, never a public interface
- GET /, /state, /events are read-only (dashboard + live ledger)
- writes only via POST /api/init, /api/dispatch, /api/detect, /api/units, and POST/DELETE
  /api/upload (binary attachments); GET /, /state, /events, /api/attachments are read-only
- per-process CSRF token: embedded in the page, required in the x-vibeflow-token header
- exact-match Host allowlist (127.0.0.1 / localhost / ::1) — mitigates DNS rebinding
- Origin/Referer, when present, must be loopback
- JSON body capped (64 KB); uploads streamed to disk and capped (50 MB/file), partial files
  removed on overflow; malformed or oversized bodies are rejected
- attachment filenames are reduced to a single safe path segment (basename; no separators,
  traversal, control/null bytes, dotfiles, or over-long names) and confined to
  <repo>/.vibeflow/attachments/ — verified by a resolve()/startsWith() check
- no remote scripts: the page ships zero third-party JS, so a compromised CDN cannot
  reach the same-origin write API (Content-Security-Policy restricts to 'self')
- user input is never used as a filesystem path; canonical writes target fixed .vibeflow/*
  paths and engine names validated against the ENGINES allowlist. The repo path the user
  picks is resolved to an existing directory; writes to it require the per-process token
- web-initiated init never shells out to $VIBEFLOW_AI (useAi:false); only the CLI may
```

## Audit log

Every run should log:

```text
- user approvals
- commands run
- files read/written
- skills used
- external sources accessed
- hook decisions
- engine selected
- final verification result
```

Audit logs should avoid storing secrets or full sensitive file contents.

---

**Related:** [Architecture](./ARCHITECTURE.md) · [Hooks and Guardrails](./HOOKS_AND_GUARDRAILS.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/SECURITY_MODEL.md)
