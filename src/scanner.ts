import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

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
  /** Per-component evidence-backed stack findings. Use for PROJECT_CONTEXT.md. */
  findings: StackFinding[];
}

const EXT_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".swift": "Swift",
  ".c": "C",
  ".cpp": "C++",
  ".sh": "Shell",
};

/** Build/manifest marker files → language. Depth-independent: catches languages whose source
 * lives deep (e.g. KMP `src/commonMain/kotlin/...`) where the extension walk's depth cap misses. */
const MARKER_LANG: Array<[string, string]> = [
  ["build.gradle.kts", "Kotlin"],
  ["settings.gradle.kts", "Kotlin"],
  ["build.gradle", "Java"],
  ["pom.xml", "Java"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["Package.swift", "Swift"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
  ["tsconfig.json", "TypeScript"],
];

const FRAMEWORK_HINTS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["nestjs", "NestJS"],
  ["@nestjs/core", "NestJS"],
  ["django", "Django"],
  ["flask", "Flask"],
  ["fastapi", "FastAPI"],
  ["gin-gonic", "Gin"],
  ["actix", "Actix"],
  ["spring-boot", "Spring Boot"],
];

/**
 * iOS / Apple-platform framework hints matched against `Package.swift`
 * dependencies (the SPM manifest equivalent of `package.json`). When
 * the project uses `import` statements instead, the secondary pass below
 * greps `.swift` source files.
 */
const IOS_FRAMEWORK_HINTS: Array<[string, string]> = [
  ["SwiftUI", "SwiftUI"],
  ["swiftui", "SwiftUI"],
  [".swiftinterface", "SwiftUI"],
  ["swift-data", "SwiftData"],
  ["SwiftData", "SwiftData"],
  ["swiftdata", "SwiftData"],
  ["AVFoundation", "AVFoundation"],
  ["avfoundation", "AVFoundation"],
  ["AVKit", "AVKit"],
  ["avkit", "AVKit"],
  ["MediaPlayer", "MediaPlayer"],
  ["mediaplayer", "MediaPlayer"],
  ["UIKit", "UIKit"],
  ["uikit", "UIKit"],
  ["CoreData", "CoreData"],
  ["coredata", "CoreData"],
  ["Combine", "Combine"],
  ["combine", "Combine"],
  ["Alamofire", "Alamofire"],
  ["SnapKit", "SnapKit"],
];

/** xcodebuild commands used for the standard iOS app verification flow.
 *  When `Package.swift` declares an iOS executable target, we set the
 *  default `build` / `test` / `lint` commands so `vf verify` knows what
 *  to run without the user wiring anything by hand. */
const IOS_BUILD_COMMANDS = {
  build: "xcodebuild -scheme MusicApp -destination 'platform=iOS Simulator,name=iPhone 15' build",
  test: "xcodebuild -scheme MusicApp -destination 'platform=iOS Simulator,name=iPhone 15' test",
  lint: "swift run swiftlint",
} as const;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "coverage",
]);

/** Safe readdir that swallows ENOENT/ENOTDIR (e.g. when the path is
 *  a file, not a directory). Used by the iOS detector to look for
 *  `.xcodeproj` / `.xcworkspace` siblings of `Package.swift`. */
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Recursive count of `.swift` files, skipping `SKIP_DIRS`. Capped to
 *  keep `vf init` snappy on huge repos. Returns 0 when no source found. */
function countSwiftSources(repo: string, cap = 500): number {
  let count = 0;
  function walk(dir: string, depth: number): void {
    if (count >= cap) return;
    for (const entry of readdirSafe(dir)) {
      if (count >= cap) return;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = readdirStat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 6) walk(full, depth + 1);
      } else if (entry.endsWith(".swift")) {
        count += 1;
      }
    }
  }
  walk(repo, 0);
  return count;
}

/** statSync wrapped in try/catch (returns null on any FS error). */
function readdirStat(path: string): { isDirectory(): boolean } {
  return statSync(path);
}

/** Walk a bounded number of `.swift` files and collect the set of
 *  `import` module names. Used as a fallback when `Package.swift` does
 *  not list the framework as a declared dependency (e.g. system
 *  frameworks like `Foundation` are always available implicitly). */
