import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConversationCoordinationRepoEvidence } from "../../src/orchestrator/conversation/conversation-coordination-evidence.js";

test("repo evidence accepts canonical in-repo files and rejects forged or escaping references", () => {
  const parent = mkdtempSync(join(tmpdir(), "vf-coordination-evidence-"));
  const repo = join(parent, "repo");
  const outside = join(parent, "outside.ts");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "inside.ts"), "export {};\n");
    writeFileSync(outside, "private\n");
    symlinkSync(outside, join(repo, "src", "escape.ts"));

    expect(validateConversationCoordinationRepoEvidence(repo, ["src/inside.ts#L1"])).toBe(true);
    for (const reference of [
      "../outside.ts",
      outside,
      "src/escape.ts",
      "src/missing.ts",
      "src\\inside.ts",
      "src/inside.ts\nforged",
    ])
      expect(validateConversationCoordinationRepoEvidence(repo, [reference])).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
