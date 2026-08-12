import { getReleaseProposal, listReleaseProposals } from "../skills/registry-release-view.js";
import type { SnapshotReader } from "../skills/registry-release-view.js";

export function handleReleaseProposalsView(repo: string, reader?: SnapshotReader): Response {
  return Response.json({ ok: true, proposals: listReleaseProposals(repo, reader) });
}

export function handleReleaseProposalView(
  repo: string,
  id: string,
  reader?: SnapshotReader,
): Response {
  const detail = getReleaseProposal(repo, id, reader);
  if (!detail) return Response.json({ error: "unknown release proposal" }, { status: 404 });
  return Response.json({ ok: true, proposal: detail });
}
