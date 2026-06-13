import { describe, expect, test } from "bun:test";
import {
  canPromote,
  draftSkillFromLesson,
  extractLessons,
  shouldPropose,
} from "../src/skills/maintainer.js";

// =============================================================================
// Branch-coverage tests for src/skills/maintainer.ts.
// These specifically target the branches the rest of the suite does not yet
// hit (slugify empty-string fallback, extractLessons empty-topic early return,
// canPromote verified/deprecated early returns).
// =============================================================================

describe("slugify edge cases (branch coverage)", () => {
  test("input that normalizes to empty string falls back to 'lesson'", () => {
    // Trigger the `|| "lesson"` fallback on the chained normalization result.
    // All non-alnum characters become a single dash, then leading/trailing
    // dashes are stripped, leaving an empty string.
    const lessons = extractLessons([
      { unit: "u1", failures: ["!!!"] },
    ]);
    // Topic is "!!!" (split on [.:;\n] yields ["!!!"]; first element trimmed is "!!!").
    // The slugify call on "!!!" produces "lesson" via the fallback.
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.topic).toBe("!!!");
    // recurrence == 1, kind == "failure" → shouldPropose is false (covered by other tests)
    expect(shouldPropose(lessons[0]!)).toBe(false);
  });

  test("input that is exactly a separator char yields empty topic and is dropped", () => {
    // "." splits to ["", ""] — [0] is "" which is falsy → `if (!topic) return;`
    // (line 42, branch 0). Lesson is silently dropped, not added to the map.
    const lessons = extractLessons([
      { unit: "u1", failures: ["."] },
    ]);
    expect(lessons).toHaveLength(0);
  });

  test("input that splits to an empty first segment is also dropped (line 42 branch 0)", () => {
    // ":" and ";" behave the same as "." — split yields ["" ] and we early-return.
    const lessons = extractLessons([
      { unit: "u1", workarounds: [":"] },
      { unit: "u2", discovered: [";"] },
    ]);
    expect(lessons).toHaveLength(0);
  });

  test("input with leading separator yields empty first segment and is dropped", () => {
    // "  .actual text" splits to ["  ", "actual text"]; [0]?.trim() is "" → return.
    const lessons = extractLessons([
      { unit: "u1", failures: [".real failure after dot"] },
    ]);
    expect(lessons).toHaveLength(0);
  });

  test("a newline-separated input keeps the part before the newline as the topic", () => {
    // Split on `\n` keeps the first line as the topic. This also covers the
    // non-empty-topic branch on line 41 (the `?? text.trim()` fallback is
    // NOT taken because [0] exists).
    const lessons = extractLessons([
      { unit: "u1", failures: ["flaky network\nretry timed out"] },
    ]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.topic).toBe("flaky network");
  });
});

describe("canPromote early-return branches (line 117/118)", () => {
  test("status === 'verified' returns ok:false with 'already verified' reason", () => {
    // Hits branch 0 of BRDA:117 — the verified early-return.
    const r = canPromote({ status: "verified", validated: true, approved: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("already verified");
  });

  test("status === 'deprecated' returns ok:false with 'deprecated skills are retired'", () => {
    // Hits branch 0 of BRDA:118 — the deprecated early-return.
    const r = canPromote({ status: "deprecated", validated: true, approved: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("deprecated skills are retired");
  });

  test("'verified' takes precedence over 'discovered' provenance", () => {
    // Verified check fires first; discovered check is not reached.
    const r = canPromote({
      status: "verified",
      validated: false,
      approved: false,
      provenance: "discovered",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("already verified");
  });

  test("'deprecated' takes precedence over 'discovered' provenance", () => {
    // Deprecated check fires before discovered; not reached otherwise.
    const r = canPromote({
      status: "deprecated",
      validated: false,
      approved: false,
      provenance: "discovered",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("deprecated skills are retired");
  });
});

describe("extractLessons: zero-recurrence edges", () => {
  test("all-empty arrays on a handoff produce no lessons", () => {
    // Exercises the `?? []` short-circuit on lines 53-55 (the false branch
    // when failures/workarounds/discovered are absent).
    const lessons = extractLessons([{ unit: "u1" }, { unit: "u2", failures: [] }]);
    expect(lessons).toHaveLength(0);
  });
});

describe("draftSkillFromLesson: name from slugify", () => {
  test("a topic that slugifies to 'lesson' is named 'lesson-skill'", () => {
    // Covers the slugify `|| "lesson"` branch independently of extractLessons.
    const draft = draftSkillFromLesson({
      topic: "!!!",
      evidence: ["!!!"],
      recurrences: 1,
      kind: "failure",
    });
    expect(draft.name).toBe("lesson-skill");
    expect(draft.content).toContain("name: lesson-skill");
  });
});
