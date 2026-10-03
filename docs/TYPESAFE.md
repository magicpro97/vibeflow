---
title: TypeSafe System One (Jev) judge
description: "The optional System One judge: what it decides, the fail-open contract, the four call sites, and every setting."
category: explanation
last_updated: 2026-09-23
---

# TypeSafe System One (Jev) judge

VibeFlow can call **TypeSafe System One (Jev)** as an optional decision judge. It is
**off by default**, it is **fail-open** by construction, and every one of its answers is
advisory: it can only push an outcome toward *more* work or *more* scrutiny.

## What it is

The judge is a typed question endpoint, not a chat model. VibeFlow sends one `state`
string plus typed questions (`Score`, `Choice`, `Noul`) and gets back typed answers with
a **calibrated confidence** in `[0, 1]`. The point of the calibrated number is that a low
confidence is a first-class answer, not a failure: below `runAtConfidence` the answer is
not used at all, and an answer that omits confidence entirely is discarded too — it never
rides a floor lowered to its clamp.

Measured latency from Vietnam is **0.72-1.35 s per call**. That is the range observed
here, not the vendor's: the vendor publishes 70-500 ms, which is West-Coast server-side
time. Plan your timeouts against the measured range, not the published one.

Cost shape, as published by the vendor: **input about $0.042 per million tokens, output
free**.

## Fail-open contract

No key, `401`, `429`, `529`, a timeout, an unreachable network, a `422`, or a malformed
body all produce the **same behaviour as a build without the integration**: the judge
result is `null` and the pre-existing local path runs unchanged. Concretely, if every
call fails:

- the reviewer escalates to the LLM bridge;
- goal evaluation falls back to the `VIBEFLOW_AI` bridge;
- risk keeps the deterministic tier (raise-only, so a `null` raises nothing);
- the planner leaves `unit.engine` **undefined**, so dispatch keeps the run-global
  engine resolution and never substitutes the first engine in the pool.

No judge failure can open a gate, change a verdict the local gate did not already allow,
or block a dispatch.

## Judge authority: escalate only

> **Invariant (JUDGE-ESCALATE-ONLY).** A judge answer may move an outcome only in the
> direction that causes more work or more scrutiny. It must never be the sole reason a
> check is skipped, a gate is passed, or an engine call is elided.

Concretely, per call site: the judge's **negative** answer may short-circuit, and its
**positive** answer must fall through to the pre-existing authority.

| Call site | Negative answer (may short-circuit) | Positive answer (must fall through) |
| --- | --- | --- |
| `reviewer` | `pass: false` or a score below `judgePassLevel` returns the failing result without spawning the engine | `pass: true` **continues to the engine reviewer**; the engine verdict is authoritative and the agreement is only recorded as `judge.agreed` |
| `goalCoverage` | `covered: false` is returned, so `vf verify` reports the goal uncovered | `covered: true` **continues to the `VIBEFLOW_AI` bridge**; the bridge answer is authoritative |
| `risk` | n/a, there is no negative that skips work | raise-only through the existing strict `>` merge against the deterministic tier: a lower or equal tier is discarded |
| `planner` | may **exclude** engines from the ready pool | may select **only among ready engines**, and a failed or absent answer leaves `unit.engine` undefined rather than defaulting to the first entry |

`acceptAtConfidence` is therefore **not** a skip-the-engine boundary. It gates only
whether the judge's *negative* answer is trusted enough to short-circuit early. No
confidence value and no setting lets the judge satisfy a check on its own.

## The four call sites

The judge is wired into exactly **four call sites**, each with its own toggle and its own
timeout budget.

### `reviewer`

Scores a unit's diff against its goal before the engine reviewer runs. On a failing
answer the change is sent back in about a second instead of waiting on a 20-40 s engine
call. On a passing answer the engine reviewer still runs. `reviewerEngine` selects what
`unit.engine` means for this: `"unit"` uses the unit's own engine, `"global"` uses the
run-global one. The policy comes from the saved `typesafe` block, so an install with **no
block at all** resolves to `"global"`: the judge is off, and an engine-annotated unit never
re-routes its reviewer. Timeout: `timeoutMs`.

### `goalCoverage`

Scores goal coverage for `vf verify --goal-eval` and `POST /api/verify`. A `covered:
false` answer short-circuits; a `covered: true` answer still goes to the `VIBEFLOW_AI`
bridge. Timeout: `timeoutMs`.

### `risk`

Classifies a proposed shell command before the tool call. Raise-only: the judge can
raise the deterministic tier and can never lower it. Timeout: `hookTimeoutMs`, clamped
below. This is the highest-risk payload of the four, because a command line routinely
carries an inline secret.

