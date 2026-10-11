---
title: Engine Native Output
description: The per-engine contract for reading resources, session ids, and final text from each engine CLI's native JSON output — flags, fixtures, exact field paths, deliberate exclusions, and the native-first rule.
category: reference
last_updated: 2026-10-11
---

# Engine Native Output

VibeFlow reads resource usage, session ids, and the engine's final text from the
engine CLI's **native structured output** — the JSON the engine itself emits
under its machine-readable flag — never by scraping prose or spinner noise.
Every field path below is pinned to a committed fixture in
`test/fixtures/native/` (captured 2026-10-11; per-fixture capture notes below).
CLI versions and the dispatch/resume surfaces live in
[Engine CLI Compatibility](./ENGINE-COMPAT.md); this file owns the native-output
contract.

Context: none verified — no engine exposes a stable headless quota command
(#355/#50926), so native structured output is the only reliable machine surface
the engines expose.

## Engine × native-output matrix

| Engine   | Fresh invocation                          | Stream form          | Fixture                                          |
| -------- | ----------------------------------------- | -------------------- | ------------------------------------------------ |
| claude   | `claude -p --output-format json`          | single JSON envelope | `test/fixtures/native/claude-p-json.txt`         |
| codex    | `codex exec --json` (prompt on stdin `-`) | JSONL events         | `test/fixtures/native/codex-exec-json.jsonl`     |
| opencode | `opencode run --format json`              | JSONL events         | `test/fixtures/native/opencode-format-json.jsonl` |
| copilot  | `copilot -p <prompt> --output-format json --allow-all` | JSONL events | `test/fixtures/native/copilot-json.jsonl`  |

The copilot argv order is load-bearing: the prompt is the **value of `-p`**
(`copilot -p <prompt> …`). The form `copilot -p --output-format json … <prompt>`
is rejected by the CLI parser (exit 1): a flag immediately after `-p` leaves it
valueless, and the CLI does not steal the trailing `<prompt>`. What IS valid
(verified live on copilot 1.0.94, exit 0 with valid JSONL): `-p <prompt>` with
flags before `-p` or after the prompt value — e.g.
`copilot -p <prompt> --output-format json --allow-all` (this repo's fresh-dispatch
order) and `copilot --output-format json --allow-all -p <prompt>` both work.
vibeflow keeps the prompt-value form because materializePrompt() splices the
prompt right after `-p` and the session path repositions `-p` last.

## Field paths per engine

### claude — single success envelope

| Quantity     | JSON path | Fixture value |
| ------------ | --------- | ------------- |
| tokens       | `usage.input_tokens + usage.output_tokens` (`cache_read_input_tokens` / `cache_creation_input_tokens` are subsets — never add) | 157 (10 + 147) |
| cost_usd     | `total_cost_usd` | 0.008567100000000001 |
| wall_seconds | `duration_ms / 1000` | 2.907 |
| session id   | `session_id` | `b16a3c25-918e-4b9f-a7b0-a38b2aa485df` |
| final text   | `result` (a JSON **string** — treat as text) | `{"ok":true}` |

### codex — JSONL events

| Quantity     | JSON path | Fixture value |
| ------------ | --------- | ------------- |
| tokens       | `turn.completed.usage.input_tokens + …output_tokens` (`cached_input_tokens` is a subset — never add) | 19661 (19636 + 25) |
| cost_usd     | — (no cost field in the stream) | — |
| wall_seconds | — (no duration field) | — |
| session id   | `thread.started.thread_id` | `01a12b0c-dc30-73a1-92d0-962cef0acd45` |
| final text   | LAST `item.completed` with `item.type == "agent_message"` → `item.text` | `ok` |

`item.completed` also emits `error` and `reasoning` items (both appear in the
committed fixture) — the parser tolerates and skips them.

### copilot — JSONL events

| Quantity     | JSON path | Fixture value |
| ------------ | --------- | ------------- |
| tokens       | — (no token field in `result.usage`) | — |
| cost_usd     | — (`result.usage.premiumRequests` is a request COUNT — deliberately not mapped, see exclusions) | — |
| wall_seconds | `result.usage.sessionDurationMs / 1000` | 79.965 |
| session id   | `result.sessionId` | `19155765-1b22-4d6e-82b3-3276bff805d8` |
| final text   | `assistant.message` → `data.content`; skip `ephemeral: true` events (streaming notices) | `ok` |

The stream ends with a `result` event (carries `exitCode`); `assistant.message`
appears after `model.call_finished`, so scans key on event type, never
position. Event count/set varies run-to-run — never assert counts.

### opencode — JSONL events

| Quantity     | JSON path | Fixture value |
| ------------ | --------- | ------------- |
| tokens       | `step_finish` → `part.tokens.total` (total, not input+output) | 28887 |
| cost_usd     | `step_finish` → `part.cost` (0 is a real value) | 0 |
| wall_seconds | first event `timestamp` → `step_finish` `timestamp`, /1000 | 0.717 |
| session id   | top-level `sessionID` (present on every event) | `ses_ed4eaccdbffef47D85FxXY0hU3` |
| final text   | `type: "text"` events → `part.text`, newline-joined | `ok` |

Top-level `type` uses underscore form (`step_start`, `step_finish`) while
`part.type` uses dash form (`step-start`, `step-finish`) — key on one (the code
keys on top-level `type`). A `type: "error"` line is terminal failure (exit 1),
not a skippable event.

## Parsers and the native-first rule

| Parser | File | Purpose |
| ------ | ---- | ------- |
| `parseEngineResources(engine, raw)` → `NativeResources` | `src/engine-output.ts` | `tokens` / `cost_usd` / `wall_seconds`; an absent field means the engine did not report it (absent, not zero) |
| `parseEngineFinalText(engine, raw)` | `src/engine-output.ts` | the engine's final answer text (#145) |
| `parseSessionId(stdout)` / `parseEngineSessionId(engine, stdout)` | `src/dispatch/prompt.ts` | session / thread id (#618) |
| `extractEngineResponseText(stdout, engine)` | `src/dispatch/prompt.ts` | transport-envelope text extraction |

**The rule: native typed field first; fenced-JSON / text scraping is fallback
only.** `parseEngineFinalText` returning `undefined` (or empty) means "nothing
native to read" — callers keep their raw-scanning fallback: review's
`extractSummary` uses `parseEngineFinalText(engine, raw) ?? raw`, and dispatch
summary parsing unwraps the claude envelope's `.result` before any fenced-JSON
scan. The fenced ```json convention is the LAST fallback — never the first.

All parsers are best-effort: malformed JSON, absent raw output, or an engine
without a reader → `undefined`, never a throw.

## Deliberate exclusions

- **omp:** excluded 2026-10-11 — no community request; adding an engine starts
  with an issue. (Precedent: #560 requests gemini as a first-class engine — the
  issue-first path.)
- **copilot `premiumRequests` is NOT `cost_usd`.** It is a request count;
  consumers render `cost_usd` as dollars, so mapping a count would print a fake
  `$`. A distinctly-named field belongs in the WorkUnit resources contract if
  wanted later.
- **opencode multi-step runs keep the LAST `step_finish`.** Whether per-step
  values are cumulative is unverified, so summing across steps is deliberately
  not attempted — last-step reporting is the honest choice until that is
  established.
- **codex reports no cost and no duration** — token counts only.
- **`codex --output-schema`: deferral** — no community artifact names it as
  wanted (sweep 2026-10-11); revisit on first issue.

## Fixture capture notes

All fixtures: machine-specific absolute home paths were scrubbed to `~/` (2 files) to satisfy the `test/no-tracked-machine-path.test.ts` gate; scrubbing does not touch any value the contract parses (ids, tokens, counts, durations), and every line stays valid JSON/JSONL.

- **claude** (`claude-p-json.txt`): required an explicit `--model` — this
  machine's global settings alias a model the local bridge no longer serves
  (attempt 1 captured a 404 error envelope, kept out of the repo). Success
  envelope is single-line stdout; stderr was empty.
- **codex** (`codex-exec-json.jsonl`): stderr must be captured **separately** —
  this machine's codex interleaves a websocket ERROR log line, so a merged
  capture would not parse as JSONL. The fixture also contains a machine-local
  hooks-config error item (path scrubbed); the parser tolerates
  non-`agent_message` items.
- **copilot** (`copilot-json.jsonl`): argv order fixed per above; event
  count/set varies run-to-run. ~58 KB of the fixture is one `ephemeral`
  `session.skills_loaded` line listing machine-local skill paths (paths
  scrubbed; kept otherwise raw per the no-hand-editing capture rule).
- **opencode** (`opencode-format-json.jsonl`): required an explicit `-m` model
  — the default model routes to a provider with no credentials in this
  environment. The trivial prompt captured 3 events only; tool-use event shapes
  are not in the fixture.

## Community evidence log (Task 0 sweep, 2026-10-11, gh 2.76.2, repo magicpro97/vibeflow)

Commands run as specified in the plan (raw):
$ gh search issues --repo magicpro97/vibeflow --state all "omp" ...                → invalid argument "all" for "--state" flag: valid values are {open|closed}   [exit 1]
$ gh search issues --repo magicpro97/vibeflow --state all "output-schema OR native json OR structured output" ... → same error   [exit 1]
$ gh search issues --repo magicpro97/vibeflow --state all "summary OR verdict OR parse" ...                        → same error   [exit 1]
  (gh 2.76.2 `gh search issues` accepts only --state open|closed; without the flag it searches all states — re-run below.)
$ gh api repos/magicpro97/vibeflow --jq '.has_discussions'                         → false
  → discussions: disabled (community surface = issues only)

Re-run without --state all (semantic equivalent):
$ gh search issues --repo magicpro97/vibeflow "omp" ...                            → <empty>
$ gh search issues --repo magicpro97/vibeflow "output-schema OR native json OR structured output" ... → <empty>
$ gh search issues --repo magicpro97/vibeflow "summary OR verdict OR parse" ...    → <empty>
  (gh search issues does not support OR — multi-term = AND; controls in task-0-report.md. Per-term expansion = the semantic equivalent:)

Per-term sweeps (limit 100):
$ "omp" → <empty>;  "oh my pi" → <empty>;  "oh-my-pi" → <empty>;  "omp" --match comments → <empty>
$ "output-schema" → 658, 660, 747, 634, 522, 140, 552, 743, 178, 550 (token matches; 0 artifacts name codex `--output-schema` as wanted)
$ "native json" → 548 (token match)
$ "structured output" → 765, 170, 177 (token matches)
$ "summary" → 617, 760, 686, 576, 689, 660, 683, 663, 347, 641, 349, 354, 173, 612, 613, 618, 136, 557, 558, 556
$ "verdict" → 811, 545, 555, 145, 170, 348, 178, 519, 324, 542, 275, 560, 763, 551, 521, 624
$ "parse" → 483, 819, 355, 805, 743, 695, 655, 765, 763, 546, 550, 649, 81, 140, 532, 640, 534, 747, 522, 201, 632, 145, 439, 564, 618, 634, 557, 424, 642, 46
$ "fenced" → <empty>

Ground truth (guards against search-index gaps): 303 issues total (302 closed, 1 open); exhaustive title/body scan over all 303 confirms:
0 standalone "omp" tokens; 0 literal "native json"; 0 literal "structured output"; 0 "fenced"; 1 literal "output schema" — #178, the cross-review skill's output shape, not the codex CLI flag.

Upstream cross-checks (as specified):
$ gh search issues --repo openai/codex "output-schema" --limit 5 → 41346, 38545, 19816, 35596, 25555
$ gh search issues --repo github/copilot-cli "output-format" --limit 5 → 4107, 5003, 5038, 4863, 4823

D-rule outcomes (pre-committed; applied mechanically; no judgement calls):
- omp: excluded 2026-10-11 — no community request; adding an engine starts with an issue.
  (0 artifacts name omp as an intended dispatch engine, incl. comments; discussions disabled. Precedent: #560 requests gemini as a first-class engine — the issue-first path.)
- summary extraction: community-reported pain confirmed as of 2026-10-11 → Task 8 executes.
  Evidence (fetched via `gh issue view`): #145 "The verdict is hard to extract programmatically" / "I want a clean, parseable verdict … without scraping 2 MB of spinner noise"; #747 "A reviewer process can time out or emit invalid JSON and callers can mistakenly interpret absence of findings as `[]`" / "a missing, stale, timed-out, or unparseable reviewer result cannot be treated as approval". Fenced-JSON scan remains the LAST fallback only.
- codex --output-schema: deferral — no community artifact names it as wanted (sweep 2026-10-11); revisit on first issue.

Full command transcripts + per-hit judgement (69 artifacts): .superpowers/sdd/2026-10-11_193527-cli-native-structured-output-alignment/task-0-report.md

Shipped: the D-summary outcome above is implemented — `parseEngineFinalText`
(native-first, fenced-JSON scan demoted to last fallback) per
[#145](https://github.com/magicpro97/vibeflow/issues/145).
[#747](https://github.com/magicpro97/vibeflow/issues/747) (commit-anchored
self-review evidence gate) remains a **separate open concern**, unchanged by
this contract: a missing, stale, timed-out, or unparseable reviewer result must
not be treated as approval.

---

**Related:** [Engine CLI Compatibility](./ENGINE-COMPAT.md) · [Command Reference](./COMMAND_REFERENCE.md)
