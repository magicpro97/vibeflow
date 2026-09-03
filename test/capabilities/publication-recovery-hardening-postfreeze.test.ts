import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityFabricServiceV1,
  CapabilityRuntimeError,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import { readCapabilityHealthCurrent } from "../../src/capabilities/operations/health-inventory.js";
import { ensureCapabilityLockCheckpoint } from "../../src/capabilities/operations/lock-checkpoint.js";
import { CapabilityOperationJournalV1 } from "../../src/capabilities/operations/operation-journal.js";
import {
  assertCapabilityPublicationEvidence,
  materializeCapabilityPublicationHealthPointer,
} from "../../src/capabilities/operations/publication-evidence.js";
import { recoverCapabilityPublication } from "../../src/capabilities/operations/publication-recovery.js";
import {
  CapabilityStorageV1,
  capabilityHealthCurrentPath,
  capabilityHealthInventoryPath,
  capabilityHistoryPath,
  capabilityOperationPaths,
  capabilityWalEventDigest,
  materializeCapabilityLock,
  projectCapabilityPaths,
  readCapabilityWal,
  validateCapabilityWalEvent,
  validateCapabilityWalPayload,
} from "../../src/capabilities/storage/index.js";
import type {
  CapabilityWalEventV1,
  CapabilityWalPayloadV1,
} from "../../src/capabilities/wire/operation.js";
import { canonicalJsonBytes, encodeVffrFrame } from "../../src/durability/index.js";
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorization(label: string) {
  return {
    schema_version: "1.0" as const,
    proposal_id: `vf-proposal-${runtimeDigest(`proposal-id-${label}`).slice(7)}`,
    proposal_digest: runtimeDigest(`proposal-${label}`),
    approval_id: `vf-approval-${runtimeDigest(`approval-id-${label}`).slice(7)}`,
    approval_digest: runtimeDigest(`approval-${label}`),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-publication-recovery-hardening-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const authorities = testRuntimeMutationAuthorities();
  const authorityReader = runtimeAuthorityReader(() => authority);
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: authorityReader,
    ...authorities,
    broker,
    now: () => "2026-08-26T00:00:00.000Z",
  });
  return { authority, broker, root, service, storage };
}

function noHealthRole(
  fx: ReturnType<typeof fixture>,
  mutate?: Parameters<typeof resolvedRolePackage>[0],
) {
  const pkg = resolvedRolePackage((manifest) => {
    manifest.health = [];
    mutate?.(manifest);
  });
  retainRuntimePackageCache(fx.storage, pkg);
  return pkg;
}

function initialGraph(fx: ReturnType<typeof fixture>) {
  return runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [noHealthRole(fx)],
      selected_engines: ["codex"],
    },
    fx.broker,
  );
}

function replacementGraph(fx: ReturnType<typeof fixture>) {
  const firstGraph = initialGraph(fx);
  expect(
    fx.service.execute({
      graph: firstGraph,
      authorization: authorization("replacement-base-install"),
    }).status,
  ).toBe("succeeded");
  const base = fx.storage.readStatus().lock;
  const priorPointer = readCapabilityHealthCurrent(fx.storage);
  if (!base || !priorPointer) throw new Error("installed replacement base fixture is absent");
  const replacement = noHealthRole(fx, (manifest) => {
    const role = manifest.components[0];
    if (!role || role.type !== "role") throw new Error("role fixture is absent");
    role.targets = ["opencode"];
    manifest.compatibility.engines = { opencode: ">=1.0.0 <2.0.0" };
  });
  const graph = runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "retarget", package_id: replacement.pin.id },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: base,
      desired_packages: [replacement],
      selected_engines: ["opencode"],
      current_permissions: firstGraph.plan.permission_binding,
    },
    fx.broker,
  );
  return { graph, priorPointer };
}

function preparedPublication(fx: ReturnType<typeof fixture>, operationId: string) {
  const payload = readCapabilityWal(fx.storage.paths, operationId).find(
    (event) => event.payload.kind === "health-inventory-prepared",
  )?.payload;
  if (payload?.kind !== "health-inventory-prepared")
    throw new Error("prepared publication fixture is absent");
  if (
    payload.expected_health_pointer_epoch === undefined ||
    payload.next_health_pointer_epoch === undefined ||
    payload.next_health_pointer_digest === undefined
  )
    throw new Error("prepared publication lacks exact post-pointer evidence");
  return {
    ...payload,
    expected_health_pointer_epoch: payload.expected_health_pointer_epoch,
    next_health_pointer_epoch: payload.next_health_pointer_epoch,
    next_health_pointer_digest: payload.next_health_pointer_digest,
  };
}

