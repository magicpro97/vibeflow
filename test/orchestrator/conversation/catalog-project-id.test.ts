import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../../src/durability/index.js";
import { ConversationArtifactStore } from "../../../src/orchestrator/conversation/artifact-store.js";
import type { ConversationDurableRecord } from "../../../src/orchestrator/conversation/artifact-validation.js";
import { CatalogCursorCodec } from "../../../src/orchestrator/conversation/catalog-cursor.js";
import { projectConversationCatalog } from "../../../src/orchestrator/conversation/catalog-projector.js";
import { createConversationRevisionSummary } from "../../../src/orchestrator/conversation/catalog-row.js";
import {
  CONVERSATION_CATALOG_HEALTH,
  CONVERSATION_DEFAULT_PROJECT_ID,
} from "../../../src/orchestrator/conversation/conversation-catalog-contract.js";
import { ConversationHomeCreateBrokerV1 } from "../../../src/orchestrator/conversation/conversation-home-create-authority.js";
import { ConversationPrivateContextBrokerV1 } from "../../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import type { ConversationHomeCreateRequestV1 } from "../../../src/orchestrator/conversation/conversation-private-context-broker-types.js";
import { assertConversationProjectId } from "../../../src/orchestrator/conversation/conversation-project-binding.js";
import { deriveConversationLineages } from "../../../src/orchestrator/conversation/lineage-reader.js";
import {
  MANIFEST_RECORD_DOMAIN,
  manifestRecordDigestMatches,
} from "../../../src/orchestrator/conversation/manifest-record-digest.js";
import { ProjectRegistryAuthority } from "../../../src/orchestrator/conversation/project-registry-authority.js";
import { revisionManifestRecord } from "../../../src/orchestrator/conversation/revision-source.js";
import { readConversationSourceInventory } from "../../../src/orchestrator/conversation/source-inventory.js";
import { fixtureRecord, installFixture } from "../../helpers/conversation-catalog-fixture.js";

/** A legal registry slug whose `sk-` prefix the public-text sanitizer reads as a credential. */
const CREDENTIAL_SHAPED_PROJECT_ID = "sk-migration-2026-refactor";

async function projectionOf(record: ConversationDurableRecord) {
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
    return projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 7)),
      scopeId: "project:demo",
      headRecords,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function projectIdOf(record: ConversationDurableRecord): Promise<unknown> {
  const projection = await projectionOf(record);
  expect(projection.response.items).toHaveLength(1);
  return projection.response.items[0]?.root.project_id;
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

test("a revision prepared before project_id existed still matches the digest pinned for it", () => {
  // The upgrade boundary. `assertConversationManifest` injects `project_id` in place on read, so a
  // record written before project binding existed hashes to a different value once normalized —
  // while the digest computed at prepare time (stored in `visibility.manifest_record_digest`) was
  // taken over the un-normalized record. `revision-artifact-store` and the two deferred-commit
  // validators compare exactly those two operands.
  const root = mkdtempSync(join(tmpdir(), "vf-manifest-digest-legacy-"));
  try {
    const store = new ConversationArtifactStore({ dir: join(root, "artifacts") });
    const parent = fixtureRecord("legacy-parent");
    store.create(parent.manifest, parent.binding_authorities);
    // A pre-branch child: the fixture omits `project_id` entirely, as the old writer did.
    const child = fixtureRecord("legacy-child", {
      parent: "legacy-parent",
      parentRevision: "revision-legacy-parent",
    });
    // The digest a pre-branch build hashed for the prepared revision: the record as the writer
    // builds it (no resume bindings, no children) and without the field it had no concept of.
    const pinned = revisionManifestRecord(child.manifest, child.binding_authorities).digest;
    const operationId = `vf-operation-${"b".repeat(64)}`;

    // The prepare site: the caller hands back the digest it computed before the upgrade.
    expect(() =>
      store.prepareRevision(child.manifest, child.binding_authorities, {
        operation_id: operationId,
        manifest_record_digest: pinned,
        updated_at: "2026-08-25T00:00:30.000Z",
      }),
    ).not.toThrow();

    const readBack = store.readPreparedRevision("legacy-child");
    const marker = store.revisionVisibility("legacy-child");
    if (!readBack || !marker) throw new Error("fixture revision did not read back");
    expect(readBack.manifest.project_id).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
    // The inequality the validators would turn into "published revision artifact authority
    // changed" / "committed revision publication closure changed" without the tolerance.
    expect(digestV1(MANIFEST_RECORD_DOMAIN, readBack)).not.toBe(pinned);
    expect(manifestRecordDigestMatches(marker.manifest_record_digest, readBack)).toBe(true);
    // A digest recomputed in the current form keeps matching unchanged.
    expect(manifestRecordDigestMatches(digestV1(MANIFEST_RECORD_DOMAIN, readBack), readBack)).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the legacy digest tolerance cannot mask a record filed into another project", () => {
  const bound = fixtureRecord("legacy-child-bound", { projectId: "checkout-web" });
  const { project_id: _projectId, ...legacyManifest } = bound.manifest;
  const legacyForm = digestV1(MANIFEST_RECORD_DOMAIN, { ...bound, manifest: legacyManifest });
  // Only the injected *default* is tolerated: deleting a real project id would accept a digest for
  // a record that differs from this one in the very field a move rewrites.
  expect(manifestRecordDigestMatches(legacyForm, bound)).toBe(false);
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

test("a registry-legal id the sanitizer rejects still projects a healthy catalog row", async () => {
  // `sk-migration-2026-refactor` is a legal registry slug; `isSafeCatalogIdentifier` rejects it
  // because the sanitizer treats the `sk-` prefix as a credential. The projection must use the
  // field's own grammar, or the row is dropped and the whole catalog goes durably degraded.
  const value = await createFixture();
  try {
    value.registry.create({
      id: CREDENTIAL_SHAPED_PROJECT_ID,
      name: "Migration",
      engine: { cli: "codex", thinking: "medium" },
    });
    expect(value.registry.get(CREDENTIAL_SHAPED_PROJECT_ID)?.id).toBe(CREDENTIAL_SHAPED_PROJECT_ID);
    expect(value.prepare("bound-credential-shaped", CREDENTIAL_SHAPED_PROJECT_ID)).toBeDefined();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }

  const projection = await projectionOf(
    fixtureRecord("pid-credential-shaped", { projectId: CREDENTIAL_SHAPED_PROJECT_ID }),
  );
  expect(projection.diagnostics).toEqual([]);
  expect(projection.response.catalog_health).toBe(CONVERSATION_CATALOG_HEALTH.READY);
  expect(projection.response.items).toHaveLength(1);
  expect(projection.response.items[0]?.root.project_id).toBe(CREDENTIAL_SHAPED_PROJECT_ID);
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
