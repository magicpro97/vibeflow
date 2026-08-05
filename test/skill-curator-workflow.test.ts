import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const content = readFileSync(".github/workflows/skill-curator.yml", "utf8");

describe("skill-curator workflow", () => {
  test("has required top-level keys", () => {
    expect(content).toMatch(/^name:\s*Skill Curator Weekly Report/m);
    expect(content).toMatch(/^on:/m);
    expect(content).toMatch(/^ {4}permissions:/m);
    expect(content).toMatch(/^concurrency:/m);
    expect(content).toMatch(/^jobs:/m);
  });

  test("scheduled weekly and dispatchable", () => {
    expect(content).toContain("schedule:");
    expect(content).toContain('cron: "0 0 * * 1"');
    expect(content).toContain("workflow_dispatch:");
  });

  test("sync and report jobs use least-privilege permissions", () => {
    expect(content).toContain("sync:");
    expect(content).toContain("report:");
    expect(content).toContain("contents: write");
    expect(content).toContain("contents: read");
    expect(content).toContain("issues: write");
    expect(content).toContain("needs: sync");
  });

  test("pinned action versions", () => {
    expect(content).toContain("actions/checkout@v4");
    expect(content).toContain("oven-sh/setup-bun@v2");
    expect(content).toContain("actions/upload-artifact@v4");
    expect(content).toContain("actions/download-artifact@v4");
  });

  test("shell strict mode in every multi-line run step", () => {
    const blocks = content.split("run: |").slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(block).toContain("set -euo pipefail");
    }
  });

  test("finds existing report issue by exact title, no label dependency", () => {
    expect(content).toContain("gh issue list");
    expect(content).toContain("--search 'in:title \"[skill-curator] Weekly Skill Health Report\"'");
    expect(content).toContain("--limit 1000");
    expect(content).toContain("--json number,title");
    expect(content).toContain('select(.title == "[skill-curator] Weekly Skill Health Report")');
    expect(content).not.toContain("gh label create");
    expect(content).not.toContain("--label skill-curator");
  });

  test("creates or updates a single issue with fixed title", () => {
    expect(content).toContain("[skill-curator] Weekly Skill Health Report");
    expect(content).toContain("gh issue create");
    expect(content).toContain("gh issue edit");
    expect(content).toContain("steps.find.outputs.found");
  });

  test("runs explicit repo sync and preserves finding exit status", () => {
    expect(content).toContain("contents: write");
    expect(content).toContain("cancel-in-progress: false");
    expect(content).toContain("node dist/cli.js skills curator scan --scope=repo --sync --yes");
    expect(content).toContain('if [ "${rc:-0}" -gt 1 ]; then exit "$rc"; fi');
    expect(content).not.toContain("node dist/cli.js skills curator scan --scope=local");
  });

  test("reads findings.json for issue body", () => {
    expect(content).toContain("findings.json");
    expect(content).toContain("jq");
  });

  test("embeds summary counts only — no raw finding detail in body", () => {
    const buildStep = content.slice(
      content.indexOf("Build issue body"),
      content.indexOf("Find existing report issue"),
    );
    expect(buildStep).toContain(".findings | length");
    expect(buildStep).toContain("| Type | Count |");
    expect(buildStep).not.toContain("jq '.findings[]'");
    expect(buildStep).not.toContain(".id");
  });

  test("handles zero findings case", () => {
    expect(content).toContain("No issues found");
  });

  test("no internal identifiers or NDA material", () => {
    expect(content).not.toContain("linhnt99x");
    expect(content).not.toContain("magicpro97");
    const buildStep = content.slice(
      content.indexOf("Build issue body"),
      content.indexOf("Find existing report issue"),
    );
    expect(buildStep).not.toMatch(/\b[a-f0-9]{16}\b/);
  });

  test("uses GITHUB_TOKEN with explicit GH_TOKEN env", () => {
    expect(content).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });
});
