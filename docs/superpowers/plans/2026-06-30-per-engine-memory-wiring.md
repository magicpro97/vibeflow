# Per-Engine Memory Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `vf` memory wiring per-engine: default off; on-enable asks which platforms; claude/codex use claude-mem pinned to v12 (no account/email); copilot uses native `/memory on` via a guidance line.

**Architecture:** Five seams change, each keeping its single responsibility. `src/memory.ts` gains a per-engine partition (copilot → guidance-only, claude/codex → pinned installer) and a new default version `"12"`. `src/settings.ts` records the chosen engines via an optional sibling field (the `memory: boolean` stays untouched for back-compat). `src/commands/init-memory.ts` adds a platform-selection step. A new `vf memory <on|off|status>` command provides runtime re-entry, with `vf config memory` kept as a thin alias.

**Tech Stack:** TypeScript + Bun runtime, Biome lint/format, bun:test. Inject seams for testability (not mock.module). `spawnSync` with array args. Normalize path separators in assertions.

## Global Constraints

- **claude-mem default version = `"12"`** (newest band before `better-auth` account login). Override chain: `opts.version` → `VF_CLAUDE_MEM_VERSION` env → `"12"`.
- **`Engine` type** = `"claude" | "codex" | "copilot"`; **`ENGINES`** = `["claude", "copilot", "codex"]` (from `src/core.js` / `src/core/types.ts`).
- **claude/codex** → claude-mem installer. **copilot** → NO claude-mem; guidance line only (`/memory on` is interactive-only, not headless-scriptable).
- Memory is enrichment, never a gate: every memory function is best-effort, returns a result, never throws. A per-engine failure warns and continues.
- Conventions: inject seams (not mock.module); `spawnSync` array args; normalize path separators (`.replace(/\\/g, "/")`); template literals over concatenation; export new types/functions from `src/commands/_shared.ts` where cross-module.
- After every code change: `bun run typecheck && bun run lint`. After a feature: `bun test --timeout 30000 <test-file>`.
- Commits: `type(scope): description` + `Signed-off-by` line matching git identity. Stage explicit paths — never `git add -A`.

---

## Task 1: Pin claude-mem default version to `12`

**Files:**
- Modify: `src/memory.ts` (the `version` resolution in `installForEngine`, ~line 91)
- Test: `test/memory.test.ts` (update the exact-args assertion ~line 64-73; add a default-version test)

**Interfaces:**
- Consumes: existing `installForEngine(engine, opts)` and `MemoryBackendOpts.version`.
- Produces: default package spec is now `claude-mem@12` when no override is given. No signature change.

- [ ] **Step 1: Update the failing test for the new default**

In `test/memory.test.ts`, the first `installForEngine` test asserts the exact args. Change the expected package arg from `"claude-mem"` to `"claude-mem@12"`:

```ts
  test("runs the non-interactive installer with the engine's --ide and returns ok on status 0", () => {
    const calls: { cmd: string; args: readonly string[]; opts: unknown }[] = [];
    const res = installForEngine("codex", {
      spawner: ((cmd: string, args: readonly string[], opts: unknown) => {
        calls.push({ cmd, args, opts });
        return { status: 0 };
      }) as never,
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("npx");
    expect(calls[0]?.args).toEqual([
      "-y",
      "claude-mem@12",
      "install",
      "--ide",
      "codex-cli",
      "--provider",
      "claude",
      "--no-auto-start",
    ]);
  });
```

Add a dedicated default-version test right after it:

```ts
  test("defaults the pinned version to 12 (pre-account era: no email/account prompt)", () => {
    const orig = process.env.VF_CLAUDE_MEM_VERSION;
    process.env.VF_CLAUDE_MEM_VERSION = undefined;
    try {
      const calls: { args: readonly string[] }[] = [];
      installForEngine("claude", {
        spawner: ((_cmd: string, args: readonly string[]) => {
          calls.push({ args });
          return { status: 0 };
        }) as never,
      });
      expect(calls[0]?.args[1]).toBe("claude-mem@12");
    } finally {
      if (orig === undefined) process.env.VF_CLAUDE_MEM_VERSION = undefined;
      else process.env.VF_CLAUDE_MEM_VERSION = orig;
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --timeout 30000 test/memory.test.ts`
Expected: FAIL — current code resolves `"latest"`, so args contain `"claude-mem"` and `args[1]` is `"claude-mem"`, not `"claude-mem@12"`.

