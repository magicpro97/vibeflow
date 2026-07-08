// src/ui/src/lib/evidence.ts
//
// #558: classify a bare work-unit evidence string into a typed shape so the
// Web-UI can render file:line as a click-to-open link, command/test as badges,
// and everything else as plain text. Pure + DOM-free so it's bun-testable to
// 100% (the .vue that consumes it is DOM-bound and lives outside lcov).

export type EvidenceKind = "file" | "command" | "test" | "text";

export interface ClassifiedEvidence {
  kind: EvidenceKind;
  raw: string;
  path?: string; // kind==="file": the path (no :line)
  line?: number; // kind==="file": optional line
  label?: string; // kind==="test": e.g. "12 pass" / the acceptance tail
}

// N pass|fail (and tenses). Anchored, bounded — no catastrophic backtracking.
const COUNT = /^\s*\d+\s+(?:pass|passed|fail|failed|passing|failing)\b/i;
// An `acceptance <id>: ` prefix that wraps a real command or a manual step.
const ACCEPTANCE = /^acceptance\s+\S+:\s*/i;
// An acceptance tail: `→ "<text>"`. The quoted text becomes the test label.
const TAIL = /→\s*"([^"]*)"/;
// A command once any acceptance prefix is stripped.
const COMMAND = /^(?:\$ |vf |bun |npm |git )/;
// A path WITH an extension, optional :line. No spaces / arrows (guarded below).
const FILE = /^([\w./\-@]+\.[\w]+)(?::(\d+))?$/;

/** Classify one evidence string. First match wins; all regex are cheap. */
export function classifyEvidence(item: string): ClassifiedEvidence {
  // 1a. test — an explicit `N pass|fail` count.
  const count = COUNT.exec(item);
  if (count) return { kind: "test", raw: item, label: count[0].trim() };

  // 2. command — after stripping an optional `acceptance <id>: ` prefix, the
  //    remainder starts with a known runner. Per design §4 the command decides,
  //    so this beats the acceptance tail below. raw is kept verbatim.
  if (COMMAND.test(item.replace(ACCEPTANCE, ""))) return { kind: "command", raw: item };

  // 1b. test — an acceptance line with a `→ "<tail>"` but no command.
  const tail = TAIL.exec(item);
  if (tail) return { kind: "test", raw: item, label: tail[1] };

  // 3. file — a path with an extension (reject spaces / arrows so the route
  //    never gets a non-path). A bare `README` (no dot) falls through to text.
  if (!item.includes(" ") && !item.includes("→")) {
    const f = FILE.exec(item);
    if (f?.[1]) {
      const out: ClassifiedEvidence = { kind: "file", raw: item, path: f[1] };
      if (f[2]) out.line = Number(f[2]);
      return out;
    }
  }

  // 4. text — everything else.
  return { kind: "text", raw: item };
}
