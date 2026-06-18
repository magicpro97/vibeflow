/**
 * Whitelist mapping for VibeFlow's deterministic skill curation pipeline.
 *
 * Each entry maps a tech keyword (case-insensitive, version-stripped) to
 * the ctx7 GitHub repository + skill name that provides the best SKILL.md
 * for that tech. The whitelist is the FIRST match attempted during
 * `curateSkillsFromEvidence`; only when a tech has no whitelist entry
 * does the AI fallback search ctx7 or author from docs.
 *
 * Format: { keyword, repo, skill }
 *   - keyword: lowercased, no version, no space-dash conversion (matchWhitelist
 *     normalizes both sides before comparison).
 *   - repo: ctx7 GitHub slug (e.g. "/github/awesome-copilot" or
 *     "/bobmatnyc/claude-mpm-skills").
 *   - skill: the skill name inside that repo (e.g. "spring-boot").
 *
 * To add a new tech:
 *   1. Add the entry to the most appropriate group below.
 *   2. Verify the repo + skill exist in ctx7 (`npx ctx7 skills info <repo>`).
 *   3. Run `bun test test/skills-curator.test.ts` to validate.
 *
 * Maintenance: this file ships with VibeFlow so common tech stacks are
 * covered out of the box. PRs welcome for missing tech (group them by
 * ecosystem; keep ordering alphabetical within a group).
 */

export interface WhitelistEntry {
  /** Tech keyword (lowercase, no version) — e.g. "spring-boot". */
  keyword: string;
  /** GitHub repo slug — e.g. "/github/awesome-copilot". */
  repo: string;
  /** Skill name in that repo — e.g. "spring-boot-testing". */
  skill: string;
}