### `planner`

Suggests which ready engine should implement a unit. The pool is the ready set, so a
judge cannot name an engine that is not installed and ready, and the routing is bounded
by `maxCalls`. On a failed or absent answer `unit.engine` stays `undefined`. Timeout:
`timeoutMs`.

## Data egress: what leaves the machine

This is the only code path in VibeFlow that posts repository content to a third party.
Requests go to `TYPESAFE_ENDPOINT` = `https://api.typesafe.ai/v1/systemone`. The `state`
string is sent **verbatim**: not redacted, not truncated, not scrubbed.

| Call site | `state` sent to `api.typesafe.ai` | Also on the wire | Why it is sensitive |
| --- | --- | --- | --- |
| `reviewer` | the **unified diff of the unit's changes**, verbatim | the **goal text** (sent as `state`, never inside `instructions`), `model` | proprietary source, including any secret, token, or customer data a diff happens to add |
| `goalCoverage` | the **same unified diff** (or the literal `(no diff available)`) | the **goal text**, `model` | same as `reviewer` |
| `risk` | the **raw shell command**, exactly as the agent proposed it | the static `risk_tier` criteria, `model` | a command line routinely carries an inline secret (`AWS_SECRET...=`, `curl -H "Authorization: ..."`, `psql "postgres://user:pw@host"`) |
| `planner` | `UNIT: <unit.name>` and `SPEC: <unit.spec>`, the **full work-unit spec text** | the ready engine names as Choice criteria, `model` | the spec describes unshipped work and may quote internal systems |
| `vf config typesafe test` | the **fixed literal probe string** plus a **fixed literal probe goal**, both exported constants | `model` | no repository content; safe to run before enabling anything |

What is **never** sent: the API key is an `Authorization` header, not payload;
`.vibeflow/SETTINGS.json`, file paths outside the diff, environment variables, and git
history are never read into `state`.

### The injection surface

Three of the four `state` payloads are attacker-influenced. Anyone who can open a pull
request controls the reviewer's diff; the goal may be an issue body; a unit spec may
originate in an issue body; and the proposed shell command is chosen by whoever wrote
the file the agent just read.

The payload text is placed in `state` and never in the question instructions, so hostile
text is never structurally an instruction. **That is mitigation, not a control.** A
judge that is merely wrong, or steered by prose the placement failed to neutralise, still
returns a well-formed, high-confidence answer. The control is structural, and it is the
escalate-only invariant above: a hostile command that talks the judge into answering
`LOW` changes nothing, because `LOW` is never greater than what the local classifier
already found, and a hostile diff that talks the judge into `pass: true` still reaches
the engine reviewer.

## Key handling

The key is resolved in this order:

1. the `TYPESAFE_API_KEY` environment variable;
2. `~/.vibeflow/typesafe.env`, a single `TYPESAFE_API_KEY=` line;
3. nothing, which means the state is `unconfigured` and no HTTP is attempted even when
   `enabled === true`.

The key is **never** written into `.vibeflow/SETTINGS.json`, which is git-tracked in
this repository.

`vf config typesafe key` reads the key from hidden stdin. A `--key` flag is refused on
purpose: it would sit in shell history and in `ps` output.

The key file is owner-only on **both** platforms, and the mechanism is the repo's
durability authority rather than a POSIX-only promise:

- on POSIX the file is created with mode `0600`;
- on Windows, where `chmod 0600` is a no-op and a mode-bit assertion would pass without
  checking anything, the file's **DACL** is verified and inherited ACEs are migrated to
  owner-only by `hasPrivateMode`, and the containing directory is created by
  `ensurePrivateDirectory` the same way.

`hasPrivateMode` is re-verified after every write. **A machine where the key file
cannot be made owner-only is a hard error, not a degradation**: `vf config typesafe key`
fails rather than leaving a world-readable key on disk and printing a warning.

## The circuit breaker

`vf hook` is a fresh process per tool call, so an in-memory breaker would never trip.
The breaker state is therefore **file-backed** at `~/.vibeflow/typesafe-health.json`,
under the same per-user `~/.vibeflow` root as `typesafe.env`. Read and write are
fail-open: an unreadable, truncated, or unrecognised file means `idle` and an in-memory
only breaker, never an error and never a gate. Concurrent hook processes serialize their
read-modify-write under a lock, so a concurrent success cannot lower `fail_streak`,
clear `cooldown_until` early, or reset `consecutive_trips`.

