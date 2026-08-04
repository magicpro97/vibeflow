import { describe, expect, test } from "bun:test";
import { POLICY_RELAXATION_CONFIRMATION, PolicyPreviewStore } from "../src/policy-preview.js";

const current = {
  envPolicy: { deny: ["TOKEN"], allow: ["PATH"] },
  hooks: { templates: ["protect-secrets"], custom: [] },
};
const relaxed = {
  envPolicy: { deny: [], allow: ["PATH", "HOME"] },
  hooks: { templates: [], custom: [] },
};

describe("policy preview store", () => {
  test("requires exact confirmation and consumes a relaxation preview once", () => {
    let now = 10;
    const store = new PolicyPreviewStore(
      () => now,
      () => "preview",
    );
    const preview = store.create("repo-a", current, relaxed);
    expect(store.consume(preview.id, "repo-a", current, "allow")).toBeNull();
    expect(
      store.consume(preview.id, "repo-a", current, POLICY_RELAXATION_CONFIRMATION)?.candidate,
    ).toEqual(relaxed);
    expect(store.consume(preview.id, "repo-a", current, POLICY_RELAXATION_CONFIRMATION)).toBeNull();
    now += 1;
  });

  test("rejects wrong repo, stale current policy, expiry, and evicts oldest preview", () => {
    let now = 0;
    let id = 0;
    const store = new PolicyPreviewStore(
      () => now,
      () => `p${id++}`,
    );
    const preview = store.create("repo-a", current, relaxed);
    expect(store.consume(preview.id, "repo-b", current, POLICY_RELAXATION_CONFIRMATION)).toBeNull();
    expect(
      store.consume(
        preview.id,
        "repo-a",
        { ...current, envPolicy: { deny: [], allow: [] } },
        POLICY_RELAXATION_CONFIRMATION,
      ),
    ).toBeNull();
    now = 5 * 60 * 1000 + 1;
    expect(store.consume(preview.id, "repo-a", current, POLICY_RELAXATION_CONFIRMATION)).toBeNull();
    now = 0;
    const bounded = new PolicyPreviewStore(
      () => now,
      () => `b${id++}`,
    );
    const previews = Array.from({ length: 21 }, () => bounded.create("repo-a", current, relaxed));
    expect(
      bounded.consume(previews[0]?.id ?? "", "repo-a", current, POLICY_RELAXATION_CONFIRMATION),
    ).toBeNull();
  });
});
