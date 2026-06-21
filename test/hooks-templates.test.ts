import { describe, expect, test } from "bun:test";
import type { CustomHookRule } from "../src/hooks/templates.js";
import {
  HOOK_TEMPLATES,
  HOOK_TEMPLATE_IDS,
  applyCustomRules,
  coerceCustomRule,
  coerceHookConfig,
  defaultHookConfig,
  isValidCustomPattern,
  resolveHookPolicy,
} from "../src/hooks/templates.js";

describe("hook templates: registry", () => {
  test("every template id has a matching registry entry, in canonical order", () => {
    expect(HOOK_TEMPLATES.map((t) => t.id)).toEqual([...HOOK_TEMPLATE_IDS]);
    for (const t of HOOK_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  test("defaultHookConfig enables every template with no custom rules", () => {
    const d = defaultHookConfig();
    expect(d.templates).toEqual([...HOOK_TEMPLATE_IDS]);
    expect(d.custom).toEqual([]);
  });
});

describe("hook templates: coerceHookConfig (fail-safe)", () => {
  test("undefined / non-object → all-on default", () => {
    expect(coerceHookConfig(undefined).templates).toEqual([...HOOK_TEMPLATE_IDS]);
    expect(coerceHookConfig(null).templates).toEqual([...HOOK_TEMPLATE_IDS]);
    expect(coerceHookConfig(42).templates).toEqual([...HOOK_TEMPLATE_IDS]);
  });

  test("missing templates key → all-on default, custom still parsed", () => {
    const cfg = coerceHookConfig({ custom: [] });
    expect(cfg.templates).toEqual([...HOOK_TEMPLATE_IDS]);
  });

  test("templates not an array → all-on default", () => {
    expect(coerceHookConfig({ templates: "block-destructive" }).templates).toEqual([
      ...HOOK_TEMPLATE_IDS,
    ]);
  });

  test("any unknown template id makes the WHOLE list fall back to all-on", () => {
    const cfg = coerceHookConfig({ templates: ["block-destructive", "bogus"] });
    expect(cfg.templates).toEqual([...HOOK_TEMPLATE_IDS]);
  });

  test("a valid explicit subset is honored verbatim (canonical order, deduped)", () => {
    const cfg = coerceHookConfig({
      templates: ["protect-secrets", "block-destructive", "block-destructive"],
    });
    expect(cfg.templates).toEqual(["block-destructive", "protect-secrets"]);
  });

  test("an explicit empty array disables all templates (deliberate opt-out)", () => {
    expect(coerceHookConfig({ templates: [] }).templates).toEqual([]);
  });

  test("custom not an array → empty custom list", () => {
    expect(coerceHookConfig({ templates: [], custom: "nope" }).custom).toEqual([]);
  });

  test("invalid custom rules are dropped, valid ones kept", () => {
    const cfg = coerceHookConfig({
      templates: [],
      custom: [
        { name: "ok", kind: "command", pattern: "danger", risk: "high" },
        { name: "", kind: "command", pattern: "x", risk: "high" }, // empty name
        { name: "empty-pattern", kind: "command", pattern: "", risk: "high" }, // empty match string
        { name: "bad-risk", kind: "command", pattern: "x", risk: "nope" }, // bad risk
        "not-an-object",
      ],
    });
    expect(cfg.custom.map((r) => r.name)).toEqual(["ok"]);
  });
});

describe("hook templates: coerceCustomRule", () => {
  test("rejects non-object", () => {
    expect(coerceCustomRule(null)).toBeNull();
    expect(coerceCustomRule("x")).toBeNull();
  });

  test("normalizes kind (file vs command) and trims name", () => {
    const r = coerceCustomRule({
      name: "  rm-guard  ",
      kind: "file",
      pattern: "secret",
      risk: "critical",
    }) as CustomHookRule;
    expect(r.name).toBe("rm-guard");
    expect(r.kind).toBe("file");
  });

  test("unknown kind → command default rejected only when other fields missing", () => {
    // kind that is neither "file" nor "command" → null kind → whole rule rejected
    expect(coerceCustomRule({ name: "x", kind: "weird", pattern: "y", risk: "high" })).toBeNull();
  });

  test("keeps an optional reason, drops a blank one", () => {
    const withReason = coerceCustomRule({
      name: "x",
      kind: "command",
      pattern: "y",
      risk: "high",
      reason: "  because  ",
    }) as CustomHookRule;
    expect(withReason.reason).toBe("because");
    const blank = coerceCustomRule({
      name: "x",
      kind: "command",
      pattern: "y",
      risk: "high",
      reason: "   ",
    }) as CustomHookRule;
    expect(blank.reason).toBeUndefined();
  });
});

describe("hook templates: isValidCustomPattern (length guard only — matching is literal)", () => {
  test("rejects empty, non-string, and oversized match strings", () => {
    expect(isValidCustomPattern("")).toBe(false);
    expect(isValidCustomPattern(123 as unknown as string)).toBe(false);
    expect(isValidCustomPattern("a".repeat(201))).toBe(false);
  });

  test("a would-be ReDoS regex is just a harmless literal string here (no compilation)", () => {
    // These are NOT compiled — they are accepted as ordinary substrings. The
    // whole catastrophic-backtracking class is structurally impossible because
    // applyCustomRules uses String.includes, never new RegExp.
    expect(isValidCustomPattern("(a+)+$")).toBe(true);
    expect(isValidCustomPattern("(a|a)*")).toBe(true);
    expect(isValidCustomPattern("((a)+)+$")).toBe(true);
  });

  test("accepts a normal substring at the length boundary", () => {
    expect(isValidCustomPattern("rm -rf")).toBe(true);
    expect(isValidCustomPattern("a".repeat(200))).toBe(true);
  });
});

describe("hook templates: coerceCustom count cap", () => {
  test("a hand-edited config with thousands of rules is capped at 32", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      name: `r${i}`,
      kind: "command",
      pattern: "x",
      risk: "high",
    }));
    const cfg = coerceHookConfig({ templates: [], custom: many });
    expect(cfg.custom.length).toBe(32);
  });
});

