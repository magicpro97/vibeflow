/** Pure banner projections: when the banner shows and what it says. */
const { describe, expect, test } = await import(String("bun:test"));
import { type UpdateStatusView, bannerLine, bannerVisible } from "../update-banner-model.js";

const base: UpdateStatusView = {
  ok: true,
  installed: "0.21.0",
  latest: null,
  mode: "notify",
  manager: "npm",
  upgrade_available: false,
  stale_servers: [],
  rollback: null,
};

describe("update banner model", () => {
  test("hidden when nothing to do", () => {
    expect(bannerVisible(base)).toBe(false);
    expect(bannerLine(base)).toBeNull();
  });
  test("shows the upgrade with counts of stale servers", () => {
    const s = {
      ...base,
      latest: "0.22.0",
      upgrade_available: true,
      stale_servers: [{ base: "/r", pid: 1, version: "0.21.0" }],
    };
    expect(bannerVisible(s)).toBe(true);
    expect(bannerLine(s)).toBe(
      "VibeFlow v0.21.0 → v0.22.0 available · 1 running UI server on old code",
    );
  });
  test("upgrade with no stale servers omits the tail", () => {
    const s = { ...base, latest: "0.22.0", upgrade_available: true };
    expect(bannerLine(s)).toBe("VibeFlow v0.21.0 → v0.22.0 available");
  });
  test("singular/plural and rollback-only cases", () => {
    const two = {
      ...base,
      latest: "0.22.0",
      upgrade_available: true,
      stale_servers: [
        { base: "/a", pid: 1, version: "x" },
        { base: "/b", pid: 2, version: "x" },
      ],
    };
    expect(bannerLine(two)).toContain("2 running UI servers on old code");
    const rb = { ...base, rollback: { version: "0.20.9" } };
    expect(bannerVisible(rb)).toBe(true);
    expect(bannerLine(rb)).toBe("Rollback available: v0.20.9");
  });
});
