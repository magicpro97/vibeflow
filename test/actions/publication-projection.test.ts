import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  deriveOperationId,
  materializeApproval,
  materializeProposal,
  projectActionSnapshot,
  targetId,
} from "../../src/actions/index.js";
import type {
  ActionAuthoritySnapshotV1,
  ActionOperationEventV1,
  PublicTargetResultV1,
} from "../../src/actions/index.js";
import { validateOperationBatches } from "../../src/actions/operation-batch-validation.js";
import { validateIdempotencyBinding } from "../../src/actions/persistence-validation.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import {
  authority,
  canonicalRequest,
  fixedNow,
  proposalDraft,
  testAuthorityResolver,
  testDigest,
} from "./fixtures.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "vf-action-publication-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("publication authority and domain projection", () => {
  test("requires a current referenced-closure proof before the first durable write", () => {
    const path = root();
    const base = testAuthorityResolver();
    const store = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: {
        ...base,
        validateProposalPublication: () => {
          throw new Error("referenced closure is stale");
        },
      },
    });
    const proposal = materializeProposal(proposalDraft());
    expect(() =>
      store.createProposal({ authority, canonical_request: canonicalRequest(), proposal }),
    ).toThrow(/closure is stale/i);
    for (const directory of ["proposals", "operations", "idempotency"])
      expect(readdirSync(join(path, "actions", "v1", directory))).toEqual([]);
  });

  test("samples the proposal clock once and persists the exact 512 KiB proposal boundary", () => {
    const path = root();
    let samples = 0;
    const { draft, proposal } = proposalAtBytes(512 * 1024);
    expect(canonicalJsonBytes(proposal).length).toBe(512 * 1024);
    const last = draft.preview.review_fields.at(-1);
    if (!last || typeof last.after !== "string") throw new Error("missing proposal size tuner");
    expect(() =>
      materializeProposal({
        ...draft,
        preview: {
          ...draft.preview,
          review_fields: [
            ...draft.preview.review_fields.slice(0, -1),
            { ...last, after: `${last.after}z` },
          ],
        },
      }),
    ).toThrow(/byte limit/i);
    const store = new ActionAuthorityStore(path, {
      now: () => {
        samples += 1;
        return fixedNow;
      },
      authority_resolver: testAuthorityResolver(),
    });
    expect(
      store.createProposal({ authority, canonical_request: canonicalRequest(), proposal }).created,
    ).toBe(true);
    expect(samples).toBe(1);
    expect(store.get(proposal.proposal_id)?.proposal.proposal_digest).toBe(
      proposal.proposal_digest,
    );
  }, 30_000);

  test("rejects a visible idempotency frame whose publication time regresses", () => {
    const preimage = {
      schema_version: "1.0" as const,
      sequence: 1 as const,
      previous_frame_digest: testDigest("previous"),
      state: "visible" as const,
      principal_digest: authority.principal_digest,
      authority_scope_digest: authority.authority_scope_digest,
      idempotency_key_digest: testDigest("key"),
      canonical_request_digest: testDigest("request"),
      proposal_id: `vf-proposal-${"a".repeat(64)}`,
      proposal_digest: testDigest("proposal"),
      created_at: "2026-08-25T00:01:00.000Z",
      visible_at: "2026-08-25T00:00:59.999Z",
      retain_until: "2026-08-25T01:00:00.000Z",
    };
    expect(() =>
      validateIdempotencyBinding({
        ...preimage,
        binding_digest: digestV1("VF-ACTION-IDEMPOTENCY-BINDING\0v1\0", preimage),
      }),
    ).toThrow(/outside/i);
  });

  test("folds dense domain phases into the operation view and rejects gaps/status drift", () => {
    const path = root();
    const store = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft());
    store.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const approval = store.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    store.prepareDispatch(proposal.proposal_id, approval.approval_id);
    store.beginDispatch(proposal.proposal_id, approval.approval_id);
    const terminal = store.recordTerminal(proposal.proposal_id);
    if (!terminal.operation_id) throw new Error("missing operation");
    const events: ActionOperationEventV1[] = [
      event(terminal.operation_id, 0, "committing", "dispatch", "running"),
      event(terminal.operation_id, 1, "succeeded", "conversation-receipt:succeeded", "succeeded"),
    ];
    const projected = projectActionSnapshot(terminal, events);
    expect(projected.operation.phase_sequence).toBe(1);
    expect(projected.operation.latest_event_cursor).toBe("cursor-1");
    expect(projected.operation.progress.map((row) => row.phase)).toEqual([
      "dispatch",
      "conversation-receipt:succeeded",
    ]);
    const first = events[0];
    if (!first?.progress) throw new Error("missing dispatch fixture");
    const firstProgress = first.progress;
    expect(() => projectActionSnapshot(terminal, [{ ...first, phase_sequence: 1 }])).toThrow(
      /dense/i,
    );
    expect(() =>
      projectActionSnapshot(terminal, [
        { ...first, progress: { ...firstProgress, status: "failed" } },
      ]),
    ).toThrow(/status/i);
    expect(() =>
      projectActionSnapshot(terminal, [
        {
          ...first,
          progress: {
            ...firstProgress,
            phase: "authority-change:prepared",
            status: "pending",
            message_code: "operation.authority-change:prepared",
          },
        },
      ]),
    ).toThrow(/action owner/i);
  });

  test("rejects duplicate, missing, and noncanonical capability target batches", () => {
    const { snapshot, targets } = capabilitySnapshot("succeeded");
    if (!snapshot.operation_id) throw new Error("missing capability operation");
    const start = event(snapshot.operation_id, 0, "committing", "operation-started", "running");
    const terminal = event(
      snapshot.operation_id,
      3,
      "succeeded",
      "operation-succeeded",
      "succeeded",
    );
    const first = atTime(
      targetEvent(snapshot.operation_id, 1, "succeeded", targets[0], "applied"),
      terminal.occurred_at,
    );
    const second = atTime(
      targetEvent(snapshot.operation_id, 2, "succeeded", targets[1], "applied"),
      terminal.occurred_at,
    );
    snapshot.events = [{ recorded_at: terminal.occurred_at } as never];

    const earlyTerminal = terminalAt(terminal, 2);
    snapshot.events = [{ recorded_at: earlyTerminal.occurred_at } as never];
    expect(() =>
      projectActionSnapshot(snapshot, [
        start,
        atTime(first, earlyTerminal.occurred_at),
        earlyTerminal,
      ]),
    ).toThrow(/target coverage/i);
    snapshot.events = [{ recorded_at: terminal.occurred_at } as never];
    expect(() =>
      projectActionSnapshot(snapshot, [
        start,
        first,
        atTime(
          targetEvent(snapshot.operation_id as string, 2, "succeeded", targets[0], "applied"),
          terminal.occurred_at,
        ),
        terminal,
      ]),
    ).toThrow(/duplicate target/i);
    expect(() =>
      projectActionSnapshot(snapshot, [
        start,
        atTime(
          targetEvent(snapshot.operation_id as string, 1, "succeeded", targets[1], "applied"),
          terminal.occurred_at,
        ),
        atTime(
          targetEvent(snapshot.operation_id as string, 2, "succeeded", targets[0], "applied"),
          terminal.occurred_at,
        ),
        terminal,
      ]),
    ).toThrow(/canonical target order/i);
    expect(
      projectActionSnapshot(snapshot, [start, first, second, terminal]).operation.targets,
    ).toHaveLength(2);
    expect(() => projectActionSnapshot(snapshot, [start, first])).not.toThrow();
  });

  test("enforces terminal transitions and a unique canonical correction batch", () => {
    const { snapshot, targets } = capabilitySnapshot("failed");
    if (!snapshot.operation_id) throw new Error("missing capability operation");
    const start = event(snapshot.operation_id, 0, "committing", "operation-started", "running");
    const uncertainty = event(
      snapshot.operation_id,
      3,
      "needs_recovery",
      "operation-needs-recovery",
      "failed",
    );
    const final = event(snapshot.operation_id, 5, "failed", "operation-failed", "failed");
    const uncertainTarget = atTime(
      targetEvent(snapshot.operation_id, 1, "needs_recovery", targets[0], "needs-recovery"),
      uncertainty.occurred_at,
    );
    const failedTarget = atTime(
      targetEvent(snapshot.operation_id, 2, "needs_recovery", targets[1], "failed"),
      uncertainty.occurred_at,
    );
    const corrected = atTime(
      targetEvent(snapshot.operation_id, 4, "failed", targets[0], "reversed"),
      final.occurred_at,
    );
    snapshot.events = [{ recorded_at: final.occurred_at } as never];
    expect(
      projectActionSnapshot(snapshot, [
        start,
        uncertainTarget,
        failedTarget,
        uncertainty,
        corrected,
        final,
      ]).operation.targets.find((row) => row.target_id === targets[0]?.target_id)?.outcome,
    ).toBe("reversed");

    const lateFinal = terminalAt(final, 6);
    snapshot.events = [{ recorded_at: lateFinal.occurred_at } as never];
    expect(() =>
      projectActionSnapshot(snapshot, [
        start,
        uncertainTarget,
        failedTarget,
        uncertainty,
        atTime(corrected, lateFinal.occurred_at),
        atTime(
          targetEvent(snapshot.operation_id as string, 5, "failed", targets[0], "reversed"),
          lateFinal.occurred_at,
        ),
        lateFinal,
      ]),
    ).toThrow(/duplicate correction target/i);

    const impossible = event(
      snapshot.operation_id,
      4,
      "succeeded",
      "operation-succeeded",
      "succeeded",
    );
    const regressed = event(snapshot.operation_id, 5, "failed", "operation-failed", "failed");
    snapshot.events = [{ recorded_at: regressed.occurred_at } as never];
    expect(() =>
      projectActionSnapshot(snapshot, [
        start,
        uncertainTarget,
        failedTarget,
        uncertainty,
        impossible,
        regressed,
      ]),
    ).toThrow(/illegal operation state transition|terminal phase has a successor/i);
  });

  test("rejects required omission, split transition timestamps, and unchanged corrections", () => {
    const { snapshot, targets } = capabilitySnapshot("succeeded");
    if (!snapshot.operation_id) throw new Error("missing capability operation");
    const start = event(snapshot.operation_id, 0, "committing", "operation-started", "running");
    const terminal = event(
      snapshot.operation_id,
      3,
      "succeeded",
      "operation-succeeded",
      "succeeded",
    );
    const omitted = atTime(
      targetEvent(snapshot.operation_id, 1, "succeeded", targets[0], "omitted"),
      terminal.occurred_at,
    );
    const applied = atTime(
      targetEvent(snapshot.operation_id, 2, "succeeded", targets[1], "applied"),
      terminal.occurred_at,
    );
    snapshot.events = [{ recorded_at: terminal.occurred_at } as never];
    expect(() => projectActionSnapshot(snapshot, [start, omitted, applied, terminal])).toThrow(
      /omitted required target|required target.*omitted/i,
    );
    expect(() => projectActionSnapshot(snapshot, [start, omitted])).toThrow(
      /omitted required target|required target.*omitted/i,
    );
    expect(() =>
      projectActionSnapshot(snapshot, [
        start,
        atTime(
          targetEvent(snapshot.operation_id as string, 1, "succeeded", targets[0], "applied"),
          new Date(Date.parse(terminal.occurred_at) - 1).toISOString(),
        ),
        applied,
        terminal,
      ]),
    ).toThrow(/transition timestamp/i);

    const recovery = capabilitySnapshot("failed");
    if (!recovery.snapshot.operation_id) throw new Error("missing recovery operation");
    const recoveryStart = event(
      recovery.snapshot.operation_id,
      0,
      "committing",
      "operation-started",
      "running",
    );
    const boundary = event(
      recovery.snapshot.operation_id,
      3,
      "needs_recovery",
      "operation-needs-recovery",
      "failed",
    );
    const first = atTime(
      targetEvent(
        recovery.snapshot.operation_id,
        1,
        "needs_recovery",
        recovery.targets[0],
        "needs-recovery",
      ),
      boundary.occurred_at,
    );
    const second = atTime(
      targetEvent(
        recovery.snapshot.operation_id,
        2,
        "needs_recovery",
        recovery.targets[1],
        "failed",
      ),
      boundary.occurred_at,
    );
    const final = event(recovery.snapshot.operation_id, 6, "failed", "operation-failed", "failed");
    const changed = atTime(
      targetEvent(recovery.snapshot.operation_id, 4, "failed", recovery.targets[0], "reversed"),
      final.occurred_at,
    );
    const unchanged = atTime(
      targetEvent(recovery.snapshot.operation_id, 5, "failed", recovery.targets[1], "failed"),
      final.occurred_at,
    );
    recovery.snapshot.events = [{ recorded_at: final.occurred_at } as never];
    expect(() =>
      projectActionSnapshot(recovery.snapshot, [recoveryStart, first, second, boundary]),
    ).not.toThrow();
    const changedPrefix = atTime(
      targetEvent(recovery.snapshot.operation_id, 4, "failed", recovery.targets[0], "reversed"),
      final.occurred_at,
    );
    expect(() =>
      projectActionSnapshot(recovery.snapshot, [
        recoveryStart,
        first,
        second,
        boundary,
        changedPrefix,
      ]),
    ).not.toThrow();
    expect(() =>
      projectActionSnapshot(recovery.snapshot, [
        recoveryStart,
        first,
        second,
        boundary,
        changed,
        unchanged,
        final,
      ]),
    ).toThrow(/unchanged target correction/i);
  });

  test("enforces nonterminal state rows and permits repeated repair uncertainty", () => {
    const operationId = "vf-operation-repair";
    const snapshot = {
      proposal: { action: { type: "authority.repair" } },
    } as unknown as ActionAuthoritySnapshotV1;
    const dispatch = event(operationId, 0, "committing", "dispatch", "running");
    const prepared = event(operationId, 1, "committing", "authority-repair:prepared", "pending");
    const uncertain = event(
      operationId,
      2,
      "needs_recovery",
      "authority-repair:needs_recovery",
      "failed",
    );
    const repeated = event(
      operationId,
      3,
      "needs_recovery",
      "authority-repair:needs_recovery",
      "failed",
    );
    expect(() =>
      validateOperationBatches(snapshot, [dispatch, prepared, uncertain, repeated]),
    ).not.toThrow();
    expect(() =>
      validateOperationBatches(snapshot, [dispatch, { ...prepared, state: "succeeded" }]),
    ).toThrow(/nonterminal phase.*committing/i);

    const policy = {
      proposal: { action: { type: "policy.update_authority" } },
    } as unknown as ActionAuthoritySnapshotV1;
    expect(() =>
      validateOperationBatches(policy, [
        dispatch,
        event(operationId, 1, "committing", "authority-change:prepared", "pending"),
        event(operationId, 2, "committing", "authority-change:observed", "succeeded"),
      ]),
    ).toThrow(/exact durable order/i);
    const grant = {
      proposal: { action: { type: "grant.create" } },
    } as unknown as ActionAuthoritySnapshotV1;
    expect(() =>
      validateOperationBatches(grant, [
        dispatch,
        event(operationId, 1, "committing", "authority-change:prepared", "pending"),
      ]),
    ).toThrow(/exact durable order/i);

    const reconcile = {
      proposal: { action: { type: "conversation.reconcile_revision_operation" } },
    } as unknown as ActionAuthoritySnapshotV1;
    expect(() =>
      validateOperationBatches(reconcile, [
        dispatch,
        event(operationId, 1, "succeeded", "revision:prepared", "succeeded"),
      ]),
    ).not.toThrow();
    expect(() =>
      validateOperationBatches(reconcile, [
        dispatch,
        event(operationId, 1, "failed", "revision:started", "failed"),
      ]),
    ).toThrow(/phase.*state/i);
    expect(() =>
      validateOperationBatches(reconcile, [
        dispatch,
        event(operationId, 1, "failed", "revision:needs_recovery", "failed"),
      ]),
    ).not.toThrow();
  });
});

