# VibeFlow dispatch + handoff architecture — the "why", for design questions

Use this when the user asks a design-level question about vf's orchestrator —
e.g. "is this mechanism optimal?", "why don't we use the engines' own session
state?", "why filesystem handoff instead of a conversation?". These questions
deserve an architecture answer, not a code tour. Below is the verified rationale.

## How dispatch actually works (verified in `src/dispatch.ts`)

Every unit dispatch is **one-shot, stateless, print-mode**. `engineCommand()`
(dispatch.ts:172) resolves each engine to a headless invocation with NO session /
resume flag:

- `claude -p --output-format json`   (print mode, JSON envelope on stdout; `--dangerously-skip-permissions` only in AI-init)
- `codex exec -`                      (non-interactive, `-` reads prompt from stdin)
- `copilot -p <prompt> --allow-all`   (prompt as argv, not stdin)

`buildEnginePrompt` composes the prompt once from canonical context, pipes it in
(stdin or arg per `promptMode`), reads back the JSON summary, and DISCARDS any
engine session. There is no `--resume`, no `-c`, no conversation id anywhere in
the dispatch path. `runParallel` (orchestrator/run.ts) fans these out with bounded
concurrency; `runDispatchAsync` is the non-blocking spawn so lanes overlap.

## Why stateless (NOT engine session state) — this is a deliberate design, not a gap

Four load-bearing reasons. When a user asks "why not use the tools' session
state", give these, and be honest that it IS a real tradeoff:

1. **Three engines, three incompatible session models.** claude has `--resume <uuid>`
   (session files under `~/.claude/`), codex has its own rollout/session store,
   copilot barely exposes a stable resume. vf wants ONE dispatch contract across
   all three → the common denominator is stateless print-mode. Binding to native
   sessions means maintaining three divergent resume adapters and losing the
   uniform contract.
2. **Determinism + the verify gate.** Vision = "no evidence, no completion" and
   (MASTER_SPEC) "deleting generated files + re-run must reproduce equivalent
   output." Engine session state carries HIDDEN context (what the engine remembers
   from prior turns) that vf can't inspect or gate. A re-dispatch of the same unit
   must be reproducible from canonical context; a hidden session makes it
   non-reproducible.
3. **Parallel scope isolation.** `runParallel` runs N units concurrently with
   disjoint scopes. A native session is a single linear conversation — it doesn't
   map onto parallel waves. Filesystem/git handoff is parallel-safe by nature.
4. **Crash-resume.** Engine sessions live in the engine's process/temp and die with
   a crash. Markers under `~/.vibeflow/markers/` survive. This is exactly why
   issue #617 (persist handoff to markers) exists.

Bottom line: stateless + filesystem handoff is the correct choice for an
N-engine, parallel, verifiable orchestrator. Native session state optimizes for
one-human + one-engine + linear chat — a different product.

## The handoff mechanism + its real weakness (transport vs content)

`dispatchInWaves` (`src/orchestrator/waves.ts`) passes context between dependent
waves via an in-memory `Map<unit, summary>`. After each wave, `deriveHandoff(u)`
(`src/orchestrator/handoff.ts`) produces a summary that gets injected into
dependents' prompts in the next wave.

**Two distinct layers — do not conflate them when evaluating a handoff issue:**

| Layer | Concern | Status |
|-------|---------|--------|
| Transport | handoff survives a crash | #617 fixes it (persist Map → `DispatchMarker.handoff`, seed on resume) |
| **Content** | **what the summary actually says** | **weak — unaddressed** |

The content weakness: `deriveHandoff` currently emits only
`"<unit>: <status>, <N> evidence item(s)"` — pure metadata. Downstream units learn
"upstream done, 3 evidence" but NOT what upstream *did* (which API changed, which
contract it left, which file it touched). #617 makes a nearly-empty payload
crash-durable — hardening the pipe to carry plain water.

## Three directions to offer when the content gap surfaces

- **A. Ship the transport fix as-is** (#617, cheap, correct at its layer) + file a
  new issue "enrich deriveHandoff" (read upstream's git diff, extract
  file/symbol/contract changes into a real summary). Separates concerns; matches
  the user's value/effort house-style.
- **B. Combine** transport + enrich in one PR. Risk: enrich may need to read the
  diff and possibly call an LLM to summarize → more tokens, bigger blast radius.
- **C. Drop the derived summary; use the artifact directly (RAG).** Downstream
  reads upstream's `evidence/` folder + git diff straight off disk via the engine's
  own read_file tool, instead of injecting a pre-summarized string. This is the
  same file-reference-first / RAG pattern the user has favored elsewhere (small
  prompt with a file list, engine reads the files itself) — and could remove
  `deriveHandoff` entirely.

The decisive question to put back to the user: **does the downstream unit need only
"upstream is done" (then #617 as-is suffices) or the actual content of upstream's
change (then enrich, or go RAG)?**
