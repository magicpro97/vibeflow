# Changelog

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
