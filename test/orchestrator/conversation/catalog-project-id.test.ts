import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../../src/durability/index.js";
import type { ConversationDurableRecord } from "../../../src/orchestrator/conversation/artifact-validation.js";
import { CatalogCursorCodec } from "../../../src/orchestrator/conversation/catalog-cursor.js";
import { projectConversationCatalog } from "../../../src/orchestrator/conversation/catalog-projector.js";
import { createConversationRevisionSummary } from "../../../src/orchestrator/conversation/catalog-row.js";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../../src/orchestrator/conversation/conversation-catalog-contract.js";
import { ConversationHomeCreateBrokerV1 } from "../../../src/orchestrator/conversation/conversation-home-create-authority.js";
import { ConversationPrivateContextBrokerV1 } from "../../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import type { ConversationHomeCreateRequestV1 } from "../../../src/orchestrator/conversation/conversation-private-context-broker-types.js";
import { assertConversationProjectId } from "../../../src/orchestrator/conversation/conversation-project-binding.js";
import { deriveConversationLineages } from "../../../src/orchestrator/conversation/lineage-reader.js";
import { ProjectRegistryAuthority } from "../../../src/orchestrator/conversation/project-registry-authority.js";
import { readConversationSourceInventory } from "../../../src/orchestrator/conversation/source-inventory.js";
import { fixtureRecord, installFixture } from "../../helpers/conversation-catalog-fixture.js";

async function projectIdOf(record: ConversationDurableRecord): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-pid-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
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
    return projection.response.items[0]?.root.project_id;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a manifest project_id flows through to the catalog DTO", async () => {
  const record = fixtureRecord("pid-bound", { projectId: "checkout-web" });
  expect(record.manifest.project_id).toBe("checkout-web");
  expect(await projectIdOf(record)).toBe("checkout-web");
});

test("a manifest-less project_id reads back as the default project, not the repo basename", async () => {
  const record = fixtureRecord("pid-legacy", { repoRoot: "/Users/me/repo-alpha" });
  expect("project_id" in record.manifest).toBe(false);
  expect(await projectIdOf(record)).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
  expect(CONVERSATION_DEFAULT_PROJECT_ID).toBe("idea");
});

test("a path-bearing project_id is rejected at projection, not silently projected", async () => {
  const record = fixtureRecord("pid-path", { projectId: "checkout-web" });
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-pid-path-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    installFixture(artifacts, traces, record, "2026-08-25T00:00:30.000Z");
    const lineages = deriveConversationLineages(
      readConversationSourceInventory({ artifactRoot: artifacts, traceRoot: traces }),
    );
    const node = lineages.lineages[0]?.nodes[0];
    if (!node) throw new Error("fixture lineage has no root node");

    // The slug grammar is what makes the label safe to project; a manifest that bypasses it
    // must fail closed here rather than reach the DTO raw. This is the guard the previous
    // `sanitizePublicText(..., "project_id")` call only appeared to provide.
    const forged = {
      ...node,
      source: {
        ...node.source,
        manifest: { ...node.source.manifest, project_id: "/Users/private/secret-repo" },
      },
    };
    expect(() => createConversationRevisionSummary(forged, 0)).toThrow("unsafe catalog project_id");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const stamp = (second: number) => new Date(Date.UTC(2026, 7, 26, 3, 0, second)).toISOString();
const principal = digestV1("VF-PROJECT-BINDING-TEST-PRINCIPAL\0v1\0", {});

function createRequest(key: string, projectId?: string): ConversationHomeCreateRequestV1 {
  return {
    schema_version: "1.0",
    idempotency_key: key,
    topic: "bind a project",
    private_context_present: false,
    ...(projectId === undefined ? {} : { project_id: projectId }),
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "vf-project-binding-"));
  let tick = 0;
  const now = () => stamp(tick++);
  const registry = new ProjectRegistryAuthority({ root: join(root, "registry") });
  const artifactRoot = join(root, "state");
  const privateContext = new ConversationPrivateContextBrokerV1({
    artifactRoot,
    repoRoot: root,
    now,
  });
  const creates = new ConversationHomeCreateBrokerV1(artifactRoot, now, privateContext, registry);
  return {
    root,
    registry,
    creates,
    prepare: (key: string, projectId?: string) =>
      creates.prepare({ principal_digest: principal, request: createRequest(key, projectId) }),
  };
}

test("create authority accepts a registered project_id and the default, rejecting unknown ones", async () => {
  const value = await createFixture();
  try {
    value.registry.create({
      id: "checkout-web",
      name: "Checkout Web",
      engine: { cli: "codex", thinking: "medium" },
    });

    expect(value.prepare("bound-known", "checkout-web").allocation.conversation_id).toMatch(
      /^conversation-[0-9a-f]{64}$/,
    );
    expect(value.prepare("bound-default").allocation.conversation_id).toMatch(
      /^conversation-[0-9a-f]{64}$/,
    );
    expect(
      value.prepare("bound-idea", CONVERSATION_DEFAULT_PROJECT_ID).allocation.conversation_id,
    ).toMatch(/^conversation-[0-9a-f]{64}$/);
    expect(() => value.prepare("bound-unknown", "nope")).toThrow("unknown project");
    expect(() => value.prepare("bound-unknown")).not.toThrow();
    expect(value.registry.get("nope")).toBeUndefined();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a registry that rejects the default id cannot make it unclassified", async () => {
  const value = await createFixture();
  try {
    // The guard is at create, so a registry can never hold the reserved fallback id even
    // though `assertConversationProjectId` would otherwise short-circuit it by name.
    expect(() =>
      value.registry.create({
        id: CONVERSATION_DEFAULT_PROJECT_ID,
        name: "Ideas",
        engine: { cli: "codex", thinking: "medium" },
      }),
    ).toThrow(/reserved/);
    expect(value.registry.get(CONVERSATION_DEFAULT_PROJECT_ID)).toBeUndefined();
    expect(value.prepare("bound-idea-unregistered", CONVERSATION_DEFAULT_PROJECT_ID)).toBeDefined();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("binding rejects a non-slug id and fails closed without a registry", () => {
  const projects = { get: (id: string) => (id === "checkout-web" ? {} : undefined) };

  expect(assertConversationProjectId(projects, undefined)).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
  expect(assertConversationProjectId(projects, "checkout-web")).toBe("checkout-web");
  expect(() => assertConversationProjectId(projects, "Bad Slug")).toThrow(
    "invalid conversation project_id",
  );
  expect(() => assertConversationProjectId(projects, "/Users/private/repo")).toThrow(
    "invalid conversation project_id",
  );
  expect(assertConversationProjectId(undefined, CONVERSATION_DEFAULT_PROJECT_ID)).toBe(
    CONVERSATION_DEFAULT_PROJECT_ID,
  );
  expect(() => assertConversationProjectId(undefined, "checkout-web")).toThrow(
    "unknown project checkout-web",
  );
});
