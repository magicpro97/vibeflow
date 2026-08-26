import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIntake } from "../src/commands.js";
import { VF_BLOCK_END, VF_BLOCK_START } from "../src/workflow/merge.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("init fat→slim migration (#326)", () => {
  test("replaces fat block with slim block inside markers, preserves human content outside", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-init-migrate-"));
    dirs.push(repo);

    // Human content outside the VibeFlow-managed region
    const beforeMarker =
      "# My Project\n\n## Custom human instructions\n- Always use TypeScript\n- Run tests before PR\n\n";
    // Old "fat" workflow block — the long inline narrative that was the default before #322
    const fatBlock = [
      "# AGENTS.md",
      "## ⚡ VibeFlow v0 Active — orchestration framework",
      "",
      "**Full workflow guide**",
      "1. Sync context",
      "2. Shape the work",
      "3. Dispatch via orchestrate",
      "4. Verify before claiming done",
      "",
      "Commands: doctor, init, orchestrate --engine, verify, skills, discover, tools, hooks, units, workflow",
      "",
      'Confidence gate: nothing is "done" until verify passes at confidence 1.0 WITH evidence.',
      "",
      "Powered by VibeFlow",
    ].join("\n");
    const afterMarker = "\n## Footer\n\nSome extra notes the human wrote.\n";

    const existing = `${beforeMarker}${VF_BLOCK_START}\n${fatBlock}\n${VF_BLOCK_END}\n${afterMarker}`;

    writeFileSync(join(repo, "AGENTS.md"), existing);

    // Run the same path vf init takes: applyIntake generates the slim body
    // and mergeManagedBlock swaps only the fenced region.
    await applyIntake({ goal: "test project", engines: ["codex"] }, { useAi: false, base: repo });

    // Read the merged result
    const result = readFileSync(join(repo, "AGENTS.md"), "utf8");

    // Human content before markers is preserved unchanged
    expect(result).toContain("# My Project");
    expect(result).toContain("## Custom human instructions");
    expect(result).toContain("Always use TypeScript");
    expect(result).toContain("Run tests before PR");

    // Human content after markers is preserved unchanged
    expect(result).toContain("## Footer");
    expect(result).toContain("Some extra notes the human wrote.");

    // Old fat block content is gone — the long inline narrative is replaced
    expect(result).not.toContain("**Full workflow guide**");
    expect(result).not.toContain("Shape the work");
    expect(result).not.toContain("Commands: doctor, init, orchestrate");

    // VibeFlow markers still present
    // Check that the marker order is correct — start before end
    const startIdx = result.indexOf(VF_BLOCK_START);
    const endIdx = result.indexOf(VF_BLOCK_END);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);

    // The managed region now contains the slim block
    const managedBlock = result.slice(startIdx, endIdx + VF_BLOCK_END.length);

    // Slim block has the confidence gate pointer to the vf skill (unique to #322 slim)
    expect(managedBlock).toMatch(/Full workflow guide: load the `vf` skill/);
    // Slim block has the 5 core commands (slim surface)
    expect(managedBlock).toMatch(/VibeFlow commands/);

    // Human content relative order is preserved (before before after)
    const beforePos = result.indexOf("# My Project");
    const afterPos = result.indexOf("## Footer");
    expect(afterPos).toBeGreaterThan(endIdx);
    expect(beforePos).toBeLessThan(startIdx);
  });

  test("slim block replaces fat block on codex engine (AGENTS.md rooted)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-init-migrate-codex-"));
    dirs.push(repo);

    const beforeMarker = "# my custom instructions\nsome human curated text\n\n";
    const fatBlock = [
      "# AGENTS.md",
      "## Working with vf (the loop)",
      "1. Sync context after editing .vibeflow/*",
      "2. Model parallel slices as work units",
      "3. Dispatch via orchestrate",
      "4. Verify before claiming done",
      "",
      "Confidence gate — nothing is done until vf verify passes.",
    ].join("\n");
    const afterMarker = "\n## extra notes\nmore human content\n";

    const existing = `${beforeMarker}${VF_BLOCK_START}\n${fatBlock}\n${VF_BLOCK_END}\n${afterMarker}`;
    writeFileSync(join(repo, "AGENTS.md"), existing);

    await applyIntake({ goal: "codex test", engines: ["codex"] }, { useAi: false, base: repo });

    const result = readFileSync(join(repo, "AGENTS.md"), "utf8");

    // Human content preserved
    expect(result).toContain("my custom instructions");
    expect(result).toContain("extra notes");
    expect(result).toContain("more human content");

    // Old fat markers gone
    expect(result).not.toContain("Working with vf (the loop)");
    expect(result).not.toContain("Model parallel slices as work units");

    // Slim block present
    expect(result).toContain(VF_BLOCK_START);
    expect(result).toContain(VF_BLOCK_END);
    const managed = result.slice(
      result.indexOf(VF_BLOCK_START),
      result.indexOf(VF_BLOCK_END) + VF_BLOCK_END.length,
    );
    expect(managed).toMatch(/Full workflow guide: load the `vf` skill/);
    expect(managed).toMatch(/VibeFlow v\d+\.\d+\.\d+ Active/);
  });
});
