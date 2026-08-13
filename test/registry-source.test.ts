import { describe, expect, test } from "bun:test";
import { resolveRegistrySource } from "../src/skills/registry-source.js";

// #763: `owner/repo` shorthand for `vf skills registry add`. Pure resolver:
// shorthand → GitHub HTTPS URL + default name; existing URLs pass through
// unchanged. --ref stays required at the CLI so the immutable pin holds.
describe("resolveRegistrySource — owner/repo shorthand (#763)", () => {
  test("resolves owner/repo to a GitHub HTTPS url + repo-slug name", () => {
    expect(resolveRegistrySource("obra/superpowers")).toEqual({
      url: "https://github.com/obra/superpowers.git",
      name: "superpowers",
      shorthand: true,
    });
  });

  test("lowercases the derived name and strips a trailing .git on the repo", () => {
    expect(resolveRegistrySource("Obra/Super-Powers.git")).toEqual({
      url: "https://github.com/Obra/Super-Powers.git",
      name: "super-powers",
      shorthand: true,
    });
  });

  test("passes an https git URL through unchanged with no derived name", () => {
    expect(resolveRegistrySource("https://github.com/x/skills.git")).toEqual({
      url: "https://github.com/x/skills.git",
      name: undefined,
      shorthand: false,
    });
  });

  test("passes an scp-style git URL through unchanged", () => {
    expect(resolveRegistrySource("git@github.com:x/skills.git")).toEqual({
      url: "git@github.com:x/skills.git",
      name: undefined,
      shorthand: false,
    });
  });

  test("passes a non-github https URL through unchanged", () => {
    expect(resolveRegistrySource("https://gitlab.com/x/y.git")).toEqual({
      url: "https://gitlab.com/x/y.git",
      name: undefined,
      shorthand: false,
    });
  });

  test.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["obra", "single segment"],
    ["obra/super/powers", "three segments"],
    ["obra/", "trailing slash"],
    ["/superpowers", "leading slash"],
    ["../evil/repo", "path traversal"],
    ["obra/repo with space", "space in repo"],
    ["ob ra/repo", "space in owner"],
    ["obra/repo\0x", "null byte"],
  ])("rejects invalid spec %p (%s) with null", (spec) => {
    expect(resolveRegistrySource(spec)).toBeNull();
  });
});
