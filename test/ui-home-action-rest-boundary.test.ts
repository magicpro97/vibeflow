import { afterEach, describe, expect, test } from "bun:test";
import { parseActionOperation } from "../src/ui/src/conversation-home-action-operation-boundary.js";
import { parseActionProposal } from "../src/ui/src/conversation-home-action-proposal-boundary.js";
import {
  ConversationHomeApiError,
  conversationHomeApi,
} from "../src/ui/src/conversation-home-api.js";

const originalFetch = globalThis.fetch;

const digest = (digit: string) => `sha256:${digit.repeat(64).slice(0, 64)}`;
const proposalId = (digit: string) => `vf-proposal-${digit.repeat(64).slice(0, 64)}`;
const approvalId = (digit: string) => `vf-approval-${digit.repeat(64).slice(0, 64)}`;
const operationId = (digit: string) => `vf-operation-${digit.repeat(64).slice(0, 64)}`;
const correlationId = (digit: string) => `vf-correlation-${digit.repeat(64).slice(0, 64)}`;
const eventCursor = (digit: string) => `vf-operation-event-${digit.repeat(64).slice(0, 64)}`;
const challengeId = (character = "A") => character.repeat(43);
const signedCursor = (seed: string) => `${seed}Body.${seed}Signature`;
const now = "2026-08-26T00:00:00.000Z";
const later = "2026-08-26T01:00:00.000Z";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function actionTarget(required = true) {
  return {
    target_id: "target-a",
    target: {
      scope: "project" as const,
      engine: null,
      participant_id: null,
      required,
      on_apply_failure: required ? ("abort-scope" as const) : ("omit-after-rollback" as const),
      on_health_failure: required ? ("abort-scope" as const) : ("commit-degraded" as const),
    },
    subject: capabilitySubject(),
  };
}

function capabilitySubject() {
  return {
    kind: "capability" as const,
    package_id: "acme/tool",
    component_id: "component-a",
  };
}

function packagePin() {
  return {
    id: "acme/tool",
    version: "1.2.3",
    source_kind: "registry" as const,
    content_sha256: "a".repeat(64),
    trust: "verified" as const,
    nonportable: false,
    pin_digest: digest("b"),
  };
}

function preview() {
  return {
    title: "Install capability",
    summary: "Install the capability for the current conversation.",
    action_type: "capability.install",
    planning_options: { mode: "durable" as const, network_read: "ordinary-host-policy" as const },
    review_fields: [],
    targets: [actionTarget()],
    target_dispositions: [{ target_id: "target-a", execution: "host" as const, reason_code: null }],
    package_pins: [packagePin()],
    permission_delta: [
      {
        permission_id: "capabilities/install",
        change: "add" as const,
        public_scope: "project",
        enforcement: "brokered" as const,
      },
    ],
    dependency_delta: [],
    config_diffs: [],
    effect_classes: ["project-write"] as const,
    enforcement: [
      {
        permission_id: "capabilities/install",
        engine: "codex" as const,
        enforcement: "brokered" as const,
        explanation: "Brokered by VibeFlow.",
      },
    ],
    reversibility: "reversible" as const,
    health_plan: [],
    recovery_actions: ["retry"] as const,
    projector_version: "vf-public-projector/1" as const,
    rules_digest: digest("c"),
    redaction_manifest_digest: digest("d"),
  };
}

function proposalView(seed = "1") {
  return {
    schema_version: "1.0" as const,
    proposal_id: proposalId(seed),
    proposal_digest: digest(seed),
    origin_event_id: null,
    action_type: "capability.install" as const,
    domain: "capability" as const,
    scope: "project" as const,
    authority_binding_mode: "current" as const,
    risk: "medium" as const,
    effect_classes: ["project-write"] as const,
    targets: [actionTarget()],
    package_pins: [packagePin()],
    adapter_set_digest: digest("2"),
    plan_digest: digest("3"),
    policy_digest: digest("4"),
    permission_digest: digest("5"),
    reversibility: "reversible" as const,
    preview: preview(),
    created_at: now,
    expires_at: later,
  };
}

function approvalView(seed = "1") {
  return {
    schema_version: "1.0" as const,
    approval_id: approvalId(seed),
    approval_digest: digest(`a${seed}`),
    proposal_id: proposalId(seed),
    proposal_digest: digest(seed),
    decision: "approved" as const,
    challenge_class: "fresh-user-scope" as const,
    decided_by: {
      kind: "human-browser" as const,
      public_actor_id: "user-a",
      credential_class: "loopback-session" as const,
    },
    decided_at: now,
    expires_at: later,
  };
}

