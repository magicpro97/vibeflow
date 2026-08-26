import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityFabricServiceV1,
  CapabilityRuntimeError,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import { requireCapabilityActionAuthority } from "../../src/capabilities/operations/action-authority.js";
import { capabilityRecoveryFrontier } from "../../src/capabilities/operations/authority-frontier.js";
import { reconcileCrashPartialEffect } from "../../src/capabilities/operations/crash-reconciliation.js";
import { readOperationBaseLock } from "../../src/capabilities/operations/fold.js";
import {
  ensureCapabilityLockCheckpoint,
  validateCapabilityLockCheckpoint,
} from "../../src/capabilities/operations/lock-checkpoint.js";
import {
  assertCapabilityAuthorizationPlanRoot,
  assertCapabilityExecutionAuthorization,
  assertCapabilityOperationHeaderClosure,
  capabilityOperationIdForAuthorization,
  capabilityOperationPlanClosure,
} from "../../src/capabilities/operations/operation-closure.js";
import { CapabilityOperationJournalV1 } from "../../src/capabilities/operations/operation-journal.js";
import { assertNoOpInspectionOnly } from "../../src/capabilities/operations/operation-preflight.js";
import { recoverCapabilityPublication } from "../../src/capabilities/operations/publication-recovery.js";
import {
  adapterReceiptDigest,
  createReceipt,
  operationIdDigest,
} from "../../src/capabilities/operations/receipts.js";
import { foldCapabilityTarget } from "../../src/capabilities/operations/target-fold.js";
import {
  capabilityHostTargetIds,
  capabilityRuntimeAuthorityMismatch,
} from "../../src/capabilities/operations/validation.js";
import { projectCapabilityDetail } from "../../src/capabilities/query/detail.js";
import {
  CapabilityStorageV1,
  capabilityHealthCurrentPath,
  capabilityHealthInventoryPath,
  capabilityHistoryPath,
  capabilityLockDigest,
  capabilityLockEntryDigest,
  capabilityWalEventDigest,
  foldCapabilityWal,
  materializeCapabilityLock,
  portableInputDigest,
  projectCapabilityPaths,
  readCapabilityWal,
  validateCapabilityLock,
  validateCapabilityOperation,
  validateCapabilityWalEvent,
  validateCapabilityWalPayload,
  writeCapabilityOperationHeader,
} from "../../src/capabilities/storage/index.js";
import {
  compareAndSwapPortableBytes,
  readPortableBytes,
} from "../../src/capabilities/storage/portable-cas.js";
import { bindProjectIdentityPortableCas } from "../../src/capabilities/storage/scope-lock.js";
import { validateAdapterReceipt } from "../../src/capabilities/storage/wal-record-validation.js";
import type { CapabilityLockV1 } from "../../src/capabilities/wire/lock.js";
import type {
  AdapterReceiptV1,
  CapabilityWalEventV1,
  CapabilityWalPayloadV1,
} from "../../src/capabilities/wire/operation.js";
import type { CapabilityQueryItemV1 } from "../../src/capabilities/wire/query.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
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

const authorization = {
  schema_version: "1.0" as const,
  proposal_id: `vf-proposal-${"6".repeat(64)}`,
  proposal_digest: runtimeDigest("runtime-coverage-proposal"),
  approval_id: `vf-approval-${"7".repeat(64)}`,
  approval_digest: runtimeDigest("runtime-coverage-approval"),
};

function fixture(manifestMutator?: Parameters<typeof resolvedRolePackage>[0]) {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-runtime-coverage-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const pkg = resolvedRolePackage(manifestMutator);
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
    now: () => "2026-08-25T00:00:00.000Z",
  });
  return { authority, broker, graph, pkg, root, service, storage };
}

function installedLock() {
  const fx = fixture();
  expect(fx.service.execute({ graph: fx.graph, authorization }).status).toBe("succeeded");
  const lock = fx.storage.readStatus().lock;
  if (!lock) throw new Error("installed lock fixture is absent");
  return { ...fx, lock };
}

function resealLock(lock: CapabilityLockV1): CapabilityLockV1 {
  for (const entry of lock.packages) {
    entry.portable_input_digest = portableInputDigest(entry);
    entry.lock_entry_digest = capabilityLockEntryDigest(entry);
  }
  const probe = { ...structuredClone(lock), generation_id: "", content_digest: "" };
  const content_digest = capabilityLockDigest(probe);
  return {
    ...lock,
    generation_id: `vf-generation-${content_digest.slice(7)}`,
    content_digest,
  };
}

function queryItem(
  fx: ReturnType<typeof fixture>,
  overrides: Partial<CapabilityQueryItemV1> = {},
): CapabilityQueryItemV1 {
  return {
    package_id: fx.pkg.pin.id,
    discovery_entry_digest: runtimeDigest("detail-entry"),
    display_name: fx.pkg.manifest.metadata.display_name,
    summary: fx.pkg.manifest.metadata.summary,
    version: fx.pkg.pin.version,
    package_pin_digest: fx.pkg.pin.pin_digest,
    content_sha256: fx.pkg.pin.content_sha256,
    scope: "project",
    status: "absent",
    source_kind: fx.pkg.pin.source.kind,
    source_trust: fx.pkg.pin.trust,
    scan_status: "passed",
    cache_status: "available",
    generation_id: null,
    targets: [],
    recovery_actions: [],
    ...overrides,
  };
}

function receiptEvent(receipt: AdapterReceiptV1, sequence = 0): CapabilityWalEventV1 {
  return { sequence, payload: { kind: "adapter-step", receipt } } as CapabilityWalEventV1;
}

function healthEvent(input: {
  planId: string;
  targetId: string;
  probeId: string;
  outcome: "ready" | "degraded" | "failed" | "unknown" | "stale";
  checkedAt?: string;
  expiresAt: string;
  evidence?: string;
  sequence?: number;
}): CapabilityWalEventV1 {
  return {
    sequence: input.sequence ?? 0,
    payload: {
      kind: "health",
      plan_id: input.planId,
      observation_digest: runtimeDigest(`observation-${input.sequence ?? 0}`),
      target_id: input.targetId,
      probe_id: input.probeId,
      outcome: input.outcome,
      checked_at: input.checkedAt ?? "2026-08-25T00:00:00.000Z",
      expires_at: input.expiresAt,
      evidence_digest: input.evidence ?? runtimeDigest(`health-${input.outcome}`),
    },
  } as CapabilityWalEventV1;
}

function walChain(
  payloads: CapabilityWalPayloadV1[],
  timestamps: string[] = [],
): CapabilityWalEventV1[] {
  const operationId = `vf-operation-${"d".repeat(64)}`;
  const events: CapabilityWalEventV1[] = [];
  for (const [sequence, payload] of payloads.entries()) {
    const draft = {
      schema_version: "1.0" as const,
      operation_id: operationId,
      sequence,
      previous_event_digest: events.at(-1)?.event_digest ?? null,
      payload,
      recorded_at: timestamps[sequence] ?? `2026-08-25T00:00:0${sequence}.000Z`,
      event_digest: "",
    };
    events.push({ ...draft, event_digest: capabilityWalEventDigest(draft) });
  }
  return events;
}

const walStart: CapabilityWalPayloadV1 = {
  kind: "operation-transition",
  from: "created",
  to: "committing",
  reason_code: null,
};

