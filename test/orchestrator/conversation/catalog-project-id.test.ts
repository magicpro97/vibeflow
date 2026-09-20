import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CatalogCursorCodec } from "../../../src/orchestrator/conversation/catalog-cursor.js";
import { projectConversationCatalog } from "../../../src/orchestrator/conversation/catalog-projector.js";
import { conversationProjectId } from "../../../src/orchestrator/conversation/catalog-row.js";
import { deriveConversationLineages } from "../../../src/orchestrator/conversation/lineage-reader.js";
import { readConversationSourceInventory } from "../../../src/orchestrator/conversation/source-inventory.js";
import { fixtureRecord, installFixture } from "../../helpers/conversation-catalog-fixture.js";

test("catalog row derives project_id as the repo_root basename", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-pid-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    const record = fixtureRecord("pid-root", { repoRoot: "/Users/me/repo-alpha" });
    installFixture(artifacts, traces, record, "2026-08-25T00:00:30.000Z");
    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    const lineages = deriveConversationLineages(inventory);
    const headRecords = new Map(
      lineages.lineages.map((lineage) => [lineage.root_session_id, lineage.initial_head_candidate]),
    );
    const projection = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 7)),
      scopeId: "project:demo",
      headRecords,
    });
    expect(projection.response.items).toHaveLength(1);
    expect(projection.response.items[0]?.root.project_id).toBe("repo-alpha");
    expect(projection.response.items[0]?.root.project_id).toBe(basename(record.manifest.repo_root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project id falls back to unassigned when repo_root has no usable basename", () => {
  expect(conversationProjectId("/Users/me/repo-alpha")).toBe("repo-alpha");
  expect(conversationProjectId("/Users/me/repo-alpha/")).toBe("repo-alpha");
  expect(conversationProjectId("")).toBe("unassigned");
  expect(conversationProjectId("/")).toBe("unassigned");
  expect(conversationProjectId(".")).toBe("unassigned");
});