| State | What it means for you | How it is left |
| --- | --- | --- |
| `off` | not enabled, or the call site is toggled off; no request is made and the judge returns `null` | `vf config typesafe on` and enabling the call site |
| `unconfigured` | enabled but no key resolves; no request is made | `vf config typesafe key`, or setting `TYPESAFE_API_KEY` |
| `idle` | healthy, breaker closed, requests allowed | any failure moves the streak up |
| `open` | breaker tripped; calls short-circuit and **no HTTP is made** until the cooldown elapses | the cooldown elapsing moves it to `half-open`; `vf config typesafe reset` or a passing probe moves it to `idle` |
| `half-open` | exactly **one** probe request is allowed, for the next caller; concurrent callers short-circuit to `null` | probe success moves it to `idle`; probe failure re-opens with a doubled cooldown |

Failure classification:

| Condition | Class | Trips the breaker |
| --- | --- | --- |
| no key resolves | `unconfigured` | no |
| breaker `open`, cooldown not elapsed | `cooldown` | unchanged |
| timeout or a caller abort | `abort` | **never** |
| connection reset, DNS, TLS, offline | `network` | streak + 1, retried at most once |
| `401`, `403` | `auth` | **immediately** |
| `429`, `529` | `budget` | **immediately** |
| `422` | `schema` | streak + 1, plus one loud warning line |
| other `5xx` | `server` | streak + 1, retried at most once |
| `2xx` with a body that fails validation | `malformed` | streak + 1 |

The cooldown starts at `cooldownBaseMs` (60 s), doubles per consecutive trip, and is
capped at `cooldownCapMs` (15 min).

## Commands

```bash
vf config typesafe on                              # enable, and print the egress notice first
vf config typesafe off                             # disable all four call sites
vf config typesafe status                          # state, thresholds, call sites, last call, both file paths
vf config typesafe model <id>                      # default jev-latest
vf config typesafe threshold run <0..1>            # runAtConfidence, default 0.7
vf config typesafe threshold accept <0..1>         # acceptAtConfidence, default 0.85
vf config typesafe call-site <reviewer|risk|goalCoverage|planner> <on|off>
vf config typesafe key                             # read the key from hidden stdin
vf config typesafe reset                           # rewrite the breaker record to idle
vf config typesafe test                            # one live probe with fixed literal content
```

`on` prints the egress notice **before** it writes the setting, and `status` prints it
unconditionally, so auditing a disabled install still shows what turning it on would
transmit.

## Settings

The block is `.vibeflow/SETTINGS.json` -> `typesafe`, and it never carries the key.

| knob | default | source |
| --- | --- | --- |
| `enabled` | `false` | `vf config typesafe on\|off` |
| key resolution order | env `TYPESAFE_API_KEY` -> `~/.vibeflow/typesafe.env` -> none | environment and file |
| `model` | `jev-latest` | `vf config typesafe model <id>` |
| `timeoutMs` | `3000` | settings only |
| `hookTimeoutMs` | `1500` | settings only, clamped to `min(1500, timeoutMs)` |
| `retryBackoffMs` | `250` | settings only, clamped `0..10000` |
| `hookBusLockRetries` | `0` | settings only, clamped `0..20` |
| `runAtConfidence` | `0.7` | `vf config typesafe threshold run <n>` |
| `acceptAtConfidence` | `0.85` | `vf config typesafe threshold accept <n>` |
| `judgeScoreLevels` | `3` | settings only |
| `judgePassLevel` | `2` | settings only |
| `judgeTestFloor` | `0.5` | settings only |
| `reviewerEngine` | `"unit"` | settings only, `"unit"` or `"global"`; an install with no `typesafe` block has no policy and reads as `"global"` |
| `failStreakLimit` | `2` | settings only |
| `cooldownBaseMs` | `60000` | settings only |
| `cooldownCapMs` | `900000` | settings only |
| `maxCalls` | `20` | settings only; per process (a dispatched server request restarts its own bucket - a dry preview never does), counted in guard entries |
| the four call-site toggles | all `true` | `vf config typesafe call-site <name> <on\|off>` |
| `status`, `key`, `reset`, `test` | - | `vf config typesafe <sub>` |
| `~/.vibeflow/typesafe.env`, `~/.vibeflow/typesafe-health.json` | - | paths, and the removal command below |

`maxCalls` is counted in **guard entries**, not HTTP requests: the client retries once
on a `network` or `server` failure, so the hard HTTP bound is `2 x maxCalls`.

