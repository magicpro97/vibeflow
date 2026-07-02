import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildFindings,
  detectLanguages,
  detectPackageManager,
  hasCI,
  readJson,
  readmeSummary,
} from "./scanner/detect.js";
import { FRAMEWORK_HINTS, SKIP_DIRS } from "./scanner/tables.js";

export type Confidence = "high" | "medium" | "low";

export interface StackFinding {
  component: string;
  value: string;
  evidence: string[];
  confidence: Confidence;
}

/** A structured, evidence-based read of a repository's stack and tooling. */
export interface ProjectProfile {
  name: string;
  summary?: string;
  languages: string[];
  packageManager?: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  frameworks: string[];
  hasCI: boolean;
  manifests: string[];
  /**
   * True when the depth-capped extension walk hit its limits (depth > 6 or
   * > 4000 files seen). The detected language list may be incomplete; see
   * `walkTruncationReason`. Issue #86.
   */
  walkTruncated?: boolean;
  walkTruncationReason?: "depth" | "files";
  /** Per-component evidence-backed stack findings. Use for PROJECT_CONTEXT.md. */
  findings: StackFinding[];
}

/**
 * Scan a repository and return an evidence-based profile. Pure read-only:
 * inspects manifests, lockfiles, README, CI config, and a capped file sample.
 */
export function scanRepo(repo: string): ProjectProfile {
  const manifests: string[] = [];
  const frameworks = new Set<string>();
  let packageManager = detectPackageManager(repo);
  let buildCommand: string | undefined;
  let testCommand: string | undefined;
  let lintCommand: string | undefined;
  let name = basename(repo);

  const pkgPath = join(repo, "package.json");
  if (existsSync(pkgPath)) {
    manifests.push("package.json");
    const pkg = readJson(pkgPath);
    if (pkg) {
      if (typeof pkg.name === "string" && pkg.name) name = pkg.name;
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      const runner = packageManager ?? "npm";
      const run = (s: string) => (runner === "npm" ? `npm run ${s}` : `${runner} run ${s}`);
      if (scripts.build) buildCommand = run("build");
      if (scripts.test) testCommand = run("test");
      if (scripts.lint) lintCommand = run("lint");
      const deps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };
      for (const [dep, fw] of FRAMEWORK_HINTS) if (deps[dep]) frameworks.add(fw);
      packageManager = packageManager ?? "npm";
    }
  }
  for (const [file, lang] of [
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["go.mod", "Go"],
    ["Cargo.toml", "Rust"],
    ["pom.xml", "Java"],
    ["build.gradle", "Java"],
    ["build.gradle.kts", "Kotlin"],
    ["settings.gradle.kts", "Kotlin"],
    ["Gemfile", "Ruby"],
  ] as const) {
    if (existsSync(join(repo, file))) {
      manifests.push(file);
      const txt = readFileSync(join(repo, file), "utf8");
      for (const [dep, fw] of FRAMEWORK_HINTS) if (txt.includes(dep)) frameworks.add(fw);
      void lang;
    }
  }

  // pubspec.yaml → Dart manifest evidence + Flutter framework detection.
  // MARKER_LANG already maps pubspec.yaml → "Dart" for language detection, but
  // manifests[] was never populated, leaving language findings with empty evidence
  // and low confidence for Dart/Flutter repos. Also detect Flutter framework from
  // the file contents (flutter: dependency or sdk: flutter).
  const pubspecPath = join(repo, "pubspec.yaml");
  if (existsSync(pubspecPath)) {
    manifests.push("pubspec.yaml");
    try {
      const pubspec = readFileSync(pubspecPath, "utf8");
      if (/\bflutter[_:]/.test(pubspec) || pubspec.includes("sdk: flutter")) {
        frameworks.add("Flutter");
      }
    } catch {
      /* ignore read error — manifest evidence already added */
    }
  }

  // --- Sub-package framework detection (issue #150) ---
  // A monorepo / multi-package layout (e.g. a `landing/` Astro app beside the
  // root tooling package) hides frameworks from the root-package.json-only
  // scan above. Sweep one level of immediate sub-directories for their own
  // package.json deps and for framework config markers so the profile does
  // not report "frameworks: []" while a real app sits in a sub-package.
  const FRAMEWORK_CONFIG_MARKERS: Array<[RegExp, string]> = [
    [/^astro\.config\.(mjs|js|ts|cjs|mts)$/, "Astro"],
    [/^next\.config\.(mjs|js|ts|cjs|mts)$/, "Next.js"],
    [/^nuxt\.config\.(mjs|js|ts|cjs|mts)$/, "Nuxt"],
    [/^svelte\.config\.(mjs|js|ts|cjs|mts)$/, "Svelte"],
    [/^vite\.config\.(mjs|js|ts|cjs|mts)$/, "Vite"],
  ];
  try {
    for (const entry of readdirSync(repo, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const subDir = join(repo, entry.name);
      // (a) framework config markers (astro.config.mjs, etc.)
      try {
        for (const child of readdirSync(subDir)) {
          for (const [re, fw] of FRAMEWORK_CONFIG_MARKERS) if (re.test(child)) frameworks.add(fw);
        }
      } catch {
        // unreadable sub-dir — skip
      }
      // (b) the sub-package's own package.json deps
      const subPkgPath = join(subDir, "package.json");
      if (existsSync(subPkgPath)) {
        const subPkg = readJson(subPkgPath);
        if (subPkg) {
          const subDeps = {
            ...((subPkg.dependencies as Record<string, string>) ?? {}),
            ...((subPkg.devDependencies as Record<string, string>) ?? {}),
          };
          for (const [dep, fw] of FRAMEWORK_HINTS) if (subDeps[dep]) frameworks.add(fw);
        }
      }
    }
  } catch {
    // repo root unreadable — leave frameworks as detected from root manifests
  }

  // --- Gradle/KMP build detection (picks commands + frameworks from build files) ---
  const gradleRoot = existsSync(join(repo, "gradlew")) || existsSync(join(repo, "gradlew.bat"));
  const gradleBuild = existsSync(join(repo, "build.gradle.kts"));
  const versionCatalog = existsSync(join(repo, "gradle", "libs.versions.toml"));
  if (gradleRoot) packageManager = packageManager ?? "gradle";
  if (gradleBuild) {
    buildCommand = buildCommand ?? "./gradlew assembleDebug";
    testCommand = testCommand ?? "./gradlew check";
    lintCommand = lintCommand ?? "./gradlew lint";
    if (!packageManager) packageManager = "gradle";
  }
  // Detect KMP frameworks from version catalog
  if (versionCatalog) {
    try {
      const catalog = readFileSync(join(repo, "gradle", "libs.versions.toml"), "utf8");
      if (catalog.includes("compose-multiplatform")) frameworks.add("Compose Multiplatform");
      if (catalog.includes("koin")) frameworks.add("Koin");
      if (catalog.includes("firebase")) frameworks.add("Firebase");
      if (catalog.includes("kotlinx-serialization")) frameworks.add("Kotlinx Serialization");
    } catch {
      /* ignore */
    }
  }
  // Detect subproject build commands (web/)
  const webPkg = join(repo, "web", "package.json");
  if (existsSync(webPkg)) {
    try {
      const pkg = JSON.parse(readFileSync(webPkg, "utf8")) as Record<string, unknown>;
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      if (scripts.build && !buildCommand)
        buildCommand = `cd web && ${typeof packageManager === "string" && packageManager === "bun" ? "bun run build" : "npm run build"}`;
      if (scripts.test && !testCommand)
        testCommand = `cd web && ${typeof packageManager === "string" && packageManager === "bun" ? "bun test" : "npm test"}`;
    } catch {
      /* ignore */
    }
  }

  const langDetect = detectLanguages(repo);
  const findings = buildFindings({
    repo,
    languages: langDetect.languages,
    packageManager,
    frameworks: [...frameworks],
    manifests,
    hasCI: hasCI(repo),
  });

  return {
    name,
    summary: readmeSummary(repo),
    languages: langDetect.languages,
    packageManager,
    buildCommand,
    testCommand,
    lintCommand,
    frameworks: [...frameworks],
    hasCI: hasCI(repo),
    manifests,
    walkTruncated: langDetect.truncated,
    walkTruncationReason: langDetect.reason,
    findings,
  };
}

