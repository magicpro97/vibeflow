/**
 * Starter-pack skill templates.
 *
 * VibeFlow ships a small catalogue of opinionated skills that are
 * auto-scaffolded into `.vibeflow/skills/` when `vf init` detects a
 * matching stack. Each template is a complete, valid SKILL.md (passes
 * `vf skills validate` out of the box) and includes the standard
 * frontmatter fields the dispatcher needs to match it to a work unit.
 *
 * Why bundled and not fetched from Context7?
 *  - `vf init` must work offline (the engine AI enrichment is optional).
 *  - These templates encode the VibeFlow policy itself (coverage gate,
 *    agent-team roles, dispatcher shape) — they are not generic library
 *    docs and are wrong to source from the network.
 *
 * Adding a new template
 *  - Add a new entry to STARTER_PACK with a `match()` predicate over
 *    the {@link ProjectProfile} from `src/scanner.ts`.
 *  - Each entry MUST provide `name`, `description`, `triggers`,
 *    `capabilities`, and a markdown body that includes `## When to use`,
 *    `## Steps`, and `## Verification` sections.
 *  - The validator (`src/skills/validator.ts`) will reject any template
 *    that does not pass.
 */

import type { ProjectProfile } from "../scanner.js";

/** Single starter skill template. */
export interface StarterSkill {
  /** Directory name + frontmatter `name`. Lowercase kebab-case. */
  name: string;
  /** Frontmatter description (<= 1024 chars). */
  description: string;
  /** Trigger tokens the dispatcher uses to match work-unit text. */
  triggers: string[];
  /** Capability tags the reviewer uses to gate goal-eval. */
  capabilities: string[];
  /** Skills this skill depends on. Listed under `requires`. */
  requires: string[];
  /** Full SKILL.md body (excluding the YAML frontmatter). */
  body: string;
  /** Predicate: returns true when this skill applies to a project. */
  match: (profile: ProjectProfile) => boolean;
}

/** Format the standard frontmatter block from a starter-skill record. */
export function renderStarterSkillFrontmatter(skill: StarterSkill): string {
  const lines = [
    "---",
    `name: ${skill.name}`,
    "status: verified",
    `description: ${skill.description}`,
    `triggers: [${skill.triggers.join(", ")}]`,
    `capabilities: [${skill.capabilities.join(", ")}]`,
    skill.requires.length > 0
      ? `requires: [${skill.requires.join(", ")}]`
      : "requires: []",
    "---",
  ];
  return lines.join("\n");
}