function event(
  operationId: string,
  sequence: number,
  state: ActionOperationEventV1["state"],
  phase: NonNullable<ActionOperationEventV1["progress"]>["phase"],
  status: NonNullable<ActionOperationEventV1["progress"]>["status"],
): ActionOperationEventV1 {
  const occurred = new Date(fixedNow + sequence * 120_000).toISOString();
  return {
    schema_version: "1.0",
    operation_id: operationId,
    phase_sequence: sequence,
    state,
    progress: {
      sequence,
      phase,
      status,
      message_code: `operation.${phase}`,
      at: occurred,
    },
    target: null,
    error: null,
    occurred_at: occurred,
    event_cursor: `cursor-${sequence}`,
  };
}

function terminalAt(eventValue: ActionOperationEventV1, sequence: number): ActionOperationEventV1 {
  if (!eventValue.progress) throw new Error("terminal progress is missing");
  const occurred = new Date(fixedNow + sequence * 120_000).toISOString();
  return {
    ...eventValue,
    phase_sequence: sequence,
    occurred_at: occurred,
    event_cursor: `cursor-${sequence}`,
    progress: { ...eventValue.progress, sequence, at: occurred },
  };
}

function atTime(eventValue: ActionOperationEventV1, occurredAt: string): ActionOperationEventV1 {
  if (!eventValue.progress) throw new Error("operation progress fixture is missing");
  return {
    ...eventValue,
    occurred_at: occurredAt,
    progress: { ...eventValue.progress, at: occurredAt },
  };
}

