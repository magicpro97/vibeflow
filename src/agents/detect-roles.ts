import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectProfile } from "../scanner.js";
import { ROLE_NAMES, type RoleName } from "./role-templates.js";

/**
 * Map each role to the repo signals that should trigger it. A signal is
 * either a manifest/file path (relative to the repo root) or a
 * framework/language entry on the {@link ProjectProfile}.
 *
 * File paths support a single `*` wildcard segment so signals like
 * `*.xcodeproj` match `MyApp.xcodeproj` without needing a full glob
 * library. Anything more complex (deep globs, alternation) is the
 * caller's job to model with a different signal.
 *
 * `detectRolesForRepo` returns every role whose at least one signal is
 * present, preserving the canonical order from {@link ROLE_NAMES}.
 */
const ROLE_SIGNALS: Record<RoleName, { files: string[]; frameworkMatch: RegExp[] }> = {
  "cli-engine": {
    files: ["src/cli.ts", "src/commands.ts", "src/adapters.ts", "bin/"],
    frameworkMatch: [/cli/i],
  },
  "web-ui": {
    files: ["src/server.ts", "src/ui/", "src/dispatch.ts", "public/", "web/"],
    frameworkMatch: [/react/i, /vue/i, /svelte/i, /next/i, /nuxt/i, /solid/i, /express/i],
  },
  "ios-engine": {
    // Match when the project has an SPM manifest, an Xcode project, or any
    // .swift source. `frameworkMatch` catches the frameworks that should
    // always pull in the iOS role even when the manifest is missing
    // (e.g. a single-file Swift script in a polyglot repo).
    files: ["Package.swift", "*.xcodeproj", "*.xcworkspace", "Sources/", "App/", "Features/"],
    frameworkMatch: [/swift/i, /swiftui/i, /uikit/i, /swiftdata/i, /coredata/i, /avfoundation/i, /avkit/i, /mediaplayer/i],
  },
  "skill-author": {
    files: [".vibeflow/skills/", ".claude/skills/", ".agents/skills/", ".github/skills/"],
    frameworkMatch: [/skill/i],
  },
  "preflight-engine": {
    files: ["src/preflight.ts", "src/probe-cache.ts", "src/engine-quota.ts"],
    frameworkMatch: [/engine/i],
  },
  "dispatch-runner": {
    files: ["src/dispatch.ts", "src/orchestrator/", "src/logbus.ts", "src/safety/checkpoint.ts"],
    frameworkMatch: [/orchestrat/i, /dispatch/i],
  },
  "doc-writer": {
    files: ["docs/", "README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md"],
    frameworkMatch: [/docs?/i],
  },
};

/**
 * Resolve a single signal path. Supports:
 *  - `foo/`     → directory at the repo root
 *  - `foo`      → file at the repo root
 *  - `*.ext`    → any file/dir in the repo root whose name ends with `.ext`
 *
 * Wildcards are intentionally narrow (single `*` at the start of the
 * last segment) so we never need to pull in a glob library for this
 * one case.
 */
function hasFile(repo: string, rel: string): boolean {
  if (rel.startsWith("*.")) {
    // Wildcard: scan the repo root for any entry matching the suffix.
    let entries: string[];
    try {
      entries = readdirSync(repo);
    } catch {
      return false;
    }
    return entries.some((e) => e.endsWith(rel.slice(1)));
  }
  // Trailing `/` → directory; otherwise → file (existsSync handles both).
  return existsSync(join(repo, rel));
}

function matchesFramework(profile: ProjectProfile, patterns: RegExp[]): boolean {
  const haystack = [...profile.frameworks, ...profile.languages, profile.packageManager ?? ""].join(
    " ",
  );
  return patterns.some((p) => p.test(haystack));
}

/** Detect which roles apply to a repo based on its scanner profile and
 * on-disk file presence. Returns a deduplicated, order-stable list. */
export function detectRolesForRepo(repo: string, profile?: ProjectProfile): RoleName[] {
  const out = new Set<RoleName>();
  for (const role of ROLE_NAMES) {
    const sig = ROLE_SIGNALS[role];
    const fileHit = sig.files.some((f) => hasFile(repo, f));
    const fwHit = profile ? matchesFramework(profile, sig.frameworkMatch) : false;
    if (fileHit || fwHit) out.add(role);
  }
  return ROLE_NAMES.filter((n) => out.has(n));
}