A long-lived `vf serve` process is not one run, so both server request boundaries restart
their own bucket: `POST /api/verify?goal-eval=1` restarts the goal-coverage bucket (one
judged request is one run) and `POST /api/typesafe/test` restarts the probe bucket. Three
counters, and no bucket can exhaust or refund another — in particular no route ever zeroes
the enforcement count the hook and review seams share, so a mounted request cannot refund
budget a drained run must refuse. The goal-coverage call still records into
`typesafe-health.json` (a failed goal call IS an enforcement failure); only the probe
diagnostic keeps its own file, because a diagnostic must not change the thing it diagnoses.

### The two clamps that keep the hook path alive

The host runs `vf hook` under a 10 s kill budget and reads a non-zero exit as a blocked
tool call, and `hook()` may already have spent 5 s draining stdin. Two settings are
therefore clamped, not merely defaulted:

- **`HOOK_TIMEOUT_CAP_MS = 1500`** is a hard ceiling on `hookTimeoutMs` on top of the
  `hookTimeoutMs <= timeoutMs` clamp. Clamping only to `timeoutMs` would leave a legal
  `{ timeoutMs: 10000, hookTimeoutMs: 10000 }` in which the judge alone consumes the
  entire spawn budget, the host kills the process, and a judge timeout becomes a
  **blocked tool call**. The cap bounds the largest single leg instead of consuming it,
  and `1500` is already the default, so it is a ceiling on misconfiguration rather than
  a behaviour change.
- **`HOOK_BUS_LOCK_RETRIES_MAX = 20`** is the ceiling on `hookBusLockRetries`, derived
  from the residual spawn budget and **not** copied from the repo-wide logbus policy:
  `floor((10_000 - 5_000 - 1_500 - 500 - 1_000) / (2 x 50)) = 20`. The `2 x` is not
  padding: one audit event can acquire the logbus lock **twice**, because a missing log
  directory makes the write relock. Reusing the repo policy of 100 would put the hook
  path at 17 000 ms, past the 10 s budget. The default is `0`: fail fast and drop the
  audit line rather than spend the budget.

The five legs of the enabled hook path are stdin drain (5 000) + judge (1 500) + health
lock (0) + health write (500) + audit bus lock (2 000) = **9 000 ms**, leaving 1 000 ms
of margin inside the 10 000 ms spawn budget. A setting can only shorten the sum.

## On-disk footprint

A **disabled** run creates no files and no directories: it never creates `~/.vibeflow`,
never writes `typesafe-health.json`, and never reads `typesafe.env`. The HTTP client
module is also not even loaded on a disabled path, so the integration costs nothing
until you turn it on.

An **enabled** run leaves three files under `~/.vibeflow`, all outside the repository and
never git-tracked:

| Path | Written by | Contents | Mode |
| --- | --- | --- | --- |
| `~/.vibeflow/typesafe.env` | `vf config typesafe key` | the API key, one `TYPESAFE_API_KEY=` line | owner-only (`0600` on POSIX, migrated owner-only DACL on Windows) |
| `~/.vibeflow/typesafe-health.json` | any enforcement call site | breaker state plus a `last_call` audit record; never the key, never payload text | owner-only (`0600` on POSIX) |
| `~/.vibeflow/typesafe-health.probe.json` | `vf config typesafe test` and the Control Center probe | the same record shape for the OPERATOR probe, kept separate so a passing probe can never clear the enforcement breaker | owner-only (`0600` on POSIX) |

An enabled run also appends to the hook's audit bus at `.vibeflow/logs/current.log`,
which IS in-repo but gitignored (`.vibeflow/.gitignore`). It records the hook's own
decisions; the judge's payload text is never written to it.

`vf config typesafe reset` is **not** uninstall: it rewrites the health record to `idle`
so a tripped breaker recovers after a key rotation, and it deliberately leaves all three
files in place. Removing the files is always safe, because the health read is fail-open
and an absent file means `idle`.

Complete removal, the documented uninstall path:

```bash
vf config typesafe off                       # stop all four call sites
rm -f ~/.vibeflow/typesafe-health.json ~/.vibeflow/typesafe-health.probe.json ~/.vibeflow/typesafe.env
```

`vf config typesafe status` names all three paths on their own lines
with each file's presence and modification time, and prints the exact
`remove all:` command, so you can always find what to delete
without reading this page.

## Getting started

```bash
vf config typesafe key                        # hidden stdin
vf config typesafe on                         # prints the egress notice first
vf config typesafe test                       # one live probe, fixed literal content
vf config typesafe status                     # see the state and the last call
```

`vf config typesafe test` uses fixed literal content, so it is safe to run before
anything repository-specific leaves the machine. It exits `2` when no key resolves or the
judge is disabled, and `1` when the request failed, so the two are distinguishable in a
script.