describe("hook templates: applyCustomRules (case-insensitive literal substring)", () => {
  const rule = (over: Partial<CustomHookRule>): CustomHookRule => ({
    name: "r",
    kind: "command",
    pattern: "danger",
    risk: "high",
    ...over,
  });

  test("command rule fires on a substring match, with reason text", () => {
    const hits = applyCustomRules([rule({ name: "no-danger", reason: "policy" })], {
      command: "run danger now",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.risk).toBe("high");
    expect(hits[0]?.reason).toBe('custom rule "no-danger": policy');
  });

  test("matching is case-insensitive", () => {
    const hits = applyCustomRules([rule({ pattern: "RM -RF" })], { command: "echo rm -rf /" });
    expect(hits).toHaveLength(1);
  });

  test("command rule reason omits the colon clause when no reason given", () => {
    const hits = applyCustomRules([rule({ name: "bare" })], { command: "danger" });
    expect(hits[0]?.reason).toBe('custom rule "bare"');
  });

  test("command rule does NOT fire when there is no command", () => {
    expect(applyCustomRules([rule({})], { files: ["danger.ts"] })).toEqual([]);
  });

  test("file rule fires on any matching path", () => {
    const hits = applyCustomRules([rule({ kind: "file", pattern: ".secret" })], {
      files: ["a.ts", "x.secret"],
    });
    expect(hits).toHaveLength(1);
  });

  test("a regex-looking pattern matches literally, not as a regex", () => {
    // `(a+)+` is treated as the exact 5-char substring, so it only fires when
    // those literal characters appear — never as a compiled pattern.
    expect(applyCustomRules([rule({ pattern: "(a+)+" })], { command: "aaaa" })).toEqual([]);
    expect(
      applyCustomRules([rule({ name: "lit", pattern: "(a+)+" })], { command: "x(a+)+y" }),
    ).toHaveLength(1);
  });
});

describe("hook templates: resolveHookPolicy", () => {
  test("undefined config → all-on policy", () => {
    const p = resolveHookPolicy(undefined);
    expect([...p.enabled].sort()).toEqual([...HOOK_TEMPLATE_IDS].sort());
    expect(p.custom).toEqual([]);
  });

  test("explicit config is reflected in the resolved set", () => {
    const p = resolveHookPolicy({ templates: ["protect-secrets"], custom: [] });
    expect(p.enabled.has("protect-secrets")).toBe(true);
    expect(p.enabled.has("block-destructive")).toBe(false);
  });
});
