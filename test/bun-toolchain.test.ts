import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

const PLAYWRIGHT_OWNED_TEST_PATHS = Object.freeze(["e2e/**", "landing/tests/*.spec.mjs"] as const);

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  packageManager?: string;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages?: Record<string, { devDependencies?: Record<string, string> }>;
};
const bunConfig = parseToml(readFileSync("bunfig.toml", "utf8")) as {
  test?: { pathIgnorePatterns?: string[] };
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

  test("keeps Playwright-owned specs out of every Bun unit and coverage invocation", () => {
    expect(bunConfig.test?.pathIgnorePatterns).toEqual([...PLAYWRIGHT_OWNED_TEST_PATHS]);
    expect(packageJson.scripts?.coverage).toBe("bun test --coverage");
    expect(packageJson.scripts?.["coverage:check"]).toContain(
      "bun test --timeout 30000 --coverage --coverage-reporter=lcov",
    );
    for (const script of ["test", "test:parallel", "coverage", "coverage:check"] as const) {
      expect(packageJson.scripts?.[script]).not.toContain("--path-ignore-patterns");
    }
  });
});
