import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityFabricServiceV1,
  CapabilityRuntimeError,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import { capabilityOperationPlanClosure } from "../../src/capabilities/operations/operation-closure.js";
import { CapabilityOperationJournalV1 } from "../../src/capabilities/operations/operation-journal.js";
import {
  CapabilityStorageV1,
  acquireCapabilityAuthorityLock,
  capabilityHealthCurrentPath,
  capabilityObjectPath,
  capabilityOperationPaths,
  projectCapabilityPaths,
  readCapabilityWal,
} from "../../src/capabilities/storage/index.js";
import { validateCapabilityOperation } from "../../src/capabilities/storage/operation-store.js";
import { digestHex, digestV1, inspectProcessLock } from "../../src/durability/index.js";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-operation-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  let authority = runtimeAuthority();
  const initialAuthority = authority;
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    ...testRuntimeMutationAuthorities(),
    broker,
    now: () => "2026-08-25T00:00:00.000Z",
  });
  return {
    broker,
    root,
    service,
    storage,
    get authority() {
      return authority;
    },
    changeAuthority() {
      authority = {
        ...authority,
        authority_epoch: authority.authority_epoch + 1,
        authority_head_digest: runtimeDigest("revoked-head"),
      };
    },
    changePermission() {
      authority = {
        ...authority,
        permission_digest: runtimeDigest("revoked-permission"),
      };
    },
    restoreAuthority() {
      authority = initialAuthority;
    },
  };
}

const authorization = {
  schema_version: "1.0" as const,
  proposal_id: `vf-proposal-${"1".repeat(64)}`,
  proposal_digest: runtimeDigest("proposal"),
  approval_id: `vf-approval-${"2".repeat(64)}`,
  approval_digest: runtimeDigest("approval"),
};

function alternateAuthorization(label: string) {
  return {
    schema_version: "1.0" as const,
    proposal_id: `vf-proposal-${label.repeat(64).slice(0, 64)}`,
    proposal_digest: runtimeDigest(`proposal-${label}`),
    approval_id: `vf-approval-${label.repeat(64).slice(0, 64)}`,
    approval_digest: runtimeDigest(`approval-${label}`),
  };
}

function rolePackage(
  fx: ReturnType<typeof fixture>,
  mutator?: Parameters<typeof resolvedRolePackage>[0],
) {
  const pkg = resolvedRolePackage(mutator);
  retainRuntimePackageCache(fx.storage, pkg);
  return pkg;
}

function noHealthRole(
  fx: ReturnType<typeof fixture>,
  mutator?: Parameters<typeof resolvedRolePackage>[0],
) {
  return rolePackage(fx, (manifest) => {
    manifest.health = [];
    mutator?.(manifest);
  });
}

function planningGraph(
  fx: ReturnType<typeof fixture>,
  request: Parameters<typeof runtimePlanningGraph>[0],
) {
  return runtimePlanningGraph(request, fx.broker);
}

