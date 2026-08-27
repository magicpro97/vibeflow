import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../src/durability/index.js";
import {
  CONVERSATION_CONTEXT_HANDOFF_FIELDS,
  CONVERSATION_HANDOFF_CONTINUITIES,
  CONVERSATION_HANDOFF_OPTIONAL_GROUP_FIELDS,
  CONVERSATION_HANDOFF_SELECTION_PLAN_FIELDS,
  CONVERSATION_PUBLIC_ARTIFACT_DELIVERY,
  CONVERSATION_PUBLIC_ARTIFACT_KIND,
  CONVERSATION_PUBLIC_ARTIFACT_REFERENCE_FIELDS,
  CONVERSATION_PUBLIC_ARTIFACT_RESOLVER,
  CONVERSATION_PUBLIC_EVENT_RANGE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_BINDING_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_MESSAGE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_RESPONSE_FIELDS,
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS,
} from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "../../src/orchestrator/conversation/handoff-limits.js";
import { handoffSelectionPlanDigest } from "../../src/orchestrator/conversation/handoff-selection-plan.js";
import {
  buildContextHandoff,
  contextHandoffContentDigest,
  contextHandoffPromptDigest,
  contextHandoffSharedPromptBytes,
} from "../../src/orchestrator/conversation/handoff-selection.js";
import { ContextHandoffStore } from "../../src/orchestrator/conversation/handoff-store.js";
import type {
  ContextHandoffV1,
  HandoffSelectionPlanV1,
} from "../../src/orchestrator/conversation/handoff-types.js";
import { assertContextHandoffV1 } from "../../src/orchestrator/conversation/handoff-validation.js";
import { REVISION_HANDOFF_ARTIFACT } from "../../src/orchestrator/conversation/revision-handoff-contract.js";

const source = {
  conversation_id: "conversation-parent",
  revision_id: "revision-parent",
  last_seq: 8,
  lock_digest: digestV1("FIXTURE\0v1\0", { lock: true }),
};

function completeHandoffFixture() {
  return buildContextHandoff({
    source,
    topic: "Durable handoff",
    policy_value: "direct",
    bindings: [
      {
        participant_id: "participant-a",
        engine: "codex",
        model: "gpt-5.4",
        role_ref: "builder",
        continuity: "retained",
      },
    ],
    user_messages: [
      {
        event_id: "event-user-1",
        conversation_id: source.conversation_id,
        revision_id: source.revision_id,
        revision_ordinal: 0,
        public_seq: 1,
        author_public_id: "user",
        text: "Keep the contract closed.",
        created_at: "2026-08-25T00:00:00.000Z",
        redaction_manifest_digest: digestV1("FIXTURE\0v1\0", { redaction: "user" }),
      },
    ],
    final_responses: [
      {
        event_id: "event-response-2",
        conversation_id: source.conversation_id,
        revision_id: source.revision_id,
        revision_ordinal: 0,
        public_seq: 2,
        participant_id: "participant-a",
        role_ref: "builder",
        text: "Contract retained.",
        terminal_status: CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.COMPLETED,
        created_at: "2026-08-25T00:00:01.000Z",
        redaction_manifest_digest: digestV1("FIXTURE\0v1\0", { redaction: "response" }),
      },
    ],
    artifacts: [],
    consensus: { score: null, synthesis: null },
    prompt_budget_bytes: 64 * 1024,
  });
}

function redigestHandoff(handoff: ContextHandoffV1): ContextHandoffV1 {
  handoff.transcript = structuredClone(handoff.prompt_projection.transcript);
  handoff.prompt_projection_digest = contextHandoffPromptDigest(handoff.prompt_projection);
  const { handoff_id: _handoffId, digest: _digest, ...preimage } = handoff;
  handoff.digest = contextHandoffContentDigest(preimage);
  handoff.handoff_id = `vf-handoff-${digestHex(handoff.digest)}`;
  return handoff;
}

function redigestSelection(value: HandoffSelectionPlanV1): HandoffSelectionPlanV1 {
  const { selection_digest: _selectionDigest, ...preimage } = value;
  value.selection_digest = handoffSelectionPlanDigest(preimage);
  return value;
}

function bindSelection(
  handoff: ContextHandoffV1,
  selection: HandoffSelectionPlanV1,
): ContextHandoffV1 {
  handoff.handoff_selection_digest = selection.selection_digest;
  return redigestHandoff(handoff);
}

