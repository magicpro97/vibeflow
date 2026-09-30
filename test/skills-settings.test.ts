import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SKILLS_CONFIG,
  coerceSkillsConfig,
  mergeSkillsConfig,
} from "../src/skills/skills-settings.js";
import type { SkillsConfig } from "../src/skills/skills-settings.js";

describe("coerceSkillsConfig", () => {
  test("rejects non-objects, including arrays", () => {
    for (const bad of [undefined, null, "skills", 7, ["a"], true]) {
      expect(coerceSkillsConfig(bad)).toBeUndefined();
    }
  });

  test("fills a field the payload does not name from the base, not the defaults", () => {
    const base: SkillsConfig = {
      autoResolve: false,
      mirrorMode: "full",
      targetEngines: ["claude"],
    };
    const out = coerceSkillsConfig({ autoResolve: true }, base);
    expect(out?.autoResolve).toBe(true);
    expect(out?.mirrorMode).toBe("full");
    expect(out?.targetEngines).toEqual(["claude"]);
  });

  test("defaults to DEFAULT_SKILLS_CONFIG when no base is given", () => {
    const out = coerceSkillsConfig({ mirrorMode: "pointer" });
    expect(out).toEqual(DEFAULT_SKILLS_CONFIG);
  });

  test("keeps a base field when the payload's value is the wrong shape", () => {
    const base: SkillsConfig = {
      autoResolve: false,
      mirrorMode: "full",
      targetEngines: ["claude"],
    };
    const out = coerceSkillsConfig(
      { autoResolve: "yes", mirrorMode: "sideways", targetEngines: "claude" },
      base,
    );
    expect(out).toEqual(base);
  });

  test("accepts only engine names, and keeps the base when none survive", () => {
    const base: SkillsConfig = {
      autoResolve: true,
      mirrorMode: "pointer",
      targetEngines: ["claude"],
    };
    expect(
      coerceSkillsConfig({ targetEngines: ["claude", "not-an-engine"] }, base)?.targetEngines,
    ).toEqual(["claude"]);
    expect(coerceSkillsConfig({ targetEngines: [] }, base)?.targetEngines).toEqual(["claude"]);
    expect(coerceSkillsConfig({ targetEngines: [42, null] }, base)?.targetEngines).toEqual([
      "claude",
    ]);
  });

  test("does not alias the base array", () => {
    const base: SkillsConfig = {
      autoResolve: true,
      mirrorMode: "pointer",
      targetEngines: ["claude"],
    };
    const out = coerceSkillsConfig({}, base);
    out?.targetEngines.push("codex");
    expect(base.targetEngines).toEqual(["claude"]);
  });
});

describe("mergeSkillsConfig", () => {
  const current: { skills?: SkillsConfig } = {
    skills: { autoResolve: false, mirrorMode: "full", targetEngines: ["claude"] },
  };

  test("a payload that names skills updates only what it names", () => {
    const merged: { skills?: SkillsConfig } = {};
    mergeSkillsConfig(merged, { skills: { autoResolve: true } as SkillsConfig }, current);
    expect(merged.skills).toEqual({
      autoResolve: true,
      mirrorMode: "full",
      targetEngines: ["claude"],
    });
  });

  test("a payload that omits skills keeps the stored block", () => {
    const merged: { skills?: SkillsConfig } = {};
    mergeSkillsConfig(merged, {}, current);
    expect(merged.skills).toBe(current.skills);
  });

  test("with nothing stored, the defaults are the base", () => {
    const merged: { skills?: SkillsConfig } = {};
    mergeSkillsConfig(merged, { skills: {} as SkillsConfig }, {});
    expect(merged.skills).toEqual(DEFAULT_SKILLS_CONFIG);
  });

  test("an unusable payload leaves the block absent when nothing was stored", () => {
    const merged: { skills?: SkillsConfig } = {};
    mergeSkillsConfig(merged, { skills: "nope" as unknown as SkillsConfig }, {});
    expect("skills" in merged).toBe(false);
  });

  test("an explicitly absent stored block stays absent", () => {
    const merged: { skills?: SkillsConfig } = {};
    mergeSkillsConfig(merged, {}, {});
    expect("skills" in merged).toBe(false);
  });
});
