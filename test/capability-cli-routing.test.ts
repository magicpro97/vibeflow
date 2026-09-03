import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasCommandHelp, printCommandHelp } from "../src/commands/help.js";

describe("capability/authority CLI routing", () => {
  test("cli routes capability and authority before generic parseFlags collapse", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/cli.ts"), "utf8");
    const capabilityBranch = src.indexOf('if (cmd === "capability")');
    const authorityBranch = src.indexOf('if (cmd === "authority")');
    const genericParse = src.indexOf("const { positionals, flags } = parseFlags(rest);");
    expect(capabilityBranch).toBeGreaterThanOrEqual(0);
    expect(authorityBranch).toBeGreaterThanOrEqual(0);
    expect(capabilityBranch).toBeLessThan(genericParse);
    expect(authorityBranch).toBeLessThan(genericParse);
  });

  test("help registry exposes capability and authority blocks", () => {
    expect(hasCommandHelp("capability")).toBe(true);
    expect(hasCommandHelp("authority")).toBe(true);
    expect(printCommandHelp("capability")).toBe(0);
    expect(printCommandHelp("authority")).toBe(0);
  });
});