function proposalAtBytes(targetBytes: number) {
  const reviewFields = Array.from({ length: 9 }, (_, index) => ({
    json_pointer: `/field-${index}`,
    label: `Field ${index}`,
    before: index < 8 ? "x".repeat(29_000) : "",
    after: index < 8 ? "y".repeat(29_000) : "",
    private_binding_digest: null,
  }));
  const initialDraft = proposalDraft({
    preview: { ...proposalDraft().preview, review_fields: reviewFields },
  });
  const remaining = targetBytes - canonicalJsonBytes(materializeProposal(initialDraft)).length;
  if (remaining < 0 || remaining > 2 * 32_766)
    throw new Error("proposal size fixture cannot reach its target");
  const beforeBytes = Math.min(remaining, 32_766);
  const afterBytes = remaining - beforeBytes;
  const last = reviewFields.at(-1);
  if (!last) throw new Error("missing proposal size tuner");
  const draft = proposalDraft({
    preview: {
      ...proposalDraft().preview,
      review_fields: [
        ...reviewFields.slice(0, -1),
        { ...last, before: "x".repeat(beforeBytes), after: "y".repeat(afterBytes) },
      ],
    },
  });
  return { draft, proposal: materializeProposal(draft) };
}

function targetEvent(
  operationId: string,
  sequence: number,
  state: ActionOperationEventV1["state"],
  target: PublicTargetResultV1 | undefined,
  outcome: PublicTargetResultV1["outcome"],
): ActionOperationEventV1 {
  if (!target) throw new Error("target fixture is missing");
  const phase = `target-${outcome}` as NonNullable<ActionOperationEventV1["progress"]>["phase"];
  const status =
    outcome === "applied"
      ? "succeeded"
      : outcome === "reversed" || outcome === "omitted"
        ? "reversed"
        : "failed";
  const projected = event(operationId, sequence, state, phase, status);
  if (!projected.progress) throw new Error("target event fixture is missing progress");
  return {
    ...projected,
    progress: projected.progress,
    target: { ...target, outcome },
  };
}

