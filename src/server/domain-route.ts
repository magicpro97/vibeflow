// #691: guarded GET routes for the read-only Domain & Facts view.
// Kept OUT of server.ts so the validation is unit-testable and the file stays
// under the size cap. Both endpoints are READ-ONLY: they only project metadata
// from the two authoritative sources (readDomainFacts / analyzeSkillImpact) and
// read metadata from disk but never mutate disk, call the network, or enter a write path.

import { buildDomainView, isValidFactQuery } from "../skills/domain-view.js";
import { analyzeSkillImpact } from "../skills/impact.js";

/** GET /api/domains — read-only domain roots, owned facts, and child skills. */
export function handleDomainsView(repo: string): Response {
  return Response.json(buildDomainView(repo));
}

/**
 * GET /api/domains/impact?q=<fact-or-path> — resolve affected child skills.
 * The query is validated at the trust boundary: control chars, traversal,
 * backslash, absolute paths, and query length > 500 are rejected with a 400.
 */
export function handleDomainImpact(repo: string, rawQuery: string | null): Response {
  const query = (rawQuery ?? "").trim();
  if (!isValidFactQuery(query)) {
    return Response.json({ error: "invalid query" }, { status: 400 });
  }
  const result = analyzeSkillImpact(repo, query);
  return Response.json({ ok: true, query, facts: result.facts, skills: result.skills });
}
