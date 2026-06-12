# Changelog

## [0.6.0](https://github.com/magicpro97/vibeflow/compare/v0.5.4...v0.6.0) (2026-06-12)


### Features

* **scanner:** evidence-backed stack findings with confidence levels ([1a8b501](https://github.com/magicpro97/vibeflow/commit/1a8b50172e57b8a04cef45e6652c0fdb96a0c1a9))
* **skills:** add Anthropic skill format validator + test suite ([7967cbf](https://github.com/magicpro97/vibeflow/commit/7967cbf77506a5434145d2da04fc78a19dbc6bce))
* **skills:** add canonical skills pointer/full sync (src/skills/sync.ts) ([7c2ae61](https://github.com/magicpro97/vibeflow/commit/7c2ae614657979880f56c75c29ade49aa347a577))
* **skills:** importer (single + parent) + sync CLI + body length fix ([80ecd9d](https://github.com/magicpro97/vibeflow/commit/80ecd9d73299211b1a242c9c03a23f171ff60ba6))
* **skills:** vf skills validate CLI command + lint fixes ([e7a0033](https://github.com/magicpro97/vibeflow/commit/e7a003345f61df34e6ce602d3f88e51388670b2c))
* **skills:** write standard + taxonomy + stack-evidence to .vibeflow/ai-context/; prompt references them ([cf5e87d](https://github.com/magicpro97/vibeflow/commit/cf5e87d4f2e97eea986ca48ee45dbe9ee5a0a63f))


### Bug Fixes

* **ai-init:** use bare copilot name in shell pipe (PATH resolves it) — avoid path-space issues on Windows ([901e5ac](https://github.com/magicpro97/vibeflow/commit/901e5aca08ff07ab4eea0d87d709906283a01ecd))
* **bun-shim:** replace data listener + buffer with async iterator — fixes duplicate stdout/stderr on Windows ([8058407](https://github.com/magicpro97/vibeflow/commit/8058407d4afb8eb9546bce4c8abf201a9734135c))
* **ci:** pin biome lineEnding=lf + add .gitattributes to keep CRLF out of source ([1cf625f](https://github.com/magicpro97/vibeflow/commit/1cf625f3c87bc7ae0ad8c99f156972f3b2feead6))
* pin lineEnding in biome.json + add .gitattributes to enforce LF on checkout. ([1cf625f](https://github.com/magicpro97/vibeflow/commit/1cf625f3c87bc7ae0ad8c99f156972f3b2feead6))
* **tests:** make path-handling cross-platform so Windows CI passes ([6070247](https://github.com/magicpro97/vibeflow/commit/60702479f2bf3cd1b5819fa57324e2db880d6c93))
* **tests:** more cross-platform test fixes (checkpoint, cli, logbus, wave2) ([7c4885c](https://github.com/magicpro97/vibeflow/commit/7c4885cab76f5827ae968113c3fdf45a94b81d78))


### Continuous Integration

* add Windows runner to test matrix — catch cross-platform regressions early ([d1f10c2](https://github.com/magicpro97/vibeflow/commit/d1f10c2d298b8d3f092ee77bae32ab1b0c034e8c))
* restore bun run build step before smoke test ([059961b](https://github.com/magicpro97/vibeflow/commit/059961b083b327de53df240cadf40670ccf3c88c))
* skip unit tests on Windows until 4 pre-existing path tests are fixed ([dab1e75](https://github.com/magicpro97/vibeflow/commit/dab1e756230c0551ad6fa7ced148b8dd806510e9))

## [0.5.4](https://github.com/magicpro97/vibeflow/compare/v0.5.3...v0.5.4) (2026-06-12)


### Bug Fixes

* **ai-init:** shell-pipe cmd must not quote copilot on Windows (cmd.exe treats quotes literally) ([11c74d6](https://github.com/magicpro97/vibeflow/commit/11c74d6fa23b49a7af50244a9b3cc6102ed1e9f2))

## [0.5.3](https://github.com/magicpro97/vibeflow/compare/v0.5.2...v0.5.3) (2026-06-12)


### Bug Fixes

* add Bun API polyfill for Node.js compat ([d0e47b8](https://github.com/magicpro97/vibeflow/commit/d0e47b8f4b09d4259f3a0052b47600a7670f7573))


### Continuous Integration

* remove autorelease:pending label check — any merged PR triggers publish (npm version check prevents duplicates) ([6d6cc44](https://github.com/magicpro97/vibeflow/commit/6d6cc44c4ceb5ef8f251cdb7fe5857311b5c601c))

## [0.5.2](https://github.com/magicpro97/vibeflow/compare/v0.5.1...v0.5.2) (2026-06-12)


### Bug Fixes

* **dispatch:** handle shell:true in Bun.spawn via /bin/sh -c wrapper ([f09e4b3](https://github.com/magicpro97/vibeflow/commit/f09e4b39983d767ff69e09d536776589a5d15ead))


### Continuous Integration

* run CLI with bun instead of node (Bun APIs not available in Node) ([f5bb989](https://github.com/magicpro97/vibeflow/commit/f5bb989d747bc899a69a2f50a0a4fc83bf2c68b0))

## [0.5.1](https://github.com/magicpro97/vibeflow/compare/v0.5.0...v0.5.1) (2026-06-12)


### Bug Fixes

* **ai-init:** include stderr snippet in engine failure message ([42a1d99](https://github.com/magicpro97/vibeflow/commit/42a1d996200086c028d66e52b9a3a397aed88d52))
* **ai-init:** Windows cmd-line too long + idle timeout + streaming callbacks ([b994a0a](https://github.com/magicpro97/vibeflow/commit/b994a0aa9a73fd1ba89ddd9bb158dfa101cfc45c))
* **test:** isolate logbus no-bus tests from parallel test bus state ([bdfbdcc](https://github.com/magicpro97/vibeflow/commit/bdfbdccb673cca9a5b2e1b3d70086de99afbc6e1))


### Refactors

* migrate process spawn + command resolution to Bun native APIs ([02cc1a3](https://github.com/magicpro97/vibeflow/commit/02cc1a353d77fb303ff96b0b8d7ac5ad5acd55b7))
* **server:** migrate from node:http to Bun.serve ([ff0e0d0](https://github.com/magicpro97/vibeflow/commit/ff0e0d0208b24e01aafcb9fadb97aaf59197887a))

## [0.5.0](https://github.com/magicpro97/vibeflow/compare/v0.4.1...v0.5.0) (2026-06-12)


### Features

* **cli:** stream engine output in real-time during vf init --ai ([b7dc81e](https://github.com/magicpro97/vibeflow/commit/b7dc81e610b32bdffa94eba2239becfb54f3f20e))
* **ui:** add AI generation toggle to web UI intake form ([41d6c63](https://github.com/magicpro97/vibeflow/commit/41d6c6337b13128a27f03af18092124f0e793768))


### Bug Fixes

* **ai-init,preflight:** copilot probe false-negative + dispatch args order + engine fallback ([1aaa883](https://github.com/magicpro97/vibeflow/commit/1aaa8833296566b641149283b4826c07b59a6d9d))
* **xss:** escape quote chars in esc() for attribute safety ([9786b72](https://github.com/magicpro97/vibeflow/commit/9786b72d709a33f927f4e0f36328d08e05ffcb85))


### Refactors

* **dispatch:** extract confidence fallback thresholds to named constants ([122734f](https://github.com/magicpro97/vibeflow/commit/122734f6844173d791aebaac6fd90c2af37a984f))
* **e2e:** extract waitForPage to shared helpers.ts ([6d8fea7](https://github.com/magicpro97/vibeflow/commit/6d8fea7d43469e9b633466abf00ea190862238b3))
* **ui:** split server.html into src/ui/ — shell + sections ([818e2eb](https://github.com/magicpro97/vibeflow/commit/818e2ebf1db7425a2d20262693561a857c2a69c2))


### Tests

* **commands:** add unit tests for orchestrate, doctor, applyIntake, writeState, review gate ([3365941](https://github.com/magicpro97/vibeflow/commit/3365941a92e99583e0483e5a5bed24f2c0634a02))
* **server:** add HTTP-level tests for /api/init, preflight, CSRF guard ([f145d6c](https://github.com/magicpro97/vibeflow/commit/f145d6c0ab11cba109013f81fbfd527015c9f01d))

## [0.4.1](https://github.com/magicpro97/vibeflow/compare/v0.4.0...v0.4.1) (2026-06-12)


### Bug Fixes

* **dispatch:** graduated fallback for asSummary — 0.85 for 10+ turns, 0 for &lt;3 ([a016120](https://github.com/magicpro97/vibeflow/commit/a0161203967448792350f2e4e0e896200fdd26d6))
* **orchestrate:** auto-set status=done when review passes ([c3592fa](https://github.com/magicpro97/vibeflow/commit/c3592fa7fdd204bb2caa2ed08ef531b7774bacdf))
* **settings:** default per-unit timeout 600s-&gt;3600s — Playwright e2e suites need &gt;10min. Assertion already uses DEFAULT_TIMEOUT_SECONDS so only test description updated. ([c3592fa](https://github.com/magicpro97/vibeflow/commit/c3592fa7fdd204bb2caa2ed08ef531b7774bacdf))


### Tests

* **e2e:** add 7 new e2e test files (+20 tests) for VibeFlow UI ([f36064b](https://github.com/magicpro97/vibeflow/commit/f36064b32f930de6dbbcefc4a4c875650bb25e9c))
* **e2e:** fix meter flake — toBeAttached instead of toBeHidden ([dc389f9](https://github.com/magicpro97/vibeflow/commit/dc389f93d66f36d6fbbdf56a9ad933c7b21eddc4))
* replaced old 'keeps dispatcher status' test (unreal dispatcher that returned 'done') with test that uses 'verifying' dispatcher — asserts status becomes 'done' after review. Added symmetric 'failed review blocks' test. ([c3592fa](https://github.com/magicpro97/vibeflow/commit/c3592fa7fdd204bb2caa2ed08ef531b7774bacdf))

## [0.4.0](https://github.com/magicpro97/vibeflow/compare/v0.3.17...v0.4.0) (2026-06-11)


### Features

* add project advisories + e2e warning gates ([72b599d](https://github.com/magicpro97/vibeflow/commit/72b599dbc7e1c4a43f3a8891c2ce8badc95a6b3f))
* **logbus:** stream engine stderr to bus + SSE + UI bottom panel ([3331fe3](https://github.com/magicpro97/vibeflow/commit/3331fe38cd1ac4a7ec080b50977dec4cfc4cfb5f))
* **ui:** refactor builder + multi workflow ([#16](https://github.com/magicpro97/vibeflow/issues/16)) ([b3a5bd4](https://github.com/magicpro97/vibeflow/commit/b3a5bd42b003c114fa68038b7b8d2a35fd0eb39d))


### Bug Fixes

* **ci:** anchor release-please at last manual release + document setup ([6a4dfe5](https://github.com/magicpro97/vibeflow/commit/6a4dfe569a7bf2765eb53e11f5841257482c4199))
* **logbus:** close() clears global active reference to fix test isolation ([29ccb7e](https://github.com/magicpro97/vibeflow/commit/29ccb7e27ff65ec81b52676feb676c54b097c353))
* tools status passes detect inject, codegraph tests deterministically mock detect ([e30df08](https://github.com/magicpro97/vibeflow/commit/e30df087e2eba8b02ea688189e993fed54e19f5d))


### Documentation

* add Conventional Commits guide to AGENTS.md ([c20a4b3](https://github.com/magicpro97/vibeflow/commit/c20a4b3e0fbb0f43cb3f4156b7601d5d2449f241))


### Continuous Integration

* integrate release-please for auto-publish on main ([d88d061](https://github.com/magicpro97/vibeflow/commit/d88d061e453d4b644e2e1b94733648fe457c4b30))
