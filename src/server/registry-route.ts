// #688 shared route helpers for the Registry tab. Kept OUT of server.ts so the
// validation logic is unit-testable without a live server and the file stays
// under the size cap. All routes are READ-ONLY: the preview endpoint only
// describes what a CLI update would do — it never spawns git, never touches the
// network, and never writes to disk.

import { buildRegistryView, findRegistryId } from "../skills/registry-view.js";
import type { LockReader } from "../skills/registry-view.js";

export interface RegistryPreview {
  ok: true;
  executable: false;
  registry: string;
  /** Human-readable description of the planned update (CLI-owned, dry-run). */
  plan: string;
}

/** GET /api/skills/registries — read-only registry list. */
export function handleRegistryView(repo: string, reader?: LockReader): Response {
  return Response.json(buildRegistryView(repo, reader));
}

/**
 * POST /api/skills/registries/preview — inert dry-run preview.
 * Accepts ONLY `{ action: "update", registry: <validated id> }` and always
 * returns `executable: false`. Real execution stays in the CLI / approval flow.
 */
export function handleRegistryPreview(repo: string, body: unknown, reader?: LockReader): Response {
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== 2 || !("action" in b) || !("registry" in b)) {
    return Response.json(
      { error: "body must contain exactly action and registry" },
      { status: 400 },
    );
  }
  if (b.action !== "update") {
    return Response.json({ error: 'action must be "update"' }, { status: 400 });
  }
  if (typeof b.registry !== "string" || !b.registry) {
    return Response.json({ error: "registry id required" }, { status: 400 });
  }
  const id = findRegistryId(repo, b.registry, reader);
  if (!id) {
    return Response.json({ error: "unknown registry" }, { status: 404 });
  }
  const preview: RegistryPreview = {
    ok: true,
    executable: false,
    registry: id,
    plan: `Dry-run: update registry "${id}" from its pinned ref. Approve in CLI to execute.`,
  };
  return Response.json(preview);
}
