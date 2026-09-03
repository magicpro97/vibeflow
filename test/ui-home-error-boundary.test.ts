import { describe, expect, test } from "bun:test";
import {
  PUBLIC_API_ERROR_SCHEMA_VERSION,
  PUBLIC_ERROR_CODE,
} from "../src/actions/public-error-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
} from "../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE } from "../src/orchestrator/conversation/conversation-message-queue-error-contract.js";
import { conversationHomeApi } from "../src/ui/src/conversation-home-api.js";
import {
  HOME_API_ERROR_CONTRACT,
  parseHomeApiError,
} from "../src/ui/src/conversation-home-error-boundary.js";

describe("Home API error boundary", () => {
  test("accepts the shared public error contract", () => {
    const error = {
      code: PUBLIC_ERROR_CODE.INVALID_REQUEST,
      message: "The request was invalid.",
      correlation_id: "ui-public-error",
      retryable: false,
      recovery_action: null,
      details: null,
    } as const;

    expect(
      parseHomeApiError(
        { schema_version: PUBLIC_API_ERROR_SCHEMA_VERSION, error },
        HOME_API_ERROR_CONTRACT.PUBLIC,
      ),
    ).toEqual(error);
  });

  test("accepts queue-specific codes and recovery actions without weakening the public parser", () => {
    const itemDigest = `sha256:${"a".repeat(64)}`;
    const error = {
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
      message:
        CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
          CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE
        ],
      correlation_id: "ui-queue-error",
      retryable: false,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW,
      details: {
        root_session_id: "root-session",
        queue_item_id: `vf-queued-message-${"b".repeat(64)}`,
        state: "claimed",
        item_digest: itemDigest,
      },
    } as const;

    expect(
      parseHomeApiError(
        { schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION, error },
        HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE,
      ),
    ).toEqual(error);
  });

  test("fails closed for malformed queue envelopes and bodies", () => {
    expect(() => parseHomeApiError({ error: null }, HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE)).toThrow(
      "invalid conversation message queue error envelope",
    );
    expect(() =>
      parseHomeApiError(
        {
          schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
          error: {
            code: "future_queue_error",
            message: "Unknown",
            correlation_id: "ui-unknown-error",
            retryable: false,
            recovery_action: null,
            details: null,
          },
        },
        HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE,
      ),
    ).toThrow("invalid conversation message queue error body");
    expect(() => parseHomeApiError({}, "future-contract" as never)).toThrow(
      "unsupported Home API error contract",
    );
  });

  test("rejects forged queue semantics and detail shapes", () => {
    const canonical = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      error: {
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
          ],
        correlation_id: "ui-queue-full",
        retryable: true,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
        details: {
          root_session_id: "root-session",
          max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
        },
      },
    } as const;

    expect(parseHomeApiError(canonical, HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE)).toEqual(
      canonical.error,
    );
    for (const error of [
      { ...canonical.error, retryable: false },
      {
        ...canonical.error,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW,
      },
      { ...canonical.error, details: { arbitrary: true } },
      {
        ...canonical.error,
        details: {
          root_session_id: "root-session",
          max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems - 1,
        },
      },
    ]) {
      expect(() =>
        parseHomeApiError({ ...canonical, error }, HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE),
      ).toThrow("invalid conversation message queue error body");
    }

    expect(() =>
      parseHomeApiError(
        {
          ...canonical,
          error: {
            ...canonical.error,
            code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
            retryable: true,
            recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW,
            details: { arbitrary: true },
          },
        },
        HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE,
      ),
    ).toThrow("invalid conversation message queue error body");
  });

  test("selects public and queue overlap semantics without fallback", () => {
    const envelope = (error: Record<string, unknown>) => ({
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      error: { correlation_id: "ui-overlap", message: "Overlap", details: null, ...error },
    });
    const queueInvalid = envelope({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
      retryable: false,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
    });
    expect(parseHomeApiError(queueInvalid, HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE).code).toBe(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
    );
    expect(() => parseHomeApiError(queueInvalid, HOME_API_ERROR_CONTRACT.PUBLIC)).toThrow();

    const publicRateLimit = envelope({
      code: PUBLIC_ERROR_CODE.RATE_LIMITED,
      retryable: true,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
    });
    expect(parseHomeApiError(publicRateLimit, HOME_API_ERROR_CONTRACT.PUBLIC).code).toBe(
      PUBLIC_ERROR_CODE.RATE_LIMITED,
    );
    expect(() =>
      parseHomeApiError(publicRateLimit, HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE),
    ).toThrow();
  });

  test("binds the queue parser only to queue-producing Home endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const envelope = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      error: {
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
          ],
        correlation_id: "ui-endpoint-contract",
        retryable: true,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
        details: {
          root_session_id: "root-session",
          max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
        },
      },
    } as const;
    globalThis.fetch = (async () =>
      Response.json(envelope, { status: 429 })) as unknown as typeof fetch;
    try {
      await expect(
        conversationHomeApi.enqueueMessage("root-session", {} as never),
      ).rejects.toMatchObject({
        publicError: { code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL },
      });
      await expect(conversationHomeApi.sessions({})).rejects.toMatchObject({
        publicError: { code: "invalid_response" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects wrong messages, internal codes, extra fields, and oversized bodies", () => {
    const canonical = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      error: {
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
          ],
        correlation_id: "ui-adversarial",
        retryable: true,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
        details: {
          root_session_id: "root-session",
          max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
        },
      },
    } as const;
    for (const error of [
      { ...canonical.error, message: "Almost canonical." },
      { ...canonical.error, code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY },
      { ...canonical.error, code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT },
      { ...canonical.error, secret: "must-not-cross" },
      { ...canonical.error, message: "x".repeat(4_097) },
    ])
      expect(() =>
        parseHomeApiError({ ...canonical, error }, HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE),
      ).toThrow();
  });
});
