import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONVERSATION_HUMAN_REACTION_REQUEST_MODE,
  CONVERSATION_INTERACTION_SCHEMA_VERSION,
} from "../src/orchestrator/conversation/conversation-interaction-contract.js";
import type { HomeReactionMutation } from "../src/ui/src/conversation-home-api.js";

const apiSource = readFileSync(
  new URL("../src/ui/src/conversation-home-api.ts", import.meta.url),
  "utf8",
);

test("Home reaction requests derive schema and toggle mode from interaction authorities", () => {
  const authorityParity: Pick<HomeReactionMutation, "schema_version" | "mode"> = {
    schema_version: CONVERSATION_INTERACTION_SCHEMA_VERSION,
    mode: CONVERSATION_HUMAN_REACTION_REQUEST_MODE.TOGGLE_SELF,
  };

  expect(authorityParity).toEqual({ schema_version: "1.0", mode: "toggle-self" });
  expect(apiSource).toContain("schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;");
  expect(apiSource).toContain("mode: typeof CONVERSATION_HUMAN_REACTION_REQUEST_MODE.TOGGLE_SELF;");
});
