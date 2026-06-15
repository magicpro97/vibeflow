# Self-hosted GitHub Actions runner

The CI workflow uses a self-hosted runner on the personal MacBook
because the GitHub-hosted ubuntu-latest runner pool was congested
(1+ hour queue for every PR).

## Current setup

| Runner directory | Repo | Status |
| --- | --- | --- |
| `~/actions-runner/` | magicpro97/tui-translator | service, online |
| `~/actions-runner-vibeflow/` | magicpro97/vibeflow | service, online |

Both runners share labels `self-hosted, linux, x64` and run as
launchd services (`~/Library/LaunchAgents/...plist`), so they
auto-start on Mac boot/login.

## Setup a new runner (one-time)

1. **Get registration token** at
   `https://github.com/<owner>/<repo>/settings/actions/runners/new`

2. **Extract the runner binary** (cached at
   `~/actions-runner-osx-arm64-2.335.1.tar.gz`):
   ```bash
   mkdir -p ~/actions-runner-<repo>
   cd ~/actions-runner-<repo>
   tar -xzf ~/actions-runner-osx-arm64-2.335.1.tar.gz
   ```

3. **Configure + install as service**:
   ```bash
   ./config.sh --unattended \
     --url https://github.com/<owner>/<repo> \
     --token <token> \
     --labels "self-hosted,linux,x64" \
     --name "MacBook-Pro-cua-mac-<repo>"
   ./svc.sh install   # writes launchd plist
   ./svc.sh start
   ```

4. **Verify** the runner is online:
   ```bash
   gh api repos/<owner>/<repo>/actions/runners
   ```

A sample launchd plist is at
`.github/actions-runner-launchd.plist.example`.

## CI workflow contract

`runs-on: [self-hosted, linux, x64]` in `.github/workflows/ci.yml`
matches the labels on both runners. Jobs run instantly when the
MacBook is online. When offline, jobs stay pending — there's no
cloud fallback (the double-spending of Actions minutes outweighs
the benefit for a personal-machine workflow).

To fall back to cloud temporarily (e.g. when the MacBook is broken
for hours), change `runs-on:` to `ubuntu-latest` in the workflow.

## Known limitations

- **Mac sleep = pending CI**: the runner only processes jobs when
  the MacBook is awake. For a 1-2h nap this is fine; for multi-day
  travel, fall back to cloud or `gh pr merge --admin` for emergencies.
- **1 runner per repo**: each repo gets its own runner directory
  (different `.runner` credentials). Don't try to share one
  directory between repos.
- **GITHUB_TOKEN for release-please**: requires manual repo setting
  "Allow GitHub Actions to create and approve pull requests" OR a
  PAT stored as `VIBEFLOW_BOT_TOKEN` secret. See `.github/workflows/ci.yml`.
