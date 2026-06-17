# Security Model

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