/** Render the full SKILL.md file (frontmatter + body). */
export function renderStarterSkillFile(skill: StarterSkill): string {
  return `${renderStarterSkillFrontmatter(skill)}\n\n${skill.body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Template catalogue
// ---------------------------------------------------------------------------

/**
 * Master Apple-platform skill. Triggered whenever the scanner detects
 * any Swift source so every iOS project lands with a coherent baseline
 * (SwiftUI + AVFoundation + SwiftData + background-audio + lock-screen)
 * before any feature work begins.
 */
const swiftIosMusic: StarterSkill = {
  name: "swift-ios-music",
  description:
    "End-to-end guide for building a SwiftUI iOS music streaming app with AVFoundation playback, SwiftData persistence, background audio, and lock-screen controls. Use when implementing a music player, audio streaming client, podcast app, or any iOS media app that needs now-playing, transport controls, MPRemoteCommandCenter, or playlist CRUD.",
  triggers: [
    "music",
    "audio",
    "music-app",
    "audio-player",
    "music-streaming",
    "now-playing",
    "playlist",
    "library",
    "track",
    "album",
    "artist",
    "avfoundation",
    "avkit",
    "swift",
    "ios",
    "swiftui",
    "swiftdata",
    "ios-bootstrap",
    "audio-engine",
    "mpremotecommandcenter",
    "background-audio",
    "lock-screen",
    "media-player",
  ],
  capabilities: [
    "music-app-architecture",
    "avfoundation-playback",
    "mpremotecommandcenter",
    "background-audio",
    "swiftdata-persistence",
    "playlist-crud",
    "now-playing-ui",
    "library-browsing",
    "audio-streaming",
    "cover-art-caching",
    "search",
  ],
  requires: ["swiftui-pro", "avkit", "swiftdata-pro", "swift-concurrency", "ios-debugger-agent"],
  body: `# SwiftUI iOS Music App

End-to-end blueprint for a SwiftUI iOS 17+ music streaming app built with
AVFoundation playback, SwiftData persistence, and \`MPRemoteCommandCenter\`
lock-screen controls. SPM-only (no CocoaPods).

## When to use

- New feature: a screen, view, or component in the music app.
- Modifying playback, library, or playlist behavior.
- Wiring a new remote-command (skip, scrub, like).
- Adding a new persistence field (e.g. recently played).
- Diagnosing a music-app bug (audio cuts, missing lock-screen art).

## Architecture (mandatory)

\`\`\`
App/
  MusicApp.swift                 \\@main, MPNowPlayingInfoCenter.default().nowPlayingInfo
  AppDelegate.swift              AVAudioSession activation, background modes
Features/
  Player/                        NowPlayingView, controls, scrub bar
  Library/                       Browse tracks, albums, artists
  Playlist/                      Playlist CRUD, reorder, swipe-delete
  Search/                        Full-text search over tracks
Core/
  Audio/                         PlaybackEngine (actor), AVPlayer wrapper
  Networking/                    StreamingClient, URLSession
  Persistence/                   SwiftData ModelContainer, repositories
  Caching/                       ImageCache, URLCache + memory cache
\`\`\`

Rules:
- \`PlaybackEngine\` MUST be an \`actor\` (Swift 6 strict concurrency).
- All UI state via \`\\@Observable\` (iOS 17+) — no \`ObservableObject\`.
- Network + disk I/O behind async APIs; never block the main actor.
- Background audio: \`AVAudioSession.Category.playback\` + \`UIBackgroundModes: audio\`.

## Steps

1. **Bootstrap Package.swift** — declare iOS 17+ target, link AVFoundation,
   AVKit, SwiftData, MediaPlayer. Verify: \`swift build\` succeeds.
2. **PlaybackEngine actor** — wrap \`AVPlayer\`, expose \`play/pause/skip/seek\`,
   publish \`\\@Observable\` state for SwiftUI. Test: unit test on actor.
3. **SwiftData models** — \`Track\`, \`Album\`, \`Artist\`, \`Playlist\`, \`PlaylistItem\`.
   Use \`\\@Model\`, \`\\@Relationship(deleteRule: .cascade)\`, composite \`[trackId]\`
   index for GSI-style lookup.
4. **NowPlayingInfoCenter wiring** — call \`MPNowPlayingInfoCenter.default().nowPlayingInfo\`
   on every state change; register \`MPRemoteCommandCenter\` handlers.
5. **Remote commands** — play/pause/skipForward/skipBackward/changePlaybackPosition.
   Each handler MUST debounce 250ms to prevent rapid-tap flood.
6. **Background audio** — \`AVAudioSession.sharedInstance().setCategory(.playback)\`
   at app start; verify with simctl \`simctl push\` notification.
7. **Cover art cache** — \`URLCache(memoryCapacity: 32MB, diskCapacity: 256MB)\` +
   in-memory \`NSCache<NSURL, UIImage>\`. Never decode on the main thread.
8. **Playlist reorder** — use \`.onMove(perform:)\` + SwiftData reorder; persist
   \`position: Int\` field; never trust array order without re-fetch.
9. **Search** — \`Text\` field with \`.searchable()\`, debounce 300ms, query
   \`Track\` SwiftData by \`title CONTAINS[c] %\\@\` + \`artist.name CONTAINS[c] %\\@\`.

## Verification (must pass before unit closes)

- [ ] \`swift build\` — clean compile, no warnings
- [ ] \`swift test\` — 100% line coverage on \`Core/Audio/PlaybackEngine.swift\`
- [ ] \`xcodebuild test -scheme MusicApp -destination 'platform=iOS Simulator,name=iPhone 15'\`
      — UI smoke: launch → tap track → backgrounding keeps audio playing
- [ ] Lock-screen controls: pause, skip, scrub — verified via simctl
- [ ] \`vf skills resolve\` reports \`swift-ios-music\` (this skill) is the
      primary match; consult \`swiftui-pro\` for view-level review and
      \`swift-concurrency\` for actor-related issues.

## Anti-patterns — flag on sight

- \`AVPlayer\` instance held by a \`\\@StateObject\` (data race) — use an actor.
- \`Task { ... }\` in a SwiftUI \`body\` (re-creates on every render) — use \`.task\`.
- \`Image(uiImage:)\` without \`.resizable()\` (memory blowup on art).
- \`MPNowPlayingInfoCenter\` updated on the main actor only (use actor hop).
- Force-unwrap of streaming URLs — guard with \`if let\`.
- Hardcoded 3-second skip interval — read from user preferences.

## Cross-references

- \`avkit\` skill — high-level player UI, VideoPlayer (skip if audio-only)
- \`swiftui-pro\` skill — view architecture, state, performance review
- \`swiftdata-pro\` skill — model schema, migration, fetch optimization
- \`swift-concurrency\` skill — actor isolation, Sendable, async/await
- \`ios-debugger-agent\` skill — simctl build/run, log capture for audio bugs
`,
  match: (p) => p.languages.includes("Swift") || p.frameworks.length > 0 && p.frameworks.some((f) =>
    /swift|swiftui|swiftdata|uikit|avfoundation|avkit|coredata/i.test(f),
  ),
};

/** Aggregated catalogue. Order = render order (most specific first). */
export const STARTER_PACK: readonly StarterSkill[] = [swiftIosMusic];

/**
 * Pick the starter skills that apply to a project profile. The current
 * implementation is greedy: a skill is included if its \`match\`
 * predicate returns true. Future tuning may weight by stack depth (a
 * full SPM project with SwiftUI + AVFoundation + SwiftData is a
 * stronger signal than a single \`.swift\` file in a polyglot repo).
 */
export function pickStarterSkills(profile: ProjectProfile): StarterSkill[] {
  return STARTER_PACK.filter((s) => s.match(profile));
}
