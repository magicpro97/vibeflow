import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const names = ["SKILLS_SYSTEM.md", "SECURITY_MODEL.md", "COMMAND_REFERENCE.md"];
const commands = [
  "vf skills registry release-propose <registry-id> --from <oid> --to <oid> --version <v>",
  "vf skills registry release list",
  "vf skills registry release show <proposal-id>",
  "vf skills registry release reject <proposal-id>",
  "vf skills registry release approve <proposal-id> --yes",
];
const requirements = [
  "committed, default-deny target allowlist",
  "immutable local snapshot",
  "no automatic fanout, webhook, discovery, or ui execution",
  "isolated checkout",
  "target pin drift",
  "lock-only diff",
  "`vf verify` before commit, push, or pr",
  "sanitized evidence",
  "per-target failures continue",
  "partial failure exits 1",
];
const start = "<!-- registry-release:start -->";
const end = "<!-- registry-release:end -->";

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function block(text: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to + end.length);
}

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

describe("#686 registry release docs contract", () => {
  test("canonical release blocks match their landing mirrors", () => {
    for (const name of names) {
      const canonical = block(read(`docs/${name}`));
      const mirror = block(read(`landing/src/content/wiki/${name}`));
      expect(normalize(mirror)).toBe(normalize(canonical));
    }
  });

  test("canonical and mirrored blocks document every release safety boundary", () => {
    const canonical = names
      .map((name) => block(read(`docs/${name}`)))
      .join("\n")
      .toLowerCase();
    const mirrors = names
      .map((name) => block(read(`landing/src/content/wiki/${name}`)))
      .join("\n")
      .toLowerCase();
    for (const requirement of requirements) {
      expect(canonical).toContain(requirement);
      expect(mirrors).toContain(requirement);
    }
  });

  test("command reference and its mirror contain the exact release commands", () => {
    const canonical = block(read("docs/COMMAND_REFERENCE.md"));
    const mirror = block(read("landing/src/content/wiki/COMMAND_REFERENCE.md"));
    for (const command of commands) {
      expect(canonical).toContain(command);
      expect(mirror).toContain(command);
    }
  });

  test("CLI help contains the exact release commands", () => {
    const help = read("src/help/skills-command-help.ts");
    for (const command of commands) expect(help).toContain(command);
  });
});