describe("canonical context handoff", () => {
  test("shares one frozen profile, artifact, and continuity vocabulary", () => {
    expect(Object.isFrozen(CONVERSATION_PUBLIC_PROFILE)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_ARTIFACT_KIND)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_ARTIFACT_RESOLVER)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_ARTIFACT_DELIVERY)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_ARTIFACT_REFERENCE_FIELDS)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_HANDOFF_BINDING_FIELDS)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_HANDOFF_MESSAGE_FIELDS)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_HANDOFF_RESPONSE_FIELDS)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_PUBLIC_EVENT_RANGE_FIELDS)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_CONTEXT_HANDOFF_FIELDS)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_HANDOFF_OPTIONAL_GROUP_FIELDS)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_HANDOFF_SELECTION_PLAN_FIELDS)).toBe(true);
    expect(Object.isFrozen(REVISION_HANDOFF_ARTIFACT)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_HANDOFF_CONTINUITIES)).toBe(true);
    expect(CONVERSATION_HANDOFF_CONTINUITIES).toEqual(["retained", "added"]);
    expect(Object.values(CONVERSATION_PUBLIC_ARTIFACT_DELIVERY)).toEqual([
      "inline-public-text",
      "conversation-artifact-resolver",
    ]);
  });

  test("is deterministic, ordered and byte-identical for every participant", () => {
    const result = buildContextHandoff({
      source,
      topic: "Continue the production repair",
      policy_value: "direct",
      bindings: [
        {
          participant_id: "participant-b",
          engine: "codex",
          model: "gpt-5.4",
          role_ref: "skeptic",
          continuity: "added",
        },
        {
          participant_id: "participant-a",
          engine: "claude",
          model: null,
          role_ref: "builder",
          continuity: "retained",
        },
      ],
      user_messages: [
        {
          event_id: "event-user-1",
          conversation_id: source.conversation_id,
          revision_id: source.revision_id,
          revision_ordinal: 0,
          public_seq: 2,
          author_public_id: "user",
          text: "Preserve the verified context.",
          created_at: "2026-08-25T00:00:00.000Z",
          redaction_manifest_digest: digestV1("FIXTURE\0v1\0", { redaction: 1 }),
        },
      ],
      final_responses: [],
      artifacts: [],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 64 * 1024,
    });
    assertContextHandoffV1(result.handoff);
    expect(result.handoff.bindings.map((row) => row.participant_id)).toEqual([
      "participant-a",
      "participant-b",
    ]);
    expect(Buffer.from(result.shared_prompt_bytes).toString("hex")).toBe(
      contextHandoffSharedPromptBytes(result.handoff.prompt_projection).toString("hex"),
    );
    expect(buildContextHandoff({ ...result.input }).handoff).toEqual(result.handoff);
  });

  test("preserves needs-input as a valid terminal response in a revision handoff", () => {
    const handoff = structuredClone(completeHandoffFixture().handoff);
    const response = handoff.prompt_projection.transcript.final_responses[0];
    if (!response) throw new Error("missing response fixture");
    response.terminal_status = CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.NEEDS_INPUT;

    expect(() => assertContextHandoffV1(redigestHandoff(handoff))).not.toThrow();
  });

  test("fails closed when mandatory bytes exceed the common bound", () => {
    expect(() =>
      buildContextHandoff({
        source,
        topic: "x".repeat(512),
        policy_value: "direct",
        bindings: [],
        user_messages: [],
        final_responses: [],
        artifacts: [],
        consensus: { score: null, synthesis: null },
        prompt_budget_bytes: 128,
      }),
    ).toThrow(/handoff_too_large/);
  });

  test("admits exactly one MiB of canonical shared handoff and rejects one byte more", () => {
    const seed = buildContextHandoff({
      source,
      topic: "",
      policy_value: "direct",
      bindings: [],
      user_messages: [],
      final_responses: [],
      artifacts: [],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: MAX_CANONICAL_HANDOFF_BYTES,
    }).handoff.prompt_projection;
    const baseLength = contextHandoffSharedPromptBytes(seed).byteLength;
    seed.topic = "x".repeat(MAX_CANONICAL_HANDOFF_BYTES - baseLength);
    expect(contextHandoffSharedPromptBytes(seed)).toHaveLength(MAX_CANONICAL_HANDOFF_BYTES);
    seed.topic += "x";
    expect(() => contextHandoffSharedPromptBytes(seed)).toThrow();
  });

  test("rejects fully re-digested persisted events outside their exact variant contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-handoff-event-contract-"));
    try {
      const store = new ContextHandoffStore({ artifactRoot: root });
      const cases: Array<[string, (handoff: ContextHandoffV1) => void]> = [
        [
          "unknown terminal status",
          (handoff) => {
            const response = handoff.prompt_projection.transcript.final_responses[0];
            if (!response) throw new Error("missing response fixture");
            (response as unknown as Record<string, unknown>).terminal_status = "invented";
          },
        ],
        [
          "extra message field",
          (handoff) => {
            const message = handoff.prompt_projection.transcript.user_messages[0];
            if (!message) throw new Error("missing message fixture");
            (message as unknown as Record<string, unknown>).unexpected = true;
          },
        ],
        [
          "missing message author",
          (handoff) => {
            const message = handoff.prompt_projection.transcript.user_messages[0];
            if (!message) throw new Error("missing message fixture");
            Reflect.deleteProperty(
              message as unknown as Record<string, unknown>,
              "author_public_id",
            );
          },
        ],
        [
          "invalid response participant",
          (handoff) => {
            const response = handoff.prompt_projection.transcript.final_responses[0];
            if (!response) throw new Error("missing response fixture");
            response.participant_id = "";
          },
        ],
        [
          "missing response role",
          (handoff) => {
            const response = handoff.prompt_projection.transcript.final_responses[0];
            if (!response) throw new Error("missing response fixture");
            Reflect.deleteProperty(response as unknown as Record<string, unknown>, "role_ref");
          },
        ],
        [
          "duplicate event id across variants",
          (handoff) => {
            const response = handoff.prompt_projection.transcript.final_responses[0];
            if (!response) throw new Error("missing response fixture");
            response.event_id = "event-user-1";
          },
        ],
        [
          "private credential-shaped message text",
          (handoff) => {
            const message = handoff.prompt_projection.transcript.user_messages[0];
            if (!message) throw new Error("missing message fixture");
            message.text = "api_key=sk-ABCDEFGHIJKLMNOPQRSTUV";
          },
        ],
      ];
      for (const [label, mutate] of cases) {
        const handoff = structuredClone(completeHandoffFixture().handoff);
        mutate(handoff);
        redigestHandoff(handoff);
        await writeFile(
          join(root, "objects", "v1", `${digestHex(handoff.digest)}.json`),
          canonicalJsonBytes(handoff),
          { mode: 0o600 },
        );
        expect(() => store.read(handoff.digest), label).toThrow(/public handoff event/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects fully re-digested forged selection plans at the write boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-handoff-selection-contract-"));
    try {
      const store = new ContextHandoffStore({ artifactRoot: root });
      const valid = completeHandoffFixture();
      expect(() => store.write(valid.handoff, valid.selection_plan)).not.toThrow();

      const nestedForgery = structuredClone(valid.selection_plan);
      const group = nestedForgery.optional_groups[0];
      if (!group) throw new Error("missing optional group fixture");
      group.event_ids.push("forged-event");
      redigestSelection(nestedForgery);
      expect(() =>
        store.write(bindSelection(structuredClone(valid.handoff), nestedForgery), nestedForgery),
      ).toThrow(/optional group digest/);

      const compactionForgery = structuredClone(valid.selection_plan);
      compactionForgery.active_compaction_digest = source.lock_digest;
      redigestSelection(compactionForgery);
      expect(() =>
        store.write(
          bindSelection(structuredClone(valid.handoff), compactionForgery),
          compactionForgery,
        ),
      ).toThrow(/active compaction closure/);

      for (const mutate of [
        (plan: Record<string, unknown>) => {
          plan.unexpected = true;
        },
        (plan: Record<string, unknown>) => {
          Reflect.deleteProperty(plan, "active_compaction_digest");
        },
        (plan: Record<string, unknown>) => {
          plan.prompt_budget_bytes = 0;
        },
      ]) {
        const forged = structuredClone(valid.selection_plan) as unknown as Record<string, unknown>;
        mutate(forged);
        const redigested = redigestSelection(forged as unknown as HandoffSelectionPlanV1);
        expect(() =>
          store.write(bindSelection(structuredClone(valid.handoff), redigested), redigested),
        ).toThrow(/handoff selection plan/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces every dropped response with one maximal durable omission range", async () => {
    const responses = [2, 3, 4].map((public_seq) => ({
      event_id: `event-response-${public_seq}`,
      conversation_id: source.conversation_id,
      revision_id: source.revision_id,
      revision_ordinal: 0,
      public_seq,
      participant_id: "participant-a",
      role_ref: "builder",
      text: "r".repeat(2_000),
      terminal_status: "completed" as const,
      created_at: "2026-08-25T00:00:00.000Z",
      redaction_manifest_digest: digestV1("FIXTURE\0v1\0", { public_seq }),
    }));
    const result = buildContextHandoff({
      source,
      topic: "topic",
      policy_value: "direct",
      bindings: [],
      user_messages: [],
      final_responses: responses,
      artifacts: [],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 4_000,
    });
    const omitted = result.omitted_public_event_artifacts;
    expect(omitted).toHaveLength(1);
    const [omission] = omitted;
    if (!omission) throw new Error("expected one omission artifact");
    const retained = result.handoff.transcript.final_responses.length;
    expect(omission.range).toMatchObject({
      first_event_id: responses[0]?.event_id,
      last_event_id: responses[responses.length - retained - 1]?.event_id,
      event_count: responses.length - retained,
    });
    expect(result.handoff.artifacts).toContainEqual(omission.range.artifact);
    expect(result.selection_plan.mandatory_artifact_ids).toContain(
      omission.range.artifact.artifact_id,
    );
    expect(JSON.parse(omission.bytes.toString("utf8")).events).toEqual(
      responses.slice(0, responses.length - retained),
    );
    assertContextHandoffV1(result.handoff);

    const root = await mkdtemp(join(tmpdir(), "vf-handoff-omission-"));
    try {
      const store = new ContextHandoffStore({ artifactRoot: root });
      store.write(result.handoff, result.selection_plan, result.omitted_public_event_artifacts);
      expect(store.readOmission(omission.range.artifact.content_sha256)).toEqual(omission.bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
