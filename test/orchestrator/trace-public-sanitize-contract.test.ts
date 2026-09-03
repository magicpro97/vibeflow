import { describe, expect, test } from "bun:test";
import { CONVERSATION_ARTIFACT_TYPES } from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import { sanitizePublicText } from "../../src/orchestrator/trace/public-sanitize.js";

describe("public trace structural vocabulary", () => {
  test("preserves every canonical artifact type even when a denied value is identical", () => {
    for (const artifactType of CONVERSATION_ARTIFACT_TYPES) {
      expect(
        sanitizePublicText(artifactType, "artifact_type", [
          { value: artifactType, replacement: "[redacted-ref]" },
        ]),
      ).toBe(artifactType);
    }
    expect(
      sanitizePublicText("future-artifact", "artifact_type", [
        { value: "future-artifact", replacement: "[redacted-ref]" },
      ]),
    ).toBe("[redacted-ref]");
  });
});
