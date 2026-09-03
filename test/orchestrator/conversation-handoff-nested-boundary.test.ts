import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../src/durability/index.js";
import {
  CONVERSATION_PUBLIC_ARTIFACT_KIND,
  CONVERSATION_PUBLIC_ARTIFACT_RESOLVER,
  CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_BYTES,
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
} from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import { assertPublicCompactionArtifactV1 } from "../../src/orchestrator/conversation/handoff-nested-validation.js";
import {
  handoffSelectionPlanDigest,
  materializeHandoffOptionalGroup,
} from "../../src/orchestrator/conversation/handoff-selection-plan.js";
import {
  buildContextHandoff,
  contextHandoffContentDigest,
  contextHandoffPromptDigest,
  handoffSourcePublicHeadDigest,
} from "../../src/orchestrator/conversation/handoff-selection.js";
import { ContextHandoffStore } from "../../src/orchestrator/conversation/handoff-store.js";
import type {
  ContextHandoffV1,
  PublicCompactionArtifactV1,
  PublicHandoffMessageV1,
} from "../../src/orchestrator/conversation/handoff-types.js";
import { assertContextHandoffV1 } from "../../src/orchestrator/conversation/handoff-validation.js";

const source = {
  conversation_id: "conversation-parent",
  revision_id: "revision-parent",
  last_seq: 1,
  lock_digest: digestV1("NESTED-FIXTURE\0v1\0", { lock: true }),
};
const message: PublicHandoffMessageV1 = {
  event_id: "event-user-1",
  conversation_id: source.conversation_id,
  revision_id: source.revision_id,
  revision_ordinal: 0,
  public_seq: 1,
  author_public_id: "user",
  text: "Retain exact nested authority.",
  created_at: "2026-08-25T00:00:00.000Z",
  redaction_manifest_digest: digestV1("NESTED-FIXTURE\0v1\0", { redaction: true }),
};

function compaction(): PublicCompactionArtifactV1 {
  const preimage = {
    schema_version: CONVERSATION_PUBLIC_SCHEMA_VERSION,
    profile: CONVERSATION_PUBLIC_PROFILE.COMPACTION,
    source: structuredClone(source),
    source_public_head_digest: handoffSourcePublicHeadDigest(source, [message]),
    oversized_candidate_digest: digestV1("NESTED-FIXTURE\0v1\0", { oversized: true }),
    selection_plan_digest: digestV1("NESTED-FIXTURE\0v1\0", { selection: true }),
    previous_compaction_digest: null,
    compaction_input_digest: digestV1("NESTED-FIXTURE\0v1\0", { input: true }),
    public_summary: "Reviewed summary.",
    retained_event_ids: [message.event_id],
    retained_artifact_ids: ["artifact-a"],
    omitted_public_ranges: [],
    created_at: "2026-08-25T00:00:01.000Z",
  };
  return {
    ...preimage,
    content_digest: digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", preimage),
  };
}

function fixture() {
  return buildContextHandoff({
    source,
    topic: "Nested boundary",
    policy_value: "direct",
    bindings: [],
    user_messages: [message],
    final_responses: [],
    artifacts: [
      {
        artifact_id: "artifact-a",
        artifact_kind: CONVERSATION_PUBLIC_ARTIFACT_KIND.CONVERSATION,
        media_type: "text/plain",
        byte_length: 0,
        content_sha256: createHash("sha256").update("").digest("hex"),
        resolver: CONVERSATION_PUBLIC_ARTIFACT_RESOLVER.CONVERSATION,
      },
    ],
    consensus: { score: null, synthesis: null },
    prompt_budget_bytes: 64 * 1024,
    active_compaction: compaction(),
  });
}

function redigest(handoff: ContextHandoffV1): ContextHandoffV1 {
  handoff.prompt_projection_digest = contextHandoffPromptDigest(handoff.prompt_projection);
  const { handoff_id: _handoffId, digest: _digest, ...preimage } = handoff;
  handoff.digest = contextHandoffContentDigest(preimage);
  handoff.handoff_id = `vf-handoff-${digestHex(handoff.digest)}`;
  return handoff;
}