export const DEFAULT_WHITELIST: WhitelistEntry[] = [
  // ── Java / JVM ecosystem ──
  { keyword: "java", repo: "/bobmatnyc/claude-mpm-skills", skill: "java-docs" },
  { keyword: "kotlin", repo: "/bobmatnyc/claude-mpm-skills", skill: "kotlin-springboot" },
  { keyword: "scala", repo: "/bobmatnyc/claude-mpm-skills", skill: "java-docs" },
  { keyword: "groovy", repo: "/bobmatnyc/claude-mpm-skills", skill: "java-docs" },
  { keyword: "spring", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "spring-boot", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "spring boot", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "spring-data", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "spring-security", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "spring-batch", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "spring-cloud", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "jpa", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "hibernate", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "thymeleaf", repo: "/bobmatnyc/claude-mpm-skills", skill: "spring-boot" },
  { keyword: "quarkus", repo: "/bobmatnyc/claude-mpm-skills", skill: "java-docs" },
  { keyword: "micronaut", repo: "/bobmatnyc/claude-mpm-skills", skill: "java-docs" },
  { keyword: "gradle", repo: "/github/awesome-copilot", skill: "create-spring-boot-java-project" },
  { keyword: "maven", repo: "/github/awesome-copilot", skill: "create-spring-boot-java-project" },
  { keyword: "lombok", repo: "/github/awesome-copilot", skill: "create-spring-boot-java-project" },
  {
    keyword: "mapstruct",
    repo: "/github/awesome-copilot",
    skill: "create-spring-boot-java-project",
  },
  {
    keyword: "liquibase",
    repo: "/github/awesome-copilot",
    skill: "create-spring-boot-java-project",
  },
  { keyword: "flyway", repo: "/github/awesome-copilot", skill: "create-spring-boot-java-project" },
  { keyword: "junit", repo: "/github/awesome-copilot", skill: "spring-boot-testing" },
  { keyword: "junit5", repo: "/github/awesome-copilot", skill: "spring-boot-testing" },
  { keyword: "mockito", repo: "/github/awesome-copilot", skill: "spring-boot-testing" },
  { keyword: "testcontainers", repo: "/github/awesome-copilot", skill: "spring-boot-testing" },

  // ── TypeScript / JavaScript ──
  { keyword: "typescript", repo: "/github/awesome-copilot", skill: "typescript" },
  { keyword: "javascript", repo: "/github/awesome-copilot", skill: "typescript" },
  { keyword: "node.js", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "nodejs", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "deno", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "bun", repo: "/bobmatnyc/claude-mpm-skills", skill: "bun-runtime" },
  { keyword: "react", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "react-native", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "nextjs", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "next.js", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "vue", repo: "/bobmatnyc/claude-mpm-skills", skill: "vue3-composition-api" },
  { keyword: "vue3", repo: "/bobmatnyc/claude-mpm-skills", skill: "vue3-composition-api" },
  { keyword: "nuxt", repo: "/bobmatnyc/claude-mpm-skills", skill: "vue3-composition-api" },
  { keyword: "angular", repo: "/bobmatnyc/claude-mpm-skills", skill: "angular-17" },
  { keyword: "svelte", repo: "/bobmatnyc/claude-mpm-skills", skill: "svelte-5" },
  { keyword: "sveltekit", repo: "/bobmatnyc/claude-mpm-skills", skill: "svelte-5" },
  { keyword: "solid", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "astro", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "remix", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "express", repo: "/bobmatnyc/claude-mpm-skills", skill: "express-local-dev" },
  { keyword: "fastify", repo: "/bobmatnyc/claude-mpm-skills", skill: "express-local-dev" },
  { keyword: "hono", repo: "/bobmatnyc/claude-mpm-skills", skill: "hono" },
  { keyword: "nestjs", repo: "/bobmatnyc/claude-mpm-skills", skill: "nestjs" },
  { keyword: "tRPC", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "graphql", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "webpack", repo: "/github/awesome-copilot", skill: "vite-config" },
  { keyword: "vite", repo: "/github/awesome-copilot", skill: "vite-config" },
  { keyword: "esbuild", repo: "/github/awesome-copilot", skill: "vite-config" },
  { keyword: "rollup", repo: "/github/awesome-copilot", skill: "vite-config" },
  { keyword: "parcel", repo: "/github/awesome-copilot", skill: "vite-config" },
  { keyword: "tailwind", repo: "/github/awesome-copilot", skill: "tailwind-css" },
  { keyword: "tailwindcss", repo: "/github/awesome-copilot", skill: "tailwind-css" },
  { keyword: "sass", repo: "/github/awesome-copilot", skill: "css-architecture" },
  { keyword: "css", repo: "/github/awesome-copilot", skill: "css-architecture" },
  { keyword: "redux", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "zustand", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "mobx", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "react-query", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "tanstack-query", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },

  // ── Python ──
  { keyword: "python", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "fastapi", repo: "/bobmatnyc/claude-mpm-skills", skill: "fastapi" },
  { keyword: "django", repo: "/bobmatnyc/claude-mpm-skills", skill: "django-rest-framework" },
  { keyword: "flask", repo: "/bobmatnyc/claude-mpm-skills", skill: "flask-production" },
  { keyword: "starlette", repo: "/bobmatnyc/claude-mpm-skills", skill: "fastapi" },
  { keyword: "uvicorn", repo: "/bobmatnyc/claude-mpm-skills", skill: "fastapi" },
  { keyword: "gunicorn", repo: "/bobmatnyc/claude-mpm-skills", skill: "fastapi" },
  { keyword: "celery", repo: "/bobmatnyc/claude-mpm-skills", skill: "asyncio" },
  { keyword: "pandas", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "numpy", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "pydantic", repo: "/bobmatnyc/claude-mpm-skills", skill: "fastapi" },
  { keyword: "sqlalchemy", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "alembic", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "pytest", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "poetry", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "pip", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "asyncio", repo: "/bobmatnyc/claude-mpm-skills", skill: "asyncio" },
  { keyword: "aiohttp", repo: "/bobmatnyc/claude-mpm-skills", skill: "asyncio" },
  { keyword: "langchain", repo: "/bobmatnyc/claude-mpm-skills", skill: "langchain" },

  // ── .NET / C# / F# ──
  { keyword: "c#", repo: "/github/awesome-copilot", skill: "csharp-best-practices" },
  { keyword: "csharp", repo: "/github/awesome-copilot", skill: "csharp-best-practices" },
  { keyword: ".net", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "dotnet", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "asp.net", repo: "/github/awesome-copilot", skill: "aspnet-minimal-api-openapi" },
  { keyword: "aspnet", repo: "/github/awesome-copilot", skill: "aspnet-minimal-api-openapi" },
  { keyword: "blazor", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "entity-framework", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "ef-core", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "xunit", repo: "/github/awesome-copilot", skill: "csharp-xunit" },
  { keyword: "nunit", repo: "/github/awesome-copilot", skill: "csharp-nunit" },
  { keyword: "mstest", repo: "/github/awesome-copilot", skill: "csharp-mstest" },
  { keyword: "f#", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "fsharp", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "nuget", repo: "/github/awesome-copilot", skill: "dotnet-upgrade" },

  // ── Go ──
  { keyword: "go", repo: "/bobmatnyc/claude-mpm-skills", skill: "go-backend-patterns" },
  { keyword: "golang", repo: "/bobmatnyc/claude-mpm-skills", skill: "go-backend-patterns" },
  { keyword: "gin", repo: "/bobmatnyc/claude-mpm-skills", skill: "go-backend-patterns" },
  { keyword: "echo", repo: "/bobmatnyc/claude-mpm-skills", skill: "go-backend-patterns" },
  { keyword: "fiber", repo: "/bobmatnyc/claude-mpm-skills", skill: "go-backend-patterns" },
  { keyword: "chi", repo: "/bobmatnyc/claude-mpm-skills", skill: "go-backend-patterns" },

  // ── Rust ──
  { keyword: "rust", repo: "/bobmatnyc/claude-mpm-skills", skill: "rust-best-practices" },
  { keyword: "actix", repo: "/bobmatnyc/claude-mpm-skills", skill: "rust-best-practices" },
  { keyword: "axum", repo: "/bobmatnyc/claude-mpm-skills", skill: "rust-best-practices" },
  { keyword: "rocket", repo: "/bobmatnyc/claude-mpm-skills", skill: "rust-best-practices" },
  { keyword: "wasm", repo: "/bobmatnyc/claude-mpm-skills", skill: "rust-best-practices" },

  // ── C / C++ ──
  { keyword: "c++", repo: "/bobmatnyc/claude-mpm-skills", skill: "cpp-modern" },
  { keyword: "cpp", repo: "/bobmatnyc/claude-mpm-skills", skill: "cpp-modern" },
  { keyword: "cmake", repo: "/bobmatnyc/claude-mpm-skills", skill: "cpp-modern" },
  { keyword: "conan", repo: "/bobmatnyc/claude-mpm-skills", skill: "cpp-modern" },

  // ── Ruby ──
  { keyword: "ruby", repo: "/bobmatnyc/claude-mpm-skills", skill: "ruby-on-rails" },
  { keyword: "rails", repo: "/bobmatnyc/claude-mpm-skills", skill: "ruby-on-rails" },
  { keyword: "sinatra", repo: "/bobmatnyc/claude-mpm-skills", skill: "ruby-on-rails" },
  { keyword: "sidekiq", repo: "/bobmatnyc/claude-mpm-skills", skill: "ruby-on-rails" },

  // ── PHP ──
  { keyword: "php", repo: "/bobmatnyc/claude-mpm-skills", skill: "laravel" },
  { keyword: "laravel", repo: "/bobmatnyc/claude-mpm-skills", skill: "laravel" },
  { keyword: "symfony", repo: "/bobmatnyc/claude-mpm-skills", skill: "laravel" },
  { keyword: "wordpress", repo: "/bobmatnyc/claude-mpm-skills", skill: "laravel" },
  { keyword: "composer", repo: "/bobmatnyc/claude-mpm-skills", skill: "laravel" },

  // ── Mobile ──
  { keyword: "swift", repo: "/bobmatnyc/claude-mpm-skills", skill: "swift-best-practices" },
  { keyword: "swiftui", repo: "/bobmatnyc/claude-mpm-skills", skill: "swift-best-practices" },
  { keyword: "ios", repo: "/bobmatnyc/claude-mpm-skills", skill: "swift-best-practices" },
  { keyword: "objective-c", repo: "/bobmatnyc/claude-mpm-skills", skill: "swift-best-practices" },
  { keyword: "android", repo: "/bobmatnyc/claude-mpm-skills", skill: "kotlin-springboot" },
  { keyword: "flutter", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "dart", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "xamarin", repo: "/github/awesome-copilot", skill: "dotnet-best-practices" },
  { keyword: "ionic", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },

  // ── Database ──
  { keyword: "postgresql", repo: "/bobmatnyc/claude-mpm-skills", skill: "postgresql-optimization" },
  { keyword: "postgres", repo: "/bobmatnyc/claude-mpm-skills", skill: "postgresql-optimization" },
  { keyword: "psql", repo: "/bobmatnyc/claude-mpm-skills", skill: "postgresql-optimization" },
  { keyword: "pgvector", repo: "/bobmatnyc/claude-mpm-skills", skill: "postgresql-optimization" },
  { keyword: "mysql", repo: "/bobmatnyc/claude-mpm-skills", skill: "mysql-optimization" },
  { keyword: "mariadb", repo: "/bobmatnyc/claude-mpm-skills", skill: "mysql-optimization" },
  { keyword: "sqlite", repo: "/bobmatnyc/claude-mpm-skills", skill: "mysql-optimization" },
  { keyword: "mongodb", repo: "/bobmatnyc/claude-mpm-skills", skill: "mongodb-patterns" },
  { keyword: "mongo", repo: "/bobmatnyc/claude-mpm-skills", skill: "mongodb-patterns" },
  { keyword: "cassandra", repo: "/bobmatnyc/claude-mpm-skills", skill: "mongodb-patterns" },
  { keyword: "dynamodb", repo: "/bobmatnyc/claude-mpm-skills", skill: "mongodb-patterns" },
  { keyword: "redis", repo: "/bobmatnyc/claude-mpm-skills", skill: "redis-patterns" },
  { keyword: "memcached", repo: "/bobmatnyc/claude-mpm-skills", skill: "redis-patterns" },
  { keyword: "kafka", repo: "/bobmatnyc/claude-mpm-skills", skill: "kafka-patterns" },
  { keyword: "rabbitmq", repo: "/bobmatnyc/claude-mpm-skills", skill: "message-queue-patterns" },
  { keyword: "activemq", repo: "/bobmatnyc/claude-mpm-skills", skill: "message-queue-patterns" },
  { keyword: "nats", repo: "/bobmatnyc/claude-mpm-skills", skill: "message-queue-patterns" },
  { keyword: "elasticsearch", repo: "/bobmatnyc/claude-mpm-skills", skill: "elasticsearch" },
  { keyword: "opensearch", repo: "/bobmatnyc/claude-mpm-skills", skill: "elasticsearch" },
  { keyword: "clickhouse", repo: "/bobmatnyc/claude-mpm-skills", skill: "elasticsearch" },
  { keyword: "neo4j", repo: "/bobmatnyc/claude-mpm-skills", skill: "graph-database" },
  { keyword: "couchdb", repo: "/bobmatnyc/claude-mpm-skills", skill: "mongodb-patterns" },
  { keyword: "supabase", repo: "/bobmatnyc/claude-mpm-skills", skill: "postgresql-optimization" },
  { keyword: "firebase", repo: "/bobmatnyc/claude-mpm-skills", skill: "mongodb-patterns" },

  // ── Caching / Search ──
  { keyword: "solr", repo: "/bobmatnyc/claude-mpm-skills", skill: "elasticsearch" },
  { keyword: "meilisearch", repo: "/bobmatnyc/claude-mpm-skills", skill: "elasticsearch" },
  { keyword: "algolia", repo: "/bobmatnyc/claude-mpm-skills", skill: "elasticsearch" },

  // ── Testing ──
  { keyword: "playwright", repo: "/github/awesome-copilot", skill: "playwright-cli" },
  { keyword: "playwright-cli", repo: "/github/awesome-copilot", skill: "playwright-cli" },
  { keyword: "cypress", repo: "/bobmatnyc/claude-mpm-skills", skill: "cypress" },
  { keyword: "puppeteer", repo: "/bobmatnyc/claude-mpm-skills", skill: "cypress" },
  { keyword: "selenium", repo: "/bobmatnyc/claude-mpm-skills", skill: "cypress" },
  { keyword: "vitest", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "jest", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "mocha", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "chai", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "rspec", repo: "/bobmatnyc/claude-mpm-skills", skill: "ruby-on-rails" },
  { keyword: "phpunit", repo: "/bobmatnyc/claude-mpm-skills", skill: "laravel" },

  // ── Cloud / Infrastructure ──
  { keyword: "docker", repo: "/github/awesome-copilot", skill: "docker" },
  { keyword: "kubernetes", repo: "/bobmatnyc/claude-mpm-skills", skill: "kubernetes" },
  { keyword: "k8s", repo: "/bobmatnyc/claude-mpm-skills", skill: "kubernetes" },
  { keyword: "helm", repo: "/bobmatnyc/claude-mpm-skills", skill: "kubernetes" },
  { keyword: "terraform", repo: "/github/awesome-copilot", skill: "terraform" },
  { keyword: "ansible", repo: "/github/awesome-copilot", skill: "ansible" },
  { keyword: "pulumi", repo: "/github/awesome-copilot", skill: "terraform" },
  { keyword: "aws", repo: "/bobmatnyc/claude-mpm-skills", skill: "aws" },
  { keyword: "gcp", repo: "/bobmatnyc/claude-mpm-skills", skill: "gcp" },
  { keyword: "azure", repo: "/bobmatnyc/claude-mpm-skills", skill: "azure" },
  { keyword: "cloudflare", repo: "/bobmatnyc/claude-mpm-skills", skill: "hono" },
  { keyword: "vercel", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "netlify", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "heroku", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  {
    keyword: "digitalocean",
    repo: "/bobmatnyc/claude-mpm-skills",
    skill: "neon-serverless-postgres",
  },
  { keyword: "neon", repo: "/bobmatnyc/claude-mpm-skills", skill: "neon-serverless-postgres" },

  // ── CI/CD ──
  { keyword: "github-actions", repo: "/github/awesome-copilot", skill: "github-actions" },
  { keyword: "circleci", repo: "/github/awesome-copilot", skill: "github-actions" },
  { keyword: "jenkins", repo: "/github/awesome-copilot", skill: "github-actions" },
  { keyword: "gitlab-ci", repo: "/github/awesome-copilot", skill: "github-actions" },
  { keyword: "travis", repo: "/github/awesome-copilot", skill: "github-actions" },

  // ── Build tools ──
  { keyword: "swc", repo: "/github/awesome-copilot", skill: "vite-config" },
  { keyword: "turbo", repo: "/github/awesome-copilot", skill: "turborepo" },
  { keyword: "turborepo", repo: "/github/awesome-copilot", skill: "turborepo" },
  { keyword: "nx", repo: "/github/awesome-copilot", skill: "turborepo" },
  { keyword: "lerna", repo: "/github/awesome-copilot", skill: "turborepo" },
  { keyword: "rush", repo: "/github/awesome-copilot", skill: "turborepo" },

  // ── Linting / Formatting ──
  { keyword: "eslint", repo: "/github/awesome-copilot", skill: "eslint-config" },
  { keyword: "prettier", repo: "/github/awesome-copilot", skill: "prettier-config" },
  { keyword: "biome", repo: "/github/awesome-copilot", skill: "biome-config" },
  { keyword: "spotless", repo: "/github/awesome-copilot", skill: "spotless-config" },
  { keyword: "checkstyle", repo: "/github/awesome-copilot", skill: "spotless-config" },
  { keyword: "pmd", repo: "/github/awesome-copilot", skill: "spotless-config" },
  { keyword: "sonarqube", repo: "/github/awesome-copilot", skill: "sonarqube" },
  { keyword: "rubocop", repo: "/bobmatnyc/claude-mpm-skills", skill: "ruby-on-rails" },
  { keyword: "phpcs", repo: "/bobmatnyc/claude-mpm-skills", skill: "laravel" },
  { keyword: "pylint", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "flake8", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "black", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "mypy", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "ruff", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },

  // ── Authentication / Security ──
  { keyword: "oauth", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-security-review" },
  { keyword: "oauth2", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-security-review" },
  { keyword: "jwt", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-security-review" },
  { keyword: "auth0", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-security-review" },
  { keyword: "okta", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-security-review" },
  { keyword: "keycloak", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-security-review" },
  { keyword: "passport", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-security-review" },
  { keyword: "nextauth", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "clerk", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },

  // ── API / Protocol ──
  { keyword: "rest", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "restful", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "openapi", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "swagger", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "grpc", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "websocket", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "sse", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "apollo", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },

  // ── Monitoring / Observability ──
  { keyword: "prometheus", repo: "/github/awesome-copilot", skill: "prometheus-grafana" },
  { keyword: "grafana", repo: "/github/awesome-copilot", skill: "prometheus-grafana" },
  { keyword: "datadog", repo: "/github/awesome-copilot", skill: "datadog-instrumentation" },
  { keyword: "sentry", repo: "/github/awesome-copilot", skill: "sentry-setup" },
  { keyword: "opentelemetry", repo: "/github/awesome-copilot", skill: "opentelemetry" },
  { keyword: "jaeger", repo: "/github/awesome-copilot", skill: "opentelemetry" },
  { keyword: "zipkin", repo: "/github/awesome-copilot", skill: "opentelemetry" },
  { keyword: "appinsights", repo: "/github/awesome-copilot", skill: "appinsights-instrumentation" },
  { keyword: "newrelic", repo: "/github/awesome-copilot", skill: "datadog-instrumentation" },
  { keyword: "loki", repo: "/github/awesome-copilot", skill: "prometheus-grafana" },

  // ── AI / ML ──
  { keyword: "openai", repo: "/bobmatnyc/claude-mpm-skills", skill: "anthropic-sdk" },
  { keyword: "anthropic", repo: "/bobmatnyc/claude-mpm-skills", skill: "anthropic-sdk" },
  { keyword: "claude", repo: "/bobmatnyc/claude-mpm-skills", skill: "anthropic-sdk" },
  { keyword: "langchain4j", repo: "/bobmatnyc/claude-mpm-skills", skill: "langchain" },
  { keyword: "llamaindex", repo: "/bobmatnyc/claude-mpm-skills", skill: "langchain" },
  { keyword: "huggingface", repo: "/bobmatnyc/claude-mpm-skills", skill: "langchain" },
  { keyword: "pytorch", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "tensorflow", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "jax", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "sklearn", repo: "/bobmatnyc/claude-mpm-skills", skill: "python-best-practices" },
  { keyword: "transformers", repo: "/bobmatnyc/claude-mpm-skills", skill: "langchain" },
  { keyword: "pinecone", repo: "/bobmatnyc/claude-mpm-skills", skill: "vector-database" },
  { keyword: "weaviate", repo: "/bobmatnyc/claude-mpm-skills", skill: "vector-database" },
  { keyword: "qdrant", repo: "/bobmatnyc/claude-mpm-skills", skill: "vector-database" },

  // ── Misc frameworks ──
  { keyword: "electron", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "tauri", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "pwa", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "expo", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-native" },
  { keyword: "capacitor", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "cordova", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "storybook", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "prisma", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "drizzle", repo: "/bobmatnyc/claude-mpm-skills", skill: "nextjs" },
  { keyword: "typeorm", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "sequelize", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "knex", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "rxjs", repo: "/bobmatnyc/claude-mpm-skills", skill: "nodejs-backend-patterns" },
  { keyword: "xstate", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "immer", repo: "/bobmatnyc/claude-mpm-skills", skill: "react-18" },
  { keyword: "stripe", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "twilio", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },
  { keyword: "sendgrid", repo: "/bobmatnyc/claude-mpm-skills", skill: "api-design-patterns" },

  // ── Documentation ──
  { keyword: "docusaurus", repo: "/bobmatnyc/claude-mpm-skills", skill: "documentation-writer" },
  { keyword: "mkdocs", repo: "/bobmatnyc/claude-mpm-skills", skill: "documentation-writer" },
  { keyword: "sphinx", repo: "/bobmatnyc/claude-mpm-skills", skill: "documentation-writer" },
  { keyword: "gitbook", repo: "/bobmatnyc/claude-mpm-skills", skill: "documentation-writer" },

  // ── Misc ──
  { keyword: "gsap", repo: "/github/awesome-copilot", skill: "gsap-framer-scroll-animation" },
  {
    keyword: "framer-motion",
    repo: "/github/awesome-copilot",
    skill: "gsap-framer-scroll-animation",
  },
  { keyword: "anime.js", repo: "/github/awesome-copilot", skill: "gsap-framer-scroll-animation" },
];
