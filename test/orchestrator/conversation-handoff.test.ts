import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "../../src/orchestrator/conversation/handoff-limits.js";
import {
  buildContextHandoff,
  contextHandoffSharedPromptBytes,
} from "../../src/orchestrator/conversation/handoff-selection.js";
import { ContextHandoffStore } from "../../src/orchestrator/conversation/handoff-store.js";
import { assertContextHandoffV1 } from "../../src/orchestrator/conversation/handoff-validation.js";

const source = {
  conversation_id: "conversation-parent",
  revision_id: "revision-parent",
  last_seq: 8,
  lock_digest: digestV1("FIXTURE\0v1\0", { lock: true }),
};

describe("canonical context handoff", () => {
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