describe("context handoff nested read boundary", () => {
  test("bounds compaction summaries by UTF-8 bytes rather than JSON escape bytes", () => {
    const artifact = compaction();
    artifact.public_summary = '"'.repeat(40_000);
    const { content_digest: _contentDigest, ...preimage } = artifact;
    artifact.content_digest = digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", preimage);

    expect(() => assertPublicCompactionArtifactV1(artifact)).not.toThrow();
  });

  test("rejects fully re-digested malformed nested shells and values", async () => {
    const valid = fixture();
    assertContextHandoffV1(valid.handoff);
    const root = await mkdtemp(join(tmpdir(), "vf-handoff-nested-contract-"));
    try {
      const store = new ContextHandoffStore({ artifactRoot: root });
      store.write(valid.handoff, valid.selection_plan);
      expect(store.read(valid.handoff.digest)).toEqual(valid.handoff);
      const cases: Array<[string, (handoff: ContextHandoffV1) => void]> = [
        [
          "consensus domain and extra field",
          (handoff) => {
            const consensus = { score: 2, synthesis: 7, unexpected: true };
            handoff.consensus = consensus as unknown as ContextHandoffV1["consensus"];
            handoff.prompt_projection.consensus = structuredClone(handoff.consensus);
          },
        ],
        [
          "source extra field",
          (handoff) => {
            (handoff.source as unknown as Record<string, unknown>).unexpected = true;
            handoff.prompt_projection.source = structuredClone(handoff.source);
          },
        ],
        [
          "self-digested policy with an extra field",
          (handoff) => {
            const policy = handoff.policy as unknown as Record<string, unknown>;
            policy.unexpected = true;
            const { policy_id: _policyId, policy_digest: _policyDigest, ...preimage } = policy;
            const digest = digestV1("VF-PUBLIC-HANDOFF-POLICY\0v1\0", preimage);
            policy.policy_digest = digest;
            policy.policy_id = `vf-handoff-policy-${digestHex(digest)}`;
            handoff.prompt_projection.policy = structuredClone(handoff.policy);
          },
        ],
        [
          "transcript extra field",
          (handoff) => {
            (handoff.transcript as unknown as Record<string, unknown>).unexpected = true;
            handoff.prompt_projection.transcript = structuredClone(handoff.transcript);
          },
        ],
        [
          "projection extra field",
          (handoff) => {
            (handoff.prompt_projection as unknown as Record<string, unknown>).unexpected = true;
          },
        ],
        [
          "private credential-shaped topic",
          (handoff) => {
            handoff.topic = "api_key=sk-ABCDEFGHIJKLMNOPQRSTUV";
            handoff.prompt_projection.topic = handoff.topic;
          },
        ],
        [
          "artifact selection delivery",
          (handoff) => {
            const selection = handoff.prompt_projection.artifacts[0];
            if (!selection) throw new Error("missing artifact selection fixture");
            (selection as unknown as Record<string, unknown>).delivery = "invented";
          },
        ],
        [
          "self-digested malformed compaction",
          (handoff) => {
            const active = handoff.compaction as unknown as Record<string, unknown>;
            active.public_summary = 7;
            active.unexpected = true;
            const { content_digest: _contentDigest, ...preimage } = active;
            active.content_digest = digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", preimage);
            handoff.prompt_projection.compaction = structuredClone(handoff.compaction);
          },
        ],
        [
          "self-digested oversized compaction summary",
          (handoff) => {
            const active = handoff.compaction;
            if (!active) throw new Error("missing active compaction fixture");
            active.public_summary = "x".repeat(
              CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_BYTES + 1,
            );
            const { content_digest: _contentDigest, ...preimage } = active;
            active.content_digest = digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", preimage);
            handoff.prompt_projection.compaction = structuredClone(active);
          },
        ],
      ];
      for (const [label, mutate] of cases) {
        const handoff = structuredClone(valid.handoff);
        mutate(handoff);
        redigest(handoff);
        await writeFile(
          join(root, "objects", "v1", `${digestHex(handoff.digest)}.json`),
          canonicalJsonBytes(handoff),
          { mode: 0o600 },
        );
        expect(() => store.read(handoff.digest), label).toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a fully re-digested omission with substituted identity and media", async () => {
    const responses = [2, 3, 4].map((public_seq) => ({
      event_id: `event-response-${public_seq}`,
      conversation_id: source.conversation_id,
      revision_id: source.revision_id,
      revision_ordinal: 0,
      public_seq,
      participant_id: "participant-a",
      role_ref: "builder",
      text: "r".repeat(2_000),
      terminal_status: CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.COMPLETED,
      created_at: `2026-08-25T00:00:0${public_seq}.000Z`,
      redaction_manifest_digest: digestV1("NESTED-FIXTURE\0v1\0", { public_seq }),
    }));
    const built = buildContextHandoff({
      source: { ...source, last_seq: 4 },
      topic: "Omission identity",
      policy_value: "direct",
      bindings: [],
      user_messages: [message],
      final_responses: responses,
      artifacts: [],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 4_000,
    });
    const handoff = structuredClone(built.handoff);
    const range = handoff.transcript.omitted_public_ranges[0];
    if (!range) throw new Error("missing omission fixture");
    range.artifact.artifact_id = "forged-omission";
    range.artifact.media_type = "application/json";
    handoff.artifacts = handoff.artifacts.map((artifact) =>
      artifact.content_sha256 === range.canonical_events_sha256
        ? structuredClone(range.artifact)
        : artifact,
    );
    handoff.prompt_projection.transcript = structuredClone(handoff.transcript);
    handoff.prompt_projection.artifacts = handoff.prompt_projection.artifacts.map((selection) =>
      selection.artifact.content_sha256 === range.canonical_events_sha256
        ? { ...selection, artifact: structuredClone(range.artifact) }
        : selection,
    );
    redigest(handoff);
    const root = await mkdtemp(join(tmpdir(), "vf-handoff-omission-identity-"));
    try {
      const store = new ContextHandoffStore({ artifactRoot: root });
      await writeFile(
        join(root, "objects", "v1", `${digestHex(handoff.digest)}.json`),
        canonicalJsonBytes(handoff),
        { mode: 0o600 },
      );
      expect(() => store.read(handoff.digest)).toThrow(/omitted public event/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds every optional-group anchor to the selected response inventory", async () => {
    const response = {
      event_id: "event-response-2",
      conversation_id: source.conversation_id,
      revision_id: source.revision_id,
      revision_ordinal: 0,
      public_seq: 2,
      participant_id: "participant-a",
      role_ref: "builder",
      text: "Closed.",
      terminal_status: CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.COMPLETED,
      created_at: "2026-08-25T00:00:02.000Z",
      redaction_manifest_digest: digestV1("NESTED-FIXTURE\0v1\0", { response: true }),
    };
    const built = buildContextHandoff({
      source: { ...source, last_seq: 2 },
      topic: "Group closure",
      policy_value: "direct",
      bindings: [],
      user_messages: [message],
      final_responses: [response],
      artifacts: [],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 64 * 1024,
    });
    const selection = structuredClone(built.selection_plan);
    const original = selection.optional_groups[0];
    if (!original) throw new Error("missing optional group fixture");
    const { group_id: _groupId, ...preimage } = original;
    selection.optional_groups = [
      materializeHandoffOptionalGroup({
        ...preimage,
        anchor_event_id: "forged-response",
        event_ids: ["forged-response"],
      }),
    ];
    const { selection_digest: _selectionDigest, ...selectionPreimage } = selection;
    selection.selection_digest = handoffSelectionPlanDigest(selectionPreimage);
    const handoff = structuredClone(built.handoff);
    handoff.handoff_selection_digest = selection.selection_digest;
    redigest(handoff);
    const root = await mkdtemp(join(tmpdir(), "vf-handoff-group-closure-"));
    try {
      const store = new ContextHandoffStore({ artifactRoot: root });
      expect(() => store.write(handoff, selection)).toThrow(/optional group response closure/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