function expectIntegrityFailure(run: () => unknown, message: RegExp): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CapabilityRuntimeError);
  expect((failure as CapabilityRuntimeError).runtime_code).toBe("integrity-failure");
  expect((failure as Error).message).toMatch(message);
}

function rewriteOperationWal(
  fx: ReturnType<typeof fixture>,
  operationId: string,
  transform: (payload: CapabilityWalPayloadV1) => CapabilityWalPayloadV1,
): void {
  let priorDigest: string | null = null;
  const events = readCapabilityWal(fx.storage.paths, operationId).map((event) => {
    const draft = {
      ...event,
      previous_event_digest: priorDigest,
      payload: transform(event.payload),
      event_digest: "",
    };
    const rewritten = {
      ...draft,
      event_digest: capabilityWalEventDigest(draft),
    };
    priorDigest = rewritten.event_digest;
    return rewritten;
  });
  const frames = events.map((event) =>
    encodeVffrFrame("capability-operation", event as never, {
      domain: "capability-operation",
      maxFrames: 100_000,
      maxPayloadBytes: 2 * 1024 * 1024,
      maxAggregateBytes: 256 * 1024 * 1024,
      sequenceStart: event.sequence,
      initialPreviousDigest: event.previous_event_digest,
      validatePayload: (payload) =>
        validateCapabilityWalEvent(payload as unknown as CapabilityWalEventV1, operationId),
      computePayloadDigest: (payload) =>
        capabilityWalEventDigest(payload as unknown as CapabilityWalEventV1),
      validateJournalIdentity: (payload) => payload.operation_id === operationId,
    }),
  );
  writeFileSync(
    capabilityOperationPaths(fx.storage.paths, operationId).events,
    Buffer.concat(frames),
  );
}

