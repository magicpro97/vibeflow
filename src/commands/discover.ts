// `vf discover` subcommand extracted from src/commands.ts (issue #80, phase 7/14).
// Pure byte-equivalent move: body preserved verbatim, only the relative
// import path `./discovery/context7.js` was rewritten to
// `../discovery/context7.js` (we are now nested one level deeper).
//
// Fail-closed posture preserved:
// - usage error → return 2
// - approval required (no --yes) → return 0 with yellow hint
// - network failure → return 1 with red reason
// - success (with or without results) → return 0
//
// The dynamic import of `./discovery/context7.js` uses ESM dynamic
// import so the network module is loaded only when the user actually
// runs `vf discover` (most users never do). The barrel re-exports
// `lookupDocsHttp` / `searchSkillsHttp` so test seams can inject
// mock fetch implementations via the `inject.fetchFn` parameter.

import { c, out } from "./_shared.js";

/**
 * External docs/skill discovery via Context7 — network only with explicit approval.
 * Rides the stdlib `fetch` HTTP path (zero-install); `inject.fetchFn` is a test-only seam so
 * suites never hit the wire. Discovery results are experimental at most and skill names are
 * sanitized to a path-safe slug before they are surfaced.
 */
export async function discover(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  inject: { fetchFn?: typeof fetch } = {},
): Promise<number> {
  const query = rest.join(" ").trim();
  const approved = Boolean(flags.yes);
  if (sub !== "docs" && sub !== "skills") {
    out("vf", c.red("Usage: vf discover <docs|skills> <query> [--yes]"), {
      level: "error",
    });
    return 2;
  }
  if (!query) {
    out("vf", c.red(`Usage: vf discover ${sub} <query> [--yes]`), {
      level: "error",
    });
    return 2;
  }
  const opts = { approved, fetchFn: inject.fetchFn };
  const { lookupDocsHttp: lookup, searchSkillsHttp: search } = await import(
    "../discovery/context7.js"
  );
  const outcome = sub === "docs" ? await lookup(query, opts) : await search(query, opts);
  if (outcome.approvalRequired) {
    out("vf", c.yellow(`${outcome.reason} Re-run with --yes to approve the network lookup.`));
    return 0;
  }
  if (!outcome.ok) {
    out("vf", c.red(outcome.reason ?? "discovery failed"), {
      level: "error",
    });
    return 1;
  }
  for (const r of outcome.results) {
    const tag = r.status ? c.yellow(`[${r.status}]`) : c.dim(`[${r.kind}]`);
    const slug = r.name ? c.dim(` name: ${r.name}`) : "";
    out("vf", `${tag} ${c.bold(r.title)} — ${r.snippet}${slug}`);
  }
  if (!outcome.results.length) out("vf", c.dim("(no results)"));
  return 0;
}
