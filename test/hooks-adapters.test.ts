/**
 * Branch coverage for src/hooks/adapters.ts.
 *
 * The `cliPath()` helper has a branch on line 21 that is only taken when
 * `import.meta.url` ends with "/dist/cli.js" — i.e. when the module is loaded
 * from the bundled CLI entry. In a normal `bun test` / vitest run we execute
 * the .ts source directly (dev branch). To exercise the bundled branch we
 * mock `node:url` so that `fileURLToPath(import.meta.url)` returns a path
 * ending with "/dist/cli.js".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mutable state consumed by the mocked fileURLToPath. vi.mock is hoisted, so
// it cannot capture per-test values; we mutate a shared variable instead and
// reset the modules cache between tests so adapters.ts re-evaluates with the
// new mock.
let mockReturn: string | null = null;

vi.mock("node:url", async () => {
  const actual = await vi.importActual<typeof import("node:url")>("node:url");
  return {
    ...actual,
    fileURLToPath: (url: string | URL) => {
      const s = typeof url === "string" ? url : url.href;
      if (mockReturn && s.startsWith("file://")) return mockReturn;
      return actual.fileURLToPath(url as URL);
    },
  };
});

describe("adapters: cliPath bundled branch (line 21)", () => {
  beforeEach(() => {
    mockReturn = null;
  });
  afterEach(() => {
    mockReturn = null;
  });

  test("returns import.meta.url when it ends with /dist/cli.js (bundled mode)", async () => {
    mockReturn = "/opt/vibeflow/dist/cli.js";

    // Re-import to pick up the current mockReturn value.
    const mod = await import("../src/hooks/adapters.js");

    const cfg = mod.claudeHookConfig();
    const parsed = JSON.parse(cfg) as { hooks: unknown };
    expect(parsed.hooks).toBeTruthy();

    // Bundled branch: cliPath returned mockReturn directly. The serialized
    // command must reference the fake bundled path with no further path join.
    expect(cfg).toContain("node /opt/vibeflow/dist/cli.js hook");
    // And it must NOT contain the dev-mode "src/hooks/adapters" segment.
    expect(cfg).not.toContain("src/hooks");
  });

  test("covers all engine configs in bundled mode", async () => {
    mockReturn = "/usr/local/lib/node_modules/vibeflow/dist/cli.js";

    const mod = await import("../src/hooks/adapters.js");

    const samples: string[] = [
      mod.codexHookConfig(),
      mod.copilotHookConfig(),
      mod.gitPreCommit(),
      mod.gitPostCheckout(),
      mod.gitPostMerge(),
      JSON.stringify(mod.engineHookFiles()),
    ];

    for (const text of samples) {
      expect(text).toContain(mockReturn);
    }
  });
});
