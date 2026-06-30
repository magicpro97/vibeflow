import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { printHelp } from "../src/commands.js";
import { hasCommandHelp, printCommandHelp } from "../src/commands/help.js";

const SKILL_SUBS = ["list", "search", "resolve", "validate", "sync", "verify-sync", "import"];

describe("help text", () => {
  test("printHelp() returns 0 (smoke check that the function runs)", () => {
    // printHelp writes via out()/logbus. Capture is complex; assert it doesn't throw.
    expect(printHelp()).toBe(0);
  });

  test("src/commands/help.ts skills help block mentions every skills subcommand", () => {
    // Per-command help blocks live in src/commands/help.ts (extracted in
    // issue #80 phase 8/14). The block still starts with `skills: () =>`
    // and ends before `tools:`.
    const src = readFileSync(join(import.meta.dir, "..", "src/commands/help.ts"), "utf8");
    const skillsBlock = src.match(/skills: \(\) =>\n([\s\S]*?)\n\n {2}tools:/);
    expect(skillsBlock).not.toBeNull();
    const block = skillsBlock ? skillsBlock[1] : "";
    for (const sub of SKILL_SUBS) {
      expect(block).toContain(sub);
    }
  });

  test("src/commands/help.ts global help line mentions validate/sync/verify-sync/import", () => {
    // Global help text moved to src/commands/help.ts in issue #80 phase
    // 8/14. The line still contains the canonical skills subcommand
    // roster as a one-liner in the usage block.
    const src = readFileSync(join(import.meta.dir, "..", "src/commands/help.ts"), "utf8");
    const line = src.match(/skills \[sub\][^\n]*/);
    expect(line).not.toBeNull();
    for (const sub of ["list", "search", "resolve", "validate", "sync", "verify-sync", "import"]) {
      expect(line?.[0] ?? "").toContain(sub);
    }
  });

  test("config has a per-command help block naming its memory subcommand", () => {
    expect(hasCommandHelp("config")).toBe(true);
    // printCommandHelp returns 0 and renders the config block (covers the
    // new COMMAND_HELP.config arm in src/commands/help.ts).
    expect(printCommandHelp("config")).toBe(0);
  });

  test("demo has a per-command help block (covers the new COMMAND_HELP.demo arm)", () => {
    expect(hasCommandHelp("demo")).toBe(true);
    expect(printCommandHelp("demo")).toBe(0);
  });
});
