import { describe, expect, test } from "bun:test";
import {
  ActionValidationError,
  parseActionProposalRequestJson,
  validateHostActionRequest,
} from "../../src/actions/index.js";

const valid = {
  schema_version: "1.0",
  idempotency_key: "key-1",
  anchor_event_id: "event-1",
  expected: {
    mode: "writable-revision",
    conversation_id: "conversation-1",
    revision_id: "revision-1",
    last_seq: 2,
    conversation_lock_digest: `sha256:${"a".repeat(64)}`,
  },
  candidate: { type: "conversation.stop_operation", operation_id: "operation-1" },
} as const;

describe("strict action wire validation", () => {
  test("accepts a bounded exact request", () => {
    expect(parseActionProposalRequestJson(JSON.stringify(valid))).toEqual(valid);
    expect(
      validateHostActionRequest({
        type: "conversation.continue_message",
        content: "continue",
        target_participants: ["participant-1", "participant-2"],
      }),
    ).toEqual({
      type: "conversation.continue_message",
      content: "continue",
      target_participants: ["participant-1", "participant-2"],
    });
  });

  test("requires a canonical bounded continuation message", () => {
    for (const candidate of [
      {
        type: "conversation.continue_message",
        content: "   ",
        target_participants: "all",
      },
      {
        type: "conversation.continue_message",
        content: "continue",
        target_participants: [],
      },
      {
        type: "conversation.continue_message",
        content: "continue",
        target_participants: ["participant-2", "participant-1"],
      },
      {
        type: "conversation.continue_message",
        content: "continue",
        target_participants: ["participant-1", "participant-1"],
      },
    ])
      expect(() => validateHostActionRequest(candidate)).toThrow(ActionValidationError);
  });

  test("accepts only ordered bounded immutable quote references on continuation", () => {
    const quote = {
      root_session_id: "root-1",
      conversation_id: "conversation-1",
      revision_id: "revision-1",
      target_event_id: "event-1",
      target_kind: "completed-agent-response",
      content_digest: `sha256:${"b".repeat(64)}`,
      author_public_id: "participant-1",
    } as const;
    expect(
      validateHostActionRequest({
        type: "conversation.continue_message",
        content: "continue",
        target_participants: "all",
        quote_refs: [quote],
      }),
    ).toMatchObject({ quote_refs: [quote] });
    for (const quote_refs of [[], [quote, quote], [{ ...quote, content_digest: "sha256:no" }]])
      expect(() =>
        validateHostActionRequest({
          type: "conversation.continue_message",
          content: "continue",
          target_participants: "all",
          quote_refs,
        }),
      ).toThrow(ActionValidationError);
  });

  test("rejects unknown fields, duplicates, pollution keys, and unsupported versions", () => {
    const cases = [
      JSON.stringify({ ...valid, unexpected: true }),
      '{"schema_version":"1.0","schema_version":"1.0","idempotency_key":"key-1","anchor_event_id":"event-1","expected":{},"candidate":{}}',
      '{"schema_version":"1.0","idempotency_key":"key-1","anchor_event_id":"event-1","expected":{"mode":"writable-revision","conversation_id":"c","revision_id":"r","last_seq":1,"conversation_lock_digest":"d"},"candidate":{"type":"conversation.stop_operation","operation_id":"o","__proto__":{"admin":true}}}',
      JSON.stringify({ ...valid, schema_version: "2.0" }),
    ];
    for (const value of cases) {
      expect(() => parseActionProposalRequestJson(value)).toThrow(ActionValidationError);
    }
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  test("rejects authority repair from browser and bounds idempotency bytes", () => {
    expect(() =>
      validateHostActionRequest(
        { type: "authority.repair", repair_id: "r", plan_digest: "d" },
        true,
      ),
    ).toThrow(/target_unsupported/);
    expect(() =>
      parseActionProposalRequestJson(
        JSON.stringify({ ...valid, idempotency_key: "x".repeat(129) }),
      ),
    ).toThrow(/idempotency_key/);
  });

  test("rejects short digests in expected locks and every digest-bearing action body", () => {
    expect(() =>
      parseActionProposalRequestJson(
        JSON.stringify({
          ...valid,
          expected: { ...valid.expected, conversation_lock_digest: "sha256:short" },
        }),
      ),
    ).toThrow(/digest/i);
    for (const candidate of [
      {
        type: "conversation.publish_suspected_literal",
        private_staging_id: "stage-1",
        staging_record_digest: "sha256:short",
        staged_content_digest: `sha256:${"b".repeat(64)}`,
        findings_digest: `sha256:${"c".repeat(64)}`,
      },
      {
        type: "capability.adopt",
        scope: "project",
        candidate_id: "candidate-1",
        candidate_digest: "sha256:short",
      },
      {
        type: "secret.revoke",
        scope: "project",
        private_binding_id: "binding-1",
        expected_binding_digest: "sha256:short",
      },
    ])
      expect(() => validateHostActionRequest(candidate)).toThrow(/digest/i);
  });
});
