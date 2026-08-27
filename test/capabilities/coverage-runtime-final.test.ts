import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCapabilityEffectBrokerV1 } from "../../src/capabilities/adapters/memory-broker.js";
import type { CapabilityOwnedResourceV1 } from "../../src/capabilities/adapters/types.js";
import { readOperationHeader } from "../../src/capabilities/operations/fold.js";
import {
  assembleCapabilityDurablePlanningGraph,
  dedupeCapabilityPlanningJsonObjects,
} from "../../src/capabilities/planning/execution-graph.js";
import {
  actionBlobRef,
  planningJsonObject,
} from "../../src/capabilities/planning/execution-objects.js";
import { buildCapabilityPlanningGraph } from "../../src/capabilities/planning/planner.js";
import type {
  CapabilityPlanningRequestV1,
  ResolvedCapabilityPackageV1,
} from "../../src/capabilities/planning/types.js";
import {
  createBindingRecord,
  validateBindRequest,
} from "../../src/capabilities/private-input/bind.js";
import {
  assertPackageIdentity,
  uniqueSortedInputIds,
} from "../../src/capabilities/private-input/helpers.js";
import {
  CapabilityStorageV1,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import { digestV1Bytes } from "../../src/durability/canonical.js";
import {
  resolvedRolePackage,
  runtimeAuthority,
  runtimeDigest,
  runtimePlanningRequest,
} from "./runtime-fixtures.js";

const NOW = "2026-08-25T12:00:00.000Z";
const EXPIRES = "2026-08-25T13:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function planningFixture() {
  const pkg = resolvedRolePackage();
  const authority = runtimeAuthority();
  const action = {
    type: "capability.install" as const,
    package: {
      id: pkg.pin.id,
      version: pkg.pin.version,
      source_kind: pkg.pin.source.kind,
      content_sha256: pkg.pin.content_sha256,
      package_pin_digest: pkg.pin.pin_digest,
    },
    scope: "project" as const,
    requested_targets: [{ engine: "codex" as const, participant_id: null }],
    inputs: [],
  };
  const request = runtimePlanningRequest({
    schema_version: "1.0",
    intent: { kind: "install" },
    scope: "project",
    scope_identity_digest: authority.scope_identity_digest,
    authority,
    base_lock: null,
    desired_packages: [pkg],
    effect_packages: [pkg],
    selected_engines: ["codex"],
    selected_targets: [{ package_id: pkg.pin.id, engine: "codex", participant_id: null }],
    canonical_action: action,
  });
  const graph = buildCapabilityPlanningGraph(
    request,
    new InMemoryCapabilityEffectBrokerV1(),
    NOW,
    "durable",
  );
  const {
    execution_closure: _closure,
    execution_closure_digest: _closureDigest,
    plan_digest: _planDigest,
    ...planDraft
  } = structuredClone(graph.plan);
  const objects = graph.ledger.json_objects;
  const values = (schema: string) =>
    objects
      .filter((row) => row.binding.object_schema_id === schema)
      .map((row) => structuredClone(row.value));
  const adapterSet = objects.find(
    (row) => row.binding.object_schema_id === "vf.adapter-set-binding/1",
  )?.value;
  if (!adapterSet) throw new Error("missing adapter-set fixture");
  return {
    request,
    planDraft,
    adapterSet,
    snapshots: structuredClone(graph.plan.runtime_closure.snapshots),
    evidence: values("vf.adapter-bounded-evidence/1"),
    privateDescriptors: values("vf.adapter-private-descriptor/1"),
    privatePreimages: [] as Array<{
      resource: CapabilityOwnedResourceV1;
      bytes: Uint8Array;
    }>,
    privateEvidence: [] as Array<{ content_digest: string; bytes: Uint8Array }>,
    stepEnforcement: values("vf.step-enforcement-binding/1"),
    probeEnforcement: values("vf.probe-enforcement-binding/1"),
    packages: request.effect_packages as ResolvedCapabilityPackageV1[],
    mode: "durable-proposal" as const,
  };
}

function resource(
  privatePreimageDigest: string | null,
  privatePreimageRef: string | null,
): CapabilityOwnedResourceV1 {
  return {
    ownership_key: "vf:test:coverage-runtime-final",
    kind: "file",
    public_target: "coverage-runtime-final",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
    private_preimage_digest: privatePreimageDigest,
    private_preimage_ref: privatePreimageRef,
  };
}

function bindRequest() {
  return {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: runtimeDigest("private-scope"),
    package_id: "acme.private",
    package_pin_digest: runtimeDigest("private-pin"),
    manifest_digest: runtimeDigest("private-manifest"),
    idempotency_key: "bind-coverage-runtime",
    values: { token: "secret" },
    expires_at: EXPIRES,
  };
}

