import { expect, test } from "bun:test";
import { CONVERSATION_COMMAND_STATUS_BY_TERMINAL_LIFECYCLE } from "../../src/orchestrator/conversation/conversation-command-result-contract.js";
import { ConversationStartAuthorityV1 } from "../../src/orchestrator/conversation/service-start-authority.js";
import type {
  ConversationManifest,
  ConversationStartResult,
} from "../../src/orchestrator/conversation/types.js";

test("allocated start replay maps every durable terminal lifecycle", async () => {
  for (const [lifecycle, status] of Object.entries(
    CONVERSATION_COMMAND_STATUS_BY_TERMINAL_LIFECYCLE,
  )) {
    const authority = new ConversationStartAuthorityV1(
      {
        snapshot: async () => ({ lifecycle }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () => "2026-08-26T00:00:00.000Z",
      () => undefined,
      {} as never,
    );
    const replay = (
      authority as unknown as {
        replay(
          manifest: ConversationManifest,
          operationId: string,
        ): Promise<ConversationStartResult>;
      }
    ).replay.bind(authority);
    const operationId = `vf-operation-${lifecycle.toLowerCase()}`;
    const started = await replay(
      {
        conversation_id: "conversation-terminal-replay",
        revision_id: "revision-terminal-replay",
      } as ConversationManifest,
      operationId,
    );

    expect(started).toMatchObject({
      conversation_id: "conversation-terminal-replay",
      revision_id: "revision-terminal-replay",
      operation_id: operationId,
    });
    await expect(started.completion).resolves.toMatchObject({
      conversation_id: "conversation-terminal-replay",
      revision_id: "revision-terminal-replay",
      result: { operation_id: operationId, status, artifact_refs: [] },
    });
  }
});
