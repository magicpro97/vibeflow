import { describe, expect, test } from "bun:test";
import { buildConversationSettingsChanges } from "../src/ui/src/conversation-home-settings.js";

describe("conversation home settings changes", () => {
  test("changes only the policy when it differs from the current policy", () => {
    expect(
      buildConversationSettingsChanges(
        { policy: "my-policy", maxRounds: "", baseline: "unchanged" },
        "current-policy",
      ),
    ).toEqual({ policy: "my-policy" });
  });

  test("omits the policy when it matches the current policy", () => {
    expect(
      buildConversationSettingsChanges(
        { policy: "same-policy", maxRounds: "", baseline: "unchanged" },
        "same-policy",
      ),
    ).toEqual("Choose at least one conversation setting change.");
  });

  test("accepts a whole-number max_rounds within the server bound", () => {
    expect(
      buildConversationSettingsChanges(
        { policy: "", maxRounds: "42", baseline: "unchanged" },
        null,
      ),
    ).toEqual({ max_rounds: 42 });
  });

  test("rejects a non-whole max_rounds", () => {
    expect(
      buildConversationSettingsChanges(
        { policy: "", maxRounds: "4.2", baseline: "unchanged" },
        null,
      ),
    ).toBe("Max rounds must be a whole number above zero.");
  });

  test("rejects max_rounds above the server bound", () => {
    expect(
      buildConversationSettingsChanges(
        { policy: "", maxRounds: "101", baseline: "unchanged" },
        null,
      ),
    ).toBe("Max rounds must be at most 100.");
  });

  test("rejects max_rounds past safe-integer precision", () => {
    expect(
      buildConversationSettingsChanges(
        { policy: "", maxRounds: "9007199254740993", baseline: "unchanged" },
        null,
      ),
    ).toBe("Max rounds must be at most 100.");
  });

  test("sets baseline_enabled for enabled and disabled", () => {
    expect(
      buildConversationSettingsChanges({ policy: "", maxRounds: "", baseline: "enabled" }, null),
    ).toEqual({ baseline_enabled: true });
    expect(
      buildConversationSettingsChanges({ policy: "", maxRounds: "", baseline: "disabled" }, null),
    ).toEqual({ baseline_enabled: false });
  });
});