describe("Capability Fabric operations", () => {
  test("refuses mutation before bytes or effects when source/action authority is absent", () => {
    const fx = fixture();
    const pkg = rolePackage(fx);
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    });
    const { plan } = graph;
    const operation = capabilityOperationPaths(
      fx.storage.paths,
      fx.service.operationId(graph, authorization),
    );
    for (const omitted of ["source", "action"] as const) {
      const authorities = testRuntimeMutationAuthorities();
      const service = new CapabilityFabricServiceV1({
        storage: fx.storage,
        authority: runtimeAuthorityReader(() => fx.authority),
        broker: fx.broker,
        ...(omitted === "source"
          ? { actionAuthority: authorities.actionAuthority }
          : { sourceAuthority: authorities.sourceAuthority }),
      });
      expect(() => service.execute({ graph, authorization })).toThrow(
        /authorities are unavailable/i,
      );
      expect(existsSync(operation.header)).toBeFalse();
      expect(existsSync(operation.events)).toBeFalse();
      for (const descriptor of plan.runtime_closure.descriptors)
        expect(fx.broker.inspect(descriptor.resource).content_sha256).toBeNull();
    }
  });

  test("publishes history/health/current lock only after WAL receipts and is idempotent", () => {
    const fx = fixture();
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [rolePackage(fx)],
      selected_engines: ["codex"],
    });
    const { plan } = graph;
    const result = fx.service.execute({ graph, authorization });
    const replay = fx.service.execute({ graph, authorization });
    expect(result.status).toBe("succeeded");
    expect(result.changed).toBeTrue();
    expect(replay).toEqual(result);
    expect(fx.storage.readStatus().lock?.packages[0]?.package_id).toBe("acme.reviewer");
    const events = readCapabilityWal(fx.storage.paths, result.operation_id);
    expect(events.map((event) => event.payload.kind)).toContain("adapter-step");
    expect(events.findIndex((event) => event.payload.kind === "lock-commit")).toBeGreaterThan(
      events.findIndex(
        (event) =>
          event.payload.kind === "adapter-step" && event.payload.receipt.state === "applied",
      ),
    );
    expect(events.some((event) => event.payload.kind === "lock-checkpoint")).toBeFalse();
  });

  test("revalidates authority before each effect and rolls back instead of partially publishing", () => {
    const fx = fixture();
    const pkg = rolePackage(fx, (manifest) => {
      const role = manifest.components[0];
      if (!role || role.type !== "role") throw new Error("fixture role component is missing");
      manifest.components[0] = {
        ...role,
        targets: ["codex", "opencode"],
      };
      manifest.compatibility.engines = {
        codex: ">=1.0.0 <2.0.0",
        opencode: ">=1.0.0 <2.0.0",
      };
    });
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex", "opencode"],
    });
    const { plan } = graph;
    let effects = 0;
    fx.broker.onEffect = () => {
      effects += 1;
      if (effects === 1) fx.changeAuthority();
    };
    const result = fx.service.execute({ graph, authorization });
    expect(result.status).toBe("failed");
    expect(result.reason_code).toBe("authority-head-stale");
    expect(fx.storage.readStatus().state).toBe("absent");
    expect(fx.broker.resources()).toEqual([]);
  });

  test("revalidates the exact permission authority before the first effect", () => {
    const fx = fixture();
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [noHealthRole(fx)],
      selected_engines: ["codex"],
    });
    let effects = 0;
    fx.broker.onEffect = () => {
      effects += 1;
    };
    fx.service.fault = (point) => {
      if (point === "after-header") throw new CapabilityRuntimeError("header crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/header crash/);
    fx.service.fault = null;
    fx.changePermission();
    const result = fx.service.recover(fx.service.operationId(graph, authorization));
    expect(result.status).toBe("failed");
    expect(result.reason_code).toBe("permission-stale");
    expect(effects).toBe(0);
  });

  test("binds a refusal to the exact authority snapshot checked under the writer lock", () => {
    const fx = fixture();
    const approved = fx.authority;
    const checked = {
      ...approved,
      authority_epoch: approved.authority_epoch + 1,
      authority_head_digest: runtimeDigest("checked-authority-b"),
    };
    const later = {
      ...approved,
      authority_epoch: approved.authority_epoch + 2,
      authority_head_digest: runtimeDigest("later-authority-c"),
    };
    let criticalSections = 0;
    let afterDecision = false;
    const authority = {
      read: () => (afterDecision ? later : approved),
      readPermissionAuthority: () => approved.permission_digest,
      criticalSection: <T>(
        _scope: "project" | "user",
        _operation: string,
        now: () => string,
        callback: (value: typeof approved, checkedAt: string) => T,
      ): T => {
        criticalSections += 1;
        const checkedAt = now();
        const result = callback(criticalSections === 1 ? approved : checked, checkedAt);
        if (criticalSections === 2) afterDecision = true;
        return result;
      },
    };
    const service = new CapabilityFabricServiceV1({
      storage: fx.storage,
      authority,
      ...testRuntimeMutationAuthorities(),
      broker: fx.broker,
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const graph = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: approved.scope_identity_digest,
        authority: approved,
        base_lock: null,
        desired_packages: [noHealthRole(fx)],
        selected_engines: ["codex"],
      },
      fx.broker,
    );
    const result = service.execute({ graph, authorization });
    expect(result.status).toBe("failed");
    expect(afterDecision).toBeTrue();
    const refusal = readCapabilityWal(fx.storage.paths, result.operation_id).find(
      (event) => event.payload.kind === "pre-effect-refusal",
    )?.payload;
    if (refusal?.kind !== "pre-effect-refusal") throw new Error("refusal fixture missing");
    const pair = (value: typeof approved) =>
      digestV1("VF-CAPABILITY-PRE-EFFECT-AUTHORITY\0v1\0", {
        schema_version: "1.0",
        authority_epoch: value.authority_epoch,
        authority_head_digest: value.authority_head_digest,
      });
    expect(refusal.refusal.observed_digest).toBe(pair(checked));
    expect(refusal.refusal.observed_digest).not.toBe(pair(later));
    expect(fx.broker.resources()).toEqual([]);
  });

  test("preserves the approved adapter-plan order in the operation header", () => {
    const fx = fixture();
    const pkg = noHealthRole(fx, (manifest) => {
      const role = manifest.components[0];
      if (!role || role.type !== "role") throw new Error("fixture role component is missing");
      role.targets = ["codex", "opencode"];
      manifest.compatibility.engines = {
        codex: ">=1.0.0 <2.0.0",
        opencode: ">=1.0.0 <2.0.0",
      };
    });
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex", "opencode"],
    });
    const reordered = structuredClone(graph);
    reordered.plan.adapter_plans.reverse();
    const approved = reordered.plan.adapter_plans.map((plan) => plan.plan_id);
    expect(capabilityOperationPlanClosure(reordered).plan_ids).toEqual(approved);
    expect(approved).not.toEqual([...approved].sort());
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const header = journal.createHeader(
      fx.service.operationId(graph, authorization),
      reordered,
      authorization,
    );
    expect(() => validateCapabilityOperation(header)).not.toThrow();
  });

  test("restart recovery classifies a third state as needs-recovery without guessing", () => {
    const fx = fixture();
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [rolePackage(fx)],
      selected_engines: ["codex"],
    });
    const { plan } = graph;
    fx.service.fault = (point) => {
      if (point === "after-effect-before-receipt")
        throw new CapabilityRuntimeError("crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/fault/);
    const operation = fx.service.readOperation({
      operation_id: fx.service.operationId(graph, authorization),
    });
    const key = plan.adapter_plans[0]?.steps[0]?.owned_resources[0]?.ownership_key;
    expect(key).toBeString();
    fx.broker.force(key as string, runtimeDigest("third-state"));
    const recovered = fx.service.recover(operation.operation_id);
    expect(recovered.status).toBe("needs-recovery");
    expect(fx.storage.readStatus().state).toBe("absent");
  });

  test("repairs rollback-phase uncertainty with the approved rollback descriptor", () => {
    const fx = fixture();
    const pkg = noHealthRole(fx, (manifest) => {
      const role = manifest.components[0];
      if (!role || role.type !== "role") throw new Error("fixture role component is missing");
      role.targets = ["codex", "opencode"];
      manifest.compatibility.engines = {
        codex: ">=1.0.0 <2.0.0",
        opencode: ">=1.0.0 <2.0.0",
      };
    });
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex", "opencode"],
    });
    const originalRollback = fx.broker.rollback.bind(fx.broker);
    const originalReconcile = fx.broker.reconcile.bind(fx.broker);
    let firstRollback = true;
    fx.broker.rollback = (descriptor, payload) => {
      if (firstRollback) {
        firstRollback = false;
        throw new Error("simulated rollback crash");
      }
      return originalRollback(descriptor, payload);
    };
    const recoveryDescriptors: string[] = [];
    fx.broker.reconcile = (descriptor, payload, direction) => {
      recoveryDescriptors.push(`${descriptor.descriptor_kind}:${direction}`);
      return originalReconcile(descriptor, payload, direction);
    };
    let effects = 0;
    fx.broker.onEffect = () => {
      effects += 1;
      if (effects === 1) fx.changeAuthority();
    };
    const needsRecovery = fx.service.execute({ graph, authorization });
    expect(needsRecovery.status).toBe("needs-recovery");
    fx.restoreAuthority();
    const repaired = fx.service.recover(needsRecovery.operation_id);
    expect(repaired.status).toBe("failed");
    expect(recoveryDescriptors).toEqual(["rollback:rollback"]);
    expect(fx.broker.resources()).toEqual([]);
    expect(
      readCapabilityWal(fx.storage.paths, needsRecovery.operation_id)
        .filter((event) => event.payload.kind === "adapter-step")
        .map((event) =>
          event.payload.kind === "adapter-step" ? event.payload.receipt.state : "unreachable",
        ),
    ).toEqual([
      "prepared",
      "effect_in_progress",
      "applied",
      "reverse_in_progress",
      "uncertain",
      "reversed",
    ]);
  });

  test("recovers one prepared receipt with exactly one effect and no duplicate receipt", () => {
    const fx = fixture();
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [noHealthRole(fx)],
      selected_engines: ["codex"],
    });
    let effects = 0;
    fx.broker.onEffect = () => {
      effects += 1;
    };
    fx.service.fault = (point) => {
      if (point === "after-prepared") throw new CapabilityRuntimeError("prepared crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/prepared crash/);
    const operationId = fx.service.operationId(graph, authorization);
    fx.service.fault = null;
    expect(fx.service.recover(operationId).status).toBe("succeeded");
    const states = readCapabilityWal(fx.storage.paths, operationId)
      .filter((event) => event.payload.kind === "adapter-step")
      .map((event) =>
        event.payload.kind === "adapter-step" ? event.payload.receipt.state : "unreachable",
      );
    expect(states).toEqual(["prepared", "effect_in_progress", "applied"]);
    expect(effects).toBe(1);
  });

  test("fails safely when authority is revoked after a durable prepared receipt", () => {
    const fx = fixture();
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [noHealthRole(fx)],
      selected_engines: ["codex"],
    });
    let effects = 0;
    fx.broker.onEffect = () => {
      effects += 1;
    };
    fx.service.fault = (point) => {
      if (point === "after-prepared") throw new CapabilityRuntimeError("prepared crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/prepared crash/);
    const operationId = fx.service.operationId(graph, authorization);
    fx.service.fault = null;
    fx.changeAuthority();
    const result = fx.service.recover(operationId);
    expect(result.status).toBe("failed");
    expect(result.reason_code).toBe("authority-head-stale");
    expect(effects).toBe(0);
    expect(fx.service.recover(operationId)).toEqual(result);
    const events = readCapabilityWal(fx.storage.paths, operationId);
    expect(
      events
        .filter((event) => event.payload.kind === "adapter-step")
        .map((event) =>
          event.payload.kind === "adapter-step" ? event.payload.receipt.state : "unreachable",
        ),
    ).toEqual(["prepared"]);
    expect(events.filter((event) => event.payload.kind === "pre-effect-refusal")).toHaveLength(1);
  });

  test("rolls back prior applied effects when a later prepared frontier is revoked", () => {
    const fx = fixture();
    const pkg = noHealthRole(fx, (manifest) => {
      const role = manifest.components[0];
      if (!role || role.type !== "role") throw new Error("role fixture missing");
      role.targets = ["codex", "opencode"];
      manifest.compatibility.engines = {
        codex: ">=1.0.0 <2.0.0",
        opencode: ">=1.0.0 <2.0.0",
      };
    });
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex", "opencode"],
    });
    let prepared = 0;
    fx.service.fault = (point) => {
      if (point === "after-prepared" && ++prepared === 2)
        throw new CapabilityRuntimeError("second prepared crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/second prepared crash/);
    const operationId = fx.service.operationId(graph, authorization);
    expect(fx.broker.resources()).toHaveLength(1);
    fx.service.fault = null;
    fx.changeAuthority();
    const result = fx.service.recover(operationId);
    expect(result.status).toBe("failed");
    expect(result.reason_code).toBe("authority-head-stale");
    expect(fx.broker.resources()).toEqual([]);
    expect(fx.service.recover(operationId)).toEqual(result);
    expect(
      readCapabilityWal(fx.storage.paths, operationId)
        .filter((event) => event.payload.kind === "adapter-step")
        .map((event) =>
          event.payload.kind === "adapter-step" ? event.payload.receipt.state : "unreachable",
        ),
    ).toEqual([
      "prepared",
      "effect_in_progress",
      "applied",
      "prepared",
      "reverse_in_progress",
      "reversed",
    ]);
  });

  test("serializes revocation-first and effect-first outcomes on the authority writer lock", () => {
    const build = () => {
      const fx = fixture();
      let current = fx.authority;
      const reader = {
        read: () => current,
        readPermissionAuthority: () => current.permission_digest,
        criticalSection: <T>(
          _scope: "project" | "user",
          operation: string,
          now: () => string,
          callback: (authority: typeof current, checkedAt: string) => T,
        ): T => {
          const lock = acquireCapabilityAuthorityLock(fx.storage.paths, operation);
          try {
            const checkedAt = now();
            return callback(current, checkedAt);
          } finally {
            lock.release();
          }
        },
      };
      const service = new CapabilityFabricServiceV1({
        storage: fx.storage,
        authority: reader,
        ...testRuntimeMutationAuthorities(),
        broker: fx.broker,
        now: () => "2026-08-25T00:00:00.000Z",
      });
      const graph = runtimePlanningGraph(
        {
          schema_version: "1.0",
          intent: { kind: "install" },
          scope: "project",
          scope_identity_digest: current.scope_identity_digest,
          authority: current,
          base_lock: null,
          desired_packages: [noHealthRole(fx)],
          selected_engines: ["codex"],
        },
        fx.broker,
      );
      return {
        fx,
        graph,
        service,
        revoke: () => {
          current = {
            ...current,
            authority_epoch: current.authority_epoch + 1,
            authority_head_digest: runtimeDigest("serialized-revocation"),
          };
        },
      };
    };

    const revoked = build();
    let revokedEffects = 0;
    revoked.fx.broker.onEffect = () => {
      revokedEffects += 1;
    };
    revoked.service.fault = (point) => {
      if (point === "after-header") throw new CapabilityRuntimeError("header crash", "fault");
    };
    expect(() => revoked.service.execute({ graph: revoked.graph, authorization })).toThrow(
      /header crash/,
    );
    revoked.service.fault = null;
    const revokedOperationId = revoked.service.operationId(revoked.graph, authorization);
    const revocationLock = acquireCapabilityAuthorityLock(
      revoked.fx.storage.paths,
      "test-revocation-first",
    );
    revoked.revoke();
    revocationLock.release();
    expect(revoked.service.recover(revokedOperationId).status).toBe("failed");
    expect(revokedEffects).toBe(0);

    const effected = build();
    const operationId = effected.service.operationId(effected.graph, authorization);
    effected.fx.broker.onEffect = () => {
      expect(
        inspectProcessLock(effected.fx.storage.paths.authorityWriterLock)?.operation,
      ).toContain("capability-effect");
      const states = readCapabilityWal(effected.fx.storage.paths, operationId)
        .filter((event) => event.payload.kind === "adapter-step")
        .map((event) =>
          event.payload.kind === "adapter-step" ? event.payload.receipt.state : "unreachable",
        );
      expect(states.at(-1)).toBe("effect_in_progress");
    };
    expect(effected.service.execute({ graph: effected.graph, authorization }).status).toBe(
      "succeeded",
    );
    const afterEffectLock = acquireCapabilityAuthorityLock(
      effected.fx.storage.paths,
      "test-revocation-after-effect",
    );
    const terminalStates = readCapabilityWal(effected.fx.storage.paths, operationId)
      .filter((event) => event.payload.kind === "adapter-step")
      .map((event) =>
        event.payload.kind === "adapter-step" ? event.payload.receipt.state : "unreachable",
      );
    expect(terminalStates.at(-1)).toBe("applied");
    afterEffectLock.release();
  });

  test("resumes every selected health observation prefix without re-probing", () => {
    for (const frontier of ["after-health-observation", "after-health-row"] as const) {
      for (const rowOrdinal of frontier === "after-health-row" ? [1, 2] : [0]) {
        const fx = fixture();
        const pkg = rolePackage(fx, (manifest) => {
          const role = manifest.components[0];
          if (!role || role.type !== "role") throw new Error("role fixture missing");
          role.targets = ["codex", "opencode"];
          manifest.compatibility.engines = {
            codex: ">=1.0.0 <2.0.0",
            opencode: ">=1.0.0 <2.0.0",
          };
          manifest.health = [
            {
              probe_id: "role-parse",
              component_ids: ["reviewer"],
              kind: "role-parse",
              required: true,
              timeout_ms: 1_000,
              retries: 0,
            },
          ];
        });
        const graph = planningGraph(fx, {
          schema_version: "1.0",
          intent: { kind: "install" },
          scope: "project",
          scope_identity_digest: fx.authority.scope_identity_digest,
          authority: fx.authority,
          base_lock: null,
          desired_packages: [pkg],
          selected_engines: ["codex", "opencode"],
        });
        const { plan } = graph;
        let probes = 0;
        let rows = 0;
        fx.broker.onHealth = () => {
          probes += 1;
        };
        fx.service.fault = (point) => {
          if (point !== frontier) return;
          if (frontier === "after-health-row" && ++rows !== rowOrdinal) return;
          throw new CapabilityRuntimeError(`crash ${frontier}-${rowOrdinal}`, "fault");
        };
        expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
        const beforeRecovery = probes;
        fx.service.fault = null;
        const operationId = fx.service.operationId(graph, authorization);
        expect(fx.service.recover(operationId).status).toBe("succeeded");
        const expectedAdditionalProbes =
          frontier === "after-health-observation" ? 2 : rowOrdinal === 1 ? 1 : 0;
        expect(probes).toBe(beforeRecovery + expectedAdditionalProbes);
        const health = readCapabilityWal(fx.storage.paths, operationId).filter(
          (event) => event.payload.kind === "health",
        );
        expect(health).toHaveLength(2);
        expect(
          new Set(
            health.map((event) =>
              event.payload.kind === "health" ? event.payload.observation_digest : "",
            ),
          ).size,
        ).toBe(2);
      }
    }
  });

  test("recovers each lock-publication crash frontier without creating another generation", () => {
    for (const frontier of [
      "after-health-inventory-prepared",
      "after-lock-publish",
      "after-lock-commit",
    ] as const) {
      const fx = fixture();
      const graph = planningGraph(fx, {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [rolePackage(fx)],
        selected_engines: ["codex"],
      });
      const { plan } = graph;
      fx.service.fault = (point) => {
        if (point === frontier) throw new CapabilityRuntimeError(`crash ${frontier}`, "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/fault/);
      fx.service.fault = null;
      const operationId = fx.service.operationId(graph, authorization);
      const recovered = fx.service.recover(operationId);
      expect(recovered.status).toBe("succeeded");
      expect(recovered.generation_id).toBe(fx.storage.readStatus().lock?.generation_id ?? null);
      expect(fx.storage.readStatus().lock?.generation_ordinal).toBe(0);
      const commits = readCapabilityWal(fx.storage.paths, operationId).filter(
        (event) => event.payload.kind === "lock-commit",
      );
      expect(commits).toHaveLength(1);
    }
  });

  test("replacement retains exactly one immutable prior-lock checkpoint", () => {
    for (const mode of ["recover", "missing-object"] as const) {
      const fx = fixture();
      const installed = noHealthRole(fx);
      const firstGraph = planningGraph(fx, {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [installed],
        selected_engines: ["codex"],
      });
      const first = firstGraph.plan;
      fx.service.execute({ graph: firstGraph, authorization });
      const replacement = noHealthRole(fx, (manifest) => {
        const role = manifest.components[0];
        if (!role || role.type !== "role") throw new Error("role fixture missing");
        role.targets = ["opencode"];
        manifest.compatibility.engines = { opencode: ">=1.0.0 <2.0.0" };
      });
      const graph = planningGraph(fx, {
        schema_version: "1.0",
        intent: { kind: "retarget", package_id: replacement.pin.id },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: fx.storage.readStatus().lock,
        desired_packages: [replacement],
        selected_engines: ["opencode"],
        current_permissions: first.permission_binding,
      });
      const { plan } = graph;
      const nextAuthorization = alternateAuthorization(mode === "recover" ? "7" : "8");
      fx.service.fault = (point) => {
        if (point === "after-lock-checkpoint")
          throw new CapabilityRuntimeError(`crash checkpoint ${mode}`, "fault");
      };
      expect(() => fx.service.execute({ graph, authorization: nextAuthorization })).toThrow(
        /checkpoint/,
      );
      const operationId = fx.service.operationId(graph, nextAuthorization);
      const checkpoints = readCapabilityWal(fx.storage.paths, operationId).filter(
        (event) => event.payload.kind === "lock-checkpoint",
      );
      expect(checkpoints).toHaveLength(1);
      const payload = checkpoints[0]?.payload;
      if (payload?.kind !== "lock-checkpoint") throw new Error("checkpoint frame missing");
      const path = join(
        fx.storage.paths.privateRoot,
        "recovery",
        "v1",
        "lock-checkpoints",
        `${digestHex(payload.prior_lock_digest)}.json`,
      );
      if (mode === "missing-object") {
        rmSync(path);
        expect(() => fx.service.readOperation({ operation_id: operationId })).toThrow(
          /checkpoint.*absent|checkpoint.*inconsistent/i,
        );
      } else {
        fx.service.fault = null;
        expect(fx.service.recover(operationId).status).toBe("succeeded");
        expect(
          readCapabilityWal(fx.storage.paths, operationId).filter(
            (event) => event.payload.kind === "lock-checkpoint",
          ),
        ).toHaveLength(1);
      }
    }
  });

  test("records a canonical target refusal when authority changes before lock publication", () => {
    const fx = fixture();
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [rolePackage(fx)],
      selected_engines: ["codex"],
    });
    const { plan } = graph;
    fx.service.fault = (point) => {
      if (point === "after-health-inventory-prepared") fx.changeAuthority();
    };
    const result = fx.service.execute({ graph, authorization });
    expect(result.status).toBe("failed");
    expect(result.reason_code).toBe("authority-head-stale");
    expect(fx.storage.readStatus().state).toBe("absent");
    const refusal = readCapabilityWal(fx.storage.paths, result.operation_id).find(
      (event) => event.payload.kind === "pre-effect-refusal",
    );
    expect(refusal?.payload.kind).toBe("pre-effect-refusal");
    if (refusal?.payload.kind !== "pre-effect-refusal") throw new Error("missing refusal");
    expect(refusal.payload.refusal.frontier_kind).toBe("lock-publication");
    expect(refusal.payload.refusal.target_ids).toEqual(
      plan.target_dispositions
        .filter((row) => row.execution === "host")
        .map((row) => row.target_id),
    );
    expect(refusal.payload.refusal.target_ids.length).toBeGreaterThan(0);
  });

  test("a retained publication refusal permanently forbids publication after restart", () => {
    const fx = fixture();
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [rolePackage(fx)],
      selected_engines: ["codex"],
    });
    const { plan } = graph;
    fx.service.fault = (point) => {
      if (point === "after-health-inventory-prepared") fx.changeAuthority();
      if (point === "after-refusal")
        throw new CapabilityRuntimeError("crash after retained refusal", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/retained refusal/);
    fx.restoreAuthority();
    fx.service.fault = null;
    const operationId = fx.service.operationId(graph, authorization);
    const recovered = fx.service.recover(operationId);
    expect(recovered.status).toBe("failed");
    expect(recovered.reason_code).toBe("authority-head-stale");
    expect(fx.storage.readStatus().lock).toBeNull();
    expect(
      readCapabilityWal(fx.storage.paths, operationId).filter(
        (event) => event.payload.kind === "pre-effect-refusal",
      ),
    ).toHaveLength(1);
  });

  test("refusal recovery requires its exact retained observation object", () => {
    for (const frontier of ["after-refusal-observation", "after-refusal"] as const) {
      const fx = fixture();
      const graph = planningGraph(fx, {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [rolePackage(fx)],
        selected_engines: ["codex"],
      });
      const { plan } = graph;
      fx.service.fault = (point) => {
        if (point === "after-health-inventory-prepared") fx.changeAuthority();
        if (point === frontier) throw new CapabilityRuntimeError(`crash ${frontier}`, "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
      const operationId = fx.service.operationId(graph, authorization);
      const before = readCapabilityWal(fx.storage.paths, operationId);
      const refusal = before.find((event) => event.payload.kind === "pre-effect-refusal");
      if (frontier === "after-refusal-observation") {
        expect(refusal).toBeUndefined();
        fx.service.fault = null;
        expect(fx.service.recover(operationId).status).toBe("failed");
        expect(
          readCapabilityWal(fx.storage.paths, operationId).filter(
            (event) => event.payload.kind === "pre-effect-refusal",
          ),
        ).toHaveLength(1);
      } else {
        if (refusal?.payload.kind !== "pre-effect-refusal")
          throw new Error("retained refusal frame missing");
        rmSync(capabilityObjectPath(fx.storage.paths, refusal.payload.refusal.observation_digest));
        expect(() => fx.service.readOperation({ operation_id: operationId })).toThrow(
          /pre-effect observation is missing/i,
        );
      }
    }
  });

  test("never refuses after the lock is durable and recovery finishes its pointer", () => {
    for (const frontier of ["after-lock-publish", "after-lock-commit"] as const) {
      const fx = fixture();
      const graph = planningGraph(fx, {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [rolePackage(fx)],
        selected_engines: ["codex"],
      });
      const { plan } = graph;
      fx.service.fault = (point) => {
        if (point !== frontier) return;
        fx.changeAuthority();
        throw new CapabilityRuntimeError(`crash ${frontier}`, "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/fault/);
      fx.service.fault = null;
      const operationId = fx.service.operationId(graph, authorization);
      const recovered = fx.service.recover(operationId);
      expect(recovered.status).toBe("succeeded");
      expect(fx.storage.readStatus().lock?.content_digest).toBeString();
      expect(
        readCapabilityWal(fx.storage.paths, operationId).filter(
          (event) => event.payload.kind === "pre-effect-refusal",
        ),
      ).toHaveLength(0);
    }
  });

  test("proved no-op remains inspection-only and revalidates authority under the scope lock", () => {
    const fx = fixture();
    const pkg = noHealthRole(fx);
    const installedGraph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    });
    const installed = installedGraph.plan;
    fx.service.execute({ graph: installedGraph, authorization });
    const noOpGraph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "configure", package_id: pkg.pin.id },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: fx.storage.readStatus().lock,
      desired_packages: [pkg],
      selected_engines: ["codex"],
      current_permissions: installed.permission_binding,
    });
    const noOp = noOpGraph.plan;
    expect(noOp.status).toBe("no-op");
    fx.changeAuthority();
    expect(() =>
      fx.service.execute({ graph: noOpGraph, authorization: alternateAuthorization("3") }),
    ).toThrow(/authority changed/i);
    expect(fx.storage.readStatus().lock?.generation_ordinal).toBe(0);
  });

  test("proved no-op revalidates its base and never creates an inert operation", () => {
    const fx = fixture();
    const pkg = noHealthRole(fx);
    const firstGraph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    });
    const first = firstGraph.plan;
    fx.service.execute({ graph: firstGraph, authorization });
    const base = fx.storage.readStatus().lock;
    const noOpGraph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "configure", package_id: pkg.pin.id },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: base,
      desired_packages: [pkg],
      selected_engines: ["codex"],
      current_permissions: first.permission_binding,
    });
    const noOp = noOpGraph.plan;
    expect(noOp.status).toBe("no-op");
    const replacement = noHealthRole(fx, (manifest) => {
      const role = manifest.components[0];
      if (!role || role.type !== "role") throw new Error("role fixture missing");
      role.targets = ["opencode"];
      manifest.compatibility.engines = { opencode: ">=1.0.0 <2.0.0" };
    });
    const updateGraph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "update", package_id: pkg.pin.id },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: base,
      desired_packages: [replacement],
      selected_engines: ["opencode"],
      current_permissions: first.permission_binding,
    });
    const update = updateGraph.plan;
    expect(update.status).toBe("planned");
    fx.service.execute({ graph: updateGraph, authorization: alternateAuthorization("4") });
    expect(() =>
      fx.service.execute({ graph: noOpGraph, authorization: alternateAuthorization("5") }),
    ).toThrow(/base generation changed/i);
    expect(fx.storage.readStatus().lock?.generation_ordinal).toBe(1);
  });

  test("effect-free authority drift is planned publication, not a proved no-op", () => {
    const fx = fixture();
    const pkg = noHealthRole(fx);
    const firstGraph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    });
    const first = firstGraph.plan;
    fx.service.execute({ graph: firstGraph, authorization });
    const driftedAuthority = {
      ...fx.authority,
      policy_digest: runtimeDigest("next-policy"),
    };
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "configure", package_id: pkg.pin.id },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: driftedAuthority,
      base_lock: fx.storage.readStatus().lock,
      desired_packages: [pkg],
      selected_engines: ["codex"],
      current_permissions: first.permission_binding,
    });
    const { plan } = graph;
    expect(plan.adapter_plans.every((adapterPlan) => adapterPlan.steps.length === 0)).toBeTrue();
    expect(plan.status).toBe("planned");
  });

  test("replacement requires the exact selected base health pointer", () => {
    const fx = fixture();
    const pkg = noHealthRole(fx);
    const firstGraph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    });
    const first = firstGraph.plan;
    fx.service.execute({ graph: firstGraph, authorization });
    const replacement = noHealthRole(fx, (manifest) => {
      const role = manifest.components[0];
      if (!role || role.type !== "role") throw new Error("role fixture missing");
      role.targets = ["opencode"];
      manifest.compatibility.engines = { opencode: ">=1.0.0 <2.0.0" };
    });
    const graph = planningGraph(fx, {
      schema_version: "1.0",
      intent: { kind: "retarget", package_id: replacement.pin.id },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: fx.storage.readStatus().lock,
      desired_packages: [replacement],
      selected_engines: ["opencode"],
      current_permissions: first.permission_binding,
    });
    const { plan } = graph;
    rmSync(capabilityHealthCurrentPath(fx.storage.paths));
    expect(() => fx.service.execute({ graph, authorization: alternateAuthorization("6") })).toThrow(
      /base lock has no selected health inventory/i,
    );
    const operationId = fx.service.operationId(graph, alternateAuthorization("6"));
    expect(existsSync(capabilityOperationPaths(fx.storage.paths, operationId).events)).toBeFalse();
  });
});
