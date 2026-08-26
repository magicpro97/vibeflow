import { describe, expect, test } from "bun:test";
import { chat } from "../src/commands/chat.js";

const service = (overrides: Partial<Parameters<typeof chat>[1]> = {}) => ({
  createService: () =>
    ({
      start: async (request: { topic: string; participants?: unknown[]; policy?: string }) => ({
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        operation_id: "operation-1",
        completion: Promise.resolve({
          conversation_id: "conversation-1",
          revision_id: "revision-1",
          result: {
            operation_id: "operation-1",
            status: "completed",
            artifact_refs: [],
          },
        }),
      }),
      subscribe: () => () => undefined,
      message: async () => ({
        message_id: "message-1",
        accepted: true,
        child_conversation_id: "conversation-2",
      }),
      snapshot: async () => ({ lifecycle: "COMPLETED" }),
    }) as never,
  ...overrides,
});

describe("vf chat", () => {
  test("raw argv keeps repeated --participant values and routes them to the service", async () => {
    let seen: unknown[] = [];
    const code = await chat(
      ["--participant", "direct@codex", "--participant", "direct@claude:gpt-5", "compare", "these"],
      {
        createService: () =>
          ({
            start: async (request: { participants?: unknown[] }) => {
              seen = [...(request.participants ?? [])];
              return {
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                operation_id: "operation-1",
                completion: Promise.resolve({
                  conversation_id: "conversation-1",
                  revision_id: "revision-1",
                  result: {
                    operation_id: "operation-1",
                    status: "completed",
                    artifact_refs: [],
                  },
                }),
              };
            },
            subscribe: () => () => undefined,
          }) as never,
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual([
      { role_ref: "direct", engine: "codex" },
      { role_ref: "direct", engine: "claude", model: "gpt-5" },
    ]);
  });

  test("--json emits exactly one JSON document", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await chat(["--json", "explain", "this"], service());
      expect(code).toBe(0);
      expect(chunks).toHaveLength(1);
      expect(() => JSON.parse(chunks[0] as string)).not.toThrow();
    } finally {
      process.stdout.write = write;
    }
  });

  test("--resume sends a message through the conversation service", async () => {
    let resumed = "";
    const code = await chat(["--resume", "conversation-1", "revise", "that"], {
      createService: () =>
        ({
          message: async (_id: string, request: { content: string }) => {
            resumed = request.content;
            return {
              message_id: "message-1",
              accepted: true,
              child_conversation_id: "conversation-2",
            };
          },
          snapshot: async () => ({ lifecycle: "COMPLETED" }),
          subscribe: () => () => undefined,
        }) as never,
    });
    expect(code).toBe(0);
    expect(resumed).toBe("revise that");
  });

  test("--resume rejects create-only flags before constructing the service", async () => {
    const cases = [
      ["--policy", "debate"],
      ["--participant", "direct@codex"],
      ["--max-rounds", "2"],
      ["--no-baseline"],
    ];
    for (const args of cases) {
      const chunks: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await chat(["--json", "--resume", "conversation-1", ...args, "revise"], {
          createService: () => {
            throw new Error("service must not start");
          },
        });
        expect(code).toBe(1);
        expect(JSON.parse(chunks[0] as string)).toEqual({ ok: false, code: "validation_error" });
        expect(chunks).toHaveLength(1);
      } finally {
        process.stdout.write = write;
      }
    }
  });

  test("--resume requires a non-empty persisted conversation id", async () => {
    for (const resume of [["--resume"], ["--resume="]]) {
      const chunks: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await chat(["--json", ...resume, "--no-baseline", "revise"], {
          createService: () => {
            throw new Error("service must not start");
          },
        });
        expect(code).toBe(1);
        expect(JSON.parse(chunks[0] as string)).toEqual({
          ok: false,
          code: "validation_error",
        });
      } finally {
        process.stdout.write = write;
      }
    }
  });

  test("--no-baseline forwards baselineEnabled=false to the shared service", async () => {
    let seen: unknown;
    const code = await chat(["--no-baseline", "--policy", "debate", "compare", "this"], {
      createService: () =>
        ({
          start: async (_request: unknown, options?: unknown) => {
            seen = options;
            return {
              conversation_id: "conversation-1",
              revision_id: "revision-1",
              operation_id: "operation-1",
              completion: Promise.resolve({
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                result: {
                  operation_id: "operation-1",
                  status: "completed",
                  artifact_refs: [],
                },
              }),
            };
          },
          subscribe: () => () => undefined,
        }) as never,
    });
    expect(code).toBe(0);
    expect(seen).toEqual({ baselineEnabled: false });
  });

  test("--json preserves STOPPED as a success and keeps the status distinct", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await chat(["--json", "--resume", "conversation-1", "stop", "there"], {
        createService: () =>
          ({
            message: async () => ({
              message_id: "message-1",
              accepted: true,
              child_conversation_id: "conversation-2",
            }),
            snapshot: async () => ({ lifecycle: "STOPPED" }),
            subscribe: () => () => undefined,
          }) as never,
      });
      expect(code).toBe(0);
      expect(JSON.parse(chunks[0] as string)).toMatchObject({ ok: true, status: "stopped" });
    } finally {
      process.stdout.write = write;
    }
  });

  test("--json reports a pending approval as accepted instead of failed", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await chat(["--json", "--policy", "plan", "draft", "a", "plan"], {
        createService: () =>
          ({
            start: async () => ({
              conversation_id: "conversation-1",
              revision_id: "revision-1",
              operation_id: "operation-1",
              completion: Promise.resolve({
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                result: {
                  operation_id: "operation-1",
                  status: "awaiting_approval",
                  artifact_refs: ["artifact-plan"],
                },
              }),
            }),
            subscribe: () => () => undefined,
          }) as never,
      });
      expect(code).toBe(0);
      expect(JSON.parse(chunks[0] as string)).toMatchObject({
        ok: true,
        status: "awaiting_approval",
        artifact_refs: ["artifact-plan"],
      });
    } finally {
      process.stdout.write = write;
    }
  });

  test("fresh production create routes through durable Home create compatibility", async () => {
    let seen: Record<string, unknown> | undefined;
    const code = await chat(["--policy", "plan", "draft", "a", "plan"], {
      durable: {
        create: async (input) => {
          seen = input as unknown as Record<string, unknown>;
          return {
            conversation_id: "conversation-1",
            conversationId: "conversation-1",
            revision_id: "revision-1",
            revisionId: "revision-1",
            artifact_refs: ["artifact-plan"],
            artifactRefs: ["artifact-plan"],
            status: "awaiting_approval",
            output: "",
            events: [],
          };
        },
        message: async () => {
          throw new Error("unexpected durable message call");
        },
      },
    });
    expect(code).toBe(0);
    expect(seen).toMatchObject({
      request: {
        topic: "draft a plan",
        policy: "plan",
      },
    });
  });
});
