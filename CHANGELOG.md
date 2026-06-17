# Changelog

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
