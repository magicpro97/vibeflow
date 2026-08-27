import { expect, test } from "bun:test";
import { PUBLIC_ERROR_CODE } from "../src/actions/public-error-contract.js";
import type { ConversationActionDomainRegistryV1 } from "../src/orchestrator/conversation/conversation-action-registry.js";
import { operationActionEvents } from "../src/server/conversation-action-events-route.js";

test("operation events return the public not-found envelope before cursor processing", async () => {
  const url = new URL("http://local/action-operation-events");
  const response = await operationActionEvents(
    {
      actions: {
        events: async () => null,
      } as unknown as ConversationActionDomainRegistryV1,
    },
    new Request(url.toString()),
    url,
    "conversation-final-coverage",
    `vf-proposal-${"a".repeat(64)}`,
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    error: {
      code: PUBLIC_ERROR_CODE.NOT_FOUND,
      message: "The proposal was not found.",
    },
  });
});
