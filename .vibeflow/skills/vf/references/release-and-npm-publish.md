# Cutting a release + publishing to npm (release-please flow)

magicpro97/vibeflow ships via **release-please** + a `release.yml` workflow that
publishes `@magicpro97/vibeflow` to npm. The commit message on `main` is the ONLY
signal that decides the bump (Conventional Commits — see the repo's AGENTS.md
table). This is the verified end-to-end cut procedure.

## How a release happens

1. **Conventional commits accumulate on main.** `feat:` → minor, `fix:`/`perf:` →
   patch, `feat!:`/`BREAKING CHANGE:` → major. `refactor:`/`docs:`/`chore:`/`test:`/
   `ci:`/`style:` do NOT bump. To ship a version you need at least one
   `feat:`/`fix:`/`perf:`/breaking commit since the last release.
2. **release-please bot keeps a Release PR open** titled `chore(main): release X.Y.Z`.
   It auto-updates on every push to main, rolling all bumping commits into the
   changelog. Find it: `gh pr list --label "autorelease: pending" --state open`.
3. **Merging that Release PR cuts the release.** release-please tags `vX.Y.Z`, then
   `release.yml` runs: a `verify` job (self-hosted) builds `dist/` + runs the full
   gate, then a `publish` job (github-hosted, required for `npm publish --provenance`
   — sigstore rejects self-hosted) downloads dist/ and publishes to npm.

## Commit types are the bump signal — audit them BEFORE the first push

release-please reads the TYPE of every commit that lands on main, so one
mis-typed commit mints a wrong changelog entry and the wrong bump. Before the
FIRST push of a branch, re-read `git log --oneline` and check every type against
intent — a formatting-only change typed `fix(ui):` ships as a "Bug Fixes" entry;
reword it to the non-bumping type (`style(ui):`) while it is still local:

```bash
GIT_SEQUENCE_EDITOR='perl -pi -e "s/^pick <sha>/reword <sha>/"' \
GIT_EDITOR='perl -pi -e "s/^fix\(ui\):/style(ui):/"' git rebase -i <sha>^
```

A reword changes the HEAD SHA (later commits rebase onto the new one) while the
TREE stays byte-identical — verify `git diff <old-head> <new-head>` is empty, then
re-run the focused gates. In repos with a push-time review-evidence gate the old
record is now bound to a dead SHA: re-create evidence for the NEW head before
pushing. Reword before the first push; once pushed, treat history as shared.

## Cutting it

```bash
# 1. Confirm the Release PR has gathered the commits you expect
gh pr view 300 --json title,body -q '.title'
gh pr view 300 --json body -q .body | grep -iE '#<issue>|<feature keywords>'

# 2. Merge it. Release-please branch carries NO `check` run, so admin-merge it.
gh pr merge 300 --squash --admin

# 3. release.yml triggers. The verify job needs a SELF-HOSTED runner.
gh run list --workflow release.yml --limit 1 --json status,conclusion,databaseId
gh run view <runId> --json status,jobs \
  -q '.status + " | " + (.jobs[] | .name + ":" + .status + " " + (.conclusion // ""))'
```

## Self-hosted runner queue trap

The `verify` job is `runs-on: [self-hosted, linux, x64]` (it needs codegraph which
only exists on the self-hosted box). The `publish` job is `ubuntu-latest`. So a
release can sit `queued` for several minutes while the self-hosted runner is busy
with another job — this is NOT a stuck pipeline. Check runner state:

```bash
gh api repos/magicpro97/vibeflow/actions/runners \
  --jq '.runners[] | .name + " — " + .status + " busy=" + (.busy|tostring)'
```

There are normally two mac runners; the job picks up when one frees. Just wait.

## Verifying the publish actually landed

Do NOT trust the workflow's green tick alone — poll npm directly:

```bash
npm view @magicpro97/vibeflow version      # must equal X.Y.Z
npm view @magicpro97/vibeflow dist-tags    # latest: X.Y.Z
gh release view vX.Y.Z --json tagName,publishedAt -q '.tagName + " @ " + .publishedAt'
```

A background poll loop is the clean way to wait without blocking:

```bash
for i in $(seq 1 40); do sleep 30
  v=$(npm view @magicpro97/vibeflow version 2>/dev/null)
  echo "$(date +%T) npm=$v"
  [ "$v" = "X.Y.Z" ] && { echo PUBLISHED; break; }
done
```

After merge, release-please also bumps `package.json` on main (a follow-up
`chore(main): release X.Y.Z` commit). `git pull` before doing anything else.

## Running the just-released version locally

`vf` global (homebrew) lags behind npm. To exercise the new version's behaviour
(e.g. re-run `vf init` with freshly-shipped templates), build from the checked-out
source instead of waiting for the brew bump:

```bash
git pull origin main            # gets the package.json X.Y.Z bump
bun run build                   # → dist/cli.js
node dist/cli.js --version      # confirm X.Y.Z
node dist/cli.js init --no-ai --no-ask   # but mind the machine-path trap below
```

WARNING: `vf init` run via `node dist/cli.js` bakes machine-absolute paths into
`.githooks/*` / `.mcp.json` / `.codex/*` / `.github/hooks/*` — see the main
SKILL.md pitfall before committing any init output. Commit only the portable
context docs.
