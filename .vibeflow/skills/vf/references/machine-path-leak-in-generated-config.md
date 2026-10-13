# Machine-absolute-path leak in vf-generated config (root-cause analysis)

When `vf init` / `vf hooks emit` generate engine config, they bake the CURRENT
machine's absolute path into several files. Some of those files are *tracked in
git*, so every contributor's init rewrites them with a different absolute path —
noisy diffs, broken hooks on other machines, and a committed `/Users/<you>/...`
that is wrong everywhere else. This file is the deep version of the one-line
pitfall in SKILL.md; read it before you "fix" the leak, because the obvious fix
(switch hooks to bare `vf hook`) is WRONG for a security guardrail.

## Where the path comes from (root cause)

- `src/hooks/adapters.ts` → `cliPath()` ALWAYS returns an absolute path to
  `dist/cli.js`. It's consumed by `claudeHookConfig()` (`.claude/settings.json`,
  exec-form `command:"node", args:[<abs>,"hook"]`), `codexHookConfig()`
  (`.codex/hooks.json`, shell string `node "<abs>" hook`), and `hookCommand()`
  → `copilotHookConfig()` (`.github/copilot-hooks.json` /
  `.github/hooks/copilot.json`, `"<abs>" hook # vibeflow-guardrail`).
- `vf init` also writes `.mcp.json` with `--workspace <abs repo path>` and
  `.vibeflow/WORKFLOW_STATE.json` with `repo_path: <abs>`.
- `package.json` declares `bin: { vf: "./dist/cli.js" }`, so an installed/global
  `vf` IS on PATH — i.e. `vf hook` (PATH-resolved) is viable for installed
  users; absolute is only strictly required from a source checkout with no
  global link.

## Why you can't just emit `vf hook` globally

The absolute path is deliberate. A portable fix must respect three constraints
(all spelled out in adapters.ts comments):

1. **Paths with spaces / `$` / backtick.** Claude uses exec-form precisely so
   `/Users/x/foo bar/dist/cli.js` survives; codex/copilot still use shell
   strings and are already fragile (acknowledged tech-debt).
2. **`liveGuardrailArmed` probe (issue #79, `src/commands/seams.ts:90-94`)**
   recognizes a real hook two ways: the `vibeflow-guardrail` sentinel string OR
   the regex `/dist\/cli\.js"?\s+hook\b/`. Claude's exec-form
   (`args:[<abs>,"hook"]`) is detected ONLY by that `dist/cli.js` regex — it has
   no sentinel. So switching Claude to bare `vf hook` BREAKS the probe for
   Claude (Copilot would still match via the sentinel); you'd have to rewrite
   the probe + add a new sentinel. A real, issue-#79-touching cost.
3. **PATH not guaranteed at hook-exec time.** The engine spawns the hook; if
   `vf` isn't on the spawned subprocess PATH (GUI-launched editor with a minimal
   PATH), `vf hook` fails OPEN and the guardrail is silently skipped. For a
   FAIL-CLOSED security hook, absolute is the safe default.

→ Conclusion: do NOT change `cliPath()`. For hooks, the right lever is to stop
TRACKING the generated files, not to fake-portabilize them.

## The diagnostic that proves the policy (the `.claude/` precedent)

`.gitignore` already ignores `.claude/` wholesale — the SAME class of
generated-with-abs-path engine config. But `.codex/hooks.json`,
`.github/copilot-hooks.json`, and `.mcp.json` were left tracked. **That
inconsistency IS the bug.** The repo already decided the correct policy for
`.claude/`; the other engine outputs just need to match it. When you find a
machine path in a tracked file, check whether a sibling of the same class is
already gitignored — that tells you the intended policy.

## File taxonomy — three real groups

| Group | Files | Deterministic? | Machine path? | Verdict |
|-------|-------|----------------|---------------|---------|
| A. Portable deterministic | root `AGENTS.md`, `.github/copilot-instructions.md`, `.codex/config.toml` | yes (SLIM templates) | no | commit (intentional reference example) |
| B. Machine-specific generated | `.mcp.json`, `.codex/hooks.json`, `.github/copilot-hooks.json`, `.github/hooks/copilot.json`, `.vibeflow/WORKFLOW_STATE.json`, `.vibeflow/workunits/**` | yes-but-per-machine | YES | untrack + gitignore (match `.claude/`) |
| C. AI-enriched | `.vibeflow/ai-context/**` | NO (LLM/profile output) | no (content varies) | decide: gitignore vs keep one snapshot |
| D. Hand-authored examples | `.github/actions-runner-*.{sh,plist.example}` | n/a | YES (sample home) | parametrize `<RUNNER_HOME>` placeholder |