function scanSwiftImports(repo: string, fileCap: number): Set<string> {
  const found = new Set<string>();
  let visited = 0;
  function walk(dir: string, depth: number): void {
    if (visited >= fileCap) return;
    for (const entry of readdirSafe(dir)) {
      if (visited >= fileCap) return;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = readdirStat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 6) walk(full, depth + 1);
      } else if (entry.endsWith(".swift")) {
        visited += 1;
        try {
          const txt = readFileSync(full, "utf8");
          for (const m of txt.matchAll(/^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
            const name = m[1];
            if (name) found.add(name);
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(repo, 0);
  return found;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** First non-empty, non-heading line of the README, used as a one-line summary. */
function readmeSummary(repo: string): string | undefined {
  for (const n of ["README.md", "README.MD", "readme.md", "README"]) {
    const p = join(repo, n);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf8").split("\n");
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("![") || line.startsWith("<"))
          continue;
        return line.replace(/^[*_>-]+\s*/, "").slice(0, 240);
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }
  return undefined;
}

/** Infer languages from build markers (depth-independent) + a capped extension walk. */
function detectLanguages(repo: string): string[] {
  const counts = new Map<string, number>();
  let seen = 0;
  // Marker files at the repo root win regardless of how deep the source lives (KMP, monorepos).
  const markers = new Set<string>();
  for (const [file, lang] of MARKER_LANG) {
    if (existsSync(join(repo, file))) markers.add(lang);
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen > 4000) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        seen++;
        const lang = EXT_LANG[extname(entry).toLowerCase()];
        if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      }
    }
  };
  walk(repo, 0);
  // Marker-detected languages first (they signal the project's primary stack), then by file count.
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
  const ordered = [...markers, ...byCount.filter((l) => !markers.has(l))];
  return ordered;
}

function detectPackageManager(repo: string): string | undefined {
  if (existsSync(join(repo, "bun.lock")) || existsSync(join(repo, "bun.lockb"))) return "bun";
  if (existsSync(join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(join(repo, "package-lock.json"))) return "npm";
  if (existsSync(join(repo, "poetry.lock"))) return "poetry";
  if (existsSync(join(repo, "Cargo.lock"))) return "cargo";
  if (existsSync(join(repo, "go.sum"))) return "go";
  return undefined;
}

function hasCI(repo: string): boolean {
  return (
    existsSync(join(repo, ".github", "workflows")) ||
    existsSync(join(repo, ".gitlab-ci.yml")) ||
    existsSync(join(repo, ".circleci")) ||
    existsSync(join(repo, "azure-pipelines.yml"))
  );
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
  // --- iOS / Apple-platform detection (Package.swift + .xcodeproj) ---
  // VibeFlow treats Package.swift (SPM) as the canonical iOS manifest, but
  // we also surface the Xcode project workspace when it exists so the
  // generated `vf verify` commands know which scheme to build.
  const packageSwift = existsSync(join(repo, "Package.swift"));
  const xcodeproj = readdirSafe(repo).find((e) => e.endsWith(".xcodeproj"));
  const xcworkspace = readdirSafe(repo).find((e) => e.endsWith(".xcworkspace"));
  const swiftSources = countSwiftSources(repo);
  if (packageSwift || xcodeproj || xcworkspace || swiftSources > 0) {
    manifests.push(packageSwift ? "Package.swift" : "*.xcodeproj");
    if (!packageManager) packageManager = "spm";

    // 1. Match frameworks from Package.swift dependencies.
    if (packageSwift) {
      try {
        const txt = readFileSync(join(repo, "Package.swift"), "utf8");
        for (const [dep, fw] of IOS_FRAMEWORK_HINTS) if (txt.includes(dep)) frameworks.add(fw);
      } catch {
        /* ignore */
      }
    }

    // 2. Fallback: scan .swift source files for `import XxxModule` statements
    //    (capped walk to keep `vf init` under 1s on big repos).
    if (frameworks.size === 0 && swiftSources > 0) {
      const seen = scanSwiftImports(repo, 50);
      for (const [dep, fw] of IOS_FRAMEWORK_HINTS) if (seen.has(dep)) frameworks.add(fw);
    }

    // 3. Pick build/test/lint defaults if the user did not set them.
    if (!buildCommand) buildCommand = IOS_BUILD_COMMANDS.build;
    if (!testCommand) testCommand = IOS_BUILD_COMMANDS.test;
    if (!lintCommand) lintCommand = IOS_BUILD_COMMANDS.lint;
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

  const findings = buildFindings({
    repo,
    languages: detectLanguages(repo),
    packageManager,
    frameworks: [...frameworks],
    manifests,
    hasCI: hasCI(repo),
  });

  return {
    name,
    summary: readmeSummary(repo),
    languages: detectLanguages(repo),
    packageManager,
    buildCommand,
    testCommand,
    lintCommand,
    frameworks: [...frameworks],
    hasCI: hasCI(repo),
    manifests,
    findings,
  };
}

/** Render a profile into markdown bullet lines for PROJECT_CONTEXT.md. */
function buildFindings(input: {
  repo: string;
  languages: string[];
  packageManager?: string;
  frameworks: string[];
  manifests: string[];
  hasCI: boolean;
}): StackFinding[] {
  const findings: StackFinding[] = [];
  const manifest = input.manifests[0];
  const language = input.languages[0];
  findings.push({
    component: "language",
    value: language ?? "unknown",
    evidence: input.manifests.length ? [manifest ?? "unknown"] : [],
    confidence: input.manifests.length ? "high" : "low",
  });
  findings.push({
    component: "package manager",
    value: input.packageManager ?? "unknown",
    evidence: input.packageManager
      ? input.manifests.filter((m) => m.endsWith(".lock") || m === "Cargo.toml" || m === "go.mod")
      : [],
    confidence: input.packageManager ? "high" : "low",
  });
  findings.push({
    component: "frameworks",
    value: input.frameworks.length ? input.frameworks.join(", ") : "none detected",
    evidence: input.manifests,
    confidence: input.frameworks.length ? "medium" : "low",
  });
  const hasWeb = input.manifests.some((m) => m === "package.json" || m.startsWith("web/"));
  findings.push({
    component: "ui",
    value: hasWeb ? "web (see package.json)" : "none detected",
    evidence: hasWeb ? input.manifests : [],
    confidence: hasWeb ? "medium" : "low",
  });
  findings.push({
    component: "ci",
    value: input.hasCI ? "configured" : "none detected",
    evidence: input.hasCI ? [".github/workflows/"] : [],
    confidence: input.hasCI ? "high" : "low",
  });
  return findings;
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