describe("publication recovery hardening", () => {
  test("recovers every valid publication crash to the exact prepared post-pointer", () => {
    for (const frontier of [
      "after-health-inventory-prepared",
      "after-lock-publish",
      "after-lock-commit",
    ] as const) {
      const fx = fixture();
      const graph = initialGraph(fx);
      const auth = authorization(frontier);
      fx.service.fault = (point) => {
        if (point === frontier) throw new CapabilityRuntimeError(`crash ${frontier}`, "fault");
      };
      expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/crash/);
      const operationId = fx.service.operationId(graph, auth);
      const prepared = preparedPublication(fx, operationId);

      fx.service.fault = null;
      expect(fx.service.recover(operationId).status).toBe("succeeded");
      const pointer = readCapabilityHealthCurrent(fx.storage);
      expect(pointer).not.toBeNull();
      expect(pointer?.inventory_epoch).toBe(prepared.next_health_pointer_epoch);
      expect(pointer?.pointer_digest).toBe(prepared.next_health_pointer_digest);
      expect(pointer?.inventory_digest).toBe(prepared.health_inventory_digest);
    }
  });

  test("rejects a same-inventory pointer with the wrong epoch as a third state", () => {
    const fx = fixture();
    const graph = initialGraph(fx);
    const auth = authorization("wrong-epoch");
    fx.service.fault = (point) => {
      if (point === "after-lock-commit")
        throw new CapabilityRuntimeError("crash before pointer", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/before pointer/);
    const operationId = fx.service.operationId(graph, auth);
    const prepared = preparedPublication(fx, operationId);
    const forged = materializeCapabilityPublicationHealthPointer({
      scope: "project",
      scopeIdentityDigest: fx.authority.scope_identity_digest,
      inventoryEpoch: prepared.next_health_pointer_epoch + 1,
      inventoryDigest: prepared.health_inventory_digest,
    });
    const held = fx.storage.acquire("install-same-inventory-wrong-epoch");
    try {
      fx.storage.publishHealthCurrent(null, forged, held);
    } finally {
      held.release();
    }

    fx.service.fault = null;
    const recovered = fx.service.recover(operationId);
    expect(recovered.status).toBe("needs-recovery");
    expect(recovered.reason_code).toBe("health-pointer-third-state");
    expect(readCapabilityHealthCurrent(fx.storage)?.pointer_digest).toBe(forged.pointer_digest);
    expect(forged.pointer_digest).not.toBe(prepared.next_health_pointer_digest);
  });

  test("rejects a self-consistent prepared pointer that skips its retained prior epoch", () => {
    const fx = fixture();
    const graph = initialGraph(fx);
    const auth = authorization("prepared-epoch-jump");
    fx.service.fault = (point) => {
      if (point === "after-health-inventory-prepared")
        throw new CapabilityRuntimeError("crash with prepared evidence", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/prepared evidence/);
    const operationId = fx.service.operationId(graph, auth);
    const events = readCapabilityWal(fx.storage.paths, operationId);
    const prepared = preparedPublication(fx, operationId);
    const jumpedEpoch = (prepared.expected_health_pointer_epoch ?? -1) + 7;
    const jumpedPointer = materializeCapabilityPublicationHealthPointer({
      scope: "project",
      scopeIdentityDigest: fx.authority.scope_identity_digest,
      inventoryEpoch: jumpedEpoch,
      inventoryDigest: prepared.health_inventory_digest,
    });
    const tampered = events.map((event) =>
      event.payload.kind === "health-inventory-prepared"
        ? {
            ...event,
            payload: {
              ...event.payload,
              next_health_pointer_epoch: jumpedEpoch,
              next_health_pointer_digest: jumpedPointer.pointer_digest,
            },
          }
        : event,
    );

    expect(() =>
      assertCapabilityPublicationEvidence({
        storage: fx.storage,
        plan: graph.plan,
        events: tampered,
      }),
    ).toThrow(/prepared health pointer escaped the approved publication closure/i);
  });

  test("records a durable terminal before reporting missing or corrupt prepared objects", () => {
    for (const scenario of ["missing-inventory", "corrupt-history"] as const) {
      const fx = fixture();
      const graph = initialGraph(fx);
      const auth = authorization(scenario);
      fx.service.fault = (point) => {
        if (point === "after-health-inventory-prepared")
          throw new CapabilityRuntimeError(`crash ${scenario}`, "fault");
      };
      expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/crash/);
      const operationId = fx.service.operationId(graph, auth);
      const prepared = preparedPublication(fx, operationId);
      const damagedPath =
        scenario === "missing-inventory"
          ? capabilityHealthInventoryPath(fx.storage.paths, prepared.health_inventory_digest)
          : capabilityHistoryPath(fx.storage.paths, prepared.generation_id);
      const retainedBytes = readFileSync(damagedPath);
      if (scenario === "missing-inventory") rmSync(damagedPath);
      else writeFileSync(damagedPath, "{}");

      fx.service.fault = null;
      expectIntegrityFailure(
        () => fx.service.recover(operationId),
        /prepared publication objects are missing or corrupt after durable recovery terminal/i,
      );
      expect(readCapabilityWal(fx.storage.paths, operationId).at(-1)?.payload).toMatchObject({
        kind: "operation-transition",
        to: "needs_recovery",
        reason_code: "publication-objects-missing",
      });
      writeFileSync(damagedPath, retainedBytes);
      chmodSync(damagedPath, 0o600);
      const retainedEventCount = readCapabilityWal(fx.storage.paths, operationId).length;
      const repeated = fx.service.recover(operationId);
      expect(repeated.status).toBe("needs-recovery");
      expect(repeated.reason_code).toBe("publication-objects-missing");
      expect(fx.storage.readStatus().lock).toBeNull();
      const repeatedEvents = readCapabilityWal(fx.storage.paths, operationId);
      expect(repeatedEvents).toHaveLength(retainedEventCount);
      expect(repeatedEvents.some((event) => event.payload.kind === "lock-commit")).toBeFalse();
    }
  });

  test("revalidates a stale base immediately before publication construction", () => {
    const fx = fixture();
    const graph = initialGraph(fx);
    const auth = authorization("stale-base");
    const foreign = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 0,
      parent_generation_digests: [],
      packages: [],
      policy_digest: runtimeDigest("foreign-policy"),
      permission_digest: runtimeDigest("foreign-permission"),
      created_at: "2026-08-26T00:00:01.000Z",
    });
    fx.service.fault = (point) => {
      if (point === "before-publication-base-validation")
        writeFileSync(fx.storage.paths.currentLock, canonicalJsonBytes(foreign));
    };

    expectIntegrityFailure(
      () => fx.service.execute({ graph, authorization: auth }),
      /checkpoint base differs from the locked operation base/i,
    );
  });

  test("revalidates a missing retained health pointer after operation preflight", () => {
    const fx = fixture();
    const { graph } = replacementGraph(fx);
    fx.service.fault = (point) => {
      if (point === "before-publication-base-validation")
        rmSync(capabilityHealthCurrentPath(fx.storage.paths), { force: true });
    };

    expectIntegrityFailure(
      () => fx.service.execute({ graph, authorization: authorization("missing-pointer") }),
      /base lock has no selected health inventory/i,
    );
  });

  test("rejects a retained lock checkpoint selected for another immutable base", () => {
    const fx = fixture();
    const { graph } = replacementGraph(fx);
    const auth = authorization("wrong-checkpoint-base");
    fx.service.fault = (point) => {
      if (point === "after-lock-checkpoint")
        throw new CapabilityRuntimeError("crash after checkpoint", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/after checkpoint/);
    const operationId = fx.service.operationId(graph, auth);
    const foreignBase = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 0,
      parent_generation_digests: [],
      packages: [],
      policy_digest: runtimeDigest("foreign-checkpoint-policy"),
      permission_digest: runtimeDigest("foreign-checkpoint-permission"),
      created_at: "2026-08-26T00:00:02.000Z",
    });
    const authorityReader = runtimeAuthorityReader(() => fx.authority);
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: authorityReader,
      now: () => "2026-08-26T00:00:02.000Z",
    });
    const held = fx.storage.acquire("validate-wrong-checkpoint-base");
    try {
      expectIntegrityFailure(
        () =>
          ensureCapabilityLockCheckpoint({
            storage: fx.storage,
            operationId,
            base: foreignBase,
            held,
            journal,
          }),
        /lock checkpoint differs from the immutable operation base/i,
      );
    } finally {
      held.release();
    }
  });

  test("durably rejects prepared evidence that escapes the selected plan", () => {
    const fx = fixture();
    const graph = initialGraph(fx);
    const auth = authorization("escaped-plan-evidence");
    fx.service.fault = (point) => {
      if (point === "after-health-inventory-prepared")
        throw new CapabilityRuntimeError("crash before escaped plan check", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/escaped plan/);
    const operationId = fx.service.operationId(graph, auth);
    const authorities = testRuntimeMutationAuthorities();
    const authorityReader = runtimeAuthorityReader(() => fx.authority);
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: authorityReader,
      now: () => "2026-08-26T00:00:01.000Z",
    });
    const held = fx.storage.acquire("recover-escaped-plan-evidence");
    try {
      expectIntegrityFailure(
        () =>
          recoverCapabilityPublication({
            plan: { ...graph.plan, permission_digest: runtimeDigest("escaped-permission") },
            graph,
            operationId,
            held,
            storage: fx.storage,
            authority: authorityReader,
            sourceAuthority: authorities.sourceAuthority,
            now: () => "2026-08-26T00:00:01.000Z",
            journal,
            actionAuthority: authorities.actionAuthority,
          }),
        /prepared publication evidence is invalid after durable recovery terminal/i,
      );
    } finally {
      held.release();
    }
    expect(readCapabilityWal(fx.storage.paths, operationId).at(-1)?.payload).toMatchObject({
      kind: "operation-transition",
      to: "needs_recovery",
      reason_code: "publication-evidence-invalid",
    });
  });

  test("durably rejects a corrupt current health pointer before any recovery mutation", () => {
    const fx = fixture();
    const graph = initialGraph(fx);
    const auth = authorization("corrupt-current-pointer");
    fx.service.fault = (point) => {
      if (point === "after-lock-commit")
        throw new CapabilityRuntimeError("crash before current pointer", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/current pointer/);
    const operationId = fx.service.operationId(graph, auth);
    writeFileSync(capabilityHealthCurrentPath(fx.storage.paths), "{}");
    fx.service.fault = null;

    expectIntegrityFailure(
      () => fx.service.recover(operationId),
      /health pointer is corrupt after durable recovery terminal/i,
    );
    expect(readCapabilityWal(fx.storage.paths, operationId).at(-1)?.payload).toMatchObject({
      kind: "operation-transition",
      to: "needs_recovery",
      reason_code: "health-pointer-invalid",
    });
  });

  test("durably rejects a retained prior pointer whose immutable inventory disappeared", () => {
    const fx = fixture();
    const { graph, priorPointer } = replacementGraph(fx);
    const auth = authorization("missing-prior-inventory");
    fx.service.fault = (point) => {
      if (point === "after-lock-commit")
        throw new CapabilityRuntimeError("crash with retained prior pointer", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/retained prior/);
    const operationId = fx.service.operationId(graph, auth);
    rmSync(capabilityHealthInventoryPath(fx.storage.paths, priorPointer.inventory_digest));
    fx.service.fault = null;

    expectIntegrityFailure(
      () => fx.service.recover(operationId),
      /retained base health pointer is invalid after durable recovery terminal/i,
    );
    expect(readCapabilityWal(fx.storage.paths, operationId).at(-1)?.payload).toMatchObject({
      kind: "operation-transition",
      to: "needs_recovery",
      reason_code: "retained-health-pointer-invalid",
    });
  });

  test("keeps legacy publication rows readable but requires paired successor evidence", () => {
    const expectedOperationId = "publication-payload-validation";
    const legacy = {
      kind: "health-inventory-prepared" as const,
      generation_id: `vf-generation-${"1".repeat(64)}`,
      lock_digest: runtimeDigest("legacy-lock"),
      health_inventory_digest: runtimeDigest("legacy-inventory"),
      expected_health_pointer_digest: null,
    };
    expect(() => validateCapabilityWalPayload(legacy, expectedOperationId)).not.toThrow();
    expect(() =>
      validateCapabilityWalPayload(
        {
          ...legacy,
          next_health_pointer_epoch: 0,
        },
        expectedOperationId,
      ),
    ).toThrow(/prior epoch, next epoch, and next digest/i);
    expect(() =>
      validateCapabilityWalPayload(
        {
          ...legacy,
          expected_health_pointer_epoch: 0,
          next_health_pointer_epoch: 1,
          next_health_pointer_digest: runtimeDigest("nullability-mismatch"),
        },
        expectedOperationId,
      ),
    ).toThrow(/prior epoch\/digest nullability differs/i);
    expect(() =>
      validateCapabilityWalPayload(
        {
          ...legacy,
          expected_health_pointer_digest: runtimeDigest("prior-pointer"),
          expected_health_pointer_epoch: 3,
          next_health_pointer_epoch: 5,
          next_health_pointer_digest: runtimeDigest("non-monotonic-pointer"),
        },
        expectedOperationId,
      ),
    ).toThrow(/successor epoch is not monotonic/i);
  });

  test("reads a legacy prepared WAL but will not guess its post-pointer identity", () => {
    const fx = fixture();
    const graph = initialGraph(fx);
    const auth = authorization("legacy-prepared-row");
    fx.service.fault = (point) => {
      if (point === "after-health-inventory-prepared")
        throw new CapabilityRuntimeError("crash with modern prepared row", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization: auth })).toThrow(/modern prepared/);
    const operationId = fx.service.operationId(graph, auth);
    rewriteOperationWal(fx, operationId, (payload) => {
      if (payload.kind !== "health-inventory-prepared") return payload;
      const {
        expected_health_pointer_epoch: _priorEpoch,
        next_health_pointer_epoch: _nextEpoch,
        next_health_pointer_digest: _nextDigest,
        ...legacy
      } = payload;
      return legacy;
    });
    expect(() => readCapabilityWal(fx.storage.paths, operationId)).not.toThrow();
    fx.service.fault = null;

    expectIntegrityFailure(
      () => fx.service.recover(operationId),
      /lacks exact post-pointer evidence after durable recovery terminal/i,
    );
    expect(readCapabilityWal(fx.storage.paths, operationId).at(-1)?.payload).toMatchObject({
      kind: "operation-transition",
      to: "needs_recovery",
      reason_code: "publication-pointer-evidence-missing",
    });
  });
});
