import { describe, expect, test } from "bun:test";
import {
  httpStatusForPublicError,
  parseActionApprovalRequestJson,
  parseActionCancelRequestJson,
  parseActionCommitRequestJson,
  publicActionError,
} from "../../src/actions/index.js";
import type { PublicApiErrorBodyV1 } from "../../src/actions/public-error-contract.js";

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
    const oversizedCandidateHeads = Array.from({ length: 20 }, (_, index) => ({
      conversation_id: `conversation-${index.toString().padStart(2, "0")}`,
      revision_id: `revision-${"r".repeat(300)}-${index.toString().padStart(2, "0")}`,
      revision_ordinal: 0,
    }));
    expect(() =>
      publicActionError({
        code: "lineage_head_unresolved",
        message: "The lineage head is unresolved.",
        correlation_id: "vf-correlation-2",
        retryable: false,
        recovery_action: "select-lineage-head",
        details: {
          root_session_id: "root-session-1",
          head_status: "ambiguous",
          candidate_heads: oversizedCandidateHeads,
          head_digest: `sha256:${"c".repeat(64)}`,
          head_epoch: 3,
        },
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
    } as const;
    expect(() => publicActionError({ ...base, code: "invented" } as never)).toThrow(/unknown/i);
    expect(() => publicActionError({ ...base, extra: true } as never)).toThrow(/unknown/i);
    expect(() =>
      publicActionError({ ...base, details: { private_path: "/Users/secret/value" } }),
    ).toThrow(/private|public/i);
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

  test("orders lineage candidates by numeric ordinal before UTF-8 identity", () => {
    const candidate = (revision_ordinal: number) => ({
      conversation_id: `conversation-${revision_ordinal}`,
      revision_id: `revision-${revision_ordinal}`,
      revision_ordinal,
    });
    const error: Extract<PublicApiErrorBodyV1, { code: "lineage_head_unresolved" }> = {
      code: "lineage_head_unresolved",
      message: "The lineage head is unresolved.",
      correlation_id: "vf-correlation-lineage-order",
      retryable: false,
      recovery_action: "select-lineage-head",
      details: {
        root_session_id: "root-session-1",
        head_status: "ambiguous",
        candidate_heads: [candidate(2), candidate(10)],
        head_digest: `sha256:${"d".repeat(64)}`,
        head_epoch: 3,
      },
    };
    expect(publicActionError(error).error.code).toBe("lineage_head_unresolved");
    expect(() =>
      publicActionError({
        ...error,
        details: { ...error.details, candidate_heads: [candidate(10), candidate(2)] },
      }),
    ).toThrow(/unordered/i);
  });
});