- [ ] **Step 3: Change the default in `src/memory.ts`**

In `installForEngine`, change the version-resolution line (currently ends with `?? "latest"`):

```ts
  // Default pin: "12" is the newest claude-mem band before the better-auth
  // account/email login era (13.x). It carries the codex-cli/copilot-cli ide
  // ids (added in 10.7.0) and never prompts for an account, so a fresh install
  // is one-shot. Override: opts.version → VF_CLAUDE_MEM_VERSION → "12".
  const version = opts.version ?? process.env.VF_CLAUDE_MEM_VERSION ?? "12";
```

Also update the JSDoc on `MemoryBackendOpts.version` (the `Default is "latest"` sentence) to say `Default is "12"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --timeout 30000 test/memory.test.ts`
Expected: PASS (all memory tests green, including the existing version-override tests which set `opts.version`/env explicitly).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/memory.ts test/memory.test.ts
git commit -m "feat(memory): pin claude-mem default to v12 (pre-account band)" -s
```

---

## Task 2: Copilot guidance block (no claude-mem install)

**Files:**
- Modify: `src/memory.ts` (add `buildCopilotMemoryGuide` + `appendCopilotMemoryGuide`)
- Test: `test/memory.test.ts` (new describe blocks)

**Interfaces:**
- Consumes: existing `ctxPathIn`, `writeFileSafe`, `existsSync`, `readFileSync` already imported in `src/memory.ts`.
- Produces:
  - `buildCopilotMemoryGuide(): string` — pure; returns markdown keyed on header `## Memory: GitHub Copilot`.
  - `appendCopilotMemoryGuide(base: string): boolean` — idempotent, best-effort; appends to `<base>/.vibeflow/WORKFLOW_POLICY.md`; returns false when the file is absent or the block already exists.

- [ ] **Step 1: Write the failing tests**

Add to `test/memory.test.ts`:

```ts
import {
  ENGINE_IDE,
  appendCopilotMemoryGuide,
  appendMemoryGuide,
  buildCopilotMemoryGuide,
  buildMemoryGuide,
  ensureInstalledForEngines,
  installForEngine,
  isInstalled,
} from "../src/memory.js";

describe("memory.buildCopilotMemoryGuide", () => {
  test("renders the copilot header and the /memory on instruction", () => {
    const guide = buildCopilotMemoryGuide();
    expect(guide).toContain("## Memory: GitHub Copilot");
    expect(guide).toContain("/memory on");
  });
});

describe("memory.appendCopilotMemoryGuide", () => {
  test("appends the copilot guide to an existing WORKFLOW_POLICY.md and returns true", () => {
    const dir = tmpRepo();
    try {
      const p = writePolicy(dir, "# Workflow Policy\n");
      expect(appendCopilotMemoryGuide(dir)).toBe(true);
      const after = readFileSync(p, "utf8");
      expect(after).toContain("## Memory: GitHub Copilot");
      expect(after).toContain("/memory on");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — a second call does not duplicate the block", () => {
    const dir = tmpRepo();
    try {
      writePolicy(dir, "# Workflow Policy\n");
      expect(appendCopilotMemoryGuide(dir)).toBe(true);
      expect(appendCopilotMemoryGuide(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns false when WORKFLOW_POLICY.md is absent (never throws)", () => {
    const dir = tmpRepo();
    try {
      expect(appendCopilotMemoryGuide(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --timeout 30000 test/memory.test.ts`
Expected: FAIL — `buildCopilotMemoryGuide` / `appendCopilotMemoryGuide` are not exported yet.

- [ ] **Step 3: Implement in `src/memory.ts`**

Add a second guide header constant near `GUIDE_HEADER`:

```ts
/** Header the copilot guide block is keyed on (idempotency). */
const COPILOT_GUIDE_HEADER = "## Memory: GitHub Copilot";
```

Add the two functions (place them next to `buildMemoryGuide` / `appendMemoryGuide`):

```ts
/** Render the markdown guide telling a Copilot session to enable native memory. Pure. */
export function buildCopilotMemoryGuide(): string {
  return `${COPILOT_GUIDE_HEADER} (VibeFlow)

When running in GitHub Copilot CLI, enable session memory by typing the
slash command at the start of your session:

\`\`\`
/memory on
\`\`\`

VibeFlow cannot enable this for you — it is an interactive command, not a
headless flag. Once enabled, Copilot persists memory across this project's
sessions.
`;
}

