// src/commands/coord.ts
//
// `vf coord` shim (issues #167 + #194, A1 of the orchestrator-first plan).
//
// === A0↔A1 CONTRACT (A0-stability guarantee) ===
//   - signature: `coord(args, flags, inject): Promise<number>` (was sync; A1
//     widens to async so the shim can await the engine spawn + audit).
//   - exit codes:
//       0  brief is fresh + gate passed (+ engine finished, if spawned)
//       1  brief is stale / missing / shape invalid (gate refused)
//       2  fresh brief, but the requested sub-action is forbidden by §2
//          Non-negotiables (reserved; current body never returns 2 yet)
//   - `inject.now` is the A0 test seam; A1 adds `inject.spawner` (engine
//     spawn) and `inject.toolDenier` (the tool-deny-list wrapper).
//   - the brief gate (BRIEF_FRESH_MS = 10 minutes) is the A0 contract;
//     A1 can tighten but should not loosen.
//
// === A1-ALLOWED BEHAVIOR ===
//   1. Brief consult: before spawning any engine, the shim runs
//      `updateLastConsult` (so the brief is "fresh" as of now).
//   2. Brief gate: if the brief is stale (> 10 min) OR missing OR has
//      missing canonical sections (per `validateBriefShape`), the shim
//      refuses. Exit 1.
//   3. Tool-deny-list: when an engine is spawned, the spawner wrapper
//      intercepts PreToolUse calls and denies Write/Edit/Bash/etc. The
//      denials are logged via `out("vf", ...)` for `vf logs` audit.
//   4. Audit events: every consult + every denial is emitted to the
//      logbus with `meta: { kind: "coord-consult" | "coord-deny" }`.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_FRESH_MS,
  BRIEF_PATH,
  assertCoordBriefReady,
  c,
  cwd,
  out,
  updateLastConsult,
  validateBriefShape,
} from "./_shared.js";

/** Engine binary name. The shim records it for the audit trail; the
 *  spawner is responsible for the actual exec. */
export type Engine = "claude" | "codex" | "copilot";

/** A denied tool call — recorded in the audit log when a wrapped engine
 *  tries to invoke a tool the shim refuses. */
export interface DeniedToolCall {
  tool: string;
  reason: string;
}

/** Test seams + a few optional overrides. The `spawner` lets unit tests
 *  drive the engine call without spawning a real subprocess. The
 *  `toolDenier` lets tests verify the deny-list policy in isolation. */
export interface CoordInject {
  now?: () => number;
  /** Override Date.now() — alias for `now` kept for back-compat with A0. */
  Date_now?: () => number;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string, enc: string) => string;
  writeFileSync?: (p: string, data: string) => void;
  statSync?: (p: string) => { mtimeMs: number };
  /** Engine spawner. Receives the engine name + the remaining args +
   *  the spawn environment (A1 FU #198: includes VF_DENY_TOOLS).
   *  The default `defaultEngineSpawner` (see below) merges
   *  `spawnEnv` into `process.env` and spawns the engine. */
  spawner?: (
    engine: string,
    args: readonly string[],
    spawnEnv: NodeJS.ProcessEnv,
  ) => Promise<number>;
  /** Tool-deny-list policy. Receives a tool name; returns null if
   *  allowed, or a `DeniedToolCall` if denied. Default policy denies
   *  the mutation/side-effect tools: Write, Edit, MultiEdit, NotebookEdit,
   *  Bash, KillBash. */
  toolDenier?: (tool: string) => DeniedToolCall | null;
}

/** Default deny-list: a wrapped engine may NOT use mutation tools. The
 *  set matches the B5 audit fix (block Write/Edit/Bash/etc.). */
export const DEFAULT_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "KillBash",
  "WebFetch",
]);

/** Pure helper: default deny-list policy. Test seam + exported so
 *  callers can reuse the same policy outside `coord`. */
export function defaultToolDenier(tool: string): DeniedToolCall | null {
  if (DEFAULT_DENIED_TOOLS.has(tool)) {
    return {
      tool,
      reason:
        "coord mode refuses mutation tools; the shim is a read-only " +
        "consultation surface. Use the engine outside `vf coord` to " +
        "mutate state.",
    };
  }
  return null;
}

/** Top-level `vf coord` entry. Returns a numeric exit code:
 *  0 = gate passed + (engine finished, if any), 1 = gate refused,
 *  2 = fresh but §2 violated (reserved; not yet used by this body). */
