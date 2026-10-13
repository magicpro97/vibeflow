# Creating GitHub issues in the VibeFlow user-story standard

How to author issues on `magicpro97/vibeflow` the way the user (magicpro97)
expects. Verified against canonical issues #347–360 (all labelled `user-story`).

## HARD RULE — docs/wiki + UI, every issue, no exception

The user's standing instruction: **"các issues luôn luôn cập nhật docs/wiki và
ui."** Every issue MUST carry acceptance criteria to:
- update the relevant `docs/*.md`, AND mirror to `landing/src/content/wiki/*.md`
- update the web UI (`src/ui/` Vue) when the change has a user-facing surface
  (new command / flag / gate / status → must show in the UI)
- if genuinely not touching docs/UI, the PR must state `N/A — <reason>` rather
  than silently skip.

Bake this into BOTH the Acceptance Criteria and the Definition of Done of every
issue you draft. Don't wait to be reminded.

## docs ↔ wiki mirror convention (verified)

- `docs/*.md` (21 files) are mirrored 1:1 to `landing/src/content/wiki/*.md`
  (21 files). Manual sync — there is NO sync script in `scripts/`.
- The wiki copy = the docs copy + an inline diagram image line, e.g.
  `![...](/diagrams/architecture.svg)` inserted after the H1. Otherwise byte-identical.
- So "update docs" always means "edit `docs/X.md` AND `landing/src/content/wiki/X.md`."

## Issue body template

Title: short imperative problem statement (NOT "As a…"). e.g.
`Reviewer is a rubber-stamp: never reads the diff`.

Body:

```markdown
**As a** <role>,
**I want** <capability>,
**so that** <benefit>.

### Problem
<what's wrong / missing today, with file paths or command evidence>

### Acceptance Criteria
- [ ] <verifiable outcome 1>
- [ ] <verifiable outcome 2>
- [ ] <docs/wiki + UI update — see block below>

### Docs/Wiki + UI (bắt buộc mọi issue)
- [ ] Cập nhật **docs/** liên quan (`docs/*.md`) + mirror **wiki** (`landing/src/content/wiki/*.md`)
- [ ] Cập nhật **UI** (`src/ui/` Vue) nếu thay đổi có mặt phẳng người dùng
- [ ] Nếu KHÔNG đụng docs/UI: ghi rõ lý do "N/A — không có mặt phẳng user/doc" trong PR

---
### Definition of Done (bắt buộc, không ngoại lệ)
- [ ] Quy trình tuần tự: **Plan → Detail Design → Code → Test → Review → PR** (mỗi bước có artifact/commit)
- [ ] **Test coverage 100%** cho code thay đổi (line + branch) — không waiver, không ngụy biện
- [ ] CI xanh toàn bộ (typecheck, lint, test, coverage gate, build, smoke, e2e)
- [ ] **Docs/wiki + UI đã cập nhật** (hoặc ghi rõ N/A + lý do)
- [ ] PR mô tả `Closes #<issue>` để tự đóng issue khi merge
- [ ] Board: set **In Progress** trước khi code, **In Review** khi mở PR, **Done** sau khi merge
- [ ] Có evidence (command output / test result / file path) cho mọi claim
```

The Vietnamese DoD block is copied VERBATIM from existing issues — reuse it
exactly, don't paraphrase.

## Labels

- Always `user-story`.
- Plus domain labels that already exist on the repo (do NOT invent): `core`,
  `cli`, `hooks`, `security`, `testability`, `coverage`, `ui`, `docs`,
  `refactor`, `parser`, `workflow`, `skills`, `bug`, `enhancement`, plus
  severity `critical|high|medium|low`. Check `gh label list -R magicpro97/vibeflow`
  first; batch-create only after confirming a label is missing.

## Workflow

1. `gh label list` + `gh issue list --state all` first — reuse the label
   vocabulary, and dedupe against open/closed issues so you don't refile a
   known gap.
2. Draft each issue to a file, get user approval (user prefers draft-first for
   bulk issue creation), THEN `gh issue create --body-file … --label user-story,<domain>`.
3. Findings that become issues should be REAL gaps: filter against the current
   `vf` surface (run `vf --help` / read `docs/`) so you don't file
   already-built features.