function walRefusal(
  frontier: "operation" | "adapter-step" = "operation",
  planId: string | null = null,
  stepId: string | null = null,
): CapabilityWalPayloadV1 {
  return {
    kind: "pre-effect-refusal",
    refusal: {
      schema_version: "1.0",
      operation_id: `vf-operation-${"d".repeat(64)}`,
      frontier_kind: frontier,
      plan_id: planId,
      step_id: stepId,
      target_ids: ["target"],
      reason_code: "scope-base-stale",
      binding_key: "scope",
      expected_digest: runtimeDigest("wal-expected"),
      observed_digest: null,
      observed_state: "absent",
      checked_at: "2026-08-25T00:00:01.000Z",
      observation_digest: runtimeDigest("wal-refusal-observation"),
    },
  };
}

describe("capability runtime, operation, and storage post-freeze coverage", () => {
  test("validates dependency and portable-input lock entry branches", () => {
    const { lock: original } = installedLock();

    const prerequisite = structuredClone(original);
    const prerequisiteEntry = prerequisite.packages[0];
    if (!prerequisiteEntry) throw new Error("lock entry fixture is absent");
    prerequisiteEntry.dependencies = [
      {
        required_scope: "user-prerequisite",
        package_id: "acme.foundation",
        version: "1.0.0",
        content_sha256: "a".repeat(64),
        required_health_plan_digest: runtimeDigest("foundation-health"),
      },
    ];
    expect(validateCapabilityLock(resealLock(prerequisite)).packages).toHaveLength(1);

    const portable = structuredClone(original);
    const portableEntry = portable.packages[0];
    if (!portableEntry) throw new Error("lock entry fixture is absent");
    portableEntry.public_inputs = [
      { input_id: "boolean", value: true },
      { input_id: "nil", value: null },
      { input_id: "number", value: 42 },
      { input_id: "text", value: "relative/value" },
    ];
    portableEntry.secret_input_ids = ["credential"];
    expect(validateCapabilityLock(resealLock(portable)).packages[0]?.public_inputs).toHaveLength(4);

    const nonFinite = structuredClone(portable);
    const numberInput = nonFinite.packages[0]?.public_inputs.find(
      (row) => row.input_id === "number",
    );
    if (!numberInput) throw new Error("number input fixture is absent");
    numberInput.value = Number.POSITIVE_INFINITY;
    expect(() => validateCapabilityLock(nonFinite)).toThrow(/finite/i);

    const nonscalar = structuredClone(original);
    const nonscalarEntry = nonscalar.packages[0];
    if (!nonscalarEntry) throw new Error("lock entry fixture is absent");
    nonscalarEntry.public_inputs = [{ input_id: "object", value: { secret: false } as never }];
    expect(() => validateCapabilityLock(nonscalar)).toThrow(/public scalar/i);
  });

  test("rejects malformed lock roots and parent histories before publication", () => {
    const { lock: original } = installedLock();
    const cases: Array<[string, (lock: CapabilityLockV1) => void, RegExp]> = [
      ["schema", (lock) => Object.assign(lock, { schema_version: "2.0" }), /schema/i],
      ["fabric", (lock) => Object.assign(lock, { fabric_active: false }), /scope|fabric/i],
      ["scope", (lock) => Object.assign(lock, { scope: "other" }), /scope|fabric/i],
      ["generation", (lock) => Object.assign(lock, { generation_id: "bad" }), /generation ID/i],
      [
        "bounds",
        (lock) => {
          lock.parent_generation_digests = Array.from({ length: 33 }, (_, index) =>
            digestV1("VF-LOCK-BOUND\0v1\0", index),
          ).sort();
        },
        /bounds/i,
      ],
      ["root ordinal", (lock) => Object.assign(lock, { generation_ordinal: 2 }), /root.*ordinal/i],
      [
        "content",
        (lock) => Object.assign(lock, { content_digest: runtimeDigest("forged") }),
        /digest/i,
      ],
    ];
    for (const [label, mutate, pattern] of cases) {
      const lock = structuredClone(original);
      mutate(lock);
      expect(() => validateCapabilityLock(lock), label).toThrow(pattern);
    }
    expect(() => validateCapabilityLock(original, { expected_scope: "user" })).toThrow(
      /scope|fabric/i,
    );
    const child = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 1,
      parent_generation_digests: [original.content_digest],
      packages: original.packages,
      policy_digest: original.policy_digest,
      permission_digest: original.permission_digest,
      created_at: "2026-08-25T00:00:01.000Z",
    });
    expect(() => validateCapabilityLock(child, { parents: [] })).toThrow(/parents/i);

    const wrongOrdinal = structuredClone(original);
    wrongOrdinal.parent_generation_digests = [original.content_digest];
    wrongOrdinal.generation_ordinal = 7;
    const resealedWrongOrdinal = resealLock(wrongOrdinal);
    expect(() => validateCapabilityLock(resealedWrongOrdinal, { parents: [original] })).toThrow(
      /ordinal/i,
    );
  });

  test("rejects malformed lock entries at each durable identity boundary", () => {
    const { lock: original } = installedLock();
    const cases: Array<[string, (lock: CapabilityLockV1) => void, RegExp]> = [
      [
        "pin identity",
        (lock) => {
          const entry = lock.packages[0];
          if (entry) entry.package_id = "acme.other";
        },
        /pin ID disagree/i,
      ],
      [
        "dependency scope",
        (lock) => {
          const entry = lock.packages[0];
          if (entry)
            entry.dependencies = [
              {
                required_scope: "invalid",
                package_id: "acme.other",
                version: "1.0.0",
                content_sha256: "b".repeat(64),
              } as never,
            ];
        },
        /dependency scope/i,
      ],
      [
        "portable digest",
        (lock) => {
          const entry = lock.packages[0];
          if (entry) entry.portable_input_digest = runtimeDigest("wrong-portable-input");
        },
        /portable input digest/i,
      ],
      [
        "target required",
        (lock) => {
          const entry = lock.packages[0];
          if (entry) entry.targets = [];
        },
        /no surviving target/i,
      ],
      [
        "target scope",
        (lock) => {
          const target = lock.packages[0]?.targets[0];
          if (target) target.scope = "user";
        },
        /target scope/i,
      ],
      [
        "ownership union",
        (lock) => {
          const entry = lock.packages[0];
          if (entry) entry.ownership_keys = [];
        },
        /ownership keys/i,
      ],
      [
        "entry digest",
        (lock) => {
          const entry = lock.packages[0];
          if (entry) entry.lock_entry_digest = runtimeDigest("wrong-entry");
        },
        /lock entry digest/i,
      ],
    ];
    for (const [label, mutate, pattern] of cases) {
      const lock = structuredClone(original);
      mutate(lock);
      expect(() => validateCapabilityLock(lock), label).toThrow(pattern);
    }

    const missingSameScope = structuredClone(original);
    const entry = missingSameScope.packages[0];
    if (!entry) throw new Error("lock entry fixture is absent");
    entry.dependencies = [
      {
        required_scope: "same",
        package_id: "acme.missing",
        version: "1.0.0",
        content_sha256: "c".repeat(64),
      },
    ];
    entry.lock_entry_digest = capabilityLockEntryDigest(entry);
    expect(() => validateCapabilityLock(missingSameScope)).toThrow(/same-scope dependency/i);
  });

  test("validates every standalone WAL payload family and rejects contradictory evidence", () => {
    const digest = runtimeDigest("wal");
    const health = {
      kind: "health" as const,
      plan_id: "plan",
      observation_digest: digest,
      target_id: "target",
      probe_id: "probe",
      outcome: "ready" as const,
      checked_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T00:01:00.000Z",
      evidence_digest: digest,
    };
    expect(() => validateCapabilityWalPayload(health)).not.toThrow();
    expect(() =>
      validateCapabilityWalPayload({
        ...health,
        expires_at: health.checked_at,
      }),
    ).toThrow(/expiry/i);

    const prepared = {
      kind: "health-inventory-prepared" as const,
      generation_id: `vf-generation-${"1".repeat(64)}`,
      lock_digest: digest,
      health_inventory_digest: digest,
      expected_health_pointer_digest: null,
    };
    expect(() => validateCapabilityWalPayload(prepared)).not.toThrow();
    expect(() =>
      validateCapabilityWalPayload({
        ...prepared,
        kind: "lock-commit",
        directory_fsync_completed: false,
      } as never),
    ).toThrow(/fsync/i);

    const checkpoint = {
      kind: "lock-checkpoint" as const,
      prior_generation_id: `vf-generation-${"2".repeat(64)}`,
      prior_lock_digest: digest,
      checkpoint_bytes_sha256: "3".repeat(64),
      checkpoint_digest: digest,
    };
    expect(() => validateCapabilityWalPayload(checkpoint)).not.toThrow();

    const outbox = {
      kind: "outbox" as const,
      outbox_event_id: `vf-outbox-${"4".repeat(64)}`,
      payload_ref: `vf-outbox-payload-${"5".repeat(64)}`,
      phase: "operation-started" as const,
      phase_sequence: 0,
      public_payload_digest: digest,
      transition: "created" as const,
      delivery: "pending" as const,
    };
    expect(() => validateCapabilityWalPayload(outbox)).not.toThrow();
    expect(() =>
      validateCapabilityWalPayload({ ...outbox, transition: "delivered", delivery: "pending" }),
    ).toThrow(/transition\/delivery/i);
    expect(() => validateCapabilityWalPayload({ ...outbox, outbox_event_id: "invalid" })).toThrow(
      /outbox event ID/i,
    );
    expect(() => validateCapabilityWalPayload({ kind: "unknown" } as never)).toThrow(
      /unknown.*kind/i,
    );
    expect(() =>
      validateCapabilityWalPayload({
        kind: "operation-transition",
        from: "committing",
        to: "failed",
        reason_code: "behavioral-failure",
      }),
    ).not.toThrow();
  });

  test("folds only dense WAL frontiers and rejects late or contradictory records", () => {
    const digest = runtimeDigest("wal-fold");
    const health: CapabilityWalPayloadV1 = {
      kind: "health",
      plan_id: "plan",
      observation_digest: digest,
      target_id: "target",
      probe_id: "probe",
      outcome: "ready",
      checked_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T00:01:00.000Z",
      evidence_digest: digest,
    };
    const checkpoint: CapabilityWalPayloadV1 = {
      kind: "lock-checkpoint",
      prior_generation_id: `vf-generation-${"1".repeat(64)}`,
      prior_lock_digest: digest,
      checkpoint_bytes_sha256: "2".repeat(64),
      checkpoint_digest: digest,
    };
    const prepared: CapabilityWalPayloadV1 = {
      kind: "health-inventory-prepared",
      generation_id: `vf-generation-${"3".repeat(64)}`,
      lock_digest: digest,
      health_inventory_digest: digest,
      expected_health_pointer_digest: null,
    };
    const commit: CapabilityWalPayloadV1 = {
      ...prepared,
      kind: "lock-commit",
      directory_fsync_completed: true,
    };
    const outbox: CapabilityWalPayloadV1 = {
      kind: "outbox",
      outbox_event_id: `vf-outbox-${"4".repeat(64)}`,
      payload_ref: `vf-outbox-payload-${"5".repeat(64)}`,
      phase: "operation-started",
      phase_sequence: 0,
      public_payload_digest: digest,
      transition: "created",
      delivery: "pending",
    };

    expect(() => foldCapabilityWal(walChain([health]))).toThrow(/sequence zero/i);
    expect(() =>
      foldCapabilityWal(
        walChain([walStart, outbox], ["2026-08-25T00:00:02.000Z", "2026-08-25T00:00:01.000Z"]),
      ),
    ).toThrow(/timestamps regress/i);
    expect(() => foldCapabilityWal(walChain([walStart, walRefusal(), walRefusal()]))).toThrow(
      /duplicate or late/i,
    );
    expect(() => foldCapabilityWal(walChain([walStart, walRefusal(), health]))).toThrow(
      /health row/i,
    );
    expect(() => foldCapabilityWal(walChain([walStart, checkpoint, checkpoint]))).toThrow(
      /checkpoint/i,
    );
    expect(() => foldCapabilityWal(walChain([walStart, prepared, prepared]))).toThrow(
      /inventory preparation/i,
    );
    expect(() => foldCapabilityWal(walChain([walStart, commit]))).toThrow(/prepared predecessor/i);
    expect(() =>
      foldCapabilityWal(
        walChain([
          walStart,
          prepared,
          { ...commit, lock_digest: runtimeDigest("different-commit-lock") },
        ]),
      ),
    ).toThrow(/differs from prepared/i);
    expect(() => foldCapabilityWal(walChain([walStart, { ...outbox, phase_sequence: 1 }]))).toThrow(
      /introduction sequence/i,
    );
    expect(() =>
      foldCapabilityWal(
        walChain([
          walStart,
          outbox,
          {
            ...outbox,
            transition: "delivered",
            delivery: "delivered",
            public_payload_digest: runtimeDigest("changed-outbox-payload"),
          },
        ]),
      ),
    ).toThrow(/delivery transition/i);
  });

  test("rejects refusal and compensation that escape the active receipt frontier", () => {
    const fx = fixture();
    const adapterPlan = structuredClone(fx.graph.plan.adapter_plans[0]);
    const first = adapterPlan?.steps[0];
    if (!adapterPlan || !first) throw new Error("WAL receipt fixture is absent");
    const second = { ...structuredClone(first), step_id: "second-step" };
    const receipt = (step: typeof first, state: AdapterReceiptV1["state"]) =>
      createReceipt({
        operation_id: `vf-operation-${"d".repeat(64)}`,
        plan: adapterPlan,
        step,
        state,
        prepared_at: fx.graph.plan.created_at,
        observed_at: "2026-08-25T00:00:01.000Z",
        evidence_digest: runtimeDigest(`wal-${step.step_id}-${state}`),
        error_code: state === "uncertain" || state === "failed" ? "failure" : null,
      });
    const row = (step: typeof first, state: AdapterReceiptV1["state"]): CapabilityWalPayloadV1 => ({
      kind: "adapter-step",
      receipt: receipt(step, state),
    });

    expect(() =>
      foldCapabilityWal(
        walChain([walStart, row(first, "prepared"), walRefusal("operation", null, null)]),
      ),
    ).toThrow(/unresolved prepared frontier/i);

    expect(() =>
      foldCapabilityWal(
        walChain([
          walStart,
          row(first, "prepared"),
          row(first, "effect_in_progress"),
          row(first, "applied"),
          row(second, "prepared"),
          row(second, "effect_in_progress"),
          row(second, "applied"),
          walRefusal(),
          row(first, "reverse_in_progress"),
        ]),
      ),
    ).toThrow(/reverse applied order/i);
  });

  test("enforces immutable operation and execution authorization closures", () => {
    const fx = fixture();
    const operationId = fx.service.operationId(fx.graph, authorization);
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const header = journal.createHeader(operationId, fx.graph, authorization);
    expect(() => assertCapabilityOperationHeaderClosure(header, fx.graph)).not.toThrow();
    expect(() => assertCapabilityExecutionAuthorization(header, authorization)).not.toThrow();
    expect(() => assertCapabilityAuthorizationPlanRoot(fx.graph.plan, authorization)).not.toThrow();

    expect(() =>
      capabilityOperationIdForAuthorization({
        ...authorization,
        operation_id: `vf-operation-${"8".repeat(64)}`,
      }),
    ).toThrow(/operation ID/i);

    expect(() =>
      assertCapabilityOperationHeaderClosure(
        { ...header, operation_id: `vf-operation-${"9".repeat(64)}` },
        fx.graph,
      ),
    ).toThrow(/derived/i);
    expect(() =>
      assertCapabilityOperationHeaderClosure(
        { ...header, created_at: "2026-08-24T23:59:59.000Z" },
        fx.graph,
      ),
    ).toThrow(/predates/i);
    expect(() =>
      assertCapabilityExecutionAuthorization(header, {
        ...authorization,
        approval_digest: runtimeDigest("different-approval"),
      }),
    ).toThrow(/authorization/i);
    expect(() =>
      assertCapabilityAuthorizationPlanRoot(fx.graph.plan, {
        ...authorization,
        action_root_locator: {
          kind: "capability",
          scope: "project",
          scope_identity_digest: runtimeDigest("different-scope"),
        },
      }),
    ).toThrow(/action root/i);
  });

  test("projects query detail errors without disclosing missing package bytes", () => {
    const fx = fixture((manifest) => {
      manifest.inputs = [
        {
          input_id: "token",
          label: "Token",
          type: "secret-handle",
          required: false,
          default_value: null,
          enum_values: [],
          min: null,
          max: null,
          pattern: null,
        },
      ];
    });
    const item = queryItem(fx);
    const request = { scope: "project" as const, package_id: fx.pkg.pin.id };
    const project = (overrides: Partial<Parameters<typeof projectCapabilityDetail>[0]> = {}) =>
      projectCapabilityDetail({
        request,
        items: [item],
        source_watermark: runtimeDigest("watermark"),
        lock: null,
        packages: { read: () => fx.pkg },
        privateInputs: undefined,
        ...overrides,
      });

    expect(project().inputs[0]?.current).toEqual({ kind: "unset" });
    expect(() => project({ items: [] })).toThrow(/not found/i);
    expect(() => project({ items: [item, structuredClone(item)] })).toThrow(/ambiguous/i);
    expect(() => project({ items: [{ ...item, package_pin_digest: null }] })).toThrow(
      /immutable identity/i,
    );
    expect(() => project({ packages: undefined })).toThrow(/reader is unavailable/i);
    expect(() => project({ packages: { read: () => null } })).toThrow(/validated cache/i);
    expect(() =>
      project({
        packages: { read: () => fx.pkg },
        items: [{ ...item, version: "9.9.9" }],
      }),
    ).toThrow(/identity closure/i);
  });

  test("reports prepared and terminal authority evidence and releases observers", () => {
    const fx = fixture();
    const operationId = fx.service.operationId(fx.graph, authorization);
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const header = journal.createHeader(operationId, fx.graph, authorization);
    const held = fx.storage.acquire("prepared-authority-evidence");
    try {
      writeCapabilityOperationHeader(fx.storage.paths, header, held);
    } finally {
      held.release();
    }
    expect(fx.service.operationAuthorityEvidence(operationId).terminal).toBeNull();

    let observed = 0;
    const unsubscribe = fx.service.subscribeOperation(operationId, () => {
      observed += 1;
    });
    expect(fx.service.execute({ graph: fx.graph, authorization }).status).toBe("succeeded");
    expect(observed).toBeGreaterThan(0);
    expect(fx.service.operationAuthorityEvidence(operationId).terminal?.outcome).toBe("succeeded");
    unsubscribe();
    unsubscribe();

    const unavailable = new CapabilityFabricServiceV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      broker: fx.broker,
    });
    expect(() => unavailable.operationAuthorityEvidence(operationId)).toThrow(
      /action authority is unavailable/i,
    );
  });

  test("folds receipt target outcomes and rejects evidence outside the approved closure", () => {
    const fx = fixture();
    const plan = structuredClone(fx.graph.plan);
    const adapterPlan = plan.adapter_plans[0];
    const step = adapterPlan?.steps[0];
    const target = plan.targets[0];
    if (!adapterPlan || !step || !target) throw new Error("target fold fixture is incomplete");
    const makeReceipt = (
      state: AdapterReceiptV1["state"],
      selectedPlan = adapterPlan,
      selectedStep = step,
      evidence = runtimeDigest(`receipt-${state}`),
    ) =>
      createReceipt({
        operation_id: `vf-operation-${"a".repeat(64)}`,
        plan: selectedPlan,
        step: selectedStep,
        state,
        prepared_at: plan.created_at,
        observed_at: "2026-08-25T00:00:01.000Z",
        evidence_digest: evidence,
        error_code: state === "failed" || state === "uncertain" ? "adapter-failure" : null,
      });
    const fold = (
      events: CapabilityWalEventV1[],
      terminal: "committing" | "succeeded" | "failed" | "needs_recovery" = "committing",
      selectedPlan = plan,
    ) =>
      foldCapabilityTarget({
        plan: selectedPlan,
        events,
        targetId: target.target_id,
        terminal,
        baseLock: null,
      });

    expect(fold([receiptEvent(makeReceipt("effect_in_progress"))]).outcome).toBe("needs-recovery");
    expect(fold([receiptEvent(makeReceipt("failed"))]).outcome).toBe("failed");
    expect(fold([receiptEvent(makeReceipt("reversed"))]).outcome).toBe("reversed");
    expect(fold([receiptEvent(makeReceipt("applied"))], "succeeded").outcome).toBe("applied");
    expect(fold([], "failed").outcome).toBe("blocked");
    expect(() => fold([], "succeeded")).toThrow(/no causal terminal witness/i);
    expect(() =>
      foldCapabilityTarget({
        plan,
        events: [],
        targetId: "missing-target",
        terminal: "failed",
        baseLock: null,
      }),
    ).toThrow(/target closure/i);

    const optionalPlan = structuredClone(plan);
    const optionalTarget = optionalPlan.targets[0];
    if (!optionalTarget) throw new Error("optional target fixture is absent");
    optionalTarget.target.required = false;
    expect(fold([receiptEvent(makeReceipt("failed"))], "failed", optionalPlan).outcome).toBe(
      "omitted",
    );

    const nonHostPlan = structuredClone(plan);
    const disposition = nonHostPlan.target_dispositions[0];
    if (!disposition) throw new Error("target disposition fixture is absent");
    disposition.execution = "manual";
    expect(fold([], "succeeded", nonHostPlan).outcome).toBe("manual");
    expect(() => fold([receiptEvent(makeReceipt("applied"))], "succeeded", nonHostPlan)).toThrow(
      /non-host target/i,
    );

    const parallelPlan = structuredClone(plan);
    const parallelAdapter = parallelPlan.adapter_plans[0];
    const first = parallelAdapter?.steps[0];
    if (!parallelAdapter || !first) throw new Error("parallel receipt fixture is absent");
    const second = { ...structuredClone(first), step_id: "secondary-step" };
    parallelAdapter.steps.push(second);
    const unresolved = [
      receiptEvent(makeReceipt("effect_in_progress", parallelAdapter, first), 0),
      receiptEvent(makeReceipt("effect_in_progress", parallelAdapter, second), 1),
    ];
    expect(() => fold(unresolved, "committing", parallelPlan)).toThrow(/multiple unresolved/i);
  });

  test("folds required and optional health evidence by severity and recency", () => {
    const fx = fixture((manifest) => {
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
    const plan = structuredClone(fx.graph.plan);
    const adapterPlan = plan.adapter_plans[0];
    const target = plan.targets[0];
    const probe = adapterPlan?.health_plan[0];
    if (!adapterPlan || !target || !probe) throw new Error("health fold fixture is incomplete");
    adapterPlan.steps = [];
    const expiresAt = new Date(
      Date.parse("2026-08-25T00:00:00.000Z") + probe.evidence_valid_for_ms,
    ).toISOString();
    const row = (outcome: "ready" | "degraded" | "failed" | "unknown" | "stale") =>
      healthEvent({
        planId: adapterPlan.plan_id,
        targetId: target.target_id,
        probeId: probe.probe_id,
        outcome,
        expiresAt,
      });
    const fold = (events: CapabilityWalEventV1[], selectedPlan = plan) =>
      foldCapabilityTarget({
        plan: selectedPlan,
        events,
        targetId: target.target_id,
        terminal: "succeeded",
        baseLock: null,
      });

    expect(fold([row("ready")])).toMatchObject({ outcome: "applied", health: "ready" });
    expect(fold([row("failed")])).toMatchObject({ outcome: "failed", health: "failed" });

    const optionalTargetPlan = structuredClone(plan);
    const optionalTarget = optionalTargetPlan.targets[0];
    if (!optionalTarget) throw new Error("optional health target fixture is absent");
    optionalTarget.target.required = false;
    optionalTarget.target.on_health_failure = "commit-degraded";
    expect(fold([row("degraded")], optionalTargetPlan).outcome).toBe("degraded");
    optionalTarget.target.on_health_failure = "omit-after-rollback";
    expect(fold([row("failed")], optionalTargetPlan).outcome).toBe("omitted");

    const optionalProbePlan = structuredClone(plan);
    const optionalProbe = optionalProbePlan.adapter_plans[0]?.health_plan[0];
    if (!optionalProbe) throw new Error("optional probe fixture is absent");
    optionalProbe.required = false;
    expect(fold([row("unknown")], optionalProbePlan)).toMatchObject({
      outcome: "applied",
      health: "unknown",
    });

    const newer = healthEvent({
      planId: adapterPlan.plan_id,
      targetId: target.target_id,
      probeId: probe.probe_id,
      outcome: "failed",
      checkedAt: "2026-08-25T00:00:01.000Z",
      expiresAt: new Date(
        Date.parse("2026-08-25T00:00:01.000Z") + probe.evidence_valid_for_ms,
      ).toISOString(),
      sequence: 1,
    });
    expect(fold([row("ready"), newer]).health).toBe("failed");
    expect(() => fold([row("ready"), { ...row("failed"), sequence: 1 }])).toThrow(/ambiguous/i);
    expect(() =>
      fold([
        healthEvent({
          planId: adapterPlan.plan_id,
          targetId: target.target_id,
          probeId: probe.probe_id,
          outcome: "ready",
          expiresAt: "2026-08-25T00:00:01.000Z",
        }),
      ]),
    ).toThrow(/probe closure/i);
    expect(() =>
      fold([
        healthEvent({
          planId: "unknown-plan",
          targetId: target.target_id,
          probeId: probe.probe_id,
          outcome: "ready",
          expiresAt,
        }),
      ]),
    ).toThrow(/probe closure/i);
  });

  test("uses retained inspection evidence as the causal no-op witness", () => {
    const fx = installedLock();
    const unchanged = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: fx.lock,
        desired_packages: [fx.pkg],
        selected_engines: ["codex"],
      },
      fx.broker,
    );
    const target = unchanged.plan.targets[0];
    if (!target) throw new Error("unchanged target fixture is absent");
    expect(unchanged.plan.adapter_plans[0]?.steps).toHaveLength(0);
    expect(
      foldCapabilityTarget({
        plan: unchanged.plan,
        events: [],
        targetId: target.target_id,
        terminal: "succeeded",
        baseLock: fx.lock,
      }),
    ).toMatchObject({ outcome: "applied" });
  });

  test("records deterministic failed and uncertain receipts for broker apply failures", () => {
    for (const failure of ["before-effect", "after-effect"] as const) {
      const fx = fixture();
      const originalApply = fx.broker.apply.bind(fx.broker);
      fx.broker.apply = (descriptor, payload) => {
        if (failure === "after-effect") originalApply(descriptor, payload);
        throw new Error(`simulated ${failure}`);
      };
      const result = fx.service.execute({ graph: fx.graph, authorization });
      expect(result.status).toBe(failure === "before-effect" ? "failed" : "needs-recovery");
      expect(result.reason_code).toBe(
        failure === "before-effect" ? "apply-failed" : "scope-needs-recovery",
      );
      expect(result.targets[0]?.outcome).toBe(
        failure === "before-effect" ? "failed" : "needs-recovery",
      );
    }
  });

  test("refuses a stale owned preimage and serializes authority revocation before effects", () => {
    const stale = fixture();
    const resource = stale.graph.plan.adapter_plans[0]?.steps[0]?.owned_resources[0];
    if (!resource) throw new Error("owned resource fixture is absent");
    stale.broker.force(resource.ownership_key, runtimeDigest("foreign-owned-state"));
    const staleResult = stale.service.execute({ graph: stale.graph, authorization });
    expect(staleResult).toMatchObject({ status: "failed", reason_code: "owned-preimage-stale" });
    expect(staleResult.targets[0]?.outcome).toBe("blocked");

    const revoked = fixture();
    const approved = revoked.authority;
    const changed = {
      ...approved,
      authority_epoch: approved.authority_epoch + 1,
      authority_head_digest: runtimeDigest("authority-after-operation-admission"),
    };
    let sections = 0;
    const authority = {
      read: () => approved,
      readPermissionAuthority: () => approved.permission_digest,
      criticalSection: <T>(
        _scope: "project" | "user",
        _operation: string,
        now: () => string,
        callback: (value: typeof approved, checkedAt: string) => T,
      ): T => {
        sections += 1;
        return callback(sections === 1 ? approved : changed, now());
      },
    };
    const service = new CapabilityFabricServiceV1({
      storage: revoked.storage,
      authority,
      ...testRuntimeMutationAuthorities(),
      broker: revoked.broker,
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const result = service.execute({ graph: revoked.graph, authorization });
    expect(result).toMatchObject({ status: "failed", reason_code: "authority-head-stale" });
    expect(revoked.broker.resources()).toEqual([]);
    expect(sections).toBeGreaterThanOrEqual(2);
  });

  test("rolls back an optional target after a required health probe fails", () => {
    const fx = fixture((manifest) => {
      const component = manifest.components[0];
      if (!component) throw new Error("optional component fixture is absent");
      component.required = false;
      manifest.health = [
        {
          probe_id: "role-parse",
          component_ids: [component.component_id],
          kind: "role-parse",
          required: true,
          timeout_ms: 1_000,
          retries: 0,
        },
      ];
    });
    const originalHealth = fx.broker.health.bind(fx.broker);
    fx.broker.health = (request) => {
      const selected = originalHealth(request);
      const { evidence_digest: _, ...evidenceDraft } = selected.evidence;
      const failedDraft = { ...evidenceDraft, outcome: "failed" as const };
      const evidence = {
        ...failedDraft,
        evidence_digest: digestV1("VF-CAPABILITY-HEALTH-EVIDENCE\0v1\0", failedDraft),
      };
      return { outcome: "failed", evidence_digest: evidence.evidence_digest, evidence };
    };
    const result = fx.service.execute({ graph: fx.graph, authorization });
    expect(result.status).toBe("failed");
    expect(result.reason_code).toBe("no-surviving-package-targets");
    expect(fx.broker.resources()).toEqual([]);
  });

  test("fails closed for every retained publication third state", () => {
    for (const scenario of [
      "missing-inventory",
      "foreign-current-lock",
      "committed-lock-missing",
      "foreign-health-pointer",
    ] as const) {
      const fx = fixture();
      const frontier =
        scenario === "committed-lock-missing" || scenario === "foreign-health-pointer"
          ? "after-lock-commit"
          : "after-health-inventory-prepared";
      fx.service.fault = (point) => {
        if (point === frontier)
          throw new CapabilityRuntimeError(`publication crash ${scenario}`, "fault");
      };
      expect(() => fx.service.execute({ graph: fx.graph, authorization })).toThrow(
        /publication crash/i,
      );
      const operationId = fx.service.operationId(fx.graph, authorization);
      const prepared = fx.service
        .readOperation({ operation_id: operationId })
        .events.find((event) => event.payload.kind === "health-inventory-prepared")?.payload;
      if (prepared?.kind !== "health-inventory-prepared")
        throw new Error("prepared publication fixture is absent");

      if (scenario === "missing-inventory") {
        rmSync(capabilityHealthInventoryPath(fx.storage.paths, prepared.health_inventory_digest));
      } else if (scenario === "foreign-current-lock") {
        const foreign = materializeCapabilityLock({
          schema_version: "1.0",
          fabric_active: true,
          scope: "project",
          generation_ordinal: 0,
          parent_generation_digests: [],
          packages: [],
          policy_digest: runtimeDigest("foreign-current-policy"),
          permission_digest: runtimeDigest("foreign-current-permission"),
          created_at: "2026-08-25T00:00:01.000Z",
        });
        const held = fx.storage.acquire("install-foreign-current");
        try {
          fx.storage.putHistory(foreign, held);
          fx.storage.publishLock(null, foreign, held);
        } finally {
          held.release();
        }
      } else if (scenario === "committed-lock-missing") {
        rmSync(fx.storage.paths.currentLock);
      } else {
        const pointerDraft = {
          schema_version: "1.0" as const,
          scope: "project" as const,
          scope_identity_digest: fx.authority.scope_identity_digest,
          inventory_epoch: 0,
          inventory_digest: runtimeDigest("foreign-health-inventory"),
          pointer_digest: "",
        };
        const { pointer_digest: _, ...preimage } = pointerDraft;
        const held = fx.storage.acquire("install-foreign-health-pointer");
        try {
          fx.storage.publishHealthCurrent(
            null,
            {
              ...pointerDraft,
              pointer_digest: digestV1("VF-CAPABILITY-HEALTH-CURRENT\0v1\0", preimage),
            },
            held,
          );
        } finally {
          held.release();
        }
      }

      fx.service.fault = null;
      if (scenario === "missing-inventory") {
        const authorities = testRuntimeMutationAuthorities();
        const held = fx.storage.acquire("recover-missing-publication-object");
        const journal = new CapabilityOperationJournalV1({
          storage: fx.storage,
          authority: runtimeAuthorityReader(() => fx.authority),
          now: () => "2026-08-25T00:00:02.000Z",
        });
        try {
          expect(() =>
            recoverCapabilityPublication({
              plan: fx.graph.plan,
              graph: fx.graph,
              operationId,
              held,
              storage: fx.storage,
              authority: runtimeAuthorityReader(() => fx.authority),
              sourceAuthority: authorities.sourceAuthority,
              now: () => "2026-08-25T00:00:02.000Z",
              journal,
              actionAuthority: authorities.actionAuthority,
            }),
          ).toThrow(
            /prepared publication objects are missing or corrupt.*durable recovery terminal/i,
          );
        } finally {
          held.release();
        }
        const terminal = readCapabilityWal(fx.storage.paths, operationId).at(-1)?.payload;
        expect(terminal).toMatchObject({
          kind: "operation-transition",
          to: "needs_recovery",
          reason_code: "publication-objects-missing",
        });
        continue;
      }
      const recovered = fx.service.recover(operationId);
      expect(recovered.status, scenario).toBe("needs-recovery");
      expect(recovered.reason_code, scenario).toBe(
        scenario === "foreign-current-lock"
          ? "lock-publication-third-state"
          : scenario === "committed-lock-missing"
            ? "committed-lock-missing"
            : "health-pointer-third-state",
      );
    }
  });

  test("retains publication history independently of the mutable current pointer", () => {
    const fx = fixture();
    fx.service.fault = (point) => {
      if (point === "after-health-inventory-prepared")
        throw new CapabilityRuntimeError("history retained", "fault");
    };
    expect(() => fx.service.execute({ graph: fx.graph, authorization })).toThrow(
      /history retained/,
    );
    const operationId = fx.service.operationId(fx.graph, authorization);
    const prepared = fx.service
      .readOperation({ operation_id: operationId })
      .events.find((event) => event.payload.kind === "health-inventory-prepared")?.payload;
    if (prepared?.kind !== "health-inventory-prepared")
      throw new Error("prepared publication fixture is absent");
    expect(capabilityHistoryPath(fx.storage.paths, prepared.generation_id)).toBeString();
    expect(capabilityHealthCurrentPath(fx.storage.paths)).toBeString();
  });

  test("validates operation headers, receipt optionals, and WAL event digests", () => {
    const fx = fixture();
    const operationId = fx.service.operationId(fx.graph, authorization);
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const header = journal.createHeader(operationId, fx.graph, authorization);
    expect(() => validateCapabilityOperation(header)).not.toThrow();
    expect(() =>
      validateCapabilityOperation({ ...header, schema_version: "2.0" } as never),
    ).toThrow(/schema/i);
    expect(() => validateCapabilityOperation({ ...header, plan_ids: [] })).toThrow(/plan order/i);
    expect(() =>
      validateCapabilityOperation({
        ...header,
        action_root_locator: {
          kind: "capability",
          scope: "user",
          scope_identity_digest: header.scope_identity_digest,
        },
      }),
    ).toThrow(/scope mismatch/i);
    expect(() =>
      validateCapabilityOperation({ ...header, header_digest: runtimeDigest("wrong-header") }),
    ).toThrow(/header digest/i);
    expect(operationIdDigest({ proposal: header.proposal_id })).toMatch(
      /^vf-operation-[a-f0-9]{64}$/,
    );

    const event = walChain([walStart])[0];
    if (!event) throw new Error("WAL event fixture is absent");
    expect(() => validateCapabilityWalEvent(event, event.operation_id)).not.toThrow();
    expect(() =>
      validateCapabilityWalEvent(
        { ...event, event_digest: runtimeDigest("wrong-event-digest") },
        event.operation_id,
      ),
    ).toThrow(/event digest/i);

    const adapterPlan = fx.graph.plan.adapter_plans[0];
    const step = adapterPlan?.steps[0];
    if (!adapterPlan || !step) throw new Error("receipt validation fixture is absent");
    const receipt = createReceipt({
      operation_id: operationId,
      plan: adapterPlan,
      step,
      state: "applied",
      prepared_at: fx.graph.plan.created_at,
      observed_at: "2026-08-25T00:00:01.000Z",
      evidence_digest: runtimeDigest("receipt-validation-evidence"),
      error_code: null,
    });
    expect(() => validateAdapterReceipt(receipt, "receipt")).not.toThrow();
    expect(() => validateAdapterReceipt({ ...receipt, attempt: 1 } as never, "receipt")).toThrow(
      /attempt zero/i,
    );
    const referenced = {
      ...receipt,
      private_evidence_ref: "private/evidence/ref",
      native_identifier_producer_receipt_digests: [runtimeDigest("producer-receipt")],
      receipt_digest: "",
    };
    referenced.receipt_digest = adapterReceiptDigest(referenced);
    expect(() => validateAdapterReceipt(referenced, "receipt")).not.toThrow();
    expect(() =>
      validateAdapterReceipt(
        { ...receipt, native_identifier_producer_receipt_digests: null } as never,
        "receipt",
      ),
    ).toThrow(/producer receipt/i);
    expect(() =>
      validateAdapterReceipt(
        { ...receipt, receipt_digest: runtimeDigest("wrong-receipt") },
        "receipt",
      ),
    ).toThrow(/receipt digest/i);
  });

  test("validates authenticity and sorted multi-row lock entry closures", () => {
    const { lock: original } = installedLock();
    const badSchema = structuredClone(original);
    const badSchemaEntry = badSchema.packages[0];
    if (!badSchemaEntry) throw new Error("authenticity fixture is absent");
    badSchemaEntry.authenticity_binding.schema_version = "2.0" as never;
    expect(() => validateCapabilityLock(badSchema)).toThrow(/authenticity binding schema/i);

    const badDigest = structuredClone(original);
    const badDigestEntry = badDigest.packages[0];
    if (!badDigestEntry) throw new Error("authenticity fixture is absent");
    badDigestEntry.authenticity_binding.authenticity_digest = runtimeDigest("wrong-authenticity");
    expect(() => validateCapabilityLock(badDigest)).toThrow(/authenticity binding digest/i);

    const multi = structuredClone(original);
    const entry = multi.packages[0];
    const target = entry?.targets[0];
    const firstProjection = target?.projections[0];
    if (!entry || !target || !firstProjection) throw new Error("multi-row lock fixture is absent");
    entry.dependencies = [
      {
        required_scope: "user-prerequisite",
        package_id: "acme.alpha",
        version: "1.0.0",
        content_sha256: "1".repeat(64),
        required_health_plan_digest: runtimeDigest("alpha-health"),
      },
      {
        required_scope: "user-prerequisite",
        package_id: "acme.beta",
        version: "1.0.0",
        content_sha256: "2".repeat(64),
        required_health_plan_digest: runtimeDigest("beta-health"),
      },
    ];
    const secondProjection = {
      ownership_key: `${firstProjection.ownership_key}-secondary`,
      projection_digest: runtimeDigest("secondary-projection"),
    };
    target.projections = [firstProjection, secondProjection].sort((left, right) =>
      Buffer.from(`${left.ownership_key}\0${left.projection_digest}`).compare(
        Buffer.from(`${right.ownership_key}\0${right.projection_digest}`),
      ),
    );
    entry.ownership_keys = target.projections.map((row) => row.ownership_key).sort();
    expect(validateCapabilityLock(resealLock(multi)).packages[0]?.dependencies).toHaveLength(2);
  });

  test("portable CAS rejects missing, unsafe, stale, and forged authorities", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-cap-portable-cas-coverage-"));
    roots.push(root);
    expect(readPortableBytes(join(root, "missing-parent", "lock.json"))).toBeNull();

    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe);
    chmodSync(unsafe, 0o777);
    expect(() => readPortableBytes(join(unsafe, "lock.json"))).toThrow(/parent is not owner-safe/i);

    const fx = fixture();
    const held = fx.storage.acquire("portable-cas-stale-preimage");
    try {
      expect(() =>
        compareAndSwapPortableBytes(
          fx.storage.paths.currentLock,
          Buffer.from("not-the-current-lock"),
          canonicalJsonBytes({ schema_version: "1.0" }),
          held,
        ),
      ).toThrow(/preimage mismatch/i);
    } finally {
      held.release();
    }
    expect(() =>
      bindProjectIdentityPortableCas(
        {} as never,
        fx.storage.paths,
        fx.authority.scope_identity_digest,
      ),
    ).toThrow(/concrete authority activation lock/i);
  });

  test("portable CAS refuses both pre-publication and post-publication replacement races", () => {
    const staged = fixture();
    const stagedHeld = staged.storage.acquire("portable-cas-staging-race");
    try {
      expect(() =>
        compareAndSwapPortableBytes(
          staged.storage.paths.currentLock,
          null,
          canonicalJsonBytes({ schema_version: "1.0", value: "replacement" }),
          stagedHeld,
          {
            fault(point) {
              if (point === "after-staging-fsync")
                writeFileSync(staged.storage.paths.currentLock, "competing-preimage");
            },
          },
        ),
      ).toThrow(/preimage changed/i);
    } finally {
      stagedHeld.release();
    }

    const published = fixture();
    const publishedHeld = published.storage.acquire("portable-cas-publication-race");
    try {
      expect(() =>
        compareAndSwapPortableBytes(
          published.storage.paths.currentLock,
          null,
          canonicalJsonBytes({ schema_version: "1.0", value: "replacement" }),
          publishedHeld,
          {
            fault(point) {
              if (point === "after-publication-fsync")
                writeFileSync(published.storage.paths.currentLock, "competing-publication");
            },
          },
        ),
      ).toThrow(/publication differs/i);
    } finally {
      publishedHeld.release();
    }
  });

  test("covers prerequisite ordering and both correlation integrity boundaries", () => {
    const fx = fixture();
    const graph = structuredClone(fx.graph);
    const adapterPlan = graph.plan.adapter_plans[0];
    if (!adapterPlan) throw new Error("prerequisite plan fixture is absent");
    const prerequisite = (packageId: string) => ({
      schema_version: "1.0" as const,
      user_scope_identity_digest: runtimeDigest(`user-scope-${packageId}`),
      package_id: packageId,
      version: "1.0.0",
      content_sha256: "a".repeat(64),
      user_generation_id: `vf-generation-${"b".repeat(64)}`,
      user_lock_digest: runtimeDigest(`user-lock-${packageId}`),
      user_lock_entry_digest: runtimeDigest(`user-entry-${packageId}`),
      user_authority_epoch: 1,
      user_authority_head_digest: runtimeDigest(`user-authority-${packageId}`),
      required_health_digest: runtimeDigest(`user-health-${packageId}`),
      checked_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T01:00:00.000Z",
    });
    adapterPlan.user_prerequisites = [prerequisite("acme.zeta"), prerequisite("acme.alpha")];
    expect(capabilityOperationPlanClosure(graph).user_prerequisites).toHaveLength(2);

    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const conversation = structuredClone(fx.graph);
    const conversationLocator = {
      kind: "conversation",
      root_session_id: `vf-root-session-${"c".repeat(64)}`,
    } as const;
    conversation.plan.action_root_locator = conversationLocator;
    const standaloneHeader = journal.createHeader(
      fx.service.operationId(fx.graph, authorization),
      fx.graph,
      authorization,
    );
    const conversationHeader = {
      ...standaloneHeader,
      action_root_locator: conversationLocator,
      conversation_correlation: null,
    };
    expect(() => assertCapabilityOperationHeaderClosure(conversationHeader, conversation)).toThrow(
      /correlation root/i,
    );

    expect(() =>
      assertCapabilityOperationHeaderClosure(
        {
          ...standaloneHeader,
          conversation_correlation: {
            schema_version: "1.0",
            correlation_id: `vf-correlation-${"d".repeat(64)}`,
            root_session_id: `vf-root-session-${"e".repeat(64)}`,
            conversation_id: `vf-conversation-${"f".repeat(64)}`,
            revision_id: `vf-revision-${"1".repeat(64)}`,
            origin_event_id: null,
            proposal_id: standaloneHeader.proposal_id,
          },
        },
        fx.graph,
      ),
    ).toThrow(/cannot claim conversation correlation/i);
  });

  test("fails closed when low-level authority and recovery dependencies are absent", () => {
    const fx = fixture();
    expect(() => requireCapabilityActionAuthority({ actionAuthority: undefined })).toThrow(
      /action authority is unavailable/i,
    );
    expect(() =>
      capabilityRuntimeAuthorityMismatch(fx.graph, {} as never, undefined, undefined),
    ).toThrow(/clock is unavailable/i);
    const nonHost = structuredClone(fx.graph.plan);
    for (const disposition of nonHost.target_dispositions) disposition.execution = "manual";
    expect(() => capabilityHostTargetIds(nonHost)).toThrow(/no canonical host targets/i);
    expect(() => assertNoOpInspectionOnly({ ...fx.graph.plan, status: "no-op" })).toThrow(
      /inspection-only/i,
    );

    const observedCurrent = capabilityRecoveryFrontier({
      graph: fx.graph,
      options: {
        authority: {
          read: () => fx.authority,
          readPermissionAuthority: () => {
            throw new Error("permission reader unavailable");
          },
          criticalSection: (_scope, _operation, now, callback) => callback(fx.authority, now()),
        },
        sourceAuthority: testRuntimeMutationAuthorities().sourceAuthority,
        now: () => "2026-08-25T00:00:00.000Z",
      },
      operation: "coverage-recovery-frontier",
      recover: (current) => current,
    });
    expect(observedCurrent).toBeFalse();

    const descriptor = fx.graph.plan.runtime_closure.descriptors.find(
      (row) => row.descriptor_kind === "intent",
    );
    if (!descriptor) throw new Error("crash descriptor fixture is absent");
    const privatePayload = fx.broker.resolvePrivatePayload(descriptor.private_payload_binding);
    fx.broker.reconcile = () => {
      throw new Error("repair unavailable");
    };
    expect(
      reconcileCrashPartialEffect({
        state: "effect_in_progress",
        phase: "forward",
        observed: descriptor.resource.expected_postimage_sha256,
        descriptor,
        privatePayload,
        broker: fx.broker,
      }),
    ).toBe("uncertain");
  });

  test("validates lock checkpoints and immutable operation base history", () => {
    const fx = fixture();
    const checkpoint = {
      kind: "lock-checkpoint" as const,
      prior_generation_id: `vf-generation-${"2".repeat(64)}`,
      prior_lock_digest: runtimeDigest("checkpoint-lock"),
      checkpoint_bytes_sha256: "3".repeat(64),
      checkpoint_digest: runtimeDigest("checkpoint"),
    };
    expect(() =>
      validateCapabilityLockCheckpoint({ storage: fx.storage, base: null, payload: checkpoint }),
    ).toThrow(/initial operation/i);

    const installed = installedLock();
    expect(() =>
      validateCapabilityLockCheckpoint({
        storage: installed.storage,
        base: installed.lock,
        payload: null,
        required: true,
      }),
    ).toThrow(/checkpoint is absent/i);

    const missingBase = structuredClone(fx.graph.plan);
    missingBase.base_generation_id = `vf-generation-${"4".repeat(64)}`;
    missingBase.base_lock_digest = runtimeDigest("missing-base-lock");
    expect(() => readOperationBaseLock(fx.storage, missingBase)).toThrow(
      /base history is missing/i,
    );

    const mismatchedBase = structuredClone(installed.graph.plan);
    mismatchedBase.base_generation_id = installed.lock.generation_id;
    mismatchedBase.base_lock_digest = runtimeDigest("mismatched-base-lock");
    expect(() => readOperationBaseLock(installed.storage, mismatchedBase)).toThrow(
      /base history identity mismatch/i,
    );

    const operationId = operationIdDigest("checkpoint-selected-for-initial-operation");
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const held = fx.storage.acquire("checkpoint-selected-for-initial-operation");
    try {
      journal.append(operationId, walStart, held);
      journal.append(operationId, checkpoint, held);
      expect(() =>
        ensureCapabilityLockCheckpoint({
          storage: fx.storage,
          operationId,
          base: null,
          held,
          journal,
        }),
      ).toThrow(/initial capability publication/i);
    } finally {
      held.release();
    }
  });

  test("refuses a changed lock checkpoint before recording it in the operation WAL", () => {
    const installed = installedLock();
    const operationId = operationIdDigest("changed-lock-checkpoint-before-wal");
    const journal = new CapabilityOperationJournalV1({
      storage: installed.storage,
      authority: runtimeAuthorityReader(() => installed.authority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const held = installed.storage.acquire("changed-lock-checkpoint-before-wal");
    const checkpointPath = join(
      installed.storage.paths.privateRoot,
      "recovery",
      "v1",
      "lock-checkpoints",
      `${installed.lock.content_digest.slice("sha256:".length)}.json`,
    );
    try {
      journal.append(operationId, walStart, held);
      expect(() =>
        ensureCapabilityLockCheckpoint({
          storage: installed.storage,
          operationId,
          base: installed.lock,
          held,
          journal,
          fault(point) {
            if (point === "after-lock-checkpoint-materialized") writeFileSync(checkpointPath, "{}");
          },
        }),
      ).toThrow(/checkpoint bytes are missing or changed/i);
      expect(readCapabilityWal(installed.storage.paths, operationId)).toHaveLength(1);
    } finally {
      held.release();
    }
  });

  test("preflight rejects corrupt and stale current scope state before effects", () => {
    const corrupt = fixture();
    corrupt.service.fault = (point) => {
      if (point === "after-header") throw new CapabilityRuntimeError("header prepared", "fault");
    };
    expect(() => corrupt.service.execute({ graph: corrupt.graph, authorization })).toThrow(
      /header prepared/i,
    );
    writeFileSync(corrupt.storage.paths.currentLock, "{");
    corrupt.service.fault = null;
    expect(
      corrupt.service.recover(corrupt.service.operationId(corrupt.graph, authorization)),
    ).toMatchObject({ status: "needs-recovery", reason_code: "scope-needs-recovery" });

    const stale = fixture();
    stale.service.fault = (point) => {
      if (point === "after-header") throw new CapabilityRuntimeError("header prepared", "fault");
    };
    expect(() => stale.service.execute({ graph: stale.graph, authorization })).toThrow(
      /header prepared/i,
    );
    const foreign = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 0,
      parent_generation_digests: [],
      packages: [],
      policy_digest: runtimeDigest("preflight-foreign-policy"),
      permission_digest: runtimeDigest("preflight-foreign-permission"),
      created_at: "2026-08-25T00:00:01.000Z",
    });
    const held = stale.storage.acquire("preflight-foreign-current");
    try {
      stale.storage.putHistory(foreign, held);
      stale.storage.publishLock(null, foreign, held);
    } finally {
      held.release();
    }
    stale.service.fault = null;
    expect(
      stale.service.recover(stale.service.operationId(stale.graph, authorization)),
    ).toMatchObject({ status: "failed", reason_code: "scope-base-stale" });
  });

  test("publication refuses a corrupt current pointer after an applied effect", () => {
    const fx = fixture();
    fx.broker.onEffect = () => {
      writeFileSync(fx.storage.paths.currentLock, "{");
    };
    expect(() => fx.service.execute({ graph: fx.graph, authorization })).toThrow(
      /current lock cannot be validated/i,
    );
  });

  test("materializes a root lock with an empty package set", () => {
    const lock = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 0,
      parent_generation_digests: [],
      packages: [],
      policy_digest: runtimeDigest("empty-policy"),
      permission_digest: runtimeDigest("empty-permission"),
      created_at: "2026-08-25T00:00:00.000Z",
    });
    expect(validateCapabilityLock(lock)).toEqual(lock);
  });
});