`git rm --cached <file>` removes a path from tracking WITHOUT deleting the
working copy — and `.gitignore` rules only take effect once a path is untracked
(a rule that lists an already-tracked file is a silent no-op; `git check-ignore
-v <f>` confirms). `WORKFLOW_STATE.json` + `workunits/` were already in
`.vibeflow/.gitignore` yet still tracked for exactly this reason.

## The AI-path gap (the half a `--no-ai` audit misses)

`vf init` defaults to `--ai` ON; `--no-ai` is the opt-out. If you enumerate
"which files init writes" from a `--no-ai` run you MISS the AI path entirely.
`src/ai-init.ts` writes only under `.vibeflow/ai-context/` (`AI_CONTEXT_DIR`) —
non-deterministic LLM/profile output (`AGENTS.md`, `CLAUDE.md`,
`PROJECT_CONTEXT.md`, evidence tables) that varies per run and per engine. The
agent-team workflow lists `AGENTS.md` + `.github/copilot-instructions.md` as
`MANAGED_ENGINE_FILES` it can regenerate. So any "is the working tree clean
after init?" acceptance check MUST run BOTH modes and diff:

```
vf init --no-ai --no-ask     # deterministic
vf init        --no-ask      # default = AI on (needs a ready engine)
git status                   # must show no tracked-file modification from EITHER
```

If the AI run dirties a tracked file, that file is group C and must be
gitignored too.

## Fix shape (the plan that came out of this) — implementation-level

- PR-1 (core): `git rm --cached` group B + a CONSISTENT `.gitignore` block next
  to `.claude/` (anchor each entry with a leading `/` so a nested test fixture
  named `.mcp.json` is unaffected) + a guard test that fails if any tracked
  non-doc file matches `/Users/`, `/home/`, or `C:\Users\` (skip
  `*.md`/`*.ts`/`*.example`). GUARD-TEST SEQUENCING TRAP: the runner script
  `.github/actions-runner-auto-shutdown.sh` is `.sh` (NOT covered by the
  `.example` skip), so the guard test goes RED until PR-4 parametrizes it. Land
  PR-1 with that `.sh` temporarily in the skip list + a `// TODO(PR-4)`, and
  remove the skip in PR-4 — keeps PR-1 self-green.
- PR-2 splits into two independent parts:
  - **Part A — `WORKFLOW_STATE.repo_path`: DELETE it, don't relativize.**
    Verified ZERO readers (`grep -rn repo_path src/ test/` → only the optional
    schema decl `core/types.ts:70` + two writers `init-apply.ts:186` and
    `ai-init/workflow.ts:205`; nothing reads it back). So the clean fix is to
    stop WRITING it at both sites; leave `repo_path?: string` in the type as a
    back-compat read of older state files. (When a generated field leaks a path,
    always check reader count first — a zero-reader field is deleted, not
    portabilized.)
  - **Part B — `.mcp.json` workspace: emit `--workspace .`.** EMPIRICALLY
    TESTED this session (not just code-read): running
    `mcp-language-server --workspace . --lsp typescript-language-server -- --stdio`
    from the repo root logged `Initializing TypeScript language server with
    workspace: /Users/<you>/vibeflow-docs` and `Opened 279 TypeScript files` —
    the binary's `filepath.Abs(cfg.workspaceDir)` (`main.go:52`) resolves `.`
    against its own CWD, and MCP clients spawn the stdio server with CWD = the
    `.mcp.json` dir. Change is in `src/tools/lsp.ts` `bridgeArgs()` (the
    `WORKSPACE_FLAG, workspace` arg becomes `WORKSPACE_FLAG, "."`); update
    `test/tools.test.ts:77` to assert `.` and that no arg `startsWith("/")`.
    Residual risk: a client spawning from a different CWD breaks — keep the
    empirical probe in your back pocket. Rejected `${workspaceFolder}`: Claude's
    `.mcp.json` doesn't document token expansion, so it'd likely be written
    literally and break.
