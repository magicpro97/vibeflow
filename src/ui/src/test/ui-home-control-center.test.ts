const { describe, expect, test } = await import(String("bun:test"));
import { readFileSync } from "node:fs";

describe("home control center contracts", () => {
  const component = readFileSync(
    new URL("../components/HomeControlCenterDrawer.vue", import.meta.url),
    "utf8",
  );
  const app = readFileSync(new URL("../App.vue", import.meta.url), "utf8");
  const types = readFileSync(new URL("../types.ts", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../../../settings.ts", import.meta.url), "utf8");

  test("mounts every requested section in one drawer", () => {
    expect(app).toContain("HomeControlCenterDrawer");
    for (const section of [
      "Harness initialization",
      "Agents and CLIs",
      "Settings",
      "Capabilities",
      "Skills",
      "MCP servers",
    ])
      expect(component).toContain(section);
  });

  test("exposes user actions for harness and agent initialization", () => {
    expect(component).toContain("Initialize harness");
    expect(component).toContain("Initialize agent");
    expect(component).toContain("api.init");
  });

  test("persists CLI enablement through typed settings", () => {
    expect(component).toContain("enabledEngines");
    expect(types).toContain("enabledEngines");
    expect(settings).toContain("enabledEngines");
    expect(api).toContain("/api/settings");
  });

  test("renders skills and MCP inventory from existing APIs/settings", () => {
    expect(component).toContain("api.skills");
    expect(component).toContain("mcpServers");
    expect(settings).toContain("mcpServers?: Record<string, UserMcpServer>");
  });
});
