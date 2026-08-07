// src/server/pending-skill-acquisitions.ts
// #682 — bounded in-memory broker for web skill-acquisition approval cards.
// Modeled after pending-hooks but typed only for SkillAcquisitionProposal and
// fail-closed: max 32 cards, duplicate IDs coalesce, conflicting payload under
// the same ID throws, blocked cards cannot be approved, unknown/stale IDs are
// 404, and cleanup/clear rejects outstanding waits (never a dangling promise).
// No disk, network, or install calls.

import type { AcquisitionDecision, SkillAcquisitionProposal } from "../skills/acquisition.js";

const MAX_PENDING_CARDS = 32;

interface PendingCard {
  proposal: SkillAcquisitionProposal;
  fingerprint: string;
  callbacks: Set<(decision: AcquisitionDecision) => void>;
}

interface WaitCall {
  remaining: Set<string>;
  decisions: Map<string, AcquisitionDecision>;
  resolve: (decisions: ReadonlyMap<string, AcquisitionDecision>) => void;
}

const pending = new Map<string, PendingCard>();

function fingerprint(p: SkillAcquisitionProposal): string {
  return JSON.stringify({
    id: p.id,
    need: p.need,
    reason: p.reason,
    name: p.name,
    version: p.version,
    source: p.source,
    scan: p.scan,
    approvable: p.approvable,
  });
}

export function requestSkillAcquisitionDecisions(
  proposals: readonly SkillAcquisitionProposal[],
): Promise<ReadonlyMap<string, AcquisitionDecision>> {
  const uniq = new Map<string, SkillAcquisitionProposal>();
  for (const p of proposals) {
    if (!p || typeof p.id !== "string" || !p.id) continue;
    uniq.set(p.id, p);
  }

  if (pending.size + uniq.size > MAX_PENDING_CARDS) {
    throw new Error(`too many pending skill acquisitions (max ${MAX_PENDING_CARDS})`);
  }

  for (const p of uniq.values()) {
    const fp = fingerprint(p);
    const existing = pending.get(p.id);
    if (existing && existing.fingerprint !== fp) {
      throw new Error("conflicting payload for pending skill acquisition");
    }
  }

  return new Promise<ReadonlyMap<string, AcquisitionDecision>>((resolve) => {
    const call: WaitCall = {
      remaining: new Set(uniq.keys()),
      decisions: new Map(),
      resolve,
    };
    if (call.remaining.size === 0) {
      call.resolve(call.decisions);
      return;
    }
    for (const p of uniq.values()) {
      const existing = pending.get(p.id);
      const cb = (decision: AcquisitionDecision): void => {
        call.decisions.set(p.id, decision);
        call.remaining.delete(p.id);
        if (call.remaining.size === 0) call.resolve(call.decisions);
      };
      if (existing) existing.callbacks.add(cb);
      else {
        const card: PendingCard = {
          proposal: p,
          fingerprint: fingerprint(p),
          callbacks: new Set([cb]),
        };
        pending.set(p.id, card);
      }
    }
  });
}

export function listPendingSkillAcquisitions(): SkillAcquisitionProposal[] {
  return [...pending.values()]
    .map((c) => c.proposal)
    .sort((a, b) => {
      const na = a.need.localeCompare(b.need);
      return na !== 0 ? na : a.source.registryId.localeCompare(b.source.registryId);
    });
}

export function resolveSkillAcquisition(
  id: string,
  decision: AcquisitionDecision,
): "resolved" | "not-found" | "not-approvable" {
  const card = pending.get(id);
  if (!card) return "not-found";
  if (decision === "approve" && !card.proposal.approvable) return "not-approvable";
  pending.delete(id);
  for (const cb of card.callbacks) cb(decision);
  return "resolved";
}

/** Clear all pending cards, rejecting every outstanding wait as reject. Returns number cleared. */
export function clearPendingSkillAcquisitions(): number {
  const cards = [...pending.values()];
  pending.clear();
  for (const card of cards) for (const cb of card.callbacks) cb("reject");
  return cards.length;
}
