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
  ".dart": "Dart",
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
  ["pubspec.yaml", "Dart"],
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
  ["astro", "Astro"],
  ["nuxt", "Nuxt"],
  ["solid-js", "SolidJS"],
  ["django", "Django"],
  ["flask", "Flask"],
  ["fastapi", "FastAPI"],
  ["gin-gonic", "Gin"],
  ["actix", "Actix"],
  ["spring-boot", "Spring Boot"],
];

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

/** Per-file size cap for repo scans. CWE-400: an unbounded
 * readFileSync on an attacker-supplied or accidentally-huge file
 * (e.g. a vendored 2GB package.json, a binary mistakenly named
 * README.md) blows the scanner's memory and stalls the whole
 * `vf` command. 4 MiB is well over any real package.json or
 * README, and well under the per-call stack pressure. */
const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024;

export { EXT_LANG, FRAMEWORK_HINTS, MARKER_LANG, MAX_SCAN_FILE_BYTES, SKIP_DIRS };
