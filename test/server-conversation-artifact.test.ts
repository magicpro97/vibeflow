import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ConversationArtifactAncestryCorruptError,
  resolvePublishedArtifactEventReference,
  resolvePublishedArtifactReference,
} from "../src/orchestrator/conversation/conversation-artifact-ancestry.js";
import type { InternalTraceStoreRecord } from "../src/orchestrator/trace/types.js";
import { handleConversationArtifact } from "../src/server/conversation-artifact.js";

const opaque = `artifact_${Buffer.alloc(32, 4).toString("base64url")}`;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const reference = (content: string | Uint8Array) => ({
  artifact_id: opaque,
  artifact_kind: "conversation-artifact" as const,
  media_type: "application/octet-stream",
  byte_length: Buffer.byteLength(content),
  content_sha256: sha(content),
  resolver: "conversation-artifact-v1" as const,
});
const serve = (
  authority: Parameters<typeof handleConversationArtifact>[0],
  conversationId: string,
  artifactId: string,
  expected = sha("verified artifact"),
) => {
  const url = new URL(
    `http://127.0.0.1/api/conversations/${conversationId}/artifacts/${artifactId}?expected_sha256=${expected}`,
  );
  return handleConversationArtifact(
    authority,
    new Request(url.toString()),
    url,
    conversationId,
    artifactId,
  );
};

