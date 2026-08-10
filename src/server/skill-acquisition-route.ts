// src/server/skill-acquisition-route.ts
// #682 — body validation + response mapping for skill-acquisition approval
// routes. Kept out of routes.ts so the file stays under its 400-line cap.
// No disk/network/install calls — decisions only resolve the in-memory broker;
// the waiting /api/orchestrate request owns all installation.

import type { AcquisitionDecision } from "../skills/acquisition.js";
import {
  listPendingSkillAcquisitions,
  resolveSkillAcquisition,
} from "./pending-skill-acquisitions.js";

/** GET /api/skills/acquisitions/pending — read-only bounded card list. */
export function handleSkillAcquisitionPending(): Response {
  return Response.json({
    pending: listPendingSkillAcquisitions().map(({ source, ...proposal }) => ({
      ...proposal,
      source: { registryId: source.registryId, commitOID: source.commitOID },
    })),
  });
}

/**
 * POST /api/skills/acquisitions/decision — resolve one card.
 * Exact-shape body: `{ id: string, decision: "approve" | "reject" }`.
 * 400 invalid body, 404 unknown/stale id, 409 blocked cannot be approved.
 */
export function handleSkillAcquisitionDecision(body: unknown): Response {
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== 2 || !("id" in b) || !("decision" in b)) {
    return Response.json({ error: "body must contain exactly id and decision" }, { status: 400 });
  }
  if (typeof b.id !== "string" || !b.id) {
    return Response.json({ error: "id required" }, { status: 400 });
  }
  if (b.decision !== "approve" && b.decision !== "reject") {
    return Response.json({ error: 'decision must be "approve" or "reject"' }, { status: 400 });
  }
  const outcome = resolveSkillAcquisition(b.id, b.decision as AcquisitionDecision);
  if (outcome === "not-found") {
    return Response.json({ error: "no such pending acquisition" }, { status: 404 });
  }
  if (outcome === "not-approvable") {
    return Response.json({ error: "proposal is blocked and cannot be approved" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
