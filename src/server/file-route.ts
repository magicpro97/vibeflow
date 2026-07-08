// src/server/file-route.ts
//
// #558: the GET /api/file handler — reads a file the Web-UI wants to show for
// `file:line` evidence. Extracted from server.ts (which is at its size cap) so
// the sandbox stays small and 100%-covered. The caller (server.ts) has ALREADY
// enforced guarded(req) — token + loopback + origin — before we run; a GET that
// leaks arbitrary files is the whole risk, so that guard is non-negotiable.
//
// Sandbox mirrors escapesWorkspace (src/hooks/risk.ts:77): the resolved target
// must sit inside activeRepo. We check twice — lexically (cheap, catches
// `..`/absolute/`~`) and again after realpathSync (defeats a symlink that
// escapes). Always JSON (never the file's own content-type → no inline
// HTML/script execution); the UI renders content via `{{ }}` only.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const MAX_BYTES = 256 * 1024;

/** True when `target` sits outside `root`. Case-SENSITIVE prefix: a case-insensitive
 *  compare would false-negative on a case-sensitive FS (Linux) — repo `/srv/App` + a real
 *  sibling `/srv/app` + `?path=../app/x` would lowercase-match and escape the sandbox. The
 *  realpathSync pass (below) canonicalizes the true on-disk case, so a legit macOS/Windows
 *  request (case-insensitive FS) still resolves to the real casing and passes. */
function outside(root: string, target: string): boolean {
  return target !== root && !target.startsWith(`${root}${sep}`);
}

/** Read `rel` if it resolves inside `repo`; else a sandbox/size/binary JSON reply. */
export function handleFileRoute(repo: string, rel: string): Response {
  const rootLex = resolve(repo);
  // Lexical guard: rejects `~`, absolute paths, and `..` escapes up front.
  if (rel.startsWith("~") || outside(rootLex, resolve(repo, rel)))
    return Response.json({ error: "forbidden" }, { status: 403 });

  const target = resolve(repo, rel);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(target);
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!st.isFile()) return Response.json({ error: "not found" }, { status: 404 });

  // Symlink guard: realpath both sides (target exists here, so realpath is safe)
  // to defeat an in-repo symlink whose real target escapes the sandbox.
  // ponytail: accepts a tiny stat→read TOCTOU (a symlink swapped in between) — fine for a
  // loopback, token-guarded, single-user dev server; harden only if this ever serves untrusted clients.
  if (outside(realpathSync(rootLex), realpathSync(target)))
    return Response.json({ error: "forbidden" }, { status: 403 });

  if (st.size > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });

  const content = readFileSync(target, "utf8");
  if (content.includes("\u0000")) return Response.json({ ok: false, reason: "binary" });
  return Response.json({ ok: true, path: rel, content, truncated: false });
}
