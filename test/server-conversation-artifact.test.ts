import { describe, expect, test } from "bun:test";
import { handleConversationArtifact } from "../src/server/conversation-artifact.js";

const opaque = `artifact_${Buffer.alloc(32, 4).toString("base64url")}`;

describe("conversation artifact route authority", () => {
  test("resolves an opaque conversation-scoped id before verified-store access", async () => {
    const calls: string[] = [];
    const response = await handleConversationArtifact(
      {
        registry: {
          resolve(conversationId, artifactId) {
            calls.push(`resolve:${conversationId}:${artifactId}`);
            return { internalRef: `vf-artifact-${"a".repeat(64)}` };
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
      registry: { resolve: () => null },
      store: {
        readArtifactRef: () => {
          reads += 1;
          return new Uint8Array();
        },
      },
    };
    expect(
      (await handleConversationArtifact(authority, "conversation-a", "../secret")).status,
    ).toBe(404);
    expect((await handleConversationArtifact(authority, "conversation-a", opaque)).status).toBe(
      404,
    );
    expect(reads).toBe(0);
  });

  test("does not expose verified-store errors or over-size content", async () => {
    const registry = {
      resolve: () => ({ internalRef: `vf-artifact-${"b".repeat(64)}` }),
    };
    const failed = await handleConversationArtifact(
      {
        registry,
        store: {
          readArtifactRef() {
            throw new Error("/private/secret/artifact.bin");
          },
        },
      },
      "conversation-a",
      opaque,
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("/private/secret");

    const oversized = await handleConversationArtifact(
      {
        registry,
        store: { readArtifactRef: () => new Uint8Array(1024 * 1024 + 1) },
      },
      "conversation-a",
      opaque,
    );
    expect(oversized.status).toBe(404);
  });
});
