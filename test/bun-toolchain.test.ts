import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  packageManager?: string;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages?: Record<string, { devDependencies?: Record<string, string> }>;
};

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/skill-curator.yml",
] as const;

describe("Bun toolchain policy", () => {
  test("pins the runtime and matching Bun types at 1.4", () => {
    expect(packageJson.packageManager).toBe("bun@1.4.0");
    expect(packageJson.devDependencies?.["@types/bun"]).toBe("^1.4.0");
    expect(packageLock.packages?.[""]?.devDependencies?.["@types/bun"]).toBe("^1.4.0");
  });

  test("lets setup-bun resolve the packageManager pin and uses frozen bun ci installs", () => {
    for (const path of workflowPaths) {
      const workflow = readFileSync(path, "utf8");
      expect(workflow).toContain("oven-sh/setup-bun@v2");
      expect(workflow).not.toContain("bun-version: latest");
      expect(workflow).not.toContain("bun install --frozen-lockfile");
      expect(workflow).toContain("bun ci");
    }
  });

  test("exposes Bun 1.4 isolated worker-process test parallelism without dropping the stable gate", () => {
    expect(packageJson.scripts?.test).toBe(
      "bun test --timeout 30000 test/coverage-anti-patterns.test.ts && bun test --timeout 30000",
    );
    expect(packageJson.scripts?.["test:parallel"]).toBe(
      "bun test --timeout 30000 test/coverage-anti-patterns.test.ts && bun test --timeout 30000 --parallel=4",
    );
  });
});