describe("conversation artifact route authority", () => {
  test("event-backed references require exact selected ancestry, manifest, and retained bytes", () => {
    const content = new TextEncoder().encode("event-backed artifact");
    const internalRef = `vf-artifact-${"4".repeat(64)}`;
    const event = {
      stored_event: {
        workflow_id: "workflow-a",
        conversation_id: "root",
        revision_id: "revision-a",
        run_id: "run-a",
        turn_id: "turn-a",
        operation_id: "operation-a",
        attempt_id: "attempt-a",
        event_id: "event-artifact",
        seq: 1,
        ts: "2026-08-25T00:00:00.000Z",
        idempotency_key: "artifact:event-backed",
        event: {
          type: "artifact_created",
          payload: { artifact_id: "artifact-logical", artifact_type: "plan", ref: internalRef },
        },
      },
      native_session_id: null,
    } as unknown as InternalTraceStoreRecord;
    const entry = {
      artifact_id: "artifact-logical",
      artifact_type: "plan" as const,
      ref: internalRef,
      previous_ref: null,
      idempotency_key: "artifact:event-backed",
      content_hash: sha(content),
    };
    const resolved = resolvePublishedArtifactEventReference({
      chain: [{ conversation_id: "root", records: [event], artifacts: [entry] }],
      artifact_id: opaque,
      registry: (id) => (id === "root" ? { internalRef } : null),
      read: (id) => (id === "root" ? content : null),
    });
    expect(resolved).toEqual({
      owner_conversation_id: "root",
      internal_ref: internalRef,
      reference: reference(content),
    });
    expect(
      resolvePublishedArtifactEventReference({
        chain: [{ conversation_id: "child", records: [], artifacts: [] }],
        artifact_id: opaque,
        registry: (id) => (id === "foreign-sibling" ? { internalRef } : null),
        read: () => content,
      }),
    ).toBeNull();
    expect(
      resolvePublishedArtifactEventReference({
        chain: [{ conversation_id: "root", records: [event], artifacts: [] }],
        artifact_id: opaque,
        registry: () => ({ internalRef }),
        read: () => content,
      }),
    ).toBeNull();
    expect(() =>
      resolvePublishedArtifactEventReference({
        chain: [{ conversation_id: "root", records: [event], artifacts: [entry] }],
        artifact_id: opaque,
        registry: () => ({ internalRef }),
        read: () => new TextEncoder().encode("corrupt"),
      }),
    ).toThrow(ConversationArtifactAncestryCorruptError);
  });

  test("accepts historical full references but denies sibling and synthesized event-only rows", () => {
    const full = reference("ancestor bytes");
    const chain = [{ conversation_id: "root" }, { conversation_id: "child" }];
    const historical = resolvePublishedArtifactReference({
      chain,
      artifact_id: opaque,
      handoff: (id) => (id === "child" ? { artifacts: [full] } : null),
      registry: (id) => (id === "root" ? { internalRef: `vf-artifact-${"1".repeat(64)}` } : null),
    });
    expect(historical).toMatchObject({
      owner_conversation_id: "root",
      reference: full,
    });
    expect(
      resolvePublishedArtifactReference({
        chain,
        artifact_id: opaque,
        handoff: () => null,
        registry: (id) => (id === "root" ? { internalRef: `vf-artifact-${"2".repeat(64)}` } : null),
      }),
    ).toBeNull();
    expect(
      resolvePublishedArtifactReference({
        chain,
        artifact_id: opaque,
        handoff: () => null,
        registry: (id) =>
          id === "foreign-sibling" ? { internalRef: `vf-artifact-${"3".repeat(64)}` } : null,
      }),
    ).toBeNull();
  });

  test("resolves an opaque conversation-scoped id before verified-store access", async () => {
    const calls: string[] = [];
    const response = await serve(
      {
        ancestry: {
          resolve(conversationId, artifactId) {
            calls.push(`resolve:${conversationId}:${artifactId}`);
            return {
              owner_conversation_id: conversationId,
              internal_ref: `vf-artifact-${"a".repeat(64)}`,
              reference: reference("verified artifact"),
            };
          },
        },
        store: {
          readArtifactRef(conversationId, internalRef) {
            calls.push(`read:${conversationId}:${internalRef}`);
            return new TextEncoder().encode("verified artifact");
          },
        },
      },
      "conversation-a",
      opaque,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("verified artifact");
    expect(calls).toEqual([
      `resolve:conversation-a:${opaque}`,
      `read:conversation-a:vf-artifact-${"a".repeat(64)}`,
    ]);
  });

  test("fails closed for malformed, unknown, or cross-conversation opaque ids", async () => {
    let reads = 0;
    const authority = {
      ancestry: { resolve: () => null },
      store: {
        readArtifactRef: () => {
          reads += 1;
          return new Uint8Array();
        },
      },
    };
    expect((await serve(authority, "conversation-a", "../secret")).status).toBe(404);
    expect((await serve(authority, "conversation-a", opaque)).status).toBe(404);
    expect(reads).toBe(0);
  });

  test("does not expose verified-store errors or over-size content", async () => {
    const ancestry = {
      resolve: () => ({
        owner_conversation_id: "conversation-a",
        internal_ref: `vf-artifact-${"b".repeat(64)}`,
        reference: reference("verified artifact"),
      }),
    };
    const failed = await serve(
      {
        ancestry,
        store: {
          readArtifactRef() {
            throw new Error("/private/secret/artifact.bin");
          },
        },
      },
      "conversation-a",
      opaque,
    );
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("/private/secret");

    const oversizedBytes = new Uint8Array(1024 * 1024 + 1);
    const oversized = await serve(
      {
        ancestry: {
          resolve: () => ({
            owner_conversation_id: "conversation-a",
            internal_ref: `vf-artifact-${"b".repeat(64)}`,
            reference: reference(oversizedBytes),
          }),
        },
        store: { readArtifactRef: () => oversizedBytes },
      },
      "conversation-a",
      opaque,
      sha(oversizedBytes),
    );
    expect(oversized.status).toBe(404);
  });

  test("requires the exact ancestry-bound hash and maps corrupt ancestry separately", async () => {
    let reads = 0;
    const authority = {
      ancestry: {
        resolve: () => ({
          owner_conversation_id: "conversation-parent",
          internal_ref: `vf-artifact-${"c".repeat(64)}`,
          reference: reference("ancestor bytes"),
        }),
      },
      store: {
        readArtifactRef(conversationId: string) {
          reads += 1;
          expect(conversationId).toBe("conversation-parent");
          return new TextEncoder().encode("ancestor bytes");
        },
      },
    };
    expect((await serve(authority, "conversation-child", opaque, sha("wrong"))).status).toBe(404);
    expect(reads).toBe(0);
    expect(
      (await serve(authority, "conversation-child", opaque, sha("ancestor bytes"))).status,
    ).toBe(200);
    expect(reads).toBe(1);

    const corrupt = await serve(
      {
        ancestry: {
          resolve() {
            throw new ConversationArtifactAncestryCorruptError("conflicting branch rows");
          },
        },
        store: { readArtifactRef: () => null },
      },
      "conversation-child",
      opaque,
    );
    expect(corrupt.status).toBe(423);

    const corruptBytes = await serve(
      {
        ancestry: {
          resolve: () => ({
            owner_conversation_id: "conversation-parent",
            internal_ref: `vf-artifact-${"d".repeat(64)}`,
            reference: reference("expected bytes"),
          }),
        },
        store: { readArtifactRef: () => new TextEncoder().encode("changed bytes") },
      },
      "conversation-child",
      opaque,
      sha("expected bytes"),
    );
    expect(corruptBytes.status).toBe(423);

    const missingBytes = await serve(
      {
        ancestry: {
          resolve: () => ({
            owner_conversation_id: "conversation-parent",
            internal_ref: `vf-artifact-${"e".repeat(64)}`,
            reference: reference("expected bytes"),
          }),
        },
        store: { readArtifactRef: () => null },
      },
      "conversation-child",
      opaque,
      sha("expected bytes"),
    );
    expect(missingBytes.status).toBe(423);
  });

  test("rejects missing hashes and conditional or range requests before authority access", async () => {
    let resolutions = 0;
    const authority = {
      ancestry: {
        resolve: () => {
          resolutions += 1;
          return null;
        },
      },
      store: { readArtifactRef: () => null },
    };
    const path = `http://127.0.0.1/api/conversations/conversation-a/artifacts/${opaque}`;
    const missingUrl = new URL(path);
    expect(
      (
        await handleConversationArtifact(
          authority,
          new Request(path),
          missingUrl,
          "conversation-a",
          opaque,
        )
      ).status,
    ).toBe(400);
    const rangedUrl = new URL(`${path}?expected_sha256=${sha("verified artifact")}`);
    expect(
      (
        await handleConversationArtifact(
          authority,
          new Request(rangedUrl.toString(), { headers: { range: "bytes=0-1" } }),
          rangedUrl,
          "conversation-a",
          opaque,
        )
      ).status,
    ).toBe(400);
    expect(resolutions).toBe(0);
  });
});