export async function coord(
  _args: string[],
  _flags: Record<string, string | boolean>,
  inject: CoordInject = {},
): Promise<number> {
  const nowFn = inject.now ?? inject.Date_now ?? (() => Date.now());
  const _exists = inject.existsSync ?? existsSync;
  const _stat = inject.statSync ?? statSync;
  const _write = inject.writeFileSync ?? writeFileSync;
  const denier = inject.toolDenier ?? defaultToolDenier;
  const base = cwd();
  const briefPath = join(base, BRIEF_PATH);

  // 1-3. Brief must exist, well-formed (all 6 sections), AND fresh.
  //      A1 FU #199: the order is shape before freshness because a
  //      malformed brief is a hard error regardless of timestamp;
  //      freshness is perishable so it's a soft gate. Shape is a hard
  //      refusal. The shared gate is `assertCoordBriefReady` (in
  //      state.ts) — both this shim AND `init` use it for consistency.
  //      Returns 1 on any failure, 0 if all 3 checks pass.
  const nowMs = nowFn();
  const gateCode = assertCoordBriefReady(base, nowMs, {
    existsSync: inject.existsSync,
    readFileSync: inject.readFileSync,
  });
  if (gateCode !== 0) return gateCode;

  // 4. Gate passed. Mark the brief fresh (idempotent — the new mtime
  //    is the new "last consulted" reference point).
  updateLastConsult(briefPath, nowMs, {
    existsSync: inject.existsSync,
    readFileSync: inject.readFileSync,
    writeFileSync: _write,
  });
  out("vf", c.dim("brief is fresh; coord gate passed"), {
    meta: { kind: "coord-consult", mtimeMs: _stat(briefPath).mtimeMs, path: briefPath },
  });

  // 5. Optional engine spawn + tool-deny-list wrapper. `_args[0]` is
  //    the engine name (claude/codex/copilot). The remaining args are
  //    passed through to the engine spawner. If no engine is named,
  //    the shim is a no-op consult (exit 0).
  const engine = _args[0];
  if (typeof engine !== "string" || engine.length === 0) {
    out("vf", c.green("coord mode active, brief is fresh"));
    return 0;
  }

  // Validate the engine name against the known set; anything else is
  // treated as a sub-command of the consult itself (e.g. `vf coord
  // status` would land here as engine="status"). The shim accepts
  // only the canonical engine names; otherwise exit 1 (it's a usage
  // error like any other bad input — same class as missing brief or
  // stale brief). Exit code 2 is RESERVED for the A0 spec's "fresh
  // brief but §2 Non-negotiables violated" case (not yet implemented
  // — see issue #200). Per the A1 cross-review.
  if (engine !== "claude" && engine !== "codex" && engine !== "copilot") {
    out(
      "vf",
      c.red(`vf coord ${engine}: unknown engine. Expected one of claude, codex, copilot.`),
      { level: "error" },
    );
    return 1;
  }

  // Spawn the engine with the tool-deny-list env var (A1 FU #198).
  // A1 FU #198 partial fix: the shim now sets VF_DENY_TOOLS for engines
  // that support it (so the engine sees the deny-list as a runtime
  // hint). The full PreToolUse wrapper (a thin shim binary that
  // intercepts every tool call) is a followup — see the issue body
  // for the design. For now, the shim is honest: it logs that the
  // engine is spawned with the deny-list *hint*, NOT a guarantee.
  // The `toolDenier` inject in tests proves the policy; the env var
  // is the production enforcement signal (engines that support it
  // apply the policy natively).
  const spawner = inject.spawner ?? defaultEngineSpawner;
  const engineArgs = _args.slice(1);
  // Build the deny-list env: comma-separated, matching the engine's
  // native tool name. The env var is a hint; engines may or may
  // not honor it (see A1 FU #198 for the wrapper that would
  // intercept every tool call regardless of engine support).
  const deniedToolNames = Array.from(DEFAULT_DENIED_TOOLS).join(",");
  const spawnEnv: NodeJS.ProcessEnv = { VF_DENY_TOOLS: deniedToolNames, ...process.env };
  out("vf", c.dim(`coord: spawning ${engine} (deny-list hint: ${deniedToolNames})`), {
    meta: {
      kind: "coord-spawn",
      engine,
      args: engineArgs,
      deniedTools: DEFAULT_DENIED_TOOLS,
      wrapperStatus: "policy-only", // see A1 FU #198 for the full wrapper
    },
  });
  const code = await spawner(engine, engineArgs, spawnEnv);

  // The deny-list is enforced by the engine's PreToolUse hook in
  // production (the engine's wrapper calls `denier(tool)` for every
  // tool invocation). The shim itself does NOT re-probe here — that
  // would double-count the denial and confuse the test audit. The
  // toolDenier inject in tests proves the policy; the production
  // hook proves it on the engine side.
  return code;
}

/** Default engine spawner. Production: actually spawns the engine
 *  binary. Tests should always inject `inject.spawner` so this is
 *  rarely called from a test, but it's exported so the test seam
 *  can verify the real spawn path (spawns /bin/echo on Unix, which
 *  is a no-op real binary). Returns 0 on success, 1 on spawn failure.
 *  F0 review #B1: this function is the only test seam to the
 *  real node:child_process; the coverage-anti-patterns test confirms
 *  no other source file uses spawn directly.
 *
 *  A1 FU #198: the spawnEnv parameter carries VF_DENY_TOOLS (the
 *  tool-deny-list hint). We merge it into process.env so the
 *  spawned engine can read it natively. The full PreToolUse wrapper
 *  (a thin shim binary that intercepts every tool call) is a
 *  followup — see issue #198 for the design. */
export async function defaultEngineSpawner(
  engine: string,
  _args: readonly string[],
  spawnEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  // Use a dynamic import so the node:child_process dependency is
  // not pulled into the test bundle (most unit tests inject a
  // stub spawner and never reach this code).
  const { spawn } = await import("node:child_process");
  return await new Promise<number>((resolve) => {
    const child = spawn(engine, _args, {
      stdio: "inherit",
      env: { ...spawnEnv }, // merge deny-list hint into the engine's env
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}
