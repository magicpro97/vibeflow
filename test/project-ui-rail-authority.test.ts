/**
 * Cross-module pins for the rail/chip copies of orchestrator authority.
 *
 * The UI's pure rail module is browser-safe by hard constraint: it must not reach
 * `project-classifier.ts` (pulls `node:fs`) or `project-types.ts` (pulls `node:path`), because
 * both would be bundled into the UI. So it re-declares the two bounds it needs, and this file —
 * which runs outside the browser bundle and may import them — is what keeps the copies honest.
 *
 * Without this, a change to `AI_MIN_CONFIDENCE` or `PROJECT_THINKING_MAX_LENGTH` would leave the
 * UI silently using the old floor: a suggestion chip that offers a move the server would refuse,
 * or a settings form that rejects a thinking label the registry accepts.
 */
import { expect, test } from "bun:test";
import {
  AI_MIN_CONFIDENCE,
  CLASSIFICATION_REASONS,
} from "../src/orchestrator/conversation/project-classifier.js";
import { PROJECT_THINKING_MAX_LENGTH } from "../src/orchestrator/conversation/project-types.js";
import {
  PROJECT_SUGGESTION_MIN_AI_CONFIDENCE,
  PROJECT_THINKING_VALUE_MAX_LENGTH,
} from "../src/ui/src/project-rail-group.js";

test("the UI's AI acceptance floor mirrors the classifier authority", () => {
  expect(PROJECT_SUGGESTION_MIN_AI_CONFIDENCE).toBe(AI_MIN_CONFIDENCE);
});

test("the UI's thinking-length bound mirrors the registry authority", () => {
  expect(PROJECT_THINKING_VALUE_MAX_LENGTH).toBe(PROJECT_THINKING_MAX_LENGTH);
});

test("the UI's reason vocabulary is exactly the classifier's tier ladder", () => {
  // Every tier the classifier can report must be one the UI can reason about; a new tier
  // added server-side would otherwise fall through the UI gate as "not proposable".
  expect([...CLASSIFICATION_REASONS]).toEqual(["repo", "mention", "fts", "ai", "fallback"]);
});