/**
 * Append the copilot guide to <base>/.vibeflow/WORKFLOW_POLICY.md when not
 * already present. Idempotent (keyed on the copilot header) and best-effort:
 * returns false when the policy file is absent or the block already exists.
 * Never throws.
 */
export function appendCopilotMemoryGuide(base: string): boolean {
  const path = ctxPathIn(base, "WORKFLOW_POLICY.md");
  if (!existsSync(path)) return false;
  const current = readFileSync(path, "utf8");
  if (current.includes(COPILOT_GUIDE_HEADER)) return false;
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSafe(path, `${current}${sep}${buildCopilotMemoryGuide()}`);
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --timeout 30000 test/memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/memory.ts test/memory.test.ts
git commit -m "feat(memory): add copilot native-memory guidance block" -s
```

---

## Task 3: Partition wiring — copilot guidance vs claude/codex install

**Files:**
- Modify: `src/memory.ts` (`ensureInstalledForEngines`)
- Test: `test/memory.test.ts` (`ensureInstalledForEngines` describe block)

**Interfaces:**
- Consumes: `installForEngine` (claude/codex), `appendCopilotMemoryGuide` (copilot) from Task 2.
- Produces: `ensureInstalledForEngines(engines, opts)` unchanged signature and `MemoryWireResult` shape, but **copilot is wired via the guidance block (no installer spawn)**. A copilot entry appears in `wired` when its guide is appended OR the policy file is absent (best-effort: copilot "wiring" is advisory, so it is never reported as failed). claude/codex keep the installer path.
- New optional opt so tests inject the guide appender:
  ```ts
  /** Injectable copilot guide appender. Defaults to appendCopilotMemoryGuide. */
  appendCopilotGuide?: (base: string) => boolean;
  ```
  added to `MemoryBackendOpts`.

- [ ] **Step 1: Write the failing tests**

Replace the first `ensureInstalledForEngines` test ("wires every engine…") and add a copilot-specific one. The key behavioral change: copilot must NOT spawn the installer.

```ts
describe("memory.ensureInstalledForEngines", () => {
  test("installs claude/codex but routes copilot to the guidance block (no spawn)", () => {
    const ides: string[] = [];
    let copilotGuideCalls = 0;
    const res = ensureInstalledForEngines(["claude", "codex", "copilot"], {
      spawner: ((_cmd: string, args: readonly string[]) => {
        ides.push(args[args.indexOf("--ide") + 1] as string);
        return { status: 0 };
      }) as never,
      appendCopilotGuide: () => {
        copilotGuideCalls++;
        return true;
      },
    });
    expect(res.wired).toEqual(["claude", "codex", "copilot"]);
    expect(res.failed).toEqual([]);
    // Only claude + codex hit the installer; copilot never does.
    expect(ides).toEqual(["claude-code", "codex-cli"]);
    expect(copilotGuideCalls).toBe(1);
  });

  test("copilot wiring is advisory: a false guide append still reports copilot wired", () => {
    const res = ensureInstalledForEngines(["copilot"], {
      spawner: (() => {
        throw new Error("installer must not run for copilot");
      }) as never,
      appendCopilotGuide: () => false, // policy file absent
    });
    expect(res.wired).toEqual(["copilot"]);
    expect(res.failed).toEqual([]);
  });
});
```

Keep the existing "best-effort: one engine failing…", "de-duplicates…", and "empty engine list…" tests, but update the best-effort test so the failing engine is a claude-mem engine (codex), not copilot — copilot no longer spawns:

```ts
  test("is best-effort: one claude-mem engine failing does not block the others", () => {
    const res = ensureInstalledForEngines(["claude", "codex", "copilot"], {
      spawner: ((_cmd: string, args: readonly string[]) => {
        const ide = args[args.indexOf("--ide") + 1];
        return ide === "codex-cli" ? { status: 1 } : { status: 0 };
      }) as never,
      appendCopilotGuide: () => true,
    });
    expect(res.wired).toEqual(["claude", "copilot"]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.engine).toBe("codex");
    expect(res.failed[0]?.reason).toContain("codex-cli");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --timeout 30000 test/memory.test.ts`
Expected: FAIL — current `ensureInstalledForEngines` spawns the installer for copilot (asserts `ides` would include `copilot-cli`), and `appendCopilotGuide` opt is unknown.

- [ ] **Step 3: Implement the partition in `src/memory.ts`**

Add the opt to `MemoryBackendOpts`:

```ts
  /** Injectable copilot guide appender. Defaults to {@link appendCopilotMemoryGuide}. */
  appendCopilotGuide?: (base: string) => boolean;
```

Rewrite the loop body of `ensureInstalledForEngines`:

```ts
export function ensureInstalledForEngines(
  engines: Engine[],
  opts: MemoryBackendOpts = {},
): MemoryWireResult {
  const appendCopilot = opts.appendCopilotGuide ?? appendCopilotMemoryGuide;
  const seen = new Set<Engine>();
  const wired: Engine[] = [];
  const failed: Array<{ engine: Engine; reason: string }> = [];
  for (const engine of engines) {
    if (seen.has(engine)) continue;
    seen.add(engine);
    if (engine === "copilot") {
      // Copilot uses its own native /memory feature, not claude-mem. We only
      // drop a guidance line; the append result is advisory (a missing policy
      // file is not a failure), so copilot is always reported wired.
      appendCopilot(opts.cwd ?? cwd());
      wired.push(engine);
      continue;
    }
    const res = installForEngine(engine, opts);
    if (res.ok) wired.push(engine);
    else failed.push({ engine, reason: res.reason ?? "unknown" });
  }
  return { wired, failed };
}
```

Add `cwd` to the imports from `./core.js` at the top of `src/memory.ts`. `cwd` is exported by `src/core.ts:80` (extend the existing `import { ... } from "./core.js"` line that already pulls `ctxPathIn`/`hasCommand`/`writeFileSafe`):

```ts
import { type Engine, ctxPathIn, cwd, hasCommand, writeFileSafe } from "./core.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --timeout 30000 test/memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/memory.ts test/memory.test.ts
git commit -m "feat(memory): route copilot to native guidance, claude/codex to installer" -s
```

---

## Task 4: Record chosen engines in settings (back-compat)

**Files:**
- Modify: `src/settings.ts` (add `memoryEngines?` to `VibeSettings` + `coerce`)
- Test: `test/settings.test.ts` (or `test/config.test.ts` — use whichever holds settings coercion tests; create `test/settings.test.ts` if none)

**Interfaces:**
- Consumes: existing `Engine` type (import from `./core.js`), `coerce`, `defaults`.
- Produces: `VibeSettings.memoryEngines?: Engine[]` — absent on old files; when present, coerced to valid `Engine` ids only. `memory: boolean` is unchanged.

- [ ] **Step 1: Confirm where settings coercion is tested**

Run: `grep -rln "coerce\|readSettings.*memory\|toolPriority" test/ | head`
If a settings-coercion test file exists, add to it. Otherwise create `test/settings.test.ts` with the standard `tmpRepo` helper.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../src/settings.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-settings-"));
}

describe("settings.memoryEngines", () => {
  test("round-trips a written memoryEngines array", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: true, memoryEngines: ["claude", "codex"] });
      expect(readSettings(dir).memoryEngines).toEqual(["claude", "codex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is absent (undefined) on a file that never wrote it (back-compat)", () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: true });
      expect(readSettings(dir).memoryEngines).toBeUndefined();
      expect(readSettings(dir).memory).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops unknown engine ids, keeping only valid ones", () => {
    const dir = tmpRepo();
    try {
      const ctx = join(dir, ".vibeflow");
      mkdirSync(ctx, { recursive: true });
      writeFileSync(
        join(ctx, "SETTINGS.json"),
        JSON.stringify({ memory: true, memoryEngines: ["claude", "bogus", "codex"] }),
      );
      expect(readSettings(dir).memoryEngines).toEqual(["claude", "codex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test --timeout 30000 test/settings.test.ts`
Expected: FAIL — `memoryEngines` is not part of `VibeSettings`, so it is dropped on read.

- [ ] **Step 4: Implement in `src/settings.ts`**

Add the import (top of file, alongside other core imports):

```ts
import { ENGINES, type Engine } from "./core.js";
```

> **Implementer note:** verify `ENGINES`/`Engine` are exported by `./core.js` (they are re-exported there per `src/core.ts:78`). If the existing import line for core already pulls other symbols, extend it rather than adding a duplicate import.

Add the field to the `VibeSettings` interface (right after the `memory: boolean;` block, ~line 42):

```ts
  /**
   * Engines memory was enabled for. claude/codex are wired to claude-mem;
   * copilot uses its native /memory feature. Absent on pre-existing files,
   * in which case callers treat it as "all chosen engines" (back-compat).
   */
  memoryEngines?: Engine[];
```

In `coerce` (after the `obj.memory` read, ~line 136), add:

```ts
  // Read memoryEngines when present and well-formed, keeping only valid engine
  // ids (mirrors the lspServers filtering below). Absent → leave undefined so
  // old files round-trip unchanged.
  if (Array.isArray(obj.memoryEngines)) {
    const valid = obj.memoryEngines.filter((e): e is Engine =>
      (ENGINES as string[]).includes(e as string),
    );
    if (valid.length) out.memoryEngines = valid;
  }
```

Do NOT add `memoryEngines` to `DEFAULT_SETTINGS` or `defaults()` — absence is the back-compat default.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test --timeout 30000 test/settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/settings.ts test/settings.test.ts
git commit -m "feat(settings): record chosen memory engines (back-compat optional field)" -s
```

---

## Task 5: Platform-selection prompt in `runMemoryPhase`

**Files:**
- Modify: `src/commands/init-memory.ts`
- Test: `test/init-memory.test.ts`

**Interfaces:**
- Consumes: `selectMany` from `../terminal-prompts/prompts.js`; `writeSettings` (now accepts `memoryEngines`); `ensureInstalledForEngines`; `appendMemoryGuide`.
- Produces: `MemoryPhaseInject` gains `askEngines?: (engines: Engine[]) => Promise<Engine[]>`. After a yes decision, the phase selects platforms (default = all chosen engines), persists `{ memory: true, memoryEngines: selected }`, and wires only `selected`. The claude-mem search guide (`appendMemoryGuide`) is added only when a claude-mem engine (claude/codex) wired; copilot wiring already appended its own guide inside `ensureInstalledForEngines`.

- [ ] **Step 1: Write the failing tests**

Add to `test/init-memory.test.ts`. The `spies` helper's `inject` already stubs `ensureInstalledForEngines`/`appendMemoryGuide`; extend it to record `askEngines`. Add new tests:

```ts
describe("runMemoryPhase — platform selection", () => {
  test("TTY yes wires only the selected platforms and persists memoryEngines", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({
        isTTY: () => true,
        ask: async () => true,
        askEngines: async () => ["claude"] as Engine[],
      });
      await runMemoryPhase(dir, {}, ["claude", "codex", "copilot"], inject);
      expect(readSettings(dir).memory).toBe(true);
      expect(readSettings(dir).memoryEngines).toEqual(["claude"]);
      expect(calls.wired).toEqual([["claude"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--memory flag (non-interactive) keeps all chosen engines", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies(); // isTTY:false, no askEngines
      await runMemoryPhase(dir, { memory: true }, ["claude", "codex"], inject);
      expect(readSettings(dir).memoryEngines).toEqual(["claude", "codex"]);
      expect(calls.wired).toEqual([["claude", "codex"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("selecting copilot-only wires copilot and persists it, no claude-mem search guide", async () => {
    const dir = tmpRepo();
    try {
      seedPolicy(dir);
      const { calls, inject } = spies({
        isTTY: () => true,
        ask: async () => true,
        askEngines: async () => ["copilot"] as Engine[],
        // copilot wiring is reported wired by the real partition; the stub
        // mirrors that and records NO claude-mem search-guide append.
        ensureInstalledForEngines: (engines: Engine[]) => {
          calls.wired.push(engines);
          return { wired: engines, failed: [] };
        },
      });
      await runMemoryPhase(dir, {}, ["claude", "copilot"], inject);
      expect(readSettings(dir).memoryEngines).toEqual(["copilot"]);
      // The "## Memory: claude-mem" search guide is for claude/codex only.
      expect(calls.append).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Update the existing `spies` helper to thread `askEngines` and to default the search-guide gate. Modify the existing assertions that expect `appendMemoryGuide` on a copilot-only path if any (none currently select copilot-only, so existing tests stay valid — all current tests include claude or codex).

> **Implementer note:** the existing test "a partial wiring (one engine fails) still appends the guide" uses `wired: ["claude"]` — still a claude-mem engine, so `append` stays 1. Keep it. The "fully-failed wiring" test has `wired: []` → `append` 0. Keep it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --timeout 30000 test/init-memory.test.ts`
Expected: FAIL — `askEngines` is not consumed; `memoryEngines` is not persisted; the search-guide gate does not distinguish claude-mem engines from copilot.

- [ ] **Step 3: Implement in `src/commands/init-memory.ts`**

Add to `MemoryPhaseInject`:

```ts
  /** Platform multi-select. Defaults to a `selectMany` wrapper (all preselected). */
  askEngines?: (engines: Engine[]) => Promise<Engine[]>;
```

Import `selectMany`:

```ts
import { selectMany } from "../terminal-prompts/prompts.js";
```

In `runMemoryPhase`, after `if (!decision) return;`, insert platform resolution. Replace the existing `targets`/`writeSettings` logic:

```ts
  // Resolve which platforms to wire. On a TTY, ask (all preselected); otherwise
  // keep every chosen engine (flag-driven / non-interactive back-compat).
  const isTTY = inject.isTTY ?? (() => Boolean(process.stdin.isTTY));
  const chosen = engines.length ? engines : (["claude"] as Engine[]);
  let selected = chosen;
  if (isTTY() && chosen.length > 1) {
    const askEngines =
      inject.askEngines ??
      ((es: Engine[]) =>
        selectMany("Enable memory for which platforms?", es, {
          defaultValues: es,
        }) as Promise<Engine[]>);
    const picked = await askEngines(chosen);
    // Guard: never wire an empty set; an empty pick means "keep all".
    selected = picked.length ? picked.filter((e): e is Engine => chosen.includes(e)) : chosen;
    if (!selected.length) selected = chosen;
  }

  // Persist the answer + the chosen engines regardless of install outcome.
  writeSettings(base, { memory: true, memoryEngines: selected });
```

Then change the wiring block to use `selected` and gate the search guide on a claude-mem engine wiring:

```ts
  const wireEngines = inject.ensureInstalledForEngines ?? realEnsureInstalledForEngines;
  const appendGuide = inject.appendMemoryGuide ?? realAppendMemoryGuide;

  out("vf");
  out("vf", c.bold("memory"));
  out(
    "vf",
    c.cyan(
      `  ▶ Wiring memory for ${selected.join(", ")} — claude/codex use claude-mem, copilot uses /memory…`,
    ),
  );
  const { wired, failed } = wireEngines(selected, { cwd: base });
  if (wired.length) out("vf", c.green(`  ✔ wired: ${wired.join(", ")}`));
  for (const f of failed) {
    out("vf", c.yellow(`  ! ${f.engine} failed — continuing (${f.reason})`));
  }
  // The claude-mem search guide is for claude/codex only. Append it once any
  // claude-mem engine wired. (Copilot's own guide is appended by the wiring.)
  const claudeMemWired = wired.some((e) => e === "claude" || e === "codex");
  if (claudeMemWired && appendGuide(base)) {
    out("vf", c.green("  + memory guide added to WORKFLOW_POLICY.md"));
  }
```

Remove the now-unused old `targets` block and its comment.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --timeout 30000 test/init-memory.test.ts`
Expected: PASS (new platform-selection tests + all existing flag/prompt tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/commands/init-memory.ts test/init-memory.test.ts
git commit -m "feat(init): ask which platforms to enable memory for" -s
```

---

## Task 6: `vf memory <on|off|status>` command + alias

**Files:**
- Modify: `src/commands/config-decision.ts` (add `memory` handler; refactor `config` to delegate)
- Modify: `src/cli.ts` (add `case "memory":`)
- Modify: `src/commands/help.ts` (add `vf memory` to the command list + a `memory:` help entry)
- Test: `test/config.test.ts` (add `vf memory` tests + alias parity)

**Interfaces:**
- Consumes: `readSettings`, `writeSettings`, `ENGINES`, `ensureInstalledForEngines`, `appendMemoryGuide`, `c`, `out`, `cwd` from `_shared`/settings/memory.
- Produces: `memory(sub: string | undefined, rest: string[], base?: string): number`. `on` wires the chosen engines against `base` and persists `{memory:true, memoryEngines}`; `off` persists `{memory:false}`; `status`/undefined prints enabled + per-engine. `config("memory", rest, base)` delegates to `memory` for parity.

> **Design note:** `vf memory on` at runtime is non-interactive in tests (no TTY). It wires the engines already recorded in `settings.memoryEngines`, or all `ENGINES` if none recorded yet. The interactive platform prompt lives in `runMemoryPhase` (init); the runtime command keeps it simple to stay unit-testable. This is the YAGNI line — runtime re-prompting can be added later if asked.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.ts`:

```ts
import { config, decision, memory } from "../src/commands/config-decision.js";

describe("vf memory command", () => {
  test("`memory status` prints off by default", async () => {
    const dir = tmpRepo();
    try {
      const { code, out } = await capture(() => memory("status", [], dir));
      expect(code).toBe(0);
      expect(out).toContain("memory: off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`memory off` persists memory:false and returns 0", async () => {
    const dir = tmpRepo();
    try {
      writeSettings(dir, { memory: true, memoryEngines: ["claude"] });
      const { code, out } = await capture(() => memory("off", [], dir));
      expect(code).toBe(0);
      expect(out).toContain("memory: off");
      expect(readSettings(dir).memory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`memory on` persists memory:true (wiring injected) and returns 0", async () => {
    const dir = tmpRepo();
    try {
      // Inject the wirer so the test never shells out to npx.
      const { code } = await capture(() =>
        memory("on", [], dir, {
          wire: () => ({ wired: ["claude"], failed: [] }),
          appendGuide: () => true,
        }),
      );
      expect(code).toBe(0);
      expect(readSettings(dir).memory).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown subcommand returns 2 with usage", async () => {
    const dir = tmpRepo();
    try {
      const { code, out } = await capture(() => memory("frobnicate", [], dir));
      expect(code).toBe(2);
      expect(out).toContain("Usage: vf memory <on|off|status>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`vf config memory on` is a thin alias of `vf memory on`", async () => {
    const dir = tmpRepo();
    try {
      const { code } = await capture(() =>
        config("memory", ["on"], dir, {
          wire: () => ({ wired: ["claude"], failed: [] }),
          appendGuide: () => true,
        }),
      );
      expect(code).toBe(0);
      expect(readSettings(dir).memory).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --timeout 30000 test/config.test.ts`
Expected: FAIL — `memory` is not exported; `config` does not accept a 4th inject arg.

- [ ] **Step 3: Implement `memory` in `src/commands/config-decision.ts`**

Add imports:

```ts
import { ENGINES, type Engine } from "../core.js";
import { appendMemoryGuide, ensureInstalledForEngines } from "../memory.js";
import type { MemoryWireResult } from "../memory.js";
```

Add the inject type + `memory` function:

```ts
/** Inject seams so `vf memory on` is unit-testable without shelling out. */
export interface MemoryCmdInject {
  wire?: (engines: Engine[], opts: { cwd: string }) => MemoryWireResult;
  appendGuide?: (base: string) => boolean;
}

export function memory(
  sub: string | undefined,
  _rest: string[],
  base: string = cwd(),
  inject: MemoryCmdInject = {},
): number {
  if (sub === undefined || sub === "status") {
    const s = readSettings(base);
    out("vf", `memory: ${s.memory ? c.green("on") : c.yellow("off")}`);
    if (s.memory) {
      const engines = s.memoryEngines ?? ENGINES;
      for (const e of engines) {
        const how = e === "copilot" ? "native /memory on" : "claude-mem@12";
        out("vf", `  ${e}: ${c.dim(how)}`);
      }
    }
    return 0;
  }
  if (sub === "off") {
    writeSettings(base, { memory: false });
    out("vf", `memory: ${c.yellow("off")}`);
    return 0;
  }
  if (sub === "on") {
    const existing = readSettings(base).memoryEngines;
    const engines = existing?.length ? existing : [...ENGINES];
    const wire = inject.wire ?? ensureInstalledForEngines;
    const append = inject.appendGuide ?? appendMemoryGuide;
    writeSettings(base, { memory: true, memoryEngines: engines });
    out("vf", c.cyan(`  ▶ Wiring memory for ${engines.join(", ")}…`));
    const { wired, failed } = wire(engines, { cwd: base });
    if (wired.length) out("vf", c.green(`  ✔ wired: ${wired.join(", ")}`));
    for (const f of failed) {
      out("vf", c.yellow(`  ! ${f.engine} failed — continuing (${f.reason})`));
    }
    if (wired.some((e) => e === "claude" || e === "codex")) append(base);
    out("vf", `memory: ${c.green("on")}`);
    return 0;
  }
  out("vf", c.red("Usage: vf memory <on|off|status>"), { level: "error" });
  return 2;
}
```

Refactor `config` to delegate `memory` and accept the inject (keep its existing non-memory usage error):

```ts
export function config(
  key: string | undefined,
  rest: string[],
  base: string = cwd(),
  inject: MemoryCmdInject = {},
): number {
  if (key !== "memory") {
    out("vf", c.red("Usage: vf config memory <on|off|status>"), { level: "error" });
    return 2;
  }
  return memory(rest[0], rest.slice(1), base, inject);
}
```

Remove the now-dead `printMemory` helper (its logic moved into `memory`).

- [ ] **Step 4: Wire `cli.ts`**

Update the import (line 27):

```ts
import { config, decision, memory } from "./commands/config-decision.js";
```

Add a case next to `config` (after line 200):

```ts
    case "memory":
      return memory(positionals[0], positionals.slice(1));
```

- [ ] **Step 5: Update `help.ts`**

In the command list (after the `config [sub]` line ~32), add:

```ts
    ${c.cyan("memory [sub]")}      on | off | status — per-engine memory (claude-mem for claude/codex, native for copilot)
```

Update the `config:` help entry and add a `memory:` entry to the `COMMAND_HELP` topic map (declared at `src/commands/help.ts:53` as `Record<string, () => string>`; add the key next to `config:` at ~line 173):

```ts
  memory: () => `${c.bold("vf memory")} ${c.dim("<on|off|status>")}
Enable per-engine memory: claude-mem (pinned v12) for claude/codex, native /memory for copilot.

${c.bold("Subcommands:")}
  status        print whether memory is on and which engines (default)
  on            enable + wire memory for the recorded/all engines
  off           disable memory

${c.bold("Examples:")}
  vf memory status
  vf memory on`,
```

- [ ] **Step 6: Run the tests + full suite slice**

Run: `bun test --timeout 30000 test/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/commands/config-decision.ts src/cli.ts src/commands/help.ts test/config.test.ts
git commit -m "feat(memory): add 'vf memory <on|off|status>' command + config alias" -s
```

---

## Task 7: Full verification + docs touch-up

**Files:**
- Modify: `docs/COMMAND_REFERENCE.md` (add `vf memory`), if it enumerates commands
- Verify: full suite, typecheck, lint, build

**Interfaces:** none (integration + docs).

- [ ] **Step 1: Update COMMAND_REFERENCE.md**

Run: `grep -n "config memory\|vf config" docs/COMMAND_REFERENCE.md | head`
Add a `vf memory` section mirroring the `vf config memory` description: default off; `on` asks platforms (init) / wires recorded engines (runtime); claude/codex → claude-mem@12, copilot → native `/memory on`.

- [ ] **Step 2: Run the full suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all green. If `bun run coverage:check` is part of CI, run it too:
Run: `bun run coverage:check`
Expected: per-file coverage gate passes (the new functions are all exercised by Tasks 1-6 tests).

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: clean build.

- [ ] **Step 4: Manual smoke (optional, no engine spend)**

Run: `bun run src/cli.ts memory status` in a scratch dir
Expected: prints `memory: off`.

- [ ] **Step 5: Commit docs**

```bash
git add docs/COMMAND_REFERENCE.md
git commit -m "docs(memory): document 'vf memory' per-engine wiring" -s
```

---

## Self-Review

**Spec coverage:**
- Default off → already true; Task 5 keeps non-TTY skip; Task 6 `status` shows off by default. ✓
- Ask which platforms on enable → Task 5 (`selectMany`). ✓
- claude/codex use claude-mem old (no email) → Task 1 pins `12`. ✓
- copilot native `/memory on` → Tasks 2-3 (guidance, no install). ✓
- Telemetry off / enterprise → no telemetry exists in any version; avoiding 13.x avoids account login (Task 1 pin). Documented in spec; no code lever needed. ✓
- "Only new cmem available → latest, fewest prompts / auto-fill" → installer already passes `--provider claude --no-auto-start` (pre-fills provider, skips key prompt, skips worker autostart). Override via `VF_CLAUDE_MEM_VERSION=latest`. Covered by existing flags; no extra task. ✓
- `vf memory on/off` per platform → Task 6. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; two flagged implementer-notes are verification steps (grep to confirm an export name), not placeholders. ✓

**Type consistency:** `Engine`, `ENGINES`, `MemoryWireResult`, `MemoryBackendOpts.appendCopilotGuide`, `MemoryPhaseInject.askEngines`, `MemoryCmdInject` used consistently across tasks. `ensureInstalledForEngines(engines, opts)` signature stable. `memory(sub, rest, base, inject)` and `config(key, rest, base, inject)` aligned. ✓

**Out of scope (carried from spec):** no copilot `/memory` automation; no per-engine version override; no store migration; no telemetry flag.