describe("capability runtime final branch coverage", () => {
  test("rejects conflicting schemas or values that claim one execution object digest", () => {
    const base = planningFixture();
    const original = planningJsonObject("vf.adapter-set-binding/1", base.adapterSet as never);
    const valueConflict = structuredClone(original);
    valueConflict.value = { ...valueConflict.value, conflict: true } as never;
    expect(() => dedupeCapabilityPlanningJsonObjects([original, valueConflict])).toThrow(
      /conflicting execution object digest/,
    );

    const schemaConflict = structuredClone(original);
    schemaConflict.binding.object_schema_id = "vf.permission-binding/1";
    expect(() => dedupeCapabilityPlanningJsonObjects([original, schemaConflict])).toThrow(
      /conflicting execution object digest/,
    );
  });

  test("reports a missing durable operation header", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-operation-header-coverage-"));
    roots.push(root);
    mkdirSync(join(root, ".vibeflow"));
    const storage = new CapabilityStorageV1(
      projectCapabilityPaths(root),
      runtimeDigest("missing-operation-scope"),
    );

    expect(() => readOperationHeader(storage, `vf-operation-${"a".repeat(64)}`)).toThrow(
      /operation was not found/,
    );
  });

  test("rejects absent and mismatched private preimage bindings", () => {
    const base = planningFixture();
    expect(() =>
      assembleCapabilityDurablePlanningGraph({
        ...base,
        privatePreimages: [{ resource: resource(null, null), bytes: Buffer.from("preimage") }],
      } as never),
    ).toThrow(/private preimage digest is absent/);

    const digest = runtimeDigest("bound-preimage");
    expect(() =>
      assembleCapabilityDurablePlanningGraph({
        ...base,
        privatePreimages: [
          {
            resource: resource(digest, "actions/v1/blobs/not-the-digest.bin"),
            bytes: Buffer.from("x"),
          },
        ],
      } as never),
    ).toThrow(/private preimage binding mismatch/);
  });

  test("rejects two raw blobs that claim one digest with different bytes", () => {
    const base = planningFixture();
    const evidenceBytes = Buffer.from("private evidence");
    const digest = digestV1Bytes("VF-ADAPTER-PRIVATE-EVIDENCE\0v1\0", evidenceBytes);
    expect(() =>
      assembleCapabilityDurablePlanningGraph({
        ...base,
        privatePreimages: [
          {
            resource: resource(digest, actionBlobRef(digest)),
            bytes: Buffer.from("different preimage"),
          },
        ],
        privateEvidence: [{ content_digest: digest, bytes: evidenceBytes }],
      } as never),
    ).toThrow(/conflicting execution blob digest/);
  });

  test("rejects conflicting records behind one private binding digest", () => {
    const base = planningFixture();
    const pkg = base.packages[0];
    if (!pkg) throw new Error("missing package fixture");
    const first = {
      ...pkg,
      private_input_execution: {
        binding_digest: pkg.private_input_binding_digest,
        record: { private_binding_id: "first", marker: "first" },
      },
    } as never;
    const second = {
      ...pkg,
      private_input_execution: {
        binding_digest: pkg.private_input_binding_digest,
        record: { private_binding_id: "second", marker: "second" },
      },
    } as never;

    expect(() =>
      assembleCapabilityDurablePlanningGraph({ ...base, packages: [first, second] } as never),
    ).toThrow(/conflicting private input binding/);
  });

  test("requires authenticated source request context for action-plan materialization", () => {
    const base = planningFixture();
    const request = {
      ...base.request,
      source_request_context: undefined,
    } as CapabilityPlanningRequestV1;
    expect(() => assembleCapabilityDurablePlanningGraph({ ...base, request } as never)).toThrow(
      /source request context is absent/,
    );
  });

  test("rejects malformed bind envelope fields before creating authority records", () => {
    const request = bindRequest();
    const validate = (candidate: typeof request) =>
      validateBindRequest({
        request: candidate,
        scope: "project",
        scopeIdentityDigest: request.scope_identity_digest,
        now: () => NOW,
      });

    expect(() => validate({ ...request, idempotency_key: "" })).toThrow(/idempotency key/);
    expect(() => validate({ ...request, values: null as never })).toThrow(
      /values must be an object/,
    );
    expect(() => validate({ ...request, values: [] as never })).toThrow(/values must be an object/);
    const validated = validate(request);
    expect(() =>
      createBindingRecord({ request: validated, now: () => "invalid-clock", readHead: () => null }),
    ).toThrow(/clock produced an invalid timestamp/);
  });

  test("rejects duplicate input IDs and malformed package identities", () => {
    expect(() => uniqueSortedInputIds(["token", "token"])).toThrow(/duplicate/);
    expect(() =>
      assertPackageIdentity("invalid package", runtimeDigest("pin"), runtimeDigest("manifest")),
    ).toThrow(/package identifier/);
    expect(() => assertPackageIdentity("acme.valid", "bad", runtimeDigest("manifest"))).toThrow(
      /package digest identity/,
    );
  });
});
