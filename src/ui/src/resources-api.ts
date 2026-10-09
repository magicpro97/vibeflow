// GET /api/resources — the repo-scoped resource snapshot (null when the repo
// has no workflow state). Sibling of api.ts, not an addition to it: that file
// sits exactly at the 400-line cap and update-api.ts set this precedent.
import type { ResourceSnapshot } from "../../resources.js";
import { req } from "./api.js";

export async function fetchResourceSnapshot(): Promise<ResourceSnapshot | null> {
  return req<ResourceSnapshot | null>("GET", "/api/resources");
}