- PR-3 (group C, AI-enriched): gitignore `.vibeflow/ai-context/**` (it's
  non-deterministic LLM output — tracking it fails the "AI run leaves git clean"
  test). ALLOWLIST TRAP: `.vibeflow/.gitignore` is an allowlist (`*` then
  `!knowledge/`, `!*.md`, …). That `!*.md` re-include can RE-TRACK ai-context's
  `AGENTS.md`/`CLAUDE.md` even after `git rm --cached`. After untracking, run
  `git check-ignore -v .vibeflow/ai-context/AGENTS.md` to CONFIRM it's ignored;
  if the `!*.md` line wins, add an explicit `ai-context/` ignore BEFORE that
  line, or drop a `.vibeflow/ai-context/.gitignore` containing `*`. Keep ONE
  reviewed snapshot under `docs/examples/ai-context-sample/` (static, labeled
  "sample, not regenerated") so the repo still ships an example without churn.
- PR-4: parametrize the runner examples with `<RUNNER_HOME>`/`<USER_LOGS>`
  placeholders + remove the PR-1 guard-test `.sh` skip (closes the guard fully).

Ship as SEPARATE PRs: PR-1 is the independent high-value core (land first);
PR-2/3/4 are independent of each other and land after PR-1. PR-4 lands LAST
because it removes PR-1's temporary `.sh` skip.

## Worktree instance (recurring during plan execution)

Running `vf hooks emit --yes` inside a git worktree regenerates the generated
hook files with absolute paths that point at the MAIN checkout's `dist/cli.js`
(NOT the worktree's), plus creates an untracked `.agents/hooks.json`.
`git status` in the worktree then shows modified `.githooks/*` +
`.claude/settings.json` + the new file — all machine noise, none of it feature
diff. Revert everything before committing:

```
git checkout -- .claude/settings.json .githooks/
rm -f .agents/hooks.json
```

You do NOT need the emit in a worktree at all: `core.hooksPath=.githooks` is
shared repo config and the COMMITTED hook script (`bun src/cli.ts hook`) runs
correctly from the worktree. Arm/verify by piping a benign event:

```
printf '{"event":"pre-write","files":[]}' | bun src/cli.ts hook
# {"decision":"allow","risk":"none",...}
```

Rule: after ANY vf init/emit inside a worktree, `git status --porcelain` must
contain only intended changes — treat every machine-path file as generated
noise to restore, never to commit.

## Two directions of the same leak (verified in the field)

The emit always writes `cliPath()` of the INVOKING binary. That cuts both ways:

- Emit from a MAIN-checkout dist → tracked worktree files get the MAIN path
  (the original worktree instance above).
- Emit from a WORKTREE dist → GLOBAL `~/.codex/hooks.json` (MERGED, not
  overwritten — `mergeCodexHooks` preserves unrelated keys such as Orca's
  SessionStart entries) receives the WORKTREE path, which dies the moment the
  worktree is cleaned after merge. NOT only manual emit: any `vf verify` run
  inside a worktree also re-emits the global codex hooks — its proof pipeline
  runs the emitter (confirmed 2026-10-12; the mtime of `~/.codex/hooks.json`
  matches the verify run). So: after verifying inside a worktree, re-emit from
  the stable checkout before deleting the worktree.

Heal it: back up the global configs to scratch, run `vf hooks emit --yes` from
the STABLE main checkout (writes main-dist paths), then `git checkout --` the
tracked files it rewrote in that checkout and delete newly created untracked
generated files the machine's engines do not use (e.g. `.agents/hooks.json`
when agy is not installed). Confirm zero transient paths:
`grep -l 'worktrees/' ~/.codex/hooks.json ~/.claude/settings.json`.

## Stale generated config + strict newer CLI = parse-error spam

A project-level `.codex/hooks.json` written by an OLDER vf (schema drift, e.g.
`unknown field 'detectionOnly'`, pointing at a long-dead checkout) makes NEWER
codex validate-fail and emit `item.completed` `type:"error"`
`failed to parse hooks config …` at the START of EVERY `codex exec` in that cwd
— non-fatal but loud, and those hooks never arm. Diagnose by probing
(`printf ok | codex exec --json -`) and grepping the event stream for
`failed to parse`; fix by regenerating with the CURRENT generator (a repo test
asserting the new schema tells you the true shape) or deleting the file when
the current design no longer manages that path (project-level codex hooks — the
design is global-only). Re-probe: zero parse-error events + a real reply.

## Process lesson (why v1 of this plan was wrong)

The user pushed back with two questions that each exposed a gap: "is this the
optimal plan?" (→ v1 hid the symptom with untrack instead of naming the source)
and "what about when init uses AI?" (→ v1 was built from a `--no-ai` run and
ignored the default AI path). When the user challenges a plan with "did you
consider X", INVESTIGATE the unconsidered path before defending — re-read the
generator source and run the path you skipped. A plan built from one mode of a
multi-mode command is incomplete by construction.
