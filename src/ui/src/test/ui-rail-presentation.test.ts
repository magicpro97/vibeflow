const { expect, test } = await import(String("bun:test"));
import {
  railGroupEntriesId,
  railGroupNameId,
  relativeRailTime,
  toggleRailGroup,
} from "../rail-presentation.js";

test("rail presentation helpers are pure and total", () => {
  expect(railGroupNameId("p1")).toBe("rail-group-p1");
  expect(railGroupEntriesId("p1")).toBe("rail-entries-p1");
  const collapsed = new Set(["a"]);
  expect([...toggleRailGroup(collapsed, "a")]).toEqual([]);
  expect([...toggleRailGroup(collapsed, "b")]).toEqual(["a", "b"]);
  expect([...collapsed]).toEqual(["a"]);
  const now = Date.parse("2026-08-25T00:10:00.000Z");
  expect(relativeRailTime("2026-08-25T00:10:00.000Z", now)).toBe("now");
  expect(relativeRailTime("2026-08-25T00:09:00.000Z", now)).toBe("1m");
  expect(relativeRailTime("2026-08-25T00:00:00.000Z", now)).toBe("10m");
  expect(relativeRailTime("2026-08-24T22:00:00.000Z", now)).toBe("2h");
  expect(relativeRailTime("2026-08-23T00:10:00.000Z", now)).toBe("2d");
  expect(relativeRailTime("not-a-date", now)).toBe("");
});
