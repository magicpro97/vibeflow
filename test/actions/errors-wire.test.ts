import { describe, expect, test } from "bun:test";
import {
  httpStatusForPublicError,
  parseActionApprovalRequestJson,
  parseActionCancelRequestJson,
  parseActionCommitRequestJson,
  publicActionError,
} from "../../src/actions/index.js";

describe("closed action wire and public errors", () => {
  test("parses exact approval/commit/cancel DTOs and rejects mixed or extra fields", () => {
    expect(
      parseActionApprovalRequestJson(
        JSON.stringify({
          schema_version: "1.0",
          proposal_digest: `sha256:${"a".repeat(64)}`,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        }),
      ).decision,
    ).toBe("approved");
    expect(() =>
      parseActionApprovalRequestJson(
        JSON.stringify({
          schema_version: "1.0",
          proposal_digest: `sha256:${"a".repeat(64)}`,
          decision: "approved",
          challenge_id: "challenge",
          challenge_response: null,
        }),
      ),
    ).toThrow(/jointly/i);
    expect(() =>
      parseActionCommitRequestJson(
        JSON.stringify({
          schema_version: "1.0",
          proposal_digest: `sha256:${"a".repeat(64)}`,
          approval_id: "vf-approval-id",
          extra: true,
        }),
      ),
    ).toThrow(/unknown/i);
    expect(
      parseActionCancelRequestJson(
        JSON.stringify({
          schema_version: "1.0",
          proposal_digest: `sha256:${"a".repeat(64)}`,
          reason: null,
        }),
      ).reason,
    ).toBeNull();
  });

  test("enforces nested special details, the 4 KiB cap, and exact 410 repair status", () => {
    const error = publicActionError({
      code: "stale_timeline_cursor",
      message: "Timeline cursor is stale.",
      correlation_id: "vf-correlation-1",
      retryable: false,
      recovery_action: "restart-pagination",
      details: {
        restart_cursor: "cursor-1",
        head: { conversation_id: "conversation-1", revision_id: "revision-1", revision_ordinal: 2 },
        head_digest: `sha256:${"b".repeat(64)}`,
        head_epoch: 3,
      },
    });
    expect(error.error.code).toBe("stale_timeline_cursor");
    expect(() =>
      publicActionError({
        ...error.error,
        details: { ...error.error.details, private_path: "/Users/secret" },
      } as never),
    ).toThrow(/unknown/i);
    expect(() =>
      publicActionError({
        code: "invalid_request",
        message: "x".repeat(500),
        correlation_id: "vf-correlation-2",
        retryable: false,
        recovery_action: null,
        details: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`field_${index}`, "y".repeat(500)]),
        ),
      }),
    ).toThrow(/4 KiB|byte limit/i);
    expect(httpStatusForPublicError("repair_unavailable")).toBe(410);
  });

  test("rejects unknown codes, extra envelope keys, invalid recovery values, and closed semantic drift", () => {
    const base = {
      code: "invalid_request",
      message: "Invalid request.",
      correlation_id: "vf-correlation-runtime",
      retryable: false,
      recovery_action: null,
      details: null,
    };
    expect(() => publicActionError({ ...base, code: "invented" } as never)).toThrow(/unknown/i);
    expect(() => publicActionError({ ...base, extra: true } as never)).toThrow(/unknown/i);
    expect(() => publicActionError({ ...base, recovery_action: "invented" } as never)).toThrow(
      /recovery/i,
    );
    expect(() =>
      publicActionError({
        code: "scope_locked",
        message: "Wrong text",
        correlation_id: "vf-correlation-runtime",
        retryable: false,
        recovery_action: null,
        details: { scope: "project" },
      }),
    ).toThrow(/semantics/i);
  });
});
