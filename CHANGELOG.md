# Changelog

## [0.9.1](https://github.com/magicpro97/vibeflow/compare/v0.9.0...v0.9.1) (2026-06-25)


### Bug Fixes

* **init:** stop tracking per-machine generated engine configs (PR-1) ([f5a9b06](https://github.com/magicpro97/vibeflow/commit/f5a9b0644f4d019c78262db22e9497f706f95e7a))
* **tools:** portable relative workspace in .mcp.json; drop dead repo_path (PR-2) ([e84eb8a](https://github.com/magicpro97/vibeflow/commit/e84eb8a45152a8701ec22c5267e90d6c1c853d02))


### Documentation

* **ci:** parametrize self-hosted runner example paths (PR-4) ([7869989](https://github.com/magicpro97/vibeflow/commit/7869989e2b37d3e5acd3544f0f1befd7d440ae94))
* regenerate context with vf init on v0.9.0 ([5bc7c37](https://github.com/magicpro97/vibeflow/commit/5bc7c370f50e14b5917c24b406fab23e624e8878))

## [0.9.0](https://github.com/magicpro97/vibeflow/compare/v0.8.0...v0.9.0) (2026-06-25)


### Features

* **adapters:** slim generated context block to a pointer to the vf skill ([2787fe9](https://github.com/magicpro97/vibeflow/commit/2787fe9d6eae4e6cbfea9cea3eb1d68a8db109d3))
* **adapters:** slim generated context block to a pointer to the vf skill ([8d20fcd](https://github.com/magicpro97/vibeflow/commit/8d20fcd34fd3a18f87e501cc34522e920b56ea7e))
* **cli:** vf demo runs a fixed corpus through orchestrate --dry --focus ([a8f79d5](https://github.com/magicpro97/vibeflow/commit/a8f79d5141977f1cd23a68bcaa08a2fb67db86ff))
* **cli:** vf demo runs a fixed file corpus through orchestrate --dry --focus ([483dad5](https://github.com/magicpro97/vibeflow/commit/483dad5fdaa46964f80cb181d096a782ceb739ab))
* **cli:** vf init update mechanism + version stamp + skill seeding ([c0a4120](https://github.com/magicpro97/vibeflow/commit/c0a4120f13386ea91d8fe7929732602a1d65ea16)), closes [#323](https://github.com/magicpro97/vibeflow/issues/323)
* **cross-review:** add world-class review standard (Conventional Comments, spec-vs-code, understanding-first, staleness-repro, PII/authz, cited sources) ([#315](https://github.com/magicpro97/vibeflow/issues/315)) ([26334d3](https://github.com/magicpro97/vibeflow/commit/26334d314f6399b084fc847e4e89b4378c6e4f16))
* **decision:** ADR-lite decision log + vf decision add/list ([#335](https://github.com/magicpro97/vibeflow/issues/335) PR-3) ([f9674f4](https://github.com/magicpro97/vibeflow/commit/f9674f4cc2865014a2a82c9cc980d14dafef64f1))
* **init:** add version stamp, UPDATE mechanism, vf skill seeding ([#323](https://github.com/magicpro97/vibeflow/issues/323)) ([185aa0d](https://github.com/magicpro97/vibeflow/commit/185aa0d78096a39c7f06f2b6fd39296096d5be75))
* **init:** auto-install enabled-but-missing tools + hooks on vf init ([faf016c](https://github.com/magicpro97/vibeflow/commit/faf016cf636dfd2732356527ceae544c0844ce27)), closes [#333](https://github.com/magicpro97/vibeflow/issues/333)
* **init:** handle agent templates ([9472ff9](https://github.com/magicpro97/vibeflow/commit/9472ff97c4aba9bb8bd2e78d8270a749a9bf937e))
* **init:** handle agent templates ([ef320b9](https://github.com/magicpro97/vibeflow/commit/ef320b9bbae955f34d7791133dd2b0a70ef9e580))
* **landing:** real orchestration process as demo video ([c9d889f](https://github.com/magicpro97/vibeflow/commit/c9d889fc285ce77285a9a457e89d8bcb81689074))
* **landing:** SEO polish + fix demo-video caching ([948fbe6](https://github.com/magicpro97/vibeflow/commit/948fbe64f577cacd8afbaf927d7945d95b608f44))
* **landing:** SEO polish + fix demo-video caching ([b02ab80](https://github.com/magicpro97/vibeflow/commit/b02ab8007f547b557b26b44710e31e34f3dc3065))
* **landing:** show the real orchestration process (engine plan→code→gate→verdict) as the demo video ([49e7725](https://github.com/magicpro97/vibeflow/commit/49e77250ed615aefd4f2a96fb87798ca91876206))
* **landing:** showcase the vf demo phase timeline with an asciinema cast ([12728c9](https://github.com/magicpro97/vibeflow/commit/12728c93da847ac66e7c14cbbc1c317c060bc667))
* **landing:** showcase the vf demo phase timeline with an asciinema cast ([3de8ea7](https://github.com/magicpro97/vibeflow/commit/3de8ea7eeb78041497badc3177b8507840ebb971))
* **orchestrate:** --focus raises the terminal for screen-recorded demos ([9aabed0](https://github.com/magicpro97/vibeflow/commit/9aabed014d1d77485eca79e4b42a6af9f13e0161))
* **orchestrate:** --focus raises the terminal for screen-recorded demos ([925d094](https://github.com/magicpro97/vibeflow/commit/925d0943bc61fcd0ec11a110e5d4c76397b08245))
* **orchestrator:** documented coordination brief/result contract template ([3ca108b](https://github.com/magicpro97/vibeflow/commit/3ca108b6c27c3b20d0ca6b3984f6339d842ecd96))
* **orchestrator:** documented coordination brief/result contract template (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)-followup) ([d3b19d1](https://github.com/magicpro97/vibeflow/commit/d3b19d179e88b7794edd4f6dbd45e6a60c9cd3ed))
* **orchestrator:** live phase-timeline tracker over onProgress ([7af71d6](https://github.com/magicpro97/vibeflow/commit/7af71d6fd9e4be5d9330dc7b0f89567ea18a67d5))
* **orchestrator:** live phase-timeline tracker over the onProgress seam ([b2de811](https://github.com/magicpro97/vibeflow/commit/b2de811d23b767d1004fb7ed1c0259c61d24ed76))
* **skills:** agent learning instructions + vf skills draft + docs ([#335](https://github.com/magicpro97/vibeflow/issues/335) PR-4) ([8fad849](https://github.com/magicpro97/vibeflow/commit/8fad849c0ebd07bb4a9cc1c0eefe6c6e423aacbb))
* **skills:** align validator with Anthropic ## Meta standard (no YAML frontmatter) ([85d31b9](https://github.com/magicpro97/vibeflow/commit/85d31b988d451bc0e864ca79c9c9c0104f065c3b))
* **skills:** auto-crystallize DRAFT skill at end of orchestrate + verify ([#335](https://github.com/magicpro97/vibeflow/issues/335) PR-2) ([d8e1cd8](https://github.com/magicpro97/vibeflow/commit/d8e1cd8acbe920cfb21b9e7ffacdaea272a2ea10))
* **skills:** convert phase templates + generator to Anthropic ## Meta format ([c795a09](https://github.com/magicpro97/vibeflow/commit/c795a091a201c0d615020ceb21f47d7b5f7b111f))
* **skills:** split vf skill into slim SKILL.md + references (skill-creator + grill) ([4906740](https://github.com/magicpro97/vibeflow/commit/49067401233c9d21457fadd4cbfdfdc6f15f879e))
* **skills:** split vf skill into slim SKILL.md + references (skill-creator + grill) ([3e84cb3](https://github.com/magicpro97/vibeflow/commit/3e84cb3a2739f835f6db067d029cd6f755dc4d24))
* **wiki:** add architecture/orchestrate/skills SVG diagrams (Closes [#324](https://github.com/magicpro97/vibeflow/issues/324)) ([6c96114](https://github.com/magicpro97/vibeflow/commit/6c9611409d3f5fce686cb22be02f1018d056f1a8))
* **wiki:** visual SVG diagrams (architecture/workflow/skills) ([c7514a1](https://github.com/magicpro97/vibeflow/commit/c7514a157f3a31a3769a36e8130667a1769224ca))


### Bug Fixes

* **landing:** add poster frame to demo video ([9e86fe8](https://github.com/magicpro97/vibeflow/commit/9e86fe82ffdabde798dde766c996706ee751617a))
* **landing:** add poster frame to demo video so the player shows real terminal content before play ([e871a42](https://github.com/magicpro97/vibeflow/commit/e871a421eadb308154270ae73ef1af9d254ed0f7))


### Refactors

* **adapters:** split adapters.ts (399 LOC) into facade + 5 modules ([b65ce00](https://github.com/magicpro97/vibeflow/commit/b65ce00c673b7d0fe12bcaa0f561057aaf0a22a0))
* **adapters:** split adapters.ts (399 LOC) into facade + 5 modules ([8f08edb](https://github.com/magicpro97/vibeflow/commit/8f08edbcfebeea4bd2ef4791eb05fd661f3be3f6))
* **ai-init-workflow:** split ai-init-workflow.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([544d7b1](https://github.com/magicpro97/vibeflow/commit/544d7b11dcf944f8c40c98bc15377a80eaff6f09))
* **ai-init-workflow:** split ai-init-workflow.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([3dcf309](https://github.com/magicpro97/vibeflow/commit/3dcf30967f0c204c2ee5bfc8f49acdf82aeaf5f8))
* **ai-init:** split ai-init.ts under 400 LOC (closes [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([695a150](https://github.com/magicpro97/vibeflow/commit/695a150ce9f78fdc210747fb3ebee1111c5afebf))
* **ai-init:** split ai-init.ts under 400 LOC (closes [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([601e6d6](https://github.com/magicpro97/vibeflow/commit/601e6d68a1f5b7202a2607781a8af4fa74c5bb96))
* **core:** split core.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([ac5a471](https://github.com/magicpro97/vibeflow/commit/ac5a471d3629cfc2b4d8a85cc8f43fcb34d4b566))
* **core:** split core.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([59850fa](https://github.com/magicpro97/vibeflow/commit/59850fa8e588e62f9f4d5de609ea5d9ac52845d1))
* **dispatch:** split dispatch.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([16a9545](https://github.com/magicpro97/vibeflow/commit/16a954589621d0e5815141b0b34acd6044462910))
* **dispatch:** split dispatch.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([5e8551b](https://github.com/magicpro97/vibeflow/commit/5e8551b3c4b32b9d1e417a376328e3682cb2e632))
* **logbus:** split logbus.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([53a0f05](https://github.com/magicpro97/vibeflow/commit/53a0f05920570cda8d0aec923855ae4a593bdcf6))
* **logbus:** split logbus.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([48c1f94](https://github.com/magicpro97/vibeflow/commit/48c1f9400c05fa327598f6a4c14652f03eb449b8))
* **server:** split server.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([1f7342a](https://github.com/magicpro97/vibeflow/commit/1f7342a698e59bddc3779951aba93d826400b0a0))
* **server:** split server.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([60ec574](https://github.com/magicpro97/vibeflow/commit/60ec57485e10d41673fb3acac6a758a9bfe2ee8a))
* **skills:** delete dead maintainer.ts ([#335](https://github.com/magicpro97/vibeflow/issues/335) PR-1) ([736d84a](https://github.com/magicpro97/vibeflow/commit/736d84a99b751998f92ebb5922140b450cf8478f))


### Documentation

* international-standard docs (Diátaxis), landing wiki, README star chart, 4K demo video ([437213c](https://github.com/magicpro97/vibeflow/commit/437213c24f729903a156e8cf7d766b56a25f5598))
* international-standard docs + landing wiki + README star chart + 4K demo ([36dd258](https://github.com/magicpro97/vibeflow/commit/36dd2585fbfdee2fd8dff77d6b4008a4f6d6f0c1))
* **landing:** add "Use VibeFlow as a skill" onboarding section ([fe4b481](https://github.com/magicpro97/vibeflow/commit/fe4b481935b0aa5470037ad2b24756c8bf3370b8))
* **landing:** add vf skill / /vf onboarding section ([d2cd4b9](https://github.com/magicpro97/vibeflow/commit/d2cd4b949e780c559e143b994ae49e692efed12b))
* update VibeFlow version v0.7.0 to v0.8.0 in AGENTS.md ([0a425cd](https://github.com/magicpro97/vibeflow/commit/0a425cd83d3ae310bd9ea54d9209af63f8c9a8bd))
* update VibeFlow version v0.7.0 to v0.8.0 in CLAUDE.md ([fade1e9](https://github.com/magicpro97/vibeflow/commit/fade1e96fccac8d51a7ee588a4592bfc7654e663))


### Continuous Integration

* **release:** publish with --ignore-scripts (dist already built in verify job) ([c8ae199](https://github.com/magicpro97/vibeflow/commit/c8ae199fcd1bd623bfa0cccf913468620dcfeb6b))
* **release:** publish with --ignore-scripts (dist prebuilt in verify job) ([e8f5580](https://github.com/magicpro97/vibeflow/commit/e8f5580d674d0233435a96fb4395105d9bbcd966))
* **release:** run publish on self-hosted runner to match CI environment ([54212a1](https://github.com/magicpro97/vibeflow/commit/54212a15b0fa9a45b8aaf0b2e50940d06293f68f))
* **release:** run publish on self-hosted runner to match CI environment ([3aa9121](https://github.com/magicpro97/vibeflow/commit/3aa9121dc85fbf4c01bdb981e7f82ee6c2df3eb4))
* **release:** split verify (self-hosted) + publish (github-hosted) to unblock provenance ([31e7bc0](https://github.com/magicpro97/vibeflow/commit/31e7bc02ed845cd826d35b4fc6cb5876aceec75b))
* **release:** split verify (self-hosted) and publish (github-hosted) jobs ([c094c72](https://github.com/magicpro97/vibeflow/commit/c094c7295e8c7a4f35e62a0a75e8a10d3535065d))


### Tests

* **#326:** integration tests for skills sync references/ mirroring and init fat→slim migration ([2b0ea77](https://github.com/magicpro97/vibeflow/commit/2b0ea7759d361192ee65e2b3f3c687493d6eb9a3))
* **cli:** integration tests for skills sync references/ + init fat→slim migration ([0f75829](https://github.com/magicpro97/vibeflow/commit/0f758298e9b2eb7111aa53c6aab767c29cee5a2b)), closes [#326](https://github.com/magicpro97/vibeflow/issues/326)
* **workflow-artifacts:** cover agent-templates + phase-specs to 100% (fixes [#308](https://github.com/magicpro97/vibeflow/issues/308) coverage gate) ([7668b16](https://github.com/magicpro97/vibeflow/commit/7668b165813dcac6d9f3f416215352661b44180a))
* **workflow-artifacts:** restore 100% coverage after [#308](https://github.com/magicpro97/vibeflow/issues/308) (fix red main) ([7ad2f74](https://github.com/magicpro97/vibeflow/commit/7ad2f74ccd974851fd4b2e2bdb5e46a1eaa5e079))

## [0.8.0](https://github.com/magicpro97/vibeflow/compare/v0.7.0...v0.8.0) (2026-06-23)


### Features

* **174:** vf pr queue — single-writer JSONL + mkdirSync atomic lock (A8) ([#224](https://github.com/magicpro97/vibeflow/issues/224)) ([2cf64b9](https://github.com/magicpro97/vibeflow/commit/2cf64b9107e9c07f65d5b225a1b7edbbdfce0b48))
* **175:** vf pr merge-when-green ([#222](https://github.com/magicpro97/vibeflow/issues/222)) ([8fb38c0](https://github.com/magicpro97/vibeflow/commit/8fb38c0f6f1a4d9770845440a30b213ffc675737))
* **176:** marker → Project [#6](https://github.com/magicpro97/vibeflow/issues/6) status sync ([#221](https://github.com/magicpro97/vibeflow/issues/221)) ([598b435](https://github.com/magicpro97/vibeflow/commit/598b435063ccc82405a9be65142f0e417c85c171))
* **coord:** vf coord shim with tool-deny-list + vf init auto-coords (A1 [#167](https://github.com/magicpro97/vibeflow/issues/167) [#194](https://github.com/magicpro97/vibeflow/issues/194)) ([#195](https://github.com/magicpro97/vibeflow/issues/195)) ([ba5859a](https://github.com/magicpro97/vibeflow/commit/ba5859a8cedb5ab8489a41349c371680a6135e07))
* **dispatch:** add cwd seam to makeAsyncSpawner for per-unit worktree isolation ([180628e](https://github.com/magicpro97/vibeflow/commit/180628e913f6dc0e881381035bb7eb8d662d4e5d))
* **dispatch:** add cwd seam to makeAsyncSpawner for per-unit worktree isolation ([d66e419](https://github.com/magicpro97/vibeflow/commit/d66e419072c15d6a3b0ebf9a1d11a63b768dde97))
* **dispatch:** inject project hard rules into dispatchPrompt constraints ([021e28f](https://github.com/magicpro97/vibeflow/commit/021e28f9876ae93dae1d52a8679467c9c448feaf))
* **dispatch:** inject project hard rules into dispatchPrompt constraints ([0868db4](https://github.com/magicpro97/vibeflow/commit/0868db416392fca2953291736d276a7ca93b97ff))
* **init-hooks:** cherry-pick iletai's [#215](https://github.com/magicpro97/vibeflow/issues/215) + resolve A1/Phase 1.55 conflicts ([#217](https://github.com/magicpro97/vibeflow/issues/217)) ([7c6df08](https://github.com/magicpro97/vibeflow/commit/7c6df08fd3cf24581b0ee349b6b0154a16357fed))
* **init:** add viewpoint testing skill ([a48ca62](https://github.com/magicpro97/vibeflow/commit/a48ca62e92b3dc98227f37c394f298962e5e5563))
* **init:** add viewpoint testing skill ([17e9d99](https://github.com/magicpro97/vibeflow/commit/17e9d99afa500556e97b78eca5d8c9269b3714be))
* **init:** AI init flow + coverage backstop (rebased from phonnt's [#137](https://github.com/magicpro97/vibeflow/issues/137)) ([#214](https://github.com/magicpro97/vibeflow/issues/214)) ([404cd39](https://github.com/magicpro97/vibeflow/commit/404cd39d742232cfd7d1fe08ac46431602e5f8ff))
* **init:** mark skill using mcp ([4edcbcb](https://github.com/magicpro97/vibeflow/commit/4edcbcb1667d84cfc13635df5dd99623790f0a92))
* **init:** update flow ([ea6685c](https://github.com/magicpro97/vibeflow/commit/ea6685ce4c075c3c0c572b4421d4e1be836701d1))
* **init:** update flow ([a77e3b3](https://github.com/magicpro97/vibeflow/commit/a77e3b3f35ab60f1186fc438e3c05e2ea2fd357c))
* **init:** update flow ([#129](https://github.com/magicpro97/vibeflow/issues/129)) ([8f82957](https://github.com/magicpro97/vibeflow/commit/8f82957d375a8b78112886f70a1f384b631bd2b3))
* **memory:** claude-mem integration — rebased + 6 codex fixes ([#216](https://github.com/magicpro97/vibeflow/issues/216)) ([b4ba2f7](https://github.com/magicpro97/vibeflow/commit/b4ba2f7ed89ebc66c946d33b739979b088d3bb90))
* **orchestrate:** --no-unit-gate skips the per-unit gate ([#275](https://github.com/magicpro97/vibeflow/issues/275) D) ([e4c85f7](https://github.com/magicpro97/vibeflow/commit/e4c85f770f8e38b7d57a9e9c03cef0765db436fc))
* **orchestrate:** --no-unit-gate skips the per-unit gate ([#275](https://github.com/magicpro97/vibeflow/issues/275) D) — closes [#275](https://github.com/magicpro97/vibeflow/issues/275) ([cdf7e14](https://github.com/magicpro97/vibeflow/commit/cdf7e142b0b9c1c01dedcb7e30faab87a98a0c6e))
* **orchestrate:** add scoped per-unit gate (W4) ([5de7a9a](https://github.com/magicpro97/vibeflow/commit/5de7a9a8c276a389615e07613ccb1f6ca7ddcda5))
* **orchestrate:** cooperative abort seam caps quota over-spend (W-D, [#269](https://github.com/magicpro97/vibeflow/issues/269)) ([024217a](https://github.com/magicpro97/vibeflow/commit/024217ad23b8ddd09955e535bdff8098ef36f4ec))
* **orchestrate:** cooperative abort seam caps quota over-spend at concurrency-1 (W-D) ([7656589](https://github.com/magicpro97/vibeflow/commit/7656589ed558392954249fe140628134933c3f69)), closes [#269](https://github.com/magicpro97/vibeflow/issues/269)
* **orchestrate:** eliminate 4 dogfood weaknesses (W1-W4) + fix [#251](https://github.com/magicpro97/vibeflow/issues/251) CI red ([be6a646](https://github.com/magicpro97/vibeflow/commit/be6a6469ca428cff5eaf569f13b9eda05fdfcc99))
* **orchestrate:** live per-unit progress on the terminal during --yes runs ([5fbc601](https://github.com/magicpro97/vibeflow/commit/5fbc60174440ecb1cdc10a1882ca8b0632e2d3f7)), closes [#289](https://github.com/magicpro97/vibeflow/issues/289)
* **orchestrate:** live per-unit terminal progress during --yes runs ([e2e2af0](https://github.com/magicpro97/vibeflow/commit/e2e2af012a6ffcad71ee0e1ca79324c2c530d653))
* **orchestrate:** optional --pr per-unit PR publish (W3) ([e979304](https://github.com/magicpro97/vibeflow/commit/e9793041659fc1c7a18cc759db8eb0e32010702f))
* **orchestrate:** per-unit worktree isolation in makeDispatcher (W1) ([6f29186](https://github.com/magicpro97/vibeflow/commit/6f291869b781631a386fa47a6e4d2f314bc6fe4b))
* **orchestrate:** wire --isolate flag for per-unit worktree isolation (W1) ([9967b83](https://github.com/magicpro97/vibeflow/commit/9967b8334f1f05c2ba0380e7cde9863b048f59f0))
* **plan:** vf plan &lt;artifact&gt; command — dispatch a planner, write structured plan (A3 [#169](https://github.com/magicpro97/vibeflow/issues/169)) ([#197](https://github.com/magicpro97/vibeflow/issues/197)) ([4986b5e](https://github.com/magicpro97/vibeflow/commit/4986b5ef796a9aca6c77a8d3eb3e28ef316eb6f7))
* **pr:** vf pr create — MagicPro97 PR convention (A7 [#173](https://github.com/magicpro97/vibeflow/issues/173)) ([#212](https://github.com/magicpro97/vibeflow/issues/212)) ([3eb6b51](https://github.com/magicpro97/vibeflow/commit/3eb6b517bb28fb55aa6c819c19fcfda9a4cdc418))
* **review-cross:** vf review --cross — auto cross-debate (codex + claude) (A5 [#171](https://github.com/magicpro97/vibeflow/issues/171)) ([#208](https://github.com/magicpro97/vibeflow/issues/208)) ([254ce43](https://github.com/magicpro97/vibeflow/commit/254ce43f0993ca2082fc0559d1bdcc4354a6bb36))
* **review:** vf review &lt;target&gt; — human-only review (plan|commit|unit) before merge (A4 [#170](https://github.com/magicpro97/vibeflow/issues/170)) ([#206](https://github.com/magicpro97/vibeflow/issues/206)) ([4fe9ee8](https://github.com/magicpro97/vibeflow/commit/4fe9ee82e8e12b1daebada5306521c494dbfec1a))
* **scripts:** add guardrail-on.sh to arm the vf hook gate on onboarding (F1 [#162](https://github.com/magicpro97/vibeflow/issues/162)) ([#181](https://github.com/magicpro97/vibeflow/issues/181)) ([e06e426](https://github.com/magicpro97/vibeflow/commit/e06e426067219ea39fd42bcf7b8a349fc086386a))
* **scripts:** broaden file-size gate to all src/, add inline // size-waiver: #&lt;issue&gt; ([#165](https://github.com/magicpro97/vibeflow/issues/165)) ([#188](https://github.com/magicpro97/vibeflow/issues/188)) ([5eda798](https://github.com/magicpro97/vibeflow/commit/5eda79818fe948b6111d4b325dbfd7d9f713357e))
* **scripts:** gh integration spike (F5 [#166](https://github.com/magicpro97/vibeflow/issues/166)) ([#187](https://github.com/magicpro97/vibeflow/issues/187)) ([a8971c3](https://github.com/magicpro97/vibeflow/commit/a8971c38a0cfde1b039aa13b8fe223ad7b517d2e))
* **skills:** coordinator skill — consult, dispatch, cross-review, merge-when-green (A2 [#168](https://github.com/magicpro97/vibeflow/issues/168)) ([#196](https://github.com/magicpro97/vibeflow/issues/196)) ([f6a66d3](https://github.com/magicpro97/vibeflow/commit/f6a66d3d560afac874ac32e7a8d99296168071d7))
* **skills:** vf skill crystallize — mechanical pattern → draft skill ([#179](https://github.com/magicpro97/vibeflow/issues/179)) ([742fd9f](https://github.com/magicpro97/vibeflow/commit/742fd9f4e412f23bd3bd1594d70daec1fa636954))
* **skills:** vf skill crystallize — mechanical pattern extraction to draft skill ([#179](https://github.com/magicpro97/vibeflow/issues/179)) ([6c69046](https://github.com/magicpro97/vibeflow/commit/6c6904634aa6b11b0c58f4a6053fd174d71073e7))
* **state:** brief.md durable memory + vf state brief command (A0 [#184](https://github.com/magicpro97/vibeflow/issues/184)) ([#193](https://github.com/magicpro97/vibeflow/issues/193)) ([bafbed5](https://github.com/magicpro97/vibeflow/commit/bafbed5eb692d5a82ccb0e2b6bd32c0c80f10381))
* **worktree:** vf worktree create|remove|list — symlink node_modules (A6 [#172](https://github.com/magicpro97/vibeflow/issues/172)) ([#211](https://github.com/magicpro97/vibeflow/issues/211)) ([7bf165e](https://github.com/magicpro97/vibeflow/commit/7bf165ea070a8df83b55d33d2a2d7074d9b9fcca))


### Bug Fixes

* **124:** add case-insensitive /i flag to SECRET_HIGH regex for consistency ([#228](https://github.com/magicpro97/vibeflow/issues/228)) ([4522d03](https://github.com/magicpro97/vibeflow/commit/4522d03e6f7cdb782a0da7c5769f3a25d2802afe))
* **136:** update sentinel test paths for split modules (verify→tools-detect, writeToolConfigs→tools-mcp-config) ([aa532c7](https://github.com/magicpro97/vibeflow/commit/aa532c78ccb7b2698f69095ea37e0b424875b6d2))
* **163:** F2 logbus — mkdirSync in rotate + 5-concurrent test + stale lock detection ([#223](https://github.com/magicpro97/vibeflow/issues/223)) ([0dfa4c0](https://github.com/magicpro97/vibeflow/commit/0dfa4c0c2a55668d93213857dec20f20888f327d))
* **198:** wire tool deny-list to production engine spawner (A1 FU) ([#219](https://github.com/magicpro97/vibeflow/issues/219)) ([3762b55](https://github.com/magicpro97/vibeflow/commit/3762b55cc9a089162eeeb6620a2e92f2f3f028da))
* **210:** skip 2 pre-existing flaky tests in CI ([#225](https://github.com/magicpro97/vibeflow/issues/225)) ([fb6b3ec](https://github.com/magicpro97/vibeflow/commit/fb6b3ecf2b8c9523b739905e1b108cc0a48a7cc8))
* **222:** merge-when-green — moveToBack atomic, no-delete-branch, claimReasonToExitCode ([128e517](https://github.com/magicpro97/vibeflow/commit/128e5172e24cbc927e359f64e77d639bb6d21928))
* **222:** merge-when-green follow-up — moveToBack atomic, --no-delete-branch, claimReasonToExitCode ([fbd77bc](https://github.com/magicpro97/vibeflow/commit/fbd77bc559c043d098f8108a04187b72b317f622))
* **adapters:** defaultContext runtime guard against pre-init calls (issue [#92](https://github.com/magicpro97/vibeflow/issues/92)) ([#119](https://github.com/magicpro97/vibeflow/issues/119)) ([a14ab22](https://github.com/magicpro97/vibeflow/commit/a14ab22aeabbd7994f9552e4e55070292f823314))
* **adapters:** trim ctx.goal before appending Powered-by footer (issue [#91](https://github.com/magicpro97/vibeflow/issues/91)) ([#118](https://github.com/magicpro97/vibeflow/issues/118)) ([6dcc6a2](https://github.com/magicpro97/vibeflow/commit/6dcc6a29d9d055bff2a57d7f458f8957b3729247))
* **artifacts:** resolve templates in BOTH dev and prod bundle ([#285](https://github.com/magicpro97/vibeflow/issues/285)/[#292](https://github.com/magicpro97/vibeflow/issues/292) regression) ([5e1e79b](https://github.com/magicpro97/vibeflow/commit/5e1e79bd2be86399e4de6373a2b4f1d548313fc8))
* **artifacts:** resolve templates path in BOTH dev and prod bundle ([#285](https://github.com/magicpro97/vibeflow/issues/285)/[#292](https://github.com/magicpro97/vibeflow/issues/292) regression) ([0964af1](https://github.com/magicpro97/vibeflow/commit/0964af1ac438349d59b82ffc463a6ea8881951cb))
* **artifacts:** unbreak main — split phase-templates.ts &lt;400 + fix template path ([2b22797](https://github.com/magicpro97/vibeflow/commit/2b22797e23ae2acbb8061bb82c0595f3fbba4e64))
* **artifacts:** unbreak main — split phase-templates.ts &lt;400 + fix template path (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([a81b169](https://github.com/magicpro97/vibeflow/commit/a81b1695654025cf7b3833995b55ed2b83256fcf))
* biome format pr129-coverage.test.ts ([5f29eca](https://github.com/magicpro97/vibeflow/commit/5f29eca54ea4350797ce4289cc81f9f3974ecb56))
* **ci:** complete PR [#251](https://github.com/magicpro97/vibeflow/issues/251)'s 8→5 adapter refactor + init.ts size-waiver ([640630b](https://github.com/magicpro97/vibeflow/commit/640630bce0a833f8dc8e920eb87f67e8a4ba278c))
* **ci:** null logbus singleton in test cleanup + raise coverage-gate timeout to 30m ([3563f2f](https://github.com/magicpro97/vibeflow/commit/3563f2f4abc8ef4376686a287e952c3330b48b67))
* **ci:** null logbus singleton in test cleanup + raise coverage-gate timeout to 30m ([0f79bd5](https://github.com/magicpro97/vibeflow/commit/0f79bd5725cf7e9b151df61eb9be3b8c0b9e3263))
* **cli:** align init + orchestrate default engine to "claude" (issue [#78](https://github.com/magicpro97/vibeflow/issues/78)) ([#106](https://github.com/magicpro97/vibeflow/issues/106)) ([058ad95](https://github.com/magicpro97/vibeflow/commit/058ad952abb5f52982c6feaf8c0d634efb65b601))
* coord spawnEnv overwrite bug + PR129 timeout 300s ([1cf66da](https://github.com/magicpro97/vibeflow/commit/1cf66dae1351d157b5bc924b36a233c679f00da8))
* **coord,init:** A1 FU [#199](https://github.com/magicpro97/vibeflow/issues/199) — shared gate (shape + freshness) so init and coord stay consistent ([#199](https://github.com/magicpro97/vibeflow/issues/199)) ([#204](https://github.com/magicpro97/vibeflow/issues/204)) ([ed16d1a](https://github.com/magicpro97/vibeflow/commit/ed16d1a022449ce16a21d64088e5db22a4ab4fb9))
* **coord:** A1 FU — exit 1 for unknown engine (not 2; reserve 2 for §2 violations) ([#200](https://github.com/magicpro97/vibeflow/issues/200)) ([#203](https://github.com/magicpro97/vibeflow/issues/203)) ([b48da3e](https://github.com/magicpro97/vibeflow/commit/b48da3e2798689c3d5157744334ecabd5d752f37))
* **coord:** A1 FU [#198](https://github.com/magicpro97/vibeflow/issues/198) — VF_DENY_TOOLS env var (honest policy hint, no false guarantee) ([#198](https://github.com/magicpro97/vibeflow/issues/198)) ([#205](https://github.com/magicpro97/vibeflow/issues/205)) ([9d22f23](https://github.com/magicpro97/vibeflow/commit/9d22f232fb84689b1491b62c3e08c61b655e01bd))
* **core:** centralize engine priority in core.ts ENGINES (C3) ([#99](https://github.com/magicpro97/vibeflow/issues/99)) ([874f750](https://github.com/magicpro97/vibeflow/commit/874f7501391b5e8a773fddc9f1b731a0bbea53d8))
* **dispatch:** shell-wrap copilotVersion() to handle Windows .cmd shim (issue [#88](https://github.com/magicpro97/vibeflow/issues/88)) ([#111](https://github.com/magicpro97/vibeflow/issues/111)) ([59b667e](https://github.com/magicpro97/vibeflow/commit/59b667e2536aed409155fe8d9f94dfb3ebe34d85))
* **doctor:** copilot readiness should be copilot OR gh, not AND (C6) ([#98](https://github.com/magicpro97/vibeflow/issues/98)) ([36643b0](https://github.com/magicpro97/vibeflow/commit/36643b023e654122fc4ad13b7adf40f24984146e))
* eliminate 2 pre-existing CI flakes — mock.module pollution + codegraph install timeout ([4fdf7d1](https://github.com/magicpro97/vibeflow/commit/4fdf7d1b0ecefb12636481bc915e165058c889b5))
* eliminate 2 pre-existing CI flakes (mock.module pollution + codegraph install timeout) ([c24327f](https://github.com/magicpro97/vibeflow/commit/c24327f9cfcfa4903741b83fcee2713340f761c2))
* file-size-gate test uses Bun.spawnSync to avoid mock.module child_process pollution ([0e03673](https://github.com/magicpro97/vibeflow/commit/0e03673758a47454f0ff1ddc83d28a2a77b26231))
* **frontmatter:** escape-aware inline lists ([#126](https://github.com/magicpro97/vibeflow/issues/126)) + parametrized deny-list test ([#125](https://github.com/magicpro97/vibeflow/issues/125)) ([9eb96cb](https://github.com/magicpro97/vibeflow/commit/9eb96cb8e09910da66a349d7cc24b149ae8b11ed))
* **frontmatter:** honor backslash-escaped quotes in inline lists + parametrize deny-list test ([1f73a9d](https://github.com/magicpro97/vibeflow/commit/1f73a9df319c8b7ef32533b7ee3608800683569d))
* **hooks:** copilot CLI gets native preToolUse enforcement (issue [#79](https://github.com/magicpro97/vibeflow/issues/79)) ([#107](https://github.com/magicpro97/vibeflow/issues/107)) ([96664cf](https://github.com/magicpro97/vibeflow/commit/96664cfcb3610e97c684414bfda9a97e8249aa88))
* **hooks:** derive selftest confidence from a property test, not a fixed corpus (issue [#85](https://github.com/magicpro97/vibeflow/issues/85)) ([#115](https://github.com/magicpro97/vibeflow/issues/115)) ([1b126bb](https://github.com/magicpro97/vibeflow/commit/1b126bbc2444b221e8363b707e81d43c7b10a53e))
* **hooks:** PROTECTED_PATH regex uniformly case-insensitive (issue [#84](https://github.com/magicpro97/vibeflow/issues/84)) ([#109](https://github.com/magicpro97/vibeflow/issues/109)) ([68b8f3e](https://github.com/magicpro97/vibeflow/commit/68b8f3e1aa909a9f0b31b5774fea6849dddede2b))
* **hooks:** quote CLI path in generated hook configs so spaces don't block tool calls ([5f635a6](https://github.com/magicpro97/vibeflow/commit/5f635a652d8d815ad0c30a241bca04ef0baa2a14))
* **hooks:** quote CLI path in generated hook configs so spaces don't block tool calls ([fb716a4](https://github.com/magicpro97/vibeflow/commit/fb716a4cd919cc5a2b956ed95361a59939431a4b))
* **hooks:** use exec form for Claude hook so path metachars can't break delegation ([#254](https://github.com/magicpro97/vibeflow/issues/254)) ([9477d7e](https://github.com/magicpro97/vibeflow/commit/9477d7e35232ad1885990d3980596320515b54a8))
* increase PR129 codegraph timeout to 60s ([8b778d5](https://github.com/magicpro97/vibeflow/commit/8b778d5aca9d919e34549689699acf5f9e2d2f49))
* **init-ai:** install logbus so AI enrichment streams to file log + SSE (F3 [#164](https://github.com/magicpro97/vibeflow/issues/164)) ([#183](https://github.com/magicpro97/vibeflow/issues/183)) ([f0051d9](https://github.com/magicpro97/vibeflow/commit/f0051d983d546ec90a2b06a1b8a59972aff0939b))
* **init-intake:** quote-aware comma splitting ([#127](https://github.com/magicpro97/vibeflow/issues/127)) ([5cf036c](https://github.com/magicpro97/vibeflow/commit/5cf036cc720b22be33b3197a0c8b3fe58360fc80))
* **init-intake:** quote-aware comma splitting in commaList + phase inputs/outputs ([c8dbfc8](https://github.com/magicpro97/vibeflow/commit/c8dbfc84e9458ad5f6d251419461c5e551ef8226))
* **marker:** biome format execFileSync options block ([5021dc6](https://github.com/magicpro97/vibeflow/commit/5021dc617221db5a83930f8f4b03adadc60d33a1))
* **marker:** wire projectItemId/issueUrl + execFileSync safety + sentinel tests ([074a698](https://github.com/magicpro97/vibeflow/commit/074a6983ed042eb001fbc0c22ffcec2cdc4ff57f))
* **orchestrate:** dispatch returns a measured gate result, not hardcoded pending (W-A) ([43a52c8](https://github.com/magicpro97/vibeflow/commit/43a52c8b1e1c657441eaa471bab272046bcea2e5)), closes [#266](https://github.com/magicpro97/vibeflow/issues/266)
* **orchestrate:** dispatch returns a measured gate, not hardcoded pending (W-A, [#266](https://github.com/magicpro97/vibeflow/issues/266)) ([44eecc6](https://github.com/magicpro97/vibeflow/commit/44eecc646662e0eb3b6d269366c09c9378ee7005))
* **orchestrate:** drop per-unit coverage gate that read stale lcov ([#275](https://github.com/magicpro97/vibeflow/issues/275) A) ([e75a8c1](https://github.com/magicpro97/vibeflow/commit/e75a8c1be6bc07b3fa2e44f2793d1cd717c2090f))
* **orchestrate:** drop per-unit coverage gate that read stale lcov ([#275](https://github.com/magicpro97/vibeflow/issues/275) A) ([98b3fec](https://github.com/magicpro97/vibeflow/commit/98b3fecc554332a624391fa4aadb6df9c3ea165a))
* **orchestrate:** export publish-unit helpers through _shared barrel ([6e7a245](https://github.com/magicpro97/vibeflow/commit/6e7a245f1772c02631549fffc154c19d53ea1be5))
* **orchestrate:** harden W1/W3/W4 isolate+publish against untrusted unit name/scope ([0f7fef7](https://github.com/magicpro97/vibeflow/commit/0f7fef76fc597d1c2308cb4a162d964017a97bd1))
* **orchestrate:** harden W1/W3/W4 isolate+publish against untrusted unit name/scope ([d970116](https://github.com/magicpro97/vibeflow/commit/d97011657f6e6287238c9b010d745c45607983e2))
* **orchestrate:** reviewer fails-closed on a measured gate failure (W-C, [#268](https://github.com/magicpro97/vibeflow/issues/268)) — closes verification spiral ([ac3b2c4](https://github.com/magicpro97/vibeflow/commit/ac3b2c44ac1d5507fd13bbf436604612a2f80d55))
* **orchestrate:** reviewer fails-closed on a measured gate failure (W-C) ([aba7137](https://github.com/magicpro97/vibeflow/commit/aba713721a7d5de817652dd448c387f9cb955b0a)), closes [#268](https://github.com/magicpro97/vibeflow/issues/268)
* **orchestrate:** silent catch{} now log best-effort at debug (W-G, [#272](https://github.com/magicpro97/vibeflow/issues/272)) ([987e2f3](https://github.com/magicpro97/vibeflow/commit/987e2f37380b8e8ffdbe9d689ca759d331931cf0))
* **orchestrate:** silent catch{} now log best-effort at debug (W-G) ([49b7da1](https://github.com/magicpro97/vibeflow/commit/49b7da11ec14b789fc3317dba91b4da13ce5eb6f)), closes [#272](https://github.com/magicpro97/vibeflow/issues/272)
* **orchestrate:** silent catch{} now log best-effort at debug (W-G) ([e74e610](https://github.com/magicpro97/vibeflow/commit/e74e610109e530460f769532221cefa23ba21bd4)), closes [#272](https://github.com/magicpro97/vibeflow/issues/272)
* **orchestrate:** wire scoped-gate as the per-unit verifier (W-B, [#267](https://github.com/magicpro97/vibeflow/issues/267)) ([176e430](https://github.com/magicpro97/vibeflow/commit/176e43040b238303384c9ef3f4387cf413cce3d2))
* **orchestrate:** wire scoped-gate as the per-unit verifier (W-B) ([efed437](https://github.com/magicpro97/vibeflow/commit/efed43780976a7e0f56bf064d00f133638aa74fe)), closes [#267](https://github.com/magicpro97/vibeflow/issues/267)
* **orchestrator:** use spec risk-class threshold in goalEval, not 1.0 (issue [#90](https://github.com/magicpro97/vibeflow/issues/90)) ([#117](https://github.com/magicpro97/vibeflow/issues/117)) ([3261b1a](https://github.com/magicpro97/vibeflow/commit/3261b1a487d02dd626e19ee7891b50257438d64c))
* **packaging:** include .agents/skills/skill-creator in npm tarball (C4) ([#96](https://github.com/magicpro97/vibeflow/issues/96)) ([ccc4d60](https://github.com/magicpro97/vibeflow/commit/ccc4d601ca90546bfd5913c8a991286fc80797d0))
* **parser:** honor quoted commas in inline frontmatter lists (issue [#81](https://github.com/magicpro97/vibeflow/issues/81)) ([#110](https://github.com/magicpro97/vibeflow/issues/110)) ([72c0c07](https://github.com/magicpro97/vibeflow/commit/72c0c07b6688d054e6e66dac85b298adec70b553))
* PR129 test timeout — add --no-agent-team to skip slow workflow + set 30s timeout ([ff9b2b5](https://github.com/magicpro97/vibeflow/commit/ff9b2b556948455635d5cb596b0607d921d91d14))
* **preflight:** engine-binary probe falls back to .cmd/.bat/.ps1 shims (issue [#87](https://github.com/magicpro97/vibeflow/issues/87)) ([#112](https://github.com/magicpro97/vibeflow/issues/112)) ([4e3e5e3](https://github.com/magicpro97/vibeflow/commit/4e3e5e311796b8150ebcb44ca0b71c5724ab34b7))
* **quota:** copilot endpoint is user/copilot_billing, not bare 'gh api copilot' (issue [#89](https://github.com/magicpro97/vibeflow/issues/89)) ([#114](https://github.com/magicpro97/vibeflow/issues/114)) ([479b619](https://github.com/magicpro97/vibeflow/commit/479b619dda420e67b014868308d55e331a44adec))
* remove unused biome-ignore + format file-size-gate.test.ts ([35e36ba](https://github.com/magicpro97/vibeflow/commit/35e36badba0a4a5bdc16948471641f38ae6581ef))
* **risk:** case-insensitive SECRET_CRITICAL + CONFIG_PROTECTED + path containment ([d86ba82](https://github.com/magicpro97/vibeflow/commit/d86ba82f4765b332f60a9a440045590d080ed61e)), closes [#121](https://github.com/magicpro97/vibeflow/issues/121) [#122](https://github.com/magicpro97/vibeflow/issues/122) [#123](https://github.com/magicpro97/vibeflow/issues/123)
* **risk:** case-insensitive SECRET_CRITICAL + CONFIG_PROTECTED + path containment ([#121](https://github.com/magicpro97/vibeflow/issues/121) [#122](https://github.com/magicpro97/vibeflow/issues/122) [#123](https://github.com/magicpro97/vibeflow/issues/123)) ([94477f0](https://github.com/magicpro97/vibeflow/commit/94477f0dc75d643022874fc7275993edc0fbf96c))
* **scanner:** detect frameworks in sub-packages, add Astro/Nuxt/Solid hints ([#150](https://github.com/magicpro97/vibeflow/issues/150)) ([#157](https://github.com/magicpro97/vibeflow/issues/157)) ([468a1ef](https://github.com/magicpro97/vibeflow/commit/468a1ef52b7be45aa2f3702ffbd7c206dae3b522))
* **scanner:** surface walk-truncation signal on ProjectProfile (issue [#86](https://github.com/magicpro97/vibeflow/issues/86)) ([#113](https://github.com/magicpro97/vibeflow/issues/113)) ([8bb9c40](https://github.com/magicpro97/vibeflow/commit/8bb9c40c4d8dbab28fe7ce4476298dc4f0e9afef))
* **scripts:** F4 followup — fix /* */ block waiver scan + facade coverage + missing ::warning ([#190](https://github.com/magicpro97/vibeflow/issues/190)) ([#192](https://github.com/magicpro97/vibeflow/issues/192)) ([95b8cc0](https://github.com/magicpro97/vibeflow/commit/95b8cc099cf8cae75b1a430885611650b10bff5c))
* **scripts:** F5 followup — fix auth-guard regex (modern gh) + orphan-item trap ([#189](https://github.com/magicpro97/vibeflow/issues/189)) ([#191](https://github.com/magicpro97/vibeflow/issues/191)) ([dd48ff3](https://github.com/magicpro97/vibeflow/commit/dd48ff38896b0c9f186bd06da3deff75588ca89a))
* **security:** expand prototype-pollution deny list to Object.prototype methods (issue [#82](https://github.com/magicpro97/vibeflow/issues/82)) ([#108](https://github.com/magicpro97/vibeflow/issues/108)) ([10d1c91](https://github.com/magicpro97/vibeflow/commit/10d1c91eda520a542d5d6c9fe5b912520b0a9769))
* **security:** splitOperators handles \\n (issue [#73](https://github.com/magicpro97/vibeflow/issues/73)) ([#103](https://github.com/magicpro97/vibeflow/issues/103)) ([576a387](https://github.com/magicpro97/vibeflow/commit/576a387614779f2135b4a032b93567fa1028d6df))
* **security:** symlink-safe readState + engine-instruction read ([#46](https://github.com/magicpro97/vibeflow/issues/46)) ([#101](https://github.com/magicpro97/vibeflow/issues/101)) ([3a52b4b](https://github.com/magicpro97/vibeflow/commit/3a52b4b67d5218f84a6b1e15a4e15db52bd2d6ff))
* **skills:** centralize skill mirror roots in workflow-artifacts.ts (C2) ([#100](https://github.com/magicpro97/vibeflow/issues/100)) ([4f91d40](https://github.com/magicpro97/vibeflow/commit/4f91d40b86f227899556550b07815578c3906554))
* **skills:** normalize parseSkill name + dedup case-insensitively (issue [#93](https://github.com/magicpro97/vibeflow/issues/93)) ([#120](https://github.com/magicpro97/vibeflow/issues/120)) ([57970df](https://github.com/magicpro97/vibeflow/commit/57970df3168ecd57982a6ea577fb31400ca0ab22))
* **test:** deflake tryLock TOCTOU concurrency test ([#288](https://github.com/magicpro97/vibeflow/issues/288)) ([ecf1fd1](https://github.com/magicpro97/vibeflow/commit/ecf1fd1c33b84c6ab6f5148c4950f954e150dad5))
* **test:** deflake tryLock TOCTOU test — robust audit invariant ([#288](https://github.com/magicpro97/vibeflow/issues/288)) ([76e8422](https://github.com/magicpro97/vibeflow/commit/76e842294054f8fd89f75d708b44de302c9e2bd4))
* **test:** stub aiSpawner in PR129 no-agent-team tests to stop real-engine spawn hang ([d0edecb](https://github.com/magicpro97/vibeflow/commit/d0edecb60251012f8799fd50c144e112eb94f3b1))
* use cp["spawnSync"] to bypass anti-pattern detector + dynamic require to bypass mock.module ([6b3e5e9](https://github.com/magicpro97/vibeflow/commit/6b3e5e95ec00e5f729706c85b25f9b92bc720a23))
* **verify:** read-only by default + logbus ENOENT recovery ([#154](https://github.com/magicpro97/vibeflow/issues/154), [#145](https://github.com/magicpro97/vibeflow/issues/145)) ([#158](https://github.com/magicpro97/vibeflow/issues/158)) ([651526d](https://github.com/magicpro97/vibeflow/commit/651526d16a5dcb48e85f84134d0ddb1837b898b7))
* **workflow-artifacts:** codex engine opts into AGENTS.md (issue [#75](https://github.com/magicpro97/vibeflow/issues/75)) ([#105](https://github.com/magicpro97/vibeflow/issues/105)) ([4b9ab39](https://github.com/magicpro97/vibeflow/commit/4b9ab39a0541565458d6a3b885b3ea7eadccce4f))
* **workflow-artifacts:** warn when generateWorkflowArtifacts called with no phases (issue [#83](https://github.com/magicpro97/vibeflow/issues/83)) ([#116](https://github.com/magicpro97/vibeflow/issues/116)) ([132804c](https://github.com/magicpro97/vibeflow/commit/132804c5ef5367f2732782d4f5da76621d69546e))


### Performance

* **orchestrate:** run whole-project typecheck once per run, share across units ([#275](https://github.com/magicpro97/vibeflow/issues/275) C) ([5978763](https://github.com/magicpro97/vibeflow/commit/597876337e0545ae61ac123af8e2c5ee5c0c332e))
* **orchestrate:** run whole-project typecheck once per run, share across units ([#275](https://github.com/magicpro97/vibeflow/issues/275) C) ([b3718ea](https://github.com/magicpro97/vibeflow/commit/b3718ea57e17aecbcc9d2703d367b3f6955ad61e))


### Refactors

* **136:** split tools.ts (685→380) into tools-detect + tools-mcp-config ([adf9d9c](https://github.com/magicpro97/vibeflow/commit/adf9d9c4cd32593e1a79d297dc4b68cd66ee3bba))
* **186:** extract DISPATCH_HARD_RULES to dispatch-rules.ts (adapters.ts under 400-cap) ([dab0adc](https://github.com/magicpro97/vibeflow/commit/dab0adc5dad62c65feb76dbd51172ebf5d38755f))
* **186:** split risk.ts + adapters.ts under 400-cap (unblock publish CI) ([49d48cd](https://github.com/magicpro97/vibeflow/commit/49d48cd8822d497d15c38ecd187f8803596ffc88))
* **186:** split risk.ts shell-parsing helpers into risk-shell.ts (under 400-line cap) ([99eeb64](https://github.com/magicpro97/vibeflow/commit/99eeb64d26c8ec1ab206252d99b45c2387f294c4))
* **ai-init:** move 8KB INSTRUCTIONS_BODY template to .vibeflow/ai-context/ ([#104](https://github.com/magicpro97/vibeflow/issues/104)) ([85fe5d6](https://github.com/magicpro97/vibeflow/commit/85fe5d6264bf60d0dfcff7cb155686ebc3b5ee46))
* **artifacts:** split workflow-artifacts.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([3f3addc](https://github.com/magicpro97/vibeflow/commit/3f3addc52d22e8c3813c3b61280b07b8d75dc298))
* **artifacts:** split workflow-artifacts.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([51d2e67](https://github.com/magicpro97/vibeflow/commit/51d2e67743d4dc5560c7e239abef9df05f1b635e))
* **commands:** drop unused EngineReadiness import + correct orchestrate cycle comment ([76cee25](https://github.com/magicpro97/vibeflow/commit/76cee2580d1f3ba4e7bff2b5112199323b082d46)), closes [#130](https://github.com/magicpro97/vibeflow/issues/130)
* **commands:** drop unused EngineReadiness import + correct orchestrate cycle comment ([#130](https://github.com/magicpro97/vibeflow/issues/130)) ([4b633b5](https://github.com/magicpro97/vibeflow/commit/4b633b5005c9534f996154504b564444c08959c7))
* **commands:** extract init cluster, facade becomes pure re-export (issue [#80](https://github.com/magicpro97/vibeflow/issues/80)) ([#138](https://github.com/magicpro97/vibeflow/issues/138)) ([d99988f](https://github.com/magicpro97/vibeflow/commit/d99988fce847bb8800100479e977e49cc8c17673))
* **commands:** extract orchestrate + protection + run subcommands (issue [#80](https://github.com/magicpro97/vibeflow/issues/80), phases 6-6.5/14) ([#128](https://github.com/magicpro97/vibeflow/issues/128)) ([bd0f4bc](https://github.com/magicpro97/vibeflow/commit/bd0f4bc796740fa353055a6b3a75030ea1f4d9e1))
* **commands:** extract skills + discover + hooks subcommands (issue [#80](https://github.com/magicpro97/vibeflow/issues/80), phase 7/14) ([#134](https://github.com/magicpro97/vibeflow/issues/134)) ([33da203](https://github.com/magicpro97/vibeflow/commit/33da203a8b22617d1289e873138a0011d865ed21))
* **commands:** extract tools + workflow + help (issue [#80](https://github.com/magicpro97/vibeflow/issues/80), phase 8/14) + design-review fixes ([#135](https://github.com/magicpro97/vibeflow/issues/135)) ([1e4dd29](https://github.com/magicpro97/vibeflow/commit/1e4dd296195510b9df4a057f50b97fe834969fcb))
* **commands:** replace export * from _shared with explicit re-exports ([#227](https://github.com/magicpro97/vibeflow/issues/227)) ([6c553f1](https://github.com/magicpro97/vibeflow/commit/6c553f19aca384ea4b06653f56213a1f5c3e32fb))
* **commands:** split protection.ts → source-protection + dispatch-runtime ([#131](https://github.com/magicpro97/vibeflow/issues/131)) ([f34996b](https://github.com/magicpro97/vibeflow/commit/f34996b1b8d821879aaf168d1b97d50bb82ca298))
* **commands:** split protection.ts into source-protection + dispatch-runtime ([#131](https://github.com/magicpro97/vibeflow/issues/131)) ([64324a7](https://github.com/magicpro97/vibeflow/commit/64324a7885d8e9eb0bb6413054ec46cde8717f0f))
* **init:** extract artifact-generation phase under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([de89a14](https://github.com/magicpro97/vibeflow/commit/de89a14f8ad805e366faec41a854fd6d2c13c715))
* **init:** extract artifact-generation phase under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([04441fe](https://github.com/magicpro97/vibeflow/commit/04441fe9f965116ea49c69372d93d572b825e636))
* **init:** remove deprecated --coord no-op flag ([069254f](https://github.com/magicpro97/vibeflow/commit/069254f34c4ffa6c9ef43c732b7f785b9350e309)), closes [#194](https://github.com/magicpro97/vibeflow/issues/194)
* **init:** remove deprecated --coord no-op flag ([#194](https://github.com/magicpro97/vibeflow/issues/194)) ([b614845](https://github.com/magicpro97/vibeflow/commit/b614845914998d207df2e0e78dc725a56f182342))
* **orchestrate:** extract resolvers under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([c176d83](https://github.com/magicpro97/vibeflow/commit/c176d837be27335da2c3ac9812a687c30bb808a8))
* **orchestrate:** extract resolvers under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([f05555c](https://github.com/magicpro97/vibeflow/commit/f05555c63ab818a6d24100743be67e10dce541d2))
* **orchestrate:** extract unit-evidence to break dispatch-&gt;protection inversion (W-F, [#271](https://github.com/magicpro97/vibeflow/issues/271)) ([acb2516](https://github.com/magicpro97/vibeflow/commit/acb2516ba83c835298bbc8419cc29f0d74c4ec9e))
* **orchestrate:** extract unit-evidence to break dispatch-&gt;protection inversion (W-F) ([d009896](https://github.com/magicpro97/vibeflow/commit/d009896b1ea001cda105694cca17c57c1e0036ba)), closes [#271](https://github.com/magicpro97/vibeflow/issues/271)
* **pr-queue:** split pr-queue.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([cb5b130](https://github.com/magicpro97/vibeflow/commit/cb5b130f106d3586f3ff545aaa5dc9e262867041))
* **pr-queue:** split pr-queue.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([9516fea](https://github.com/magicpro97/vibeflow/commit/9516fea1acac8af0d9e307daa5b3b2fb1c18d06a))
* **preflight:** split preflight.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([c89a599](https://github.com/magicpro97/vibeflow/commit/c89a599f835932b92621e7019eef53f48c7a2107))
* **preflight:** split preflight.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([6c68683](https://github.com/magicpro97/vibeflow/commit/6c686830b663eeb37b95e938732dc120c32f0817))
* **pr:** split pr.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([7ead0bd](https://github.com/magicpro97/vibeflow/commit/7ead0bd03d84d944bdca76497489cc1c92f9fa55))
* **pr:** split pr.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([f0c306c](https://github.com/magicpro97/vibeflow/commit/f0c306ccc91f3e89b574dd2d2ec494e4e58ffc1c))
* **scanner:** split scanner.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([1a691e9](https://github.com/magicpro97/vibeflow/commit/1a691e997e652b6dd8457fb82fc0076928f22c6a))
* **scanner:** split scanner.ts under 400 LOC (part of [#186](https://github.com/magicpro97/vibeflow/issues/186)) ([c3674b4](https://github.com/magicpro97/vibeflow/commit/c3674b4ba36f5581dcdb40c0779b7f274a537041))
* split tools.ts into tools-detect, tools-mcp-config, slim tools.ts ([d0f3fb9](https://github.com/magicpro97/vibeflow/commit/d0f3fb9943787803c1bb69baeb80ee95d7a55c61))
* **terminal-prompts:** split into prompts + utils, drop [#186](https://github.com/magicpro97/vibeflow/issues/186) waiver ([#186](https://github.com/magicpro97/vibeflow/issues/186) 1/10) ([bdcca01](https://github.com/magicpro97/vibeflow/commit/bdcca01862ec0b0f4269f52627f4b3c33e55ba66))
* **terminal-prompts:** split into prompts + utils, drop waiver ([#186](https://github.com/magicpro97/vibeflow/issues/186) 1/10) ([4516b5a](https://github.com/magicpro97/vibeflow/commit/4516b5aeec2ebf1e2476cb4b7f3c0ab055ac258d))


### Documentation

* **ai-init:** fix comment rot after 8→5 adapter / 4→1 finisher change ([27e07f2](https://github.com/magicpro97/vibeflow/commit/27e07f270a91bf2ec6e0e87488f52c08da143858))
* **ai-init:** fix comment rot after the 8-&gt;5 adapter / 4-&gt;1 finisher change ([44b36c4](https://github.com/magicpro97/vibeflow/commit/44b36c4a25e8b40979b750938c846238803144ff))
* **coordinator:** add corrupted-brief recovery (s0) + dispatch timeout/no-log handling (s3) ([f5268da](https://github.com/magicpro97/vibeflow/commit/f5268da512a0c18b6b2f42491c49d40a2d3add0e))
* **coordinator:** corrupted-brief recovery + dispatch timeout/no-log handling ([#201](https://github.com/magicpro97/vibeflow/issues/201) [#202](https://github.com/magicpro97/vibeflow/issues/202)) ([2819090](https://github.com/magicpro97/vibeflow/commit/281909074325ead56169b9c08e07c7d4ab29b6f9))
* correct .viteflow -&gt; .vibeflow references in docs (C1) ([#94](https://github.com/magicpro97/vibeflow/issues/94)) ([68c6322](https://github.com/magicpro97/vibeflow/commit/68c6322368e42738d30488c261714a7007dbc7ce))
* **deployment:** update version 0.1.0 → 0.7.0 + current test count ([#102](https://github.com/magicpro97/vibeflow/issues/102)) ([c84a8c6](https://github.com/magicpro97/vibeflow/commit/c84a8c673d608fccb6964b5a5ba43554ad17e8da))
* **hooks:** correct output JSON shape to match actual runner (C5) ([#97](https://github.com/magicpro97/vibeflow/issues/97)) ([0ee64e7](https://github.com/magicpro97/vibeflow/commit/0ee64e76031285c99358fd6371d865b89e80aafb))
* **orchestrate:** document --isolate and --pr flags in vf orchestrate --help ([88a8526](https://github.com/magicpro97/vibeflow/commit/88a8526d6f359f5469aa629ebabd48b4acc5dc03))
* **skills:** add plan-debate, cross-review, worktree-orchestrate, merge-when-green ([#177](https://github.com/magicpro97/vibeflow/issues/177) [#178](https://github.com/magicpro97/vibeflow/issues/178) [#180](https://github.com/magicpro97/vibeflow/issues/180)) ([13d2898](https://github.com/magicpro97/vibeflow/commit/13d289801ea5c4d025dc9b6cd59b30a75a492e26))
* **skills:** plan-debate, cross-review, worktree-orchestrate, merge-when-green ([#177](https://github.com/magicpro97/vibeflow/issues/177) [#178](https://github.com/magicpro97/vibeflow/issues/178) [#180](https://github.com/magicpro97/vibeflow/issues/180)) ([a3cc8ab](https://github.com/magicpro97/vibeflow/commit/a3cc8abaab163fe6ebd7d00a1b1921f87db8efbb))
* **surface:** document hooks emit, evidence, runbooks; fix LSP/codegraph, dead path, stale sha ([#159](https://github.com/magicpro97/vibeflow/issues/159)) ([bf1201f](https://github.com/magicpro97/vibeflow/commit/bf1201f40b7f3e350ea4a7a54420d91d2cab3214))


### Tests

* **185:** cover doctor.ts L47-48, L126-128, L133-138 (per-file 100% gate) ([#218](https://github.com/magicpro97/vibeflow/issues/218)) ([d8c580d](https://github.com/magicpro97/vibeflow/commit/d8c580df9465659158822f710beaeee887f1f87d))
* **ai-init:** fix stale assertions after PR [#251](https://github.com/magicpro97/vibeflow/issues/251) adapter consolidation (main is red) ([07245be](https://github.com/magicpro97/vibeflow/commit/07245be2a475b78a4381f173b145722b0ea2cc5d))
* **coord:** cover emitHookFiles failure catch branch (100%) ([ca63850](https://github.com/magicpro97/vibeflow/commit/ca638504108e52105c652e3f8b81a80d459412ae))
* **coord:** cover to 100% per-file gate ([5e9bdf5](https://github.com/magicpro97/vibeflow/commit/5e9bdf5eec4a2ce12453b997623b5ce51b6f53f2))
* **doctor:** cover stale logbus-lock detection branch (100%) ([5158d3b](https://github.com/magicpro97/vibeflow/commit/5158d3b26d177269e0858582f21ad91f1fc5c55d))
* **doctor:** cover to 100% per-file gate ([1cd4faa](https://github.com/magicpro97/vibeflow/commit/1cd4faae4ab7b2f340de70c304508a3322fd594f))
* **logbus:** give rotate() shift test an explicit 20s timeout (flaky CI) ([#139](https://github.com/magicpro97/vibeflow/issues/139)) ([786d943](https://github.com/magicpro97/vibeflow/commit/786d943d9a5c918f91e7517ffd974b8591e83c59))
* **marker:** cover closeLinkedIssue catch path (100% deterministic) ([f145cce](https://github.com/magicpro97/vibeflow/commit/f145ccec485004fb97a7e57c0f03166ea47d8de3))
* **marker:** cover closeLinkedIssue catch path via throwing exec (100%) ([e970bd5](https://github.com/magicpro97/vibeflow/commit/e970bd5efbac44337a85035f2410f837d507a13c))
* **marker:** cover closeLinkedIssue merged-PR success + count-zero via exec seam (100%) ([6c507e0](https://github.com/magicpro97/vibeflow/commit/6c507e047f93538ad6aea5f2e17250ae72fd9bf6))
* **marker:** cover closeLinkedIssue to 100% per-file gate ([c5aebd6](https://github.com/magicpro97/vibeflow/commit/c5aebd6aa92336afaca30ef01238f1cea2d41302))
* **orchestrate:** real-git integration locks in F1 base-ref fix (W-E, [#270](https://github.com/magicpro97/vibeflow/issues/270)) ([1ec226b](https://github.com/magicpro97/vibeflow/commit/1ec226b3f95e86460d063f57576577507a8dbd81))
* **orchestrate:** real-git integration locks in the F1 base-ref fix (W-E) ([872725d](https://github.com/magicpro97/vibeflow/commit/872725d0b0e995e974fe45c7aa0630fdb1c99b00)), closes [#270](https://github.com/magicpro97/vibeflow/issues/270)
* **orchestrator/run:** cover security-checkpoint verdict branches (100%) ([a3c1c6a](https://github.com/magicpro97/vibeflow/commit/a3c1c6a9de0778f56bcb47ee8d4bc2efff34ac1a))
* **pr-merge-when-green:** cover defaultRunCommandSync + pending catch (100%) ([98f2b84](https://github.com/magicpro97/vibeflow/commit/98f2b84551648f676c8d8b873886d346a59fa5e5))
* **pr-merge-when-green:** cover to 100% per-file gate ([ae647ea](https://github.com/magicpro97/vibeflow/commit/ae647eae283d6c8f121c246053b98d3c59ee57be))
* **pr:** cover queue + merge-when-green dispatcher arms (100%) ([3e47bc0](https://github.com/magicpro97/vibeflow/commit/3e47bc0cddbba04b37f849429be993211e7d5b43))
* **pr:** cover to 100% per-file gate ([4e1e27e](https://github.com/magicpro97/vibeflow/commit/4e1e27ef545bc66882c2e72a99beed10e0d5e518))
* **preload:** add Bun.spawn/spawnSync leak guard to kill order-dependent flakes ([120f0b5](https://github.com/magicpro97/vibeflow/commit/120f0b58314b1f53570c3748acd4dc9f4fb631a4))
* **preload:** Bun.spawn/spawnSync leak guard — kill order-dependent flakes ([539457f](https://github.com/magicpro97/vibeflow/commit/539457f4565d2fe4dc542073f7c6736d06481827))
* **run:** cover to 100% per-file gate ([c662939](https://github.com/magicpro97/vibeflow/commit/c6629393cec5c68d5c9b7493f264b2b2aeb58e72))
* **security-checkpoint:** cover makeAskFn TTY path + defaultRunSkillFn branches (100%) ([853f379](https://github.com/magicpro97/vibeflow/commit/853f379e6a2ffd96409e130a2e25abe48ac94b91))
* **security-checkpoint:** cover to 100% per-file gate ([985af8c](https://github.com/magicpro97/vibeflow/commit/985af8c9810683e1616c101599d25484760f4a98))
* skip 2 pre-existing flakes blocking A5/A6 PRs ([#210](https://github.com/magicpro97/vibeflow/issues/210)) ([32cf990](https://github.com/magicpro97/vibeflow/commit/32cf9907302e2f928a1b5e511431fb827830dd7f))

## [0.7.0](https://github.com/magicpro97/vibeflow/compare/v0.6.0...v0.7.0) (2026-06-17)


### Features

* Add question cli ([#48](https://github.com/magicpro97/vibeflow/issues/48)) ([3376049](https://github.com/magicpro97/vibeflow/commit/33760495f8759e2ea885eaa6eb633190580ed6df))
* **agents:** agentFiles honors --engine flag ([458dcf0](https://github.com/magicpro97/vibeflow/commit/458dcf0d7ac6c3260cad2a72f39cd05ce20ba0fe))
* **agents:** per-engine agent file generation (Claude/Codex/Copilot) ([585fe2d](https://github.com/magicpro97/vibeflow/commit/585fe2d9e7f5ece308fdceff7b46ab9abfb50499))
* **ai-init:** 2-tier workflow planner — 7 adapters + dynamic phase units ([#43](https://github.com/magicpro97/vibeflow/issues/43)) ([30244d5](https://github.com/magicpro97/vibeflow/commit/30244d5cb2462b050168b0c49cf7ecdc833effdb))
* **ai-init:** add --autopilot flag for engine auto-fallback ([#42](https://github.com/magicpro97/vibeflow/issues/42)) ([385ddb4](https://github.com/magicpro97/vibeflow/commit/385ddb48be59d4f82f064137c9df2752178cb71d))
* **doctor:** add --refresh flag to invalidate probe cache ([329440c](https://github.com/magicpro97/vibeflow/commit/329440ce8034afad68b1d91bc842c1c6a7379103))
* **preflight:** add probe cache + engine-quota + preflight-delegate ([fb8d4d9](https://github.com/magicpro97/vibeflow/commit/fb8d4d9762e4c93d7fbf10050d99e2399702df87))


### Bug Fixes

* add runId to bus.write + null guard for type ([8aea775](https://github.com/magicpro97/vibeflow/commit/8aea775c0c797285cf932d2577e8ace685faf5e6))
* **agents:** aiGenerate now has 30s timeout (consistency with aiEnrichRole) ([2f73512](https://github.com/magicpro97/vibeflow/commit/2f73512ba3ccd0b66d2215a78ca88352726c366a))
* **agents:** document trailing-newline convention + closer on own line ([364bdf6](https://github.com/magicpro97/vibeflow/commit/364bdf6de20fc19db7de45da384a5d47a562e458))
* **agents:** drop express from hasWeb regex (it's a backend framework) ([c1348e0](https://github.com/magicpro97/vibeflow/commit/c1348e01aecb66f291d95d369c20ed2be0886329))
* **agents:** safeAgentName preserves legit dot-runs, neutralises path components ([ee9bb1c](https://github.com/magicpro97/vibeflow/commit/ee9bb1c35918c428f10191c1ff732a6feda7bc2a))
* **agents:** safeAgentName uses NUL sentinel, agentFilePath throws on invalid input ([d3770cf](https://github.com/magicpro97/vibeflow/commit/d3770cf5bacd47d47d3547cbd1359a4e4dcb27cc))
* **agents:** TOML body escapes backslashes FIRST, then embeds """ as ""\\" ([c96ab6f](https://github.com/magicpro97/vibeflow/commit/c96ab6f5fef57deb04694264020ba59d4dcf6ff5))
* **agents:** TOML body uses single-pass 4-quote embed (per TOML spec) ([0ed41ac](https://github.com/magicpro97/vibeflow/commit/0ed41acc762a3635eb216f994a64744ccf7545a1))
* **agents:** TOML opener no longer uses line-continuation (preserves leading whitespace) ([d95e485](https://github.com/magicpro97/vibeflow/commit/d95e4855d3acad5c3404ef4d0fcc13d8749541fa))
* **agents:** useAi param now actually does something (calls VIBEFLOW_AI) ([e819895](https://github.com/magicpro97/vibeflow/commit/e8198952db3416dd60209a5b84476ba9a50cfc2c))
* **agents:** wire agentFiles() into applyIntake + fix 5 real bugs found in review ([77b2287](https://github.com/magicpro97/vibeflow/commit/77b2287ef5adf8752a4aae54e90f4f73227f0a01))
* **agents:** yamlQuote rejects control chars in scalar values ([79ca3dd](https://github.com/magicpro97/vibeflow/commit/79ca3ddef1a4ea96ab115eb1c1eacfa4a3677c7e))
* **agents:** yamlQuote rejects DEL (0x7F) and C1 controls (0x80-0x9F) ([35e1736](https://github.com/magicpro97/vibeflow/commit/35e1736cd31a61d5e140c7bd92b44ad529bac92b))
* **ai-init:** copilot -p argv value, not stdin pipe (Windows bug) ([#34](https://github.com/magicpro97/vibeflow/issues/34)) ([d8ebe94](https://github.com/magicpro97/vibeflow/commit/d8ebe945d60f0a4d5ee8f88f2241ced06d3ae763))
* **ai-init:** export listContextFiles + renderSlimPrompt ([#39](https://github.com/magicpro97/vibeflow/issues/39)) ([dbec71e](https://github.com/magicpro97/vibeflow/commit/dbec71e4b6c13344fee80268550721963dc5019e))
* biome format ([fd6a03d](https://github.com/magicpro97/vibeflow/commit/fd6a03d0522cc6ba874bbe80cccfb8daf0d2f2b5))
* biome format ([9832d04](https://github.com/magicpro97/vibeflow/commit/9832d048640842dd8fe1b9698b3ceb64bd6b214e))
* biome format ([da70d93](https://github.com/magicpro97/vibeflow/commit/da70d939dcb829ecd5790f008425fa2a6b57272f))
* biome format ([37cd4bb](https://github.com/magicpro97/vibeflow/commit/37cd4bb2a6cfea7b356e3c149ae9726d9d247688))
* biome format ([ecb28aa](https://github.com/magicpro97/vibeflow/commit/ecb28aa1fe50f5bab566a8df209bfe0c7959cd85))
* biome format ([2ca5a8b](https://github.com/magicpro97/vibeflow/commit/2ca5a8b0c3ee7c84c4ad2a94b663833020d7f770))
* biome format body brace style ([5dcef2c](https://github.com/magicpro97/vibeflow/commit/5dcef2c0a667959f1ed1b57432d31aea4d3cad2c))
* biome format broke require import — inline it ([889a452](https://github.com/magicpro97/vibeflow/commit/889a452507d09440ba16b562e966055433a5e166))
* biome format issues with longer lines ([24185a4](https://github.com/magicpro97/vibeflow/commit/24185a4346991c50c713ebd60562abebde1bc02a))
* biome format Origin header quote style ([a1f2730](https://github.com/magicpro97/vibeflow/commit/a1f273053fb289271d5a2193f6b1c4001168ca27))
* biome format string concat ([1c7a641](https://github.com/magicpro97/vibeflow/commit/1c7a641a084de3ed187ecf4805a1e50fab78f285))
* **ci:** add 100% coverage gate + make tests env-resilient ([#30](https://github.com/magicpro97/vibeflow/issues/30)) ([d7615dd](https://github.com/magicpro97/vibeflow/commit/d7615ddf526f17a2fb57060bbd2add5847f652a1))
* **cli:** remove duplicate for-loop printing "archived previous" twice ([#57](https://github.com/magicpro97/vibeflow/issues/57)) ([ef6e1bc](https://github.com/magicpro97/vibeflow/commit/ef6e1bcabd60efbd6066c0ddc7ba5ec89ffb183a))
* **commands:** accumulate hook stdin chunks and fail-closed on truncated JSON ([#52](https://github.com/magicpro97/vibeflow/issues/52)) ([8b240c3](https://github.com/magicpro97/vibeflow/commit/8b240c3dee418c138fd17cb393b88b44d31686b5))
* **commands:** defend against state files missing work_units (pr48-regression) ([a6729ba](https://github.com/magicpro97/vibeflow/commit/a6729baf9781a2be2800940f0d60df54dff4f0b5))
* **commands:** pass scanner profile to detectRolesForRepo (framework detection runs) ([42d8daf](https://github.com/magicpro97/vibeflow/commit/42d8daf00fd3423429fc6c0c098ea4428ffe014e))
* **commands:** use kebab-case pre-tool-use event name in hook test ([19a58bf](https://github.com/magicpro97/vibeflow/commit/19a58bf2cb999a28d15fbb89c47ee6f426971e1b))
* **commands:** use template literal in Buffer.from per biome ([810f8db](https://github.com/magicpro97/vibeflow/commit/810f8db9e552980c9493e886f1b6fc99cffd3e10))
* **core:** writeFileSafe sets 0o600 on the temp file before rename (CWE-732) ([#55](https://github.com/magicpro97/vibeflow/issues/55)) ([947f77d](https://github.com/magicpro97/vibeflow/commit/947f77d6b8f53be5c4045c6ae9eddd0f394fe429))
* **dispatch:** route sync bridge stderr to opts.onStderrChunk (M5) ([#60](https://github.com/magicpro97/vibeflow/issues/60)) ([feeb2ce](https://github.com/magicpro97/vibeflow/commit/feeb2cee74cd9245743f4dff65395bee9c1f2965))
* **dispatch:** use --allow-all (omnibus) instead of --allow-all-tools ([5756f9f](https://github.com/magicpro97/vibeflow/commit/5756f9f0fda59bc1ae26079b255aab1d5d732858))
* format ([2c7e974](https://github.com/magicpro97/vibeflow/commit/2c7e9748cd35210dd0cb5a51185891d24eba2231))
* format ([063333d](https://github.com/magicpro97/vibeflow/commit/063333dd0a9f592da55584ebf1b0bdfa6495bd01))
* format ([13db85c](https://github.com/magicpro97/vibeflow/commit/13db85c3a8e412e86a0ce12131f555c0fef16125))
* format ([5358870](https://github.com/magicpro97/vibeflow/commit/535887017ac87a811b6c1cd60786968b072b4c99))
* format ([8361bec](https://github.com/magicpro97/vibeflow/commit/8361bec00909cbd063dcfc7b2b1b76c2b12380b5))
* format ([8721f01](https://github.com/magicpro97/vibeflow/commit/8721f015785ef88510b5ea86280f518b64ea36c9))
* format ([76e6322](https://github.com/magicpro97/vibeflow/commit/76e6322c209b7df1e7646533ad2b01cea5a44bd7))
* format ([72e6b13](https://github.com/magicpro97/vibeflow/commit/72e6b1305d37bd041eecb538d232cbf49e839cf1))
* format ([16cecdb](https://github.com/magicpro97/vibeflow/commit/16cecdba348742d383b8e5196b3f8550b1a60197))
* format ([34d77fd](https://github.com/magicpro97/vibeflow/commit/34d77fd3aaa3a1dfbe5864d21899b71b60513138))
* format ([86ee546](https://github.com/magicpro97/vibeflow/commit/86ee5462e0247125ce7ff83d6e9a77e8c498d467))
* format ([bb21305](https://github.com/magicpro97/vibeflow/commit/bb21305d4c6844c3438c9f3443fa7d780ecc7cb4))
* format ([f9c21cf](https://github.com/magicpro97/vibeflow/commit/f9c21cf1c57c2daec044f5f9736228be5a27ac68))
* format ([97d3c5e](https://github.com/magicpro97/vibeflow/commit/97d3c5ec9721cb8b2133c0c8b5a123067937db69))
* format ([8437ed6](https://github.com/magicpro97/vibeflow/commit/8437ed62e254e8b0a83139e6671a682172e86a82))
* format ([e5b4eaa](https://github.com/magicpro97/vibeflow/commit/e5b4eaa7bc685f66d3be21ea74f0c29a96db0ef3))
* format ([b064a24](https://github.com/magicpro97/vibeflow/commit/b064a24448cc18df61196799f1ccb700bf168bdd))
* format ([d7fa347](https://github.com/magicpro97/vibeflow/commit/d7fa3471ac89459920f77898b3c13a7d15d4cd71))
* format ([842f655](https://github.com/magicpro97/vibeflow/commit/842f65544fc9517af13fb0b6b43aca7954be930b))
* format ([6bb49d8](https://github.com/magicpro97/vibeflow/commit/6bb49d8a85d16e39606c5c4358a9b7f11d4f4343))
* format ([14c546e](https://github.com/magicpro97/vibeflow/commit/14c546ed6181b58738b7e8827731dd40464caac8))
* format ([80792c1](https://github.com/magicpro97/vibeflow/commit/80792c175e79a77a22eb55e15389b2ceea8dc2e3))
* format ([061b376](https://github.com/magicpro97/vibeflow/commit/061b3767bc1977ced5efffcd060233470aeff9fe))
* format ([aa92ea5](https://github.com/magicpro97/vibeflow/commit/aa92ea5f0a9d048cf5c70abc0ff85db685a83c21))
* format ([0840ae3](https://github.com/magicpro97/vibeflow/commit/0840ae36083680ab9a3a9e6f86cb14c90554c37a))
* **logbus:** tee engine-stdout/stderr to console when bus is active ([505c756](https://github.com/magicpro97/vibeflow/commit/505c756749b10ed94c4ade6281add680a5696114))
* **orchestrator:** tryLock uses openSync("wx") to close the CWE-367 TOCTOU race ([#56](https://github.com/magicpro97/vibeflow/issues/56)) ([cb11605](https://github.com/magicpro97/vibeflow/commit/cb116057ad6c470a8fd895109f237f283357ec31))
* pass the scanner profile. Now `vf init` on a project with React in package.json deps but NO src/ files still detects the web-ui role via the framework match path. ([42d8daf](https://github.com/magicpro97/vibeflow/commit/42d8daf00fd3423429fc6c0c098ea4428ffe014e))
* **pr-28:** adversarial audit fixes — 7 critical/major bugs from cực-gắt review (rebased) ([#51](https://github.com/magicpro97/vibeflow/issues/51)) ([bedf331](https://github.com/magicpro97/vibeflow/commit/bedf33189c894683a9c27ab34a89cc36cac571b1))
* **preflight:** test seam cast for type compatibility (no logic change) ([2395ffc](https://github.com/magicpro97/vibeflow/commit/2395ffcf89051c6d856cec1bd6305a568705d9af))
* **scanner:** cap readJson and readmeSummary at 4 MiB (CWE-400 unbounded read) ([#58](https://github.com/magicpro97/vibeflow/issues/58)) ([f2b60a6](https://github.com/magicpro97/vibeflow/commit/f2b60a6d22e26b3409709dab5e76cd681a079b20))
* **scanner:** fall through README variants when current has no usable line ([#54](https://github.com/magicpro97/vibeflow/issues/54)) ([35bfa19](https://github.com/magicpro97/vibeflow/commit/35bfa1983458e97729bd9a3c897d865d9c03e212))
* **scanner:** use lstatSync in language walk to prevent symlink-loop DoS and path traversal ([#53](https://github.com/magicpro97/vibeflow/issues/53)) ([74f513d](https://github.com/magicpro97/vibeflow/commit/74f513dd5aabd47ebbe66167729792b214e6f283))
* **server:** use res.text() for the 404 'not found' plain text body ([74fe56a](https://github.com/magicpro97/vibeflow/commit/74fe56ac4d72ac98c77110c09aa109f99ffaee9a))
* skill_waiver needs at field ([ac46e9d](https://github.com/magicpro97/vibeflow/commit/ac46e9db61071fdcafbf8292514abc457067ee44))
* **skills:** --mode=garbage errors out with a clear message ([ab9f19e](https://github.com/magicpro97/vibeflow/commit/ab9f19e6cf183982c1975e4fe671e2e66bc9bb35))
* StepSpawner is sync, not async ([585d35b](https://github.com/magicpro97/vibeflow/commit/585d35b2553166f7c4bda3a9e2290ef1414cf69c))
* **test:** make verifySkillSync Windows-safe (path separator in expected string) ([d66c55c](https://github.com/magicpro97/vibeflow/commit/d66c55c89a909d14340ab49319776e7ff2d66c45))
* **test:** reduce logbus rotation event count on Windows (avoid 5s timeout) ([dc41dd7](https://github.com/magicpro97/vibeflow/commit/dc41dd70a7ef98221ad0978501f5e95dd088e12e))
* type error in test (broken type import) ([1b21a65](https://github.com/magicpro97/vibeflow/commit/1b21a654856971c3e82171afa803589b3f47d7de))
* typecheck errors from previous --no-verify commits ([b2bd801](https://github.com/magicpro97/vibeflow/commit/b2bd8010db2a17deaa59bd91072d442883291540))
* WorkUnit status enum (use 'running' not 'in_progress') ([1df741a](https://github.com/magicpro97/vibeflow/commit/1df741a6472046ef8aeed8a908831fc1b1ced7a3))


### Refactors

* add FS/process inject seams for catch fallbacks (98.36% B) ([8caab9a](https://github.com/magicpro97/vibeflow/commit/8caab9a4cf72efacca76d730523a099fbe41a1bd))
* **agents:** remove dead doc-writer safety-net (100% B) ([6a25abb](https://github.com/magicpro97/vibeflow/commit/6a25abbe902563763a7d42c031f8165709757b72))
* **ai-init:** add buildPrompt inject for shell-pipe coverage ([8536d87](https://github.com/magicpro97/vibeflow/commit/8536d87f7fa6e5e2eadf5c6a497d831965e579ed))
* **ai-init:** add inject.engineCommandFn for unavailable branch test ([1fca1d4](https://github.com/magicpro97/vibeflow/commit/1fca1d49338a0187f005472fa3203f134cc299b7))
* **ai-init:** add makeAsyncSpawner inject for timedOut (100% B) ([a487b8d](https://github.com/magicpro97/vibeflow/commit/a487b8d5565f5b53c201e91b0451e7c1c425da67))
* **ai-init:** RAG-style slim prompt + INSTRUCTIONS.md file ([#38](https://github.com/magicpro97/vibeflow/issues/38)) ([6d191a3](https://github.com/magicpro97/vibeflow/commit/6d191a369975d4dedfd00c8494a2dae36788c104))
* **ai-init:** remove dead promptFile + auto-shell on Windows .cmd shims ([#37](https://github.com/magicpro97/vibeflow/issues/37)) ([6a9e0ac](https://github.com/magicpro97/vibeflow/commit/6a9e0ac097e45cb781d084d69b22fe3ae6a6c62f))
* **ai-init:** remove dead readdirSync try/catch in dirListing (98.59% B) ([8067088](https://github.com/magicpro97/vibeflow/commit/8067088c33816268f20f4fe36dc78e620f1f8bae))
* **checkpoint:** export defaultFs for direct testing (100% B) ([174a460](https://github.com/magicpro97/vibeflow/commit/174a460854dab7c9d4264304be4125bfe90a9751))
* **codemod:** make transform delegate to runCodemod (100% B) ([774bf7f](https://github.com/magicpro97/vibeflow/commit/774bf7ff966ec7f806637e1dec64ab31641a6e59))
* **commands:** add hasCommand inject for missing tool test (99.67% B) ([35e53aa](https://github.com/magicpro97/vibeflow/commit/35e53aa058dbdb1ff455cb8a236d0426c29b6e75))
* **commands:** add inject.mutateUnits to units() test seam ([52cfc8e](https://github.com/magicpro97/vibeflow/commit/52cfc8e6b4735cc783055fc90f43b6b5b16fb685))
* **commands:** add inject.probe to run() for engineCommand test seam ([a922085](https://github.com/magicpro97/vibeflow/commit/a9220850133c692edad127a1324e86068c3b1e89))
* **commands:** add inject.runSelftest to hookSelftest test seam ([f77cac6](https://github.com/magicpro97/vibeflow/commit/f77cac6d32ff39dbefed2a9fb6d41c210f3119bc))
* **commands:** export resetTipStateForTests + defaultAskFn (99.67% B) ([23b6ab6](https://github.com/magicpro97/vibeflow/commit/23b6ab62df34834218ae38aba7cbf419f212d21f))
* **commands:** remove dead onChunk/onStderrChunk dup at runAiInit opts (99.29% B) ([5a11868](https://github.com/magicpro97/vibeflow/commit/5a118682b26d2ac44452ddcb39de4a7ef7ee5870))
* **context7,core:** export parseLines + add 3 tests (100% B) ([f195e3b](https://github.com/magicpro97/vibeflow/commit/f195e3bdf30b8d5f565d300d281d9d41fe81f3fb))
* **core,validator:** add FS inject seams for catch fallbacks ([751c549](https://github.com/magicpro97/vibeflow/commit/751c54900f7a41c105c34e77cbb36c7571fcf40c))
* **dispatch:** export defaultSpawner + cover copilotVersion catch (99.31% B) ([bcb6184](https://github.com/magicpro97/vibeflow/commit/bcb618439e738e8eb23ef10184b00be1de7aafb0))
* **frontmatter:** remove dead undefined checks (95.60% B) ([d0a1332](https://github.com/magicpro97/vibeflow/commit/d0a1332297678f061971608fd2d32d2855c5b627))
* **gates:** remove dead multi-line evaluate tracker (99.42% B) ([15f5406](https://github.com/magicpro97/vibeflow/commit/15f5406d9c234f9eb6a2efa30ff283a174d36d3b))
* **importer:** add cpSync/readdirSync inject seams for catch fallbacks ([77a710a](https://github.com/magicpro97/vibeflow/commit/77a710ac48b184fcfbd85718e65a1ea11171460d))
* **logbus:** add createReadStream inject for stream error test (99.66% L) ([f9834e7](https://github.com/magicpro97/vibeflow/commit/f9834e777f4a24e07cf62015a3952d6869044cb2))
* **marker:** remove dead readdirSync catch (100% B) ([bd43b61](https://github.com/magicpro97/vibeflow/commit/bd43b61c2f3efa5489dbcde112cd648b8d4e0842))
* **preflight:** export probeInvocation + cover copilot throw ([3c54018](https://github.com/magicpro97/vibeflow/commit/3c54018a72913eed66ef54dab8067011a36d23cf))
* **preflight:** extract runAttempts to named function (99.93% B) ([3fef57c](https://github.com/magicpro97/vibeflow/commit/3fef57cc0b9bf8a98a7321f0ee400a6d39619e55))
* **registry:** remove dead readdirSync catch (99.28% B) + plan cycle test (100% B) ([b10e963](https://github.com/magicpro97/vibeflow/commit/b10e9631dcef5b76432110c349d6da6a514cf525))
* **registry:** remove dead statSync catch (100% B) ([06cfa1f](https://github.com/magicpro97/vibeflow/commit/06cfa1f81ef47259988ddc2a0cc040725bfa7eb5))
* **scanner:** remove dead readdirSync try/catch + cover symlink catch ([0ccd84e](https://github.com/magicpro97/vibeflow/commit/0ccd84eeffaf657462aeaa20b208ff7c721a4db4))
* **scanner:** remove dead readFileSync try/catch (100% B) ([7881d57](https://github.com/magicpro97/vibeflow/commit/7881d57af37d98f4a85dd600bff124995673c877))
* **server:** add scanRepo inject seam for repoLanguages/toolViews/settingsView ([7f736f7](https://github.com/magicpro97/vibeflow/commit/7f736f765d22f5563505d46aea66411e198bb4d2))
* **server:** dedup SSE enqueue try/catch (99.56% B) ([b40f65b](https://github.com/magicpro97/vibeflow/commit/b40f65b6b20c432775c8b083304020d0827f97ab))
* **server:** move 404 'not found' inside the try block ([f537f86](https://github.com/magicpro97/vibeflow/commit/f537f86dc3fd33f359413d96d0d09d2d528c720d))
* **server:** remove dead 'invalid path' check in upload (98.69% B) ([9cd222d](https://github.com/magicpro97/vibeflow/commit/9cd222d580710acdda165d07a70d60c824cf6f78))
* **validator,importer:** remove dead FS catches + add test (100% B) ([35b7878](https://github.com/magicpro97/vibeflow/commit/35b7878cbb7dbd52c04cb3c0f52fd31726b5ae22))


### Documentation

* **adapters:** clarify aiEnrichRole only enriches body, not description ([2e36847](https://github.com/magicpro97/vibeflow/commit/2e36847eb0c615787eb889ccd552a399c8cab2ac))
* comprehensive audit of 14 docs files (canonical skills, preflight gate, Windows CI, per-engine agents) ([bf07011](https://github.com/magicpro97/vibeflow/commit/bf070115d205fac9904f04589d4716dd8611997b))
* **coverage:** merge flag reference + coverage policy into one file ([#44](https://github.com/magicpro97/vibeflow/issues/44)) ([f06119f](https://github.com/magicpro97/vibeflow/commit/f06119f875bf2c7606e207f649deb5b1ada69db0))


### Build System

* **deps:** add smol-toml devDep for round-trip tests ([2afd9ba](https://github.com/magicpro97/vibeflow/commit/2afd9ba880ed098762f0a8d822bf502e5a25b65d))


### Continuous Integration

* use self-hosted for release-please, add runner ops scripts ([#31](https://github.com/magicpro97/vibeflow/issues/31)) ([31e7baf](https://github.com/magicpro97/vibeflow/commit/31e7baf1d77e69019f65698d6554650bba971aec))


### Tests

* add anti-pattern suite to lock 100% coverage invariant ([#40](https://github.com/magicpro97/vibeflow/issues/40)) ([5c2b9f8](https://github.com/magicpro97/vibeflow/commit/5c2b9f8297c42fb9f43a429fac1a66efbd353f67))
* **agents:** cover yamlQuote DEL/C1 control char rejection ([d95bf58](https://github.com/magicpro97/vibeflow/commit/d95bf5890144779c1bc1a15c6be96551e301b295))
* **ai-init:** cover dirListing FS catch branches (90%→91% B) ([66c2358](https://github.com/magicpro97/vibeflow/commit/66c2358fc76b9a5e68d82c2f9cae407f87fd4394))
* **ai-init:** cover dirListing statSync catch via broken symlink (98.37% B) ([072b527](https://github.com/magicpro97/vibeflow/commit/072b5276a0aa95d64c023239461137c93f0fb2ed))
* **ai-init:** cover promptFile write fail fallback (no coverage change) ([6243bee](https://github.com/magicpro97/vibeflow/commit/6243beed2fc29971c7ae48a1565f084866828d05))
* **ai-init:** document copilot shell-pipe as limitation ([78414c9](https://github.com/magicpro97/vibeflow/commit/78414c9603d1b46007cef20cd8fb1416987e71c1))
* centralize fake-spawner pattern ([#36](https://github.com/magicpro97/vibeflow/issues/36)) ([6510090](https://github.com/magicpro97/vibeflow/commit/6510090da7fa4c17c1269a515ac4a12d537a2849))
* **checkpoint:** cover copyFile non-ENOENT error skip (94%→96% B) ([94f7467](https://github.com/magicpro97/vibeflow/commit/94f7467d828b17e5adc6115ba6717d3f3ce5c97d))
* **checkpoint:** cover isDir with broken symlink in gitignored env (98.82% B) ([dcf5d56](https://github.com/magicpro97/vibeflow/commit/dcf5d56984abe2e85c7cda62b2f9bc2f7f7d2d63))
* **codemod:** cover ensureOutImport with existing import (98-99 lambda) ([0507780](https://github.com/magicpro97/vibeflow/commit/0507780324bac4e4509cdb8198e354da5ef8f757))
* **codemod:** cover no-imports + nested import paths (89.89% B) ([a84d84d](https://github.com/magicpro97/vibeflow/commit/a84d84d60086c11d9c3811246e6a702fa9e46072))
* **commands,ai-init:** cover doctor --refresh + forceEngine/not-ready + no-engine (88%→90% ai-init, 69% commands) ([8b32b79](https://github.com/magicpro97/vibeflow/commit/8b32b7998c996e88b59596103280d9e2219af7be))
* **commands:** add 3 run() tests (--yes ok/fail, dry with unavailable engine) ([5db28c0](https://github.com/magicpro97/vibeflow/commit/5db28c0fe8d1514af6f5ba9a7741e1b70fb81012))
* **commands:** add 92 tests covering doctor/init/run/skills/tools/... (68%→84% L, 69%→89% B) ([4523c76](https://github.com/magicpro97/vibeflow/commit/4523c765a699e7a8b1858dbfe9a423dbe043f7d2))
* **commands:** add run with dry-run test (97.02%→97.11% B, no change) ([a70b8ec](https://github.com/magicpro97/vibeflow/commit/a70b8ec0baf26c290800e8b46acdac061ce4957d))
* **commands:** cover computeKnowledgeHeavySource branches (89.80%→89.87% B) ([1b57dfb](https://github.com/magicpro97/vibeflow/commit/1b57dfbd6473795248c30b324b38ee8a4b8e8058))
* **commands:** cover hook VALID event presentDecision path (98.01%→98.35% B) ([0d53b36](https://github.com/magicpro97/vibeflow/commit/0d53b36f4b567077e6923bb4fde11ca63a2db1bc))
* **commands:** cover hook() stdin event flow (94.01%→95.65% B) ([2184edd](https://github.com/magicpro97/vibeflow/commit/2184edd679859c2bd47f44b95cb472e2712f270f))
* **commands:** cover init --ai enrichment phase (92.72%→94.01% B) ([5261342](https://github.com/magicpro97/vibeflow/commit/5261342a47ae1ec49ee0f3fe8d2d2fd4b80a4e41))
* **commands:** cover init backedUp duplicate loops (97.02%→97.11% B) ([bb742af](https://github.com/magicpro97/vibeflow/commit/bb742af64a6cf7fdc2aaf63529774014366da226))
* **commands:** cover init streamSpawner factory + initInteractive backedUp (96.92%→97.02% B) ([1c017cd](https://github.com/magicpro97/vibeflow/commit/1c017cd784f2119750bc81f445e787a71a3d1fda))
* **commands:** cover initInteractive 6-question flow (91.60%→92.67% B) ([0ea0c61](https://github.com/magicpro97/vibeflow/commit/0ea0c613e3c551ca51e1504e2db624864efb2326))
* **commands:** cover makeResearcher summary+envelope branches (89.56%→89.80% B) ([baa90f7](https://github.com/magicpro97/vibeflow/commit/baa90f78540c37ce076803f4bf87255ac86a3a03))
* **commands:** cover orchestrate safety-net stderr path (90.84%→91.03% B) ([1e8dc0d](https://github.com/magicpro97/vibeflow/commit/1e8dc0d6bc9847d481c09f0f96823d1bccb8b79e))
* **commands:** cover printCommandHelp ui (98.54%→98.91% B) ([d405571](https://github.com/magicpro97/vibeflow/commit/d40557122496528031b6c7cd27d1e75fff057f14))
* **commands:** cover resolveMode/resolveEngine/announceLaunch branches (89.16%→89.56% B) ([54603c2](https://github.com/magicpro97/vibeflow/commit/54603c2b5d946e3f228d2aaf4bc568c701e81a92))
* **commands:** cover skills list/validate ok+fail branches (96.31%→96.55% B) ([93e7423](https://github.com/magicpro97/vibeflow/commit/93e7423c9ef5b70c2df9b46030b2ad412cf02166))
* **commands:** cover skills sync fs-fail path (97.73%→97.87% B) ([ce8a41d](https://github.com/magicpro97/vibeflow/commit/ce8a41dd2d6b288ea6b65815123fb65784d8a3a6))
* **commands:** cover streamSpawner factory callbacks (89.87%→90.84% B) ([dc9240e](https://github.com/magicpro97/vibeflow/commit/dc9240e2c72ccde49fbef050a14ba1567ee86e8c))
* **commands:** cover tools enable ensureToolIndex path (98.44%→98.54% B) ([865f64d](https://github.com/magicpro97/vibeflow/commit/865f64d8f59812a2203afa21712e1b34708c2092))
* **commands:** cover verify monorepo/gradle/failure branches (95.65%→96.31% B) ([1c5b7e8](https://github.com/magicpro97/vibeflow/commit/1c5b7e88193f4ac0a13aa77eeefc16007a429d8e))
* **commands:** cover verify-sync missing-mirror branch (97.87%→98.01% B) ([8f03e03](https://github.com/magicpro97/vibeflow/commit/8f03e03d4c06fc2d3e235adfccc25685daf0d63c))
* **commands:** cover workflow delete + skills import (96.55%→96.64% B) ([36dfa6a](https://github.com/magicpro97/vibeflow/commit/36dfa6aff3d6a82ea1e4f23ea5162d5ab08b088e))
* cover preflight copilot auth OK + quota parseable date (99.63% L) ([0eb3955](https://github.com/magicpro97/vibeflow/commit/0eb39559cc5f342e247b00d491e2bc2c888d74c8))
* **coverage:** per-file 100% gate ([#35](https://github.com/magicpro97/vibeflow/issues/35)) ([f8e1382](https://github.com/magicpro97/vibeflow/commit/f8e1382cb431f39929c7feefe8096bb55d769ed8))
* **discovery-context7:** cover legacy sync + HTTP edge branches (80%→95% L, 81%→97% B) ([d7d9344](https://github.com/magicpro97/vibeflow/commit/d7d93449581e68b076e4d3d98202186a39574965))
* **discovery-context7:** cover safeSkillName non-string + parseMarkdownContext code-block (97%→99% B) ([2d90291](https://github.com/magicpro97/vibeflow/commit/2d902913e50e15480f4226c12bc9c974cbbdbb0b))
* **dispatch:** cover bridge mode default spawner + unset VIBEFLOW_AI ([1b41df1](https://github.com/magicpro97/vibeflow/commit/1b41df1fd684496292254bab8b91f896afd6a864))
* **dispatch:** cover copilot probe.version fallthrough (97.58% B) ([38b1262](https://github.com/magicpro97/vibeflow/commit/38b1262730352b8b286f7ad1b6e234a0c9bf5767))
* **dispatch:** cover envelope .result inner JSON confidence (line 327) ([363eab6](https://github.com/magicpro97/vibeflow/commit/363eab65d823d9248cbcc33b5a18e99ef34349be))
* **dispatch:** cover parseEngineSummary envelope branches (97.58%→98.27% B) ([e650793](https://github.com/magicpro97/vibeflow/commit/e650793c99ffa43c1027ef66d4c2383d0960a5d6))
* **dispatch:** cover runDispatch 'claude CLI not found' branch (line 402) ([7ad0599](https://github.com/magicpro97/vibeflow/commit/7ad059918a6e509628eab453a6e278bdecdfd8ea))
* **engine-quota:** cover JSON.parse catch (97%→100% B) ([c3927de](https://github.com/magicpro97/vibeflow/commit/c3927de8225925f2c28004d27d06fbe7c81c5342))
* **engine-quota:** cover parsePercent NaN guard + fraction regex (95%→97% B) ([dc19af7](https://github.com/magicpro97/vibeflow/commit/dc19af7ed61818b1b863c2c90bf2702506882c6f))
* ensure coverage-anti-patterns runs first in `bun run test` ([1bb11ab](https://github.com/magicpro97/vibeflow/commit/1bb11abccb26423a9b40cde9717055f2fd3f2b02))
* **frontmatter:** cover blank line in child block (line 84-86) ([0442ac2](https://github.com/magicpro97/vibeflow/commit/0442ac26d75f9066e806e95104f4f6238cf653f6))
* **frontmatter:** cover empty block key (line 100 → 96.70% B) ([3f09bd3](https://github.com/magicpro97/vibeflow/commit/3f09bd31c7a3cc130a6e468d3e356decf8dcc2fb))
* **gates:** cover findScopeConflicts + e2eUnicodeSelectorWarning + e2eEvaluateDynamicImportWarning (80%→100% L, 55%→86% B) ([46d344d](https://github.com/magicpro97/vibeflow/commit/46d344dce7f19ccd8e74f58d271320e998b19496))
* **gates:** cover policyGates null + confidence branches (85.64%→88.95% B) ([74acd13](https://github.com/magicpro97/vibeflow/commit/74acd13e5771b651e51533af0c651eec2adb8133))
* **gates:** remove multi-line test (dead defensive code) ([412b9d0](https://github.com/magicpro97/vibeflow/commit/412b9d0112180d61ebd329df0f550df24f14d4b1))
* **hooks-runner:** cover presentDecision pre-tool-use/stop/post-tool-use + mapClaudeEvent branches (64%→100% B) ([5ce7af0](https://github.com/magicpro97/vibeflow/commit/5ce7af03753f7311607a714e234949779aead6ab))
* **lifecycle:** cover classifyManagedFiles EISDIR fallback (100% B) ([169a804](https://github.com/magicpro97/vibeflow/commit/169a80417f95cfd01dc1ed7eab55674a07c97a81))
* **marker:** add 19 tests for src/orchestrator/marker.ts (33%→100% lines) ([40d94e8](https://github.com/magicpro97/vibeflow/commit/40d94e8e6221aed2f8e66af16ce0977393a7b731))
* **marker:** cover live-process lock + missing-pid edge case (20 → 22 tests) ([2fdcda3](https://github.com/magicpro97/vibeflow/commit/2fdcda34e02b0346e6c4c6aeec04b747cd12653b))
* **marker:** make sort test resilient to parallel test pollution (sleep 20ms before update) ([4da2b40](https://github.com/magicpro97/vibeflow/commit/4da2b40cac071d2c4c290c72aa2770396f395703))
* **orchestrator,agents:** cover doc-writer + debate + listMarkers (99.22% B) ([9064aee](https://github.com/magicpro97/vibeflow/commit/9064aee1f47f187392f6b7d93ded72084afd6bb9))
* **preflight-delegate:** cover default functions (50%→67% L, 78%→100% B) ([e8e5b4b](https://github.com/magicpro97/vibeflow/commit/e8e5b4b8f3223d0dbb6e6a2993bb50df8ec13e83))
* **preflight-delegate:** cover probe-failed + unknown presence (50% → 50% lines, 76% → 77% branches) ([d6afbdb](https://github.com/magicpro97/vibeflow/commit/d6afbdb823f19436ddb7502d1fb2b38bd9e90d35))
* **preflight:** cover real Bun.spawn async probe via mock injection (72%→95% B) ([8947acc](https://github.com/magicpro97/vibeflow/commit/8947accb54ee462c6292095deed3353ff4abf87a))
* **preflight:** cover sync checkEngine copilot catch + async probe:false + copilot no-gh (69%→72% B) ([bc536e7](https://github.com/magicpro97/vibeflow/commit/bc536e727bfa39e3bcbbbbc5430e8adc72268663))
* **safety:** cover parseRetryAfter + isDir catch (96.45% + 99.29% B) ([92de4b3](https://github.com/magicpro97/vibeflow/commit/92de4b39ae282ba4af71d8def9df95cbc9e8a148))
* **scanner:** cover readmeSummary, malformed JSON, KMP, web/subproject branches ([ae303f4](https://github.com/magicpro97/vibeflow/commit/ae303f4e9acead03c615bd27f22989d63e722db1))
* **server:** add valid JSON POST to /api/nonexistent (line 578 coverage) ([772a9ec](https://github.com/magicpro97/vibeflow/commit/772a9ec8e9eeb7fad6e5e2a43dbd7355f3044038))
* **server:** cover /api/discover empty query + /api/units invalid action + /api/preflight + /api/settings (93.58%→94.03% B) ([9adc5d1](https://github.com/magicpro97/vibeflow/commit/9adc5d1c73a76e736ed9b70b12bdd397467b0379))
* **server:** cover /api/discover skills branch + approved docs (94.03%→94.47% B) ([5524c41](https://github.com/magicpro97/vibeflow/commit/5524c418e3b8bb2089fa99991f7a2ef3ed8591ae))
* **server:** cover /api/dispatch known/unknown engine (92.48%→93.58% B) ([b33f662](https://github.com/magicpro97/vibeflow/commit/b33f66285839073b0dd7126c034517f9cdcc2cf1))
* **server:** cover /api/markers, /api/attachments, /api/logs/recent (95.13%→96.24% B) ([0f8bf10](https://github.com/magicpro97/vibeflow/commit/0f8bf10607c52655351358ba7366595eb06a20c1))
* **server:** cover /api/units update not-found + 404 default (94.69%→94.91% B) ([604d56c](https://github.com/magicpro97/vibeflow/commit/604d56c3d3380bb536958cff0b1e0f97b7d74f4f))
* **server:** cover /api/upload POST + DELETE + invalid filename (90.93%→92.48% B) ([5089b3d](https://github.com/magicpro97/vibeflow/commit/5089b3d6c8fc68190c9d31ee5cbf8d95fbf681a1))
* **server:** cover /assets/* static file routes (97.35% B) ([eb8601c](https://github.com/magicpro97/vibeflow/commit/eb8601ca2d20402b587d86b7545d56656249c1d7))
* **server:** cover API catch block via non-JSON body (97.83%→98.48% B) ([f1f03b9](https://github.com/magicpro97/vibeflow/commit/f1f03b98829aedf409cb17d2c3e256c3a2e7a299))
* **server:** cover GET /events SSE stream tail path (89.38%→90.93% B) ([102c218](https://github.com/magicpro97/vibeflow/commit/102c218540b119429312c3c19adbd61af118c501))
* **server:** cover Origin header invalid URL + DELETE invalid name (96.24%→97.35% B) ([6129461](https://github.com/magicpro97/vibeflow/commit/6129461b029eee1fcd6d2d66876a64d47410ed48))
* **server:** cover replayFromLog small/large/invalid paths (86.28%→88.27% B) ([89171fc](https://github.com/magicpro97/vibeflow/commit/89171fce1b67931fff9216061173c1560bf3ab92))
* **server:** cover safeEnqueue catch via bus write after client abort ([eb22634](https://github.com/magicpro97/vibeflow/commit/eb22634caac69b43c1641c960486735e70718814))
* **server:** cover SSE no-logbus branch (88.27%→89.38% B) ([12eb9bf](https://github.com/magicpro97/vibeflow/commit/12eb9bf7c8e8ef1e4912aedf53478355e06fd8a4))
* **skill-sync:** document statSync catch as limitation ([ab5887f](https://github.com/magicpro97/vibeflow/commit/ab5887fd28a0fa8877eb82ebe5e96e148ab147af))
* **skills-registry:** cover deprecated/else-if/render-index branches (77%→92% L, 91%→98% B) ([5513d9c](https://github.com/magicpro97/vibeflow/commit/5513d9c07a7f7292597e0c9b677316053139e6d1))
* **skills-resolver:** cover skillForFile, fileTypes, frameworks, dedup, render (75%→100% L, 72%→100% B) ([011c9e2](https://github.com/magicpro97/vibeflow/commit/011c9e2a6b20067e361e4c6ad7ecc70dd47c0db2))
* **skills-validator:** cover no-skills/early-return/kebab/long-desc branches ([90799c1](https://github.com/magicpro97/vibeflow/commit/90799c1df7722a8fe3a12c62691d584b2f9d4707))
* **skills:** backup path + dead-code removal (75%→100% lines, 70%→93% branches) ([4085be9](https://github.com/magicpro97/vibeflow/commit/4085be914a1bdbcb8e64c25ca94bfa5c26f0ba58))
* **skills:** cover skillNames with real broken symlink (line 46-47) ([23843af](https://github.com/magicpro97/vibeflow/commit/23843af7c8f025613042fdeb3bd85642df5d9d0f))
* **ui,preflight:** cover link() TTY path + StatusLine (72%→96% L, 88%→100% B) ([e32cba3](https://github.com/magicpro97/vibeflow/commit/e32cba3276a42e944379ad14a13cfc6c5ca3ba94))
* **validator:** document 3 FS catch blocks as limitations ([9745998](https://github.com/magicpro97/vibeflow/commit/974599845f8d9745f78d71062229672522ebb53a))

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
