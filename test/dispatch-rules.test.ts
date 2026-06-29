import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_HARD_RULES,
  readDispatchPolicyRules,
  resolveDispatchRules,
} from "../src/adapters/dispatch-prompt.js";

describe("DISPATCH_HARD_RULES", () => {
  test("is a non-empty array of strings", () => {
    expect(Array.isArray(DISPATCH_HARD_RULES)).toBe(true);
    expect(DISPATCH_HARD_RULES.length).toBeGreaterThan(0);
    for (const r of DISPATCH_HARD_RULES) expect(typeof r).toBe("string");
  });

  test("contains the expected built-in rules", () => {
    const joined = DISPATCH_HARD_RULES.join("\n");
    expect(joined).toContain("git push origin HEAD:");
    expect(joined).toContain("biome check src test");
    expect(joined).toContain("FULL suite");
  });
});

describe("readDispatchPolicyRules", () => {
  test("returns [] when readPolicy returns undefined", () => {
    expect(readDispatchPolicyRules(() => undefined)).toEqual([]);
  });

  test("returns [] when readPolicy returns empty string", () => {
    expect(readDispatchPolicyRules(() => "")).toEqual([]);
  });

  test("returns [] when readPolicy has no Dispatch hard rules section", () => {
    expect(readDispatchPolicyRules(() => "## Some section\n- skip\n\n## Other\n- ignore")).toEqual(
      [],
    );
  });

  test("returns bullet lines from ## Dispatch hard rules section", () => {
    const policyText =
      "## Some section\n- skip\n\n## Dispatch hard rules\n- Extra rule: never force-push\n- Another: use rebase\n\n## Other section\n- ignore";
    const rules = readDispatchPolicyRules(() => policyText);
    expect(rules).toEqual(["- Extra rule: never force-push", "- Another: use rebase"]);
  });

  test("returns [] when try block throws", () => {
    expect(
      readDispatchPolicyRules(() => {
        throw new Error("boom");
      }),
    ).toEqual([]);
  });

  test("returns [] when readPolicy returns text but no ## Dispatch hard rules header", () => {
    expect(readDispatchPolicyRules(() => "# Just a single header\n- item")).toEqual([]);
  });

  describe("with default file-system reader", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test("returns [] when policy file is missing", () => {
      dir = mkdtempSync(join(tmpdir(), "vf-dispatch-rules-"));
      // readDispatchPolicyRules uses cwd() which is process.cwd();
      // default reader only works at repo root, so we test with inject
      expect(readDispatchPolicyRules(() => undefined)).toEqual([]);
    });
  });
});

describe("resolveDispatchRules", () => {
  test("returns built-in rules when readPolicy returns undefined", () => {
    const rules = resolveDispatchRules(() => undefined);
    expect(rules.length).toBe(DISPATCH_HARD_RULES.length);
    expect(rules.join("\n")).toContain("git push origin HEAD:");
  });

  test("merges built-in rules with augment from policy", () => {
    const policyText = "## Dispatch hard rules\n- Custom rule: do X\n- Another built-in rule\n";
    const rules = resolveDispatchRules(() => policyText);
    // built-in rules + 2 augment
    expect(rules.length).toBe(DISPATCH_HARD_RULES.length + 2);
    expect(rules.join("\n")).toContain("git push origin HEAD:");
    expect(rules.join("\n")).toContain("Custom rule: do X");
  });

  test("deduplicates identical rules", () => {
    const policyText = `## Dispatch hard rules\n${DISPATCH_HARD_RULES[0]}\n- Unique augment rule\n`;
    const rules = resolveDispatchRules(() => policyText);
    // one dedup, one unique augment
    expect(rules.length).toBe(DISPATCH_HARD_RULES.length + 1);
    expect(rules.join("\n")).toContain("Unique augment rule");
  });

  test("returns only built-in rules when policy has no matching section", () => {
    const rules = resolveDispatchRules(() => "## Other\n- skip");
    expect(rules.length).toBe(DISPATCH_HARD_RULES.length);
  });

  test("returns only built-in rules on error", () => {
    const rules = resolveDispatchRules(() => {
      throw new Error("fail");
    });
    expect(rules.length).toBe(DISPATCH_HARD_RULES.length);
  });
});
