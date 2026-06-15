import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "bun:test": resolve(__dirname, "test/shim-bun-test.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Use happy-dom or jsdom? Default node env is fine for most tests.
    // The sse-stream tests need Bun.serve — skip them in coverage run.
    exclude: ["test/sse-stream.test.ts", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "scripts/**",
        "test/**",
        "**/*.d.ts",
        "**/index.ts",
      ],
      // Don't fail on test errors — still produce a report
      reportOnFailure: true,
    },
  },
});