export function renderFindingsTable(findings: StackFinding[]): string {
  if (!findings.length) return "_(no findings — run `vf init` to scan)_";
  const rows = findings.map(
    (f) =>
      `| ${f.component} | ${f.value} | ${f.evidence.length ? f.evidence.join(", ") : "_no evidence_"} | ${f.confidence} |`,
  );
  return [
    "| Component | Value | Evidence | Confidence |",
    "|-----------|-------|----------|------------|",
    ...rows,
  ].join("\n");
}

export function summarizeProfile(p: ProjectProfile): string {
  const lines: string[] = [];
  if (p.languages.length) lines.push(`- Languages: ${p.languages.join(", ")}`);
  if (p.frameworks.length) lines.push(`- Frameworks: ${p.frameworks.join(", ")}`);
  if (p.packageManager) lines.push(`- Package manager: ${p.packageManager}`);
  if (p.buildCommand) lines.push(`- Build: \`${p.buildCommand}\``);
  if (p.testCommand) lines.push(`- Test: \`${p.testCommand}\``);
  if (p.lintCommand) lines.push(`- Lint: \`${p.lintCommand}\``);
  if (p.manifests.length) lines.push(`- Manifests: ${p.manifests.join(", ")}`);
  lines.push(`- CI configured: ${p.hasCI ? "yes" : "no"}`);
  return lines.join("\n");
}
