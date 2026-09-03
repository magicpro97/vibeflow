import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonSlice, writeJsonSlice } from "../../src/capabilities/adapters/filesystem-io.js";
import { InMemoryCapabilityEffectBrokerV1 } from "../../src/capabilities/adapters/memory-broker.js";
import { validateActionRootLocator } from "../../src/capabilities/authority/shapes.js";
import { CapabilityFabricServiceV1 } from "../../src/capabilities/index.js";
import { patternMatches } from "../../src/capabilities/manifest/validation-helpers.js";
import { readOperationHeader } from "../../src/capabilities/operations/fold.js";
import { assertCapabilityWalReferentialClosure } from "../../src/capabilities/operations/wal-referential.js";
import {
  CapabilityStorageV1,
  projectCapabilityPaths,
  readCapabilityWal,
} from "../../src/capabilities/storage/index.js";
import type { CapabilityWalEventV1 } from "../../src/capabilities/wire/operation.js";
import { readConversationSourceInventory } from "../../src/orchestrator/conversation/source-inventory.js";
import {
  resolvedRolePackage,
  retainRuntimePackageCache,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimeDigest,
  runtimePlanningGraph,
  testRuntimeMutationAuthorities,
} from "./runtime-fixtures.js";

const roots: string[] = [];
const NOW = "2026-08-25T00:00:00.000Z";
const authorization = {
  schema_version: "1.0" as const,
  proposal_id: `vf-proposal-${"6".repeat(64)}`,
  proposal_digest: runtimeDigest("final-boundary-proposal"),
  approval_id: `vf-approval-${"7".repeat(64)}`,
  approval_digest: runtimeDigest("final-boundary-approval"),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-final-boundary-runtime-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const pkg = resolvedRolePackage();
  retainRuntimePackageCache(storage, pkg);
  const graph = runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: authority.scope_identity_digest,
      authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    },
    broker,
  );
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    ...testRuntimeMutationAuthorities(),
    broker,
    now: () => NOW,
  });
  return { broker, graph, service, storage };
}

describe("final fail-closed boundary regressions", () => {
  test("degrades a conversation inventory when its pinned source moves during the scan", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-final-boundary-inventory-"));
    roots.push(root);
    const artifactRoot = join(root, "artifacts");
    const movedArtifactRoot = join(root, "artifacts-moved");
    const traceRoot = join(root, "traces");
    mkdirSync(artifactRoot, { mode: 0o700 });
    mkdirSync(traceRoot, { mode: 0o700 });

    const inventory = readConversationSourceInventory({
      artifactRoot,
      traceRoot,
      fault: (point) => {
        expect(point).toBe("after-artifact-scan");
        renameSync(artifactRoot, movedArtifactRoot);
      },
    });

    expect(inventory).toMatchObject({
      state: "degraded",
      authoritative: false,
      sources: [],
      diagnostics: [
        {
          code: "invalid-source-root",
          source_kind: "inventory",
          record_id: null,
          message: "conversation source changed while read",
        },
      ],
    });
  });

  test("rejects runtime-invalid action roots and regex syntax outside the linear scanner", () => {
    expect(() =>
      validateActionRootLocator({ kind: "not-an-action-root" } as never, "root"),
    ).toThrow(/invalid action-root locator kind/i);
    expect(() => patternMatches("[z-a]", "z")).toThrow(/invalid input pattern/i);
  });

  test("rejects an empty JSON projection key path instead of addressing the root object", () => {
    expect(() => readJsonSlice({ retained: true }, [])).toThrow(/key path must not be empty/i);
    expect(() => writeJsonSlice({ retained: true }, [], true, "replacement")).toThrow(
      /key path must not be empty/i,
    );
    expect(readJsonSlice({ nested: { retained: true } }, ["nested", "retained"])).toEqual({
      present: true,
      value: true,
    });
  });

  test("rejects lock publication after a real required apply failure", () => {
    const fixture = runtimeFixture();
    fixture.broker.apply = () => {
      throw new Error("required effect failed before mutation");
    };
    const result = fixture.service.execute({ graph: fixture.graph, authorization });
    expect(result).toMatchObject({ status: "failed", reason_code: "apply-failed" });

    const header = readOperationHeader(fixture.storage, result.operation_id);
    const events = readCapabilityWal(fixture.storage.paths, result.operation_id);
    const publication = {
      schema_version: "1.0",
      operation_id: result.operation_id,
      sequence: (events.at(-1)?.sequence ?? -1) + 1,
      previous_event_digest: events.at(-1)?.event_digest ?? null,
      recorded_at: NOW,
      payload: { kind: "lock-commit" },
      event_digest: runtimeDigest("corrupt-required-failure-publication"),
    } as CapabilityWalEventV1;

    expect(() =>
      assertCapabilityWalReferentialClosure(
        fixture.storage,
        header,
        fixture.graph.plan,
        [...events, publication],
        null,
      ),
    ).toThrow(/lock publication follows a required apply failure/i);
  });
});
