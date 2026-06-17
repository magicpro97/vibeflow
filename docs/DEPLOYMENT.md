# VibeFlow — Deploy Plan (git + npm)

Status of the package as verified by `npm pack --dry-run`:
- `@magicpro97/vibeflow@0.1.0`, tarball **77 kB** / unpacked 252 kB.
- Ships only: `dist/cli.js` (built), `README.md`, `LICENSE`, `docs/**`, `package.json`.
- **No** `src/`, `test/`, `.vibeflow/`, `.env`, or secrets in the tarball (the `files` allow-list +
  `.gitignore` keep them out). Verified.
- `bin: { vf: ./dist/cli.js }`, `prepublishOnly: bun run build`, `publishConfig.access: public`,
  `engines.node >=18`, MIT license, `repository`/`homepage`/`bugs` fields present.
- `bun run check` (typecheck+lint+test) green: **266 tests**. `bun run test:e2e`: **8 passed**.

## ⚠️ MUST CONFIRM before publishing
1. **Repository URL** — I set `repository.url` to `git+https://github.com/magicpro97/vibeflow.git`
   (and matching `homepage`/`bugs`) as a placeholder. **Confirm the real GitHub owner/repo** and
   correct these three fields before publish, or the npm page links will 404.
2. **npm scope `@vibeflow`** — publishing `@magicpro97/vibeflow` requires that the `@vibeflow` org/scope
   exists on npm and you're a member, OR rename to an unscoped/owned name. Confirm you own the
   scope (`npm org ls vibeflow` / check npmjs.com). `publishConfig.access:"public"` is already set
   for a scoped public publish.
3. **Version** — `0.1.0` is unpublished/first release. Fine as an initial publish; bump per semver
   afterward.

## Git deploy (do first)
1. **Create the GitHub repo** (manual or `gh repo create <owner>/vibeflow --public --source=. --remote=origin`).
   The user must run `gh auth login` / `gh repo create` themselves (interactive auth) — suggest
   typing `! gh repo create ...` in the session so output lands here.
2. **Add remote** (if not via `gh`): `git remote add origin git@github.com:<owner>/vibeflow.git`.
3. **Push** — current branch is `main`, history is clean (8 logical commits, the throwaway "wip
   checkpoint" was already rewritten into feat/test/docs/chore commits). Push with upstream:
   `git push -u origin main`. (No force — nothing is published yet.)
4. **Tag the release**: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Optional: a GitHub Actions CI running `bun install && bun run check` on push/PR (the repo already
   has a `.githooks/pre-commit` gate locally; CI mirrors it). Defer unless wanted.

## npm deploy (after git)
1. **Auth**: `npm login` (or `npm whoami` to confirm) — user runs this (interactive). For CI,
   an `NPM_TOKEN` + `npm publish` step.
2. **Dry-run once more**: `npm publish --dry-run` — confirm the 77 kB tarball contents shown above.
3. **Build is automatic**: `prepublishOnly` runs `bun run build` → `dist/cli.js`. Ensure `dist/` is
   NOT gitignored away from the publish (it's in `files`; npm builds it fresh via prepublishOnly,
   so a missing committed `dist/` is fine).
4. **Publish**: `npm publish` (scope access already public). 
5. **Smoke-test the published bin**: in a throwaway dir, `npx @magicpro97/vibeflow@0.1.0 doctor` →
   should print the environment check. Also `npx @magicpro97/vibeflow doctor --probe` if engines installed.

## Pre-publish checklist (gate — all must hold)
- [ ] `repository`/`homepage`/`bugs` URLs corrected to the real repo (item ⚠️1).
- [ ] `@vibeflow` npm scope owned/confirmed (item ⚠️2), or package renamed.
- [ ] `bun run check` green + `bun run test:e2e` green (currently true: 266 + 8).
- [ ] `npm pack --dry-run` shows no src/test/secret files (currently true).
- [ ] `git push -u origin main` succeeded + `vX.Y.Z` tag pushed.
- [ ] `LICENSE` present (true) and README install line matches the final package name.

## Verification (post-deploy)
- `npx @magicpro97/vibeflow@0.1.0 doctor` exits 0 and prints the tool check.
- The GitHub repo shows the 8-commit history; the npm page renders README + the docs links resolve.
- `git clone <repo> && cd vibeflow && bun install && bun run check` reproduces green from a fresh
  clone (proves the repo is self-contained, zero-runtime-deps).

## Windows CI

Cross-platform support is enforced in three layers:

```text
1. .gitattributes          # forces LF for every source file (`* text=auto eol=lf`)
2. biome.json              # formatter.lineEnding = "lf" — formatter normalises newlines
3. hook scripts            # risk classification + path joins use path.sep, never `/` or `\`
```

The `.gitattributes` file pins line endings so Windows checkouts + autocrlf
cannot rewrite `*.ts` / `*.js` / `*.json` source. Biome's `lineEnding: "lf"`
formatter is the second line of defence — any file that slips through is
normalised on `bun run format`. Hook scripts and risk classification
(`src/agents/role-templates.ts`, the `vf hook` runner) compose paths with
`path.sep` and split with `path.split` / `path.relative`, so glob/scope rules
behave identically on `win32` and `posix`.

## Notes
- **Never auto-publish**: git push + npm publish are out-of-this-tool actions with external blast
  radius — they require explicit user go-ahead and interactive auth (gh/npm login). This plan
  prepares everything; the user triggers the two publish commands.
- The `.vibeflow/` runtime dir, `.kiro/`-tool config, and the tool-generated `AGENTS.md`/`.claude/`
  are gitignored or intentionally committed per earlier decisions — none leak into the npm tarball.
