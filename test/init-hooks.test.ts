import { describe, expect, test } from "bun:test";
import { HOOK_TEMPLATES, HOOK_TEMPLATE_IDS } from "../src/hooks/templates.js";
import { type HookSetupDeps, collectHookSetup } from "../src/init-hooks.js";

const ALL_LABELS = HOOK_TEMPLATES.map((t) => t.label);
const labelFor = (id: string) => HOOK_TEMPLATES.find((t) => t.id === id)?.label ?? "";

/** Build deps that answer the menu deterministically. Captures `out` lines. */
function makeDeps(over: Partial<HookSetupDeps> & { confirmSeq?: boolean[] }): {
  deps: HookSetupDeps;
  lines: string[];
} {
  const lines: string[] = [];
  const confirmSeq = over.confirmSeq ?? [false];
  let confirmIdx = 0;
  const deps: HookSetupDeps = {
    isTTY: true,
    out: ((_ch: string, msg?: unknown) => {
      if (typeof msg === "string") lines.push(msg);
    }) as HookSetupDeps["out"],
    panel: ((_t: string, b: string) => b) as HookSetupDeps["panel"],
    selectMany: (async () => ALL_LABELS) as HookSetupDeps["selectMany"],
    confirmInput: (async () => confirmSeq[confirmIdx++] ?? false) as HookSetupDeps["confirmInput"],
    textInput: (async () => "") as HookSetupDeps["textInput"],
    selectOne: (async (_q: string, _items: string[], opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? "") as HookSetupDeps["selectOne"],
    ...over,
  };
  return { deps, lines };
}

describe("collectHookSetup", () => {
  test("non-TTY returns null (init then leaves policy untouched)", async () => {
    const { deps } = makeDeps({ isTTY: false });
    expect(await collectHookSetup(deps)).toBeNull();
  });

  test("default path: keep all templates, no custom rules → all-on config", async () => {
    const { deps } = makeDeps({ confirmSeq: [false] });
    const cfg = await collectHookSetup(deps);
    expect(cfg?.templates).toEqual([...HOOK_TEMPLATE_IDS]);
    expect(cfg?.custom).toEqual([]);
  });

  test("disabling a subset is reflected + announced", async () => {
    const { deps, lines } = makeDeps({
      confirmSeq: [false],
      selectMany: (async () => [labelFor("block-destructive")]) as HookSetupDeps["selectMany"],
    });
    const cfg = await collectHookSetup(deps);
    expect(cfg?.templates).toEqual(["block-destructive"]);
    expect(lines.some((l) => l.includes("disabling:"))).toBe(true);
  });

  test("collects a valid custom rule through the loop", async () => {
    let textIdx = 0;
    // promptCustomRule order: name, pattern, reason
    const textAnswers = ["no-prod", "deploy prod", "ask first"];
    const { deps } = makeDeps({
      confirmSeq: [true, false], // add one, then stop
      textInput: (async () => textAnswers[textIdx++] ?? "") as HookSetupDeps["textInput"],
      selectOne: (async (_q: string, _items: string[], opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "") as HookSetupDeps["selectOne"],
    });
    const cfg = await collectHookSetup(deps);
    expect(cfg?.custom).toHaveLength(1);
    expect(cfg?.custom[0]).toMatchObject({
      name: "no-prod",
      kind: "command",
      pattern: "deploy prod",
      risk: "critical", // default CUSTOM_RISK_CHOICES[0] = block (critical)
      reason: "ask first",
    });
  });

  test("a custom rule with an empty name aborts that rule with a warning", async () => {
    const { deps, lines } = makeDeps({
      confirmSeq: [true, false],
      textInput: (async () => "") as HookSetupDeps["textInput"], // empty name
    });
    const cfg = await collectHookSetup(deps);
    expect(cfg?.custom).toEqual([]);
    expect(lines.some((l) => l.includes("needs a name"))).toBe(true);
  });

  test("a custom rule with an empty match string is skipped with a warning", async () => {
    let textIdx = 0;
    const textAnswers = ["bad", "", ""]; // name, empty match string, reason
    const { deps, lines } = makeDeps({
      confirmSeq: [true, false],
      textInput: (async () => textAnswers[textIdx++] ?? "") as HookSetupDeps["textInput"],
    });
    const cfg = await collectHookSetup(deps);
    expect(cfg?.custom).toEqual([]);
    expect(lines.some((l) => l.includes("skipped"))).toBe(true);
  });

  test("a file-kind custom rule is normalized to kind=file", async () => {
    let textIdx = 0;
    const textAnswers = ["lockfile", "package-lock", ""];
    const { deps } = makeDeps({
      confirmSeq: [true, false],
      textInput: (async () => textAnswers[textIdx++] ?? "") as HookSetupDeps["textInput"],
      selectOne: (async (q: string, _items: string[], opts?: { defaultValue?: string }) =>
        q.includes("Match against")
          ? "file path"
          : (opts?.defaultValue ?? "")) as HookSetupDeps["selectOne"],
    });
    const cfg = await collectHookSetup(deps);
    expect(cfg?.custom[0]?.kind).toBe("file");
  });

  test("the custom-rule loop is bounded by the per-run cap", async () => {
    let textIdx = 0;
    // Always answer "yes, add another"; supply a fresh valid rule each time.
    const { deps, lines } = makeDeps({
      confirmSeq: Array(20).fill(true),
      textInput: (async () => {
        // name, pattern, reason cycle — always non-empty + valid
        const phase = textIdx++ % 3;
        return phase === 0 ? `rule${textIdx}` : phase === 1 ? "x" : "";
      }) as HookSetupDeps["textInput"],
    });
    const cfg = await collectHookSetup(deps);
    expect(cfg?.custom.length).toBe(10);
    expect(lines.some((l) => l.includes("limit"))).toBe(true);
  });

  test("a cancel during the menu returns null (not a thrown error)", async () => {
    const { deps } = makeDeps({
      selectMany: (async () => {
        throw new Error("cancelled");
      }) as HookSetupDeps["selectMany"],
    });
    expect(await collectHookSetup(deps)).toBeNull();
  });

  test("a non-cancel error propagates", async () => {
    const { deps } = makeDeps({
      selectMany: (async () => {
        throw new Error("disk on fire");
      }) as HookSetupDeps["selectMany"],
    });
    await expect(collectHookSetup(deps)).rejects.toThrow("disk on fire");
  });
});