function capabilitySnapshot(state: "succeeded" | "failed"): {
  snapshot: ActionAuthoritySnapshotV1;
  targets: PublicTargetResultV1[];
} {
  const bindings = ["codex", "claude"]
    .map((engine, index) => {
      const identity = {
        target: {
          scope: "project" as const,
          engine: engine as "codex" | "claude",
          participant_id: null,
          required: true as const,
          on_apply_failure: "abort-scope" as const,
          on_health_failure: "abort-scope" as const,
        },
        subject: {
          kind: "capability" as const,
          package_id: "demo.package",
          component_id: `component-${index}`,
        },
      };
      return { target_id: targetId(identity), ...identity };
    })
    .sort((left, right) => Buffer.from(left.target_id).compare(Buffer.from(right.target_id)));
  const draft = proposalDraft();
  const proposal = materializeProposal(
    proposalDraft({
      domain: "capability",
      execution_object_closure_digest: testDigest("capability-closure"),
      base: { ...draft.base, capability_scope: "project" },
      action: {
        type: "capability.install",
        package: { id: "demo.package" },
        scope: "project",
        requested_targets: bindings.map((row) => ({
          engine: row.target.engine as "codex" | "claude",
          participant_id: null,
        })),
        inputs: [],
      },
      target_set: bindings,
      preview: {
        ...draft.preview,
        action_type: "capability.install",
        targets: bindings,
        target_dispositions: bindings.map((row) => ({
          target_id: row.target_id,
          execution: "host" as const,
          reason_code: null,
        })),
      },
    }),
  );
  const approval = materializeApproval(proposal, {
    decision: "approved",
    decided_by: authority.actor,
    challenge_class: "normal-confirm",
    challenge_digest: null,
    decided_at: new Date(fixedNow).toISOString(),
    expires_at: new Date(fixedNow + 30 * 60_000).toISOString(),
  });
  const operationId = deriveOperationId(proposal, approval.approval_id);
  return {
    snapshot: {
      proposal,
      approval,
      state,
      operation_id: operationId,
      dispatch_record_digest: testDigest("dispatch"),
      domain_terminal_digest: testDigest(`terminal-${state}`),
      events: [],
    },
    targets: bindings.map((row) => ({
      ...row,
      outcome: "applied",
      health: "ready",
      evidence_digest: testDigest(`evidence-${row.target_id}`),
    })),
  };
}
