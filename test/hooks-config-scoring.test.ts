import { describe, expect, test } from "bun:test";
import { scoreRisk } from "../src/hooks/risk.js";
import { resolveHookPolicy } from "../src/hooks/templates.js";

// The default policy (no arg) is all-on and is already exhaustively covered by
// hooks.test.ts. These tests pin the NEW behavior: a template gate silences
// exactly its own cluster and nothing else, and custom rules layer on top.

describe("scoreRisk: template gating", () => {
  test("default (no policy) blocks a destructive command — unchanged baseline", () => {
    const { risk } = scoreRisk({ event: "pre-command", command: "rm -rf /tmp/x" });
    expect(risk).toBe("critical");
  });

  test("disabling block-destructive drops a destructive command to the low floor", () => {
    const policy = resolveHookPolicy({
      templates: ["protect-secrets", "protect-config", "flag-installs", "workspace-guard"],
      custom: [],
    });
    const { risk } = scoreRisk({ event: "pre-command", command: "rm -rf /tmp/x" }, policy);
    expect(risk).toBe("low");
  });

  test("disabling block-destructive still lets protect-secrets fire on the same scan", () => {
    const policy = resolveHookPolicy({ templates: ["protect-secrets"], custom: [] });
    const { risk, reasons } = scoreRisk({ event: "pre-command", command: "cat .env" }, policy);
    expect(risk).toBe("critical");
    expect(reasons.some((r) => r.includes("secret"))).toBe(true);
  });

  test("disabling protect-secrets silences the secret signal", () => {
    const policy = resolveHookPolicy({ templates: ["block-destructive"], custom: [] });
    const { risk } = scoreRisk({ event: "pre-command", command: "cat .env" }, policy);
    expect(risk).toBe("low");
  });

  test("flag-installs off → install command no longer bumps to medium", () => {
    const allOn = scoreRisk({ event: "pre-command", command: "npm install left-pad" });
    expect(allOn.risk).toBe("medium");
    const policy = resolveHookPolicy({ templates: ["block-destructive"], custom: [] });
    const off = scoreRisk({ event: "pre-command", command: "npm install left-pad" }, policy);
    expect(off.risk).toBe("low");
  });

  test("protect-config gate controls the config-file signal", () => {
    const allOn = scoreRisk({ event: "pre-write", files: ["tsconfig.json"] });
    expect(allOn.risk).toBe("high");
    const policy = resolveHookPolicy({ templates: ["protect-secrets"], custom: [] });
    const off = scoreRisk({ event: "pre-write", files: ["tsconfig.json"] }, policy);
    expect(off.risk).toBe("none");
  });

  test("protect-secrets gate controls the protected-path file signal", () => {
    const policy = resolveHookPolicy({ templates: ["protect-config"], custom: [] });
    const { risk } = scoreRisk({ event: "pre-write", files: [".env"] }, policy);
    expect(risk).toBe("none");
  });

  test("workspace-guard gate controls scope + workspace-escape signals", () => {
    const scoped = { event: "pre-write" as const, files: ["other/x.ts"], scope: ["src/"] };
    expect(scoreRisk(scoped).risk).toBe("high");
    const policy = resolveHookPolicy({ templates: ["block-destructive"], custom: [] });
    expect(scoreRisk(scoped, policy).risk).toBe("none");
  });

  test("workspace-guard off silences a command that escapes the workspace", () => {
    const input = {
      event: "pre-command" as const,
      command: "cat ../../secrets.txt",
      workspace: "/repo",
    };
    expect(scoreRisk(input).reasons.some((r) => r.includes("outside workspace"))).toBe(true);
    const policy = resolveHookPolicy({ templates: ["block-destructive"], custom: [] });
    expect(scoreRisk(input, policy).reasons.some((r) => r.includes("outside workspace"))).toBe(
      false,
    );
  });

  test("an all-templates-off policy floors a benign-shaped command at low", () => {
    const policy = resolveHookPolicy({ templates: [], custom: [] });
    const { risk } = scoreRisk({ event: "pre-command", command: "rm -rf /" }, policy);
    expect(risk).toBe("low");
  });
});

describe("scoreRisk: custom rules layer on top", () => {
  test("a custom command rule raises risk even with all built-ins disabled", () => {
    const policy = resolveHookPolicy({
      templates: [],
      custom: [
        {
          name: "no-prod",
          kind: "command",
          pattern: "deploy prod",
          risk: "high",
          reason: "ask first",
        },
      ],
    });
    const { risk, reasons } = scoreRisk(
      { event: "pre-command", command: "deploy prod now" },
      policy,
    );
    expect(risk).toBe("high");
    expect(reasons.some((r) => r.includes('custom rule "no-prod"'))).toBe(true);
  });

  test("a custom file rule fires on a matching path", () => {
    const policy = resolveHookPolicy({
      templates: [],
      custom: [{ name: "lock", kind: "file", pattern: "package-lock", risk: "critical" }],
    });
    const { risk } = scoreRisk({ event: "pre-write", files: ["package-lock.json"] }, policy);
    expect(risk).toBe("critical");
  });

  test("custom rules cannot lower a built-in decision (only raise)", () => {
    // A custom medium rule alongside a destructive command still ends critical.
    const policy = resolveHookPolicy({
      templates: ["block-destructive"],
      custom: [{ name: "warn-only", kind: "command", pattern: "rm", risk: "medium" }],
    });
    const { risk } = scoreRisk({ event: "pre-command", command: "rm -rf /tmp/x" }, policy);
    expect(risk).toBe("critical");
  });
});
