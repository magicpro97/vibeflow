import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const docs = [
  "COMMAND_REFERENCE.md",
  "SECURITY_MODEL.md",
  "SKILL_SECURITY_SCAN.md",
  "AGENT_ORCHESTRATION_POLICY.md",
  "WEB_UI_DESIGN.md",
  "USER_GUIDE.md",
];
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("#682 acquisition docs contract", () => {
  for (const name of docs) {
    test(`${name} and landing mirror document the approval boundary`, () => {
      const canonical = read(`docs/${name}`);
      const mirror = read(`landing/src/content/wiki/${name}`);
      for (const phrase of ["pinned registry", "security scan", "skill gap"]) {
        expect(canonical.toLowerCase()).toContain(phrase);
        expect(mirror.toLowerCase()).toContain(phrase);
      }
    });
  }

  test("command help states --yes acquisition consent without overriding scan blocks", () => {
    const help = read("src/commands/help-commands.ts");
    expect(help).toContain("auto-approve installable pinned-registry skill acquisitions");
    expect(help).toContain("scan blocks still apply");
  });
});