function committedOperation(seed = "1") {
  return {
    schema_version: "1.0" as const,
    operation_id: operationId(seed),
    proposal_id: proposalId(seed),
    proposal_digest: digest(seed),
    approval_id: approvalId(seed),
    approval_digest: digest(`a${seed}`),
    correlation_id: correlationId(seed),
    domain: "capability" as const,
    state: "committing" as const,
    phase_sequence: 0,
    latest_event_cursor: eventCursor(seed),
    progress: [
      {
        sequence: 0,
        phase: "operation-started" as const,
        status: "running" as const,
        message_code: "operation.operation-started" as const,
        at: now,
      },
    ],
    targets: [],
    delivery: "pending" as const,
    result_ref: null,
    error: null,
    recovery_actions: [] as const,
    created_at: now,
    updated_at: now,
  };
}

function pendingOperation(seed = "1") {
  return {
    schema_version: "1.0" as const,
    operation_id: null,
    proposal_id: proposalId(seed),
    proposal_digest: digest(seed),
    approval_id: null,
    approval_digest: null,
    correlation_id: correlationId(seed),
    domain: "capability" as const,
    state: "pending_review" as const,
    phase_sequence: null,
    latest_event_cursor: null,
    progress: [],
    targets: [],
    delivery: "not-applicable" as const,
    result_ref: null,
    error: null,
    recovery_actions: [],
    created_at: now,
    updated_at: now,
  };
}

function actionResponse(seed = "1", operation = pendingOperation(seed)) {
  return {
    schema_version: "1.0" as const,
    proposal: proposalView(seed),
    approval: null,
    operation,
  };
}

function timelineResponse() {
  return {
    schema_version: "1.0" as const,
    root_session_id: "root-a",
    head: {
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      revision_ordinal: 0,
    },
    head_epoch: 1,
    head_digest: digest("e"),
    items: [
      {
        kind: "conversation-start" as const,
        revision_ordinal: 0,
        conversation_id: "conversation-a",
        revision_id: "revision-a",
        anchor_id: "anchor-a",
        action_operations: {
          schema_version: "1.0" as const,
          items: [committedOperation("7")],
          next_cursor: signedCursor("timeline"),
          proposal_set_watermark: digest("f"),
        },
      },
    ],
    next_cursor: signedCursor("head"),
  };
}

function installFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("Home action REST boundary", () => {
  test("accepts valid action REST payloads and normalizes timeline action pages", async () => {
    installFetch(actionResponse("1"));
    const proposed = await conversationHomeApi.propose(
      "conversation-a",
      {
        mode: "writable-revision",
        conversation_id: "conversation-a",
        revision_id: "revision-a",
        last_seq: 0,
        conversation_lock_digest: digest("1"),
      },
      {
        type: "capability.install",
        package: { id: "acme/tool" },
        scope: "project",
        requested_targets: [{ engine: "codex", participant_id: null }],
        inputs: [],
      },
      "idempotency-a",
    );
    expect(proposed.proposal.preview.title).toBe("Install capability");
    expect(proposed.proposal.package_pins).toEqual([
      {
        id: "acme/tool",
        version: "1.2.3",
        source_kind: "registry",
        content_sha256: "a".repeat(64),
        trust: "verified",
        nonportable: false,
        pin_digest: digest("b"),
      },
    ]);

    installFetch(
      {
        schema_version: "1.0",
        challenge_id: challengeId(),
        challenge_class: "public-literal",
        display_phrase: "publish abcdef012345",
        expires_at: later,
      },
      201,
    );
    const challenge = await conversationHomeApi.challenge(
      "conversation-a",
      proposalId("2"),
      digest("2"),
      "public-literal",
    );
    expect(challenge).toEqual({
      schema_version: "1.0",
      challenge_id: challengeId(),
      challenge_class: "public-literal",
      display_phrase: "publish abcdef012345",
      expires_at: later,
    });

    installFetch({
      schema_version: "1.0",
      approval: approvalView("2"),
      operation: {
        ...pendingOperation("2"),
        approval_id: approvalId("2"),
        approval_digest: digest("a2"),
        state: "approved",
      },
    });
    const approved = await conversationHomeApi.approve(
      "conversation-a",
      proposalId("2"),
      digest("2"),
      "approved",
      { id: "challenge-a", response: "approve" },
    );
    expect(approved.approval.approval_id).toBe(approvalId("2"));
    expect(approved.operation.state).toBe("approved");

    installFetch({ schema_version: "1.0", operation: committedOperation("3") });
    const committed = await conversationHomeApi.commit(
      "conversation-a",
      proposalId("3"),
      digest("3"),
      approvalId("3"),
    );
    expect(committed.operation.phase_sequence).toBe(0);
    expect(committed.operation.latest_event_cursor).toBe(eventCursor("3"));

    installFetch({
      schema_version: "1.0",
      operation: { ...pendingOperation("4"), state: "canceled" },
    });
    const canceled = await conversationHomeApi.cancel(
      "conversation-a",
      proposalId("4"),
      digest("4"),
    );
    expect(canceled.schema_version).toBe("1.0");
    expect(canceled.operation.state).toBe("canceled");

    installFetch({
      schema_version: "1.0",
      items: [actionResponse("5")],
      next_cursor: signedCursor("pending"),
      authority_watermark: digest("9"),
    });
    const pending = await conversationHomeApi.pending("conversation-a", { limit: 1 });
    expect(pending.next_cursor).toBe(signedCursor("pending"));
    expect(pending.items[0]?.operation.correlation_id).toBe(correlationId("5"));

    installFetch(timelineResponse());
    const timeline = await conversationHomeApi.timeline({ rootSessionId: "root-a", limit: 1 });
    expect(timeline.items[0]?.kind).toBe("conversation-start");
    if (timeline.items[0]?.kind === "conversation-start") {
      expect(timeline.items[0].action_operations.items[0]?.operation_id).toBe(operationId("7"));
      expect(timeline.items[0].action_operations.proposal_set_watermark).toBe(digest("f"));
    }
  });

  test("rejects an unknown operation state in proposed action payloads", async () => {
    installFetch({
      ...actionResponse("6"),
      operation: { ...pendingOperation("6"), state: "invented" },
    });
    await expect(
      conversationHomeApi.propose(
        "conversation-a",
        {
          mode: "writable-revision",
          conversation_id: "conversation-a",
          revision_id: "revision-a",
          last_seq: 0,
          conversation_lock_digest: digest("6"),
        },
        {
          type: "capability.install",
          package: { id: "acme/tool" },
          scope: "project",
          requested_targets: [{ engine: "codex", participant_id: null }],
          inputs: [],
        },
        "idempotency-b",
      ),
    ).rejects.toMatchObject({
      name: "ConversationHomeApiError",
      status: 200,
      publicError: { code: "invalid_response", retryable: false },
    });
  });

  test("rejects malformed, cross-class, and extended approval challenge responses", async () => {
    const valid = {
      schema_version: "1.0",
      challenge_id: challengeId(),
      challenge_class: "public-literal",
      display_phrase: "publish abcdef012345",
      expires_at: later,
    };
    const malformed = [
      {
        challenge_id: 7,
        display_phrase: null,
        expires_at: "not-a-time",
        unexpected: true,
      },
      { ...valid, challenge_class: "fresh-user-scope" },
      { ...valid, display_phrase: "user abcdef012345" },
      { ...valid, unexpected: true },
    ];
    for (const body of malformed) {
      installFetch(body, 201);
      await expect(
        conversationHomeApi.challenge(
          "conversation-a",
          proposalId("2"),
          digest("2"),
          "public-literal",
        ),
      ).rejects.toMatchObject({
        name: "ConversationHomeApiError",
        status: 201,
        publicError: { code: "invalid_response", retryable: false },
      });
    }
  });

  test("rejects invalid sequence, id, correlation, and event cursor in action mutations", async () => {
    const cases = [
      { operation: { ...committedOperation("8"), phase_sequence: 1 }, label: "sequence" },
      { operation: { ...committedOperation("9"), operation_id: "bad-operation" }, label: "id" },
      {
        operation: { ...committedOperation("a"), correlation_id: "bad-correlation" },
        label: "correlation",
      },
      {
        operation: { ...committedOperation("b"), latest_event_cursor: "bad-cursor" },
        label: "cursor",
      },
    ];
    for (const row of cases) {
      installFetch({ schema_version: "1.0", operation: row.operation });
      await expect(
        conversationHomeApi.commit("conversation-a", proposalId("c"), digest("c"), approvalId("c")),
        row.label,
      ).rejects.toMatchObject({
        publicError: { code: "invalid_response" },
      });
    }
  });

  test("rejects v1 operation semantic and approval closure mismatches", async () => {
    const malformedOperations = [
      { ...committedOperation("8"), result_ref: "future-result" },
      { ...committedOperation("9"), approval_digest: null },
      {
        ...committedOperation("a"),
        progress: [
          {
            ...committedOperation("a").progress[0],
            status: "succeeded",
          },
        ],
      },
    ];
    for (const operation of malformedOperations) {
      installFetch({ schema_version: "1.0", operation });
      await expect(
        conversationHomeApi.commit("conversation-a", proposalId("8"), digest("8"), approvalId("8")),
      ).rejects.toMatchObject({ publicError: { code: "invalid_response" } });
    }

    installFetch({
      ...actionResponse("b"),
      operation: { ...pendingOperation("b"), proposal_digest: digest("c") },
    });
    await expect(conversationHomeApi.pending("conversation-a")).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });

    for (const approval of [
      { ...approvalView("b"), decided_at: "2026-08-25T23:59:59.999Z" },
      { ...approvalView("b"), expires_at: "2026-08-26T01:00:00.001Z" },
    ]) {
      installFetch({
        ...actionResponse("b"),
        approval,
        operation: {
          ...pendingOperation("b"),
          approval_id: approval.approval_id,
          approval_digest: approval.approval_digest,
          state: "approved",
        },
      });
      await expect(conversationHomeApi.pending("conversation-a")).rejects.toMatchObject({
        publicError: { code: "invalid_response" },
      });
    }

    installFetch({
      schema_version: "1.0",
      approval: approvalView("c"),
      operation: {
        ...pendingOperation("c"),
        approval_id: approvalId("d"),
        approval_digest: digest("ad"),
        state: "approved",
      },
    });
    await expect(
      conversationHomeApi.approve("conversation-a", proposalId("c"), digest("c"), "approved", null),
    ).rejects.toMatchObject({ publicError: { code: "invalid_response" } });
  });

  test("uses producer phase authority for standalone terminal operations", () => {
    const revisionSucceeded = {
      ...committedOperation("1"),
      domain: "conversation",
      state: "succeeded",
      phase_sequence: 1,
      progress: [
        {
          sequence: 0,
          phase: "dispatch",
          status: "running",
          message_code: "operation.dispatch",
          at: now,
        },
        {
          sequence: 1,
          phase: "revision:started",
          status: "succeeded",
          message_code: "operation.revision:started",
          at: later,
        },
      ],
      delivery: "not-applicable",
      updated_at: later,
    };
    expect(parseActionOperation(revisionSucceeded).state).toBe("succeeded");

    const impossibleRevisionTerminal = {
      ...revisionSucceeded,
      state: "failed",
      progress: [
        revisionSucceeded.progress[0],
        { ...revisionSucceeded.progress[1], status: "failed" },
      ],
      recovery_actions: ["retry"],
    };
    expect(() => parseActionOperation(impossibleRevisionTerminal)).toThrow(
      /producer phase semantics/i,
    );

    const mismatchedTerminal = {
      ...committedOperation("2"),
      state: "succeeded",
      phase_sequence: 1,
      progress: [
        committedOperation("2").progress[0],
        {
          sequence: 1,
          phase: "operation-failed",
          status: "failed",
          message_code: "operation.operation-failed",
          at: later,
        },
      ],
      updated_at: later,
    };
    expect(() => parseActionOperation(mismatchedTerminal)).toThrow(/producer phase semantics/i);
  });

  test("binds each proposal action family to its declared domain", () => {
    const mismatched = proposalView("3");
    mismatched.action_type = "conversation.add_participant" as never;
    mismatched.preview.action_type = "conversation.add_participant" as never;
    expect(() => parseActionProposal(mismatched)).toThrow(/belong to its domain/i);
  });

  test("rejects review previews that do not describe the approved proposal", async () => {
    const body = actionResponse("d");
    installFetch({
      ...body,
      proposal: {
        ...body.proposal,
        preview: {
          ...body.proposal.preview,
          effect_classes: ["user-write"],
        },
      },
    });
    await expect(conversationHomeApi.pending("conversation-a")).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });

    const inner = actionTarget().target;
    const wrongShape = actionResponse("e");
    installFetch({
      ...wrongShape,
      proposal: {
        ...wrongShape.proposal,
        targets: [inner],
        preview: { ...wrongShape.proposal.preview, targets: [inner] },
      },
    });
    await expect(conversationHomeApi.pending("conversation-a")).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });
  });

  test("rejects target subjects and mutation responses that escape immutable request bindings", async () => {
    const mismatchedSubject = actionResponse("e");
    mismatchedSubject.proposal.targets = [
      {
        ...actionTarget(),
        subject: {
          kind: "conversation" as const,
          action_type: "conversation.remove_participant" as const,
          participant_id: null,
        },
      } as unknown as (typeof mismatchedSubject.proposal.targets)[number],
    ];
    mismatchedSubject.proposal.preview.targets = structuredClone(
      mismatchedSubject.proposal.targets,
    );
    installFetch({
      schema_version: "1.0",
      items: [mismatchedSubject],
      next_cursor: null,
      authority_watermark: digest("e"),
    });
    await expect(conversationHomeApi.pending("conversation-a")).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });

    installFetch({
      schema_version: "1.0",
      approval: approvalView("f"),
      operation: {
        ...pendingOperation("f"),
        approval_id: approvalId("f"),
        approval_digest: digest("af"),
        state: "approved",
      },
    });
    await expect(
      conversationHomeApi.approve("conversation-a", proposalId("f"), digest("f"), "denied", null),
    ).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });

    installFetch({
      schema_version: "1.0",
      operation: { ...committedOperation("g"), proposal_id: proposalId("h") },
    });
    await expect(
      conversationHomeApi.commit("conversation-a", proposalId("g"), digest("g"), approvalId("g")),
    ).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });
  });

  test("rejects operation and approval chronologies that run before their authority exists", async () => {
    installFetch({
      schema_version: "1.0",
      operation: {
        ...committedOperation("i"),
        created_at: later,
        updated_at: later,
      },
    });
    await expect(
      conversationHomeApi.commit("conversation-a", proposalId("i"), digest("i"), approvalId("i")),
    ).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });

    installFetch({
      schema_version: "1.0",
      approval: approvalView("j"),
      operation: {
        ...committedOperation("j"),
        progress: [
          {
            ...committedOperation("j").progress[0],
            at: "2026-08-25T23:59:59.999Z",
          },
        ],
      },
    });
    await expect(
      conversationHomeApi.approve("conversation-a", proposalId("j"), digest("j"), "approved", null),
    ).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });
  });

  test("rejects invalid pending cursors and exact-field violations", async () => {
    installFetch({
      schema_version: "1.0",
      items: [actionResponse("d")],
      next_cursor: "not a cursor",
      authority_watermark: digest("d"),
    });
    await expect(conversationHomeApi.pending("conversation-a")).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });

    installFetch({
      schema_version: "1.0",
      items: [{ ...actionResponse("e"), operation: { ...pendingOperation("e"), extra: true } }],
      next_cursor: null,
      authority_watermark: digest("e"),
    });
    await expect(conversationHomeApi.pending("conversation-a")).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });
  });

  test("rejects extra keys inside timeline action operation pages", async () => {
    const body = timelineResponse();
    const first = body.items[0];
    if (first?.kind === "conversation-start") {
      first.action_operations = {
        ...first.action_operations,
        rogue: true,
      } as typeof first.action_operations & { rogue: boolean };
    }
    installFetch(body);
    await expect(conversationHomeApi.timeline({ rootSessionId: "root-a" })).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });
  });

  test("rejects prototype-shaped closed-vocabulary values", async () => {
    installFetch({
      schema_version: "1.0",
      operation: { ...committedOperation("f"), delivery: "__proto__" },
    });
    await expect(
      conversationHomeApi.commit("conversation-a", proposalId("f"), digest("f"), approvalId("f")),
    ).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });

    const body = timelineResponse();
    body.items = [
      { ...(body.items[0] ?? {}), kind: "constructor" },
    ] as unknown as typeof body.items;
    installFetch(body);
    await expect(conversationHomeApi.timeline({ rootSessionId: "root-a" })).rejects.toMatchObject({
      publicError: { code: "invalid_response" },
    });
  });
});
