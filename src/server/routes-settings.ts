import { applySettings, settingsView } from "./handlers.js";

/**
 * `POST /api/settings` writes ONE repository's SETTINGS.json, and the repository it writes is the
 * server's process-global active repo — not anything named in the request.
 *
 * That is fine while exactly one client is moving that global, and wrong the moment a second one
 * does. Any page load holding the page token may `POST /api/detect`, which reassigns the active
 * repo for everyone; a tab that loaded repo A's System One block keeps two client-side mirrors
 * (`typesafeRepo`, `repoPath`) that still agree with each other, so its own guard stays open and
 * the save writes A's block — `enabled: true` included — into B. The key resolves per user, so B
 * then reads as configured. Nothing on the wire said which repo the client meant.
 *
 * So the write must carry the repo the client believed it was editing, and the server compares
 * that against the repo it is about to write. `expectRepo` is not persisted: `writeSettings`
 * copies known fields only, so an unknown top-level key never reaches disk.
 *
 * An absent `expectRepo` stays allowed — the other settings panels post the same block and this
 * guard must not break them — but the System One section always sends it.
 */
export function handleSettingsRoute(
  activeRepo: string,
  payload: Record<string, unknown>,
): Response {
  if ("envPolicy" in payload || "hooks" in payload) {
    return Response.json({ error: "policy changes require preview approval" }, { status: 400 });
  }
  const expectRepo = typeof payload.expectRepo === "string" ? payload.expectRepo : "";
  // A write that carries a System One block MUST name the repo it was read from. `expectRepo` is
  // optional for the blocks that other panels own, but `mergeTypesafeSettings` is replace-on-write
  // on mere key PRESENCE, so any client that posts a whole settings snapshot it took earlier can
  // silently overwrite the judge — including into a repo it never named. Refusing the combination
  // outright is what makes the guard structural rather than dependent on each caller opting in.
  // Malformed block: `null`, a string or an array coerces to "no block", and the merge would read
  // that as a DELETE of the stored guardrail configuration while reporting success. The invariant is
  // enforced in `assertTypesafeWriteAllowed`; this only picks the status code the client sees.
  if (
    "typesafe" in payload &&
    (payload.typesafe === null ||
      typeof payload.typesafe !== "object" ||
      Array.isArray(payload.typesafe))
  ) {
    return Response.json({ error: "the System One block must be an object" }, { status: 400 });
  }
  if ("typesafe" in payload && expectRepo === "") {
    return Response.json(
      { error: "a System One write must name the repository it was read from" },
      { status: 400 },
    );
  }
  if (expectRepo !== "" && expectRepo !== activeRepo) {
    return Response.json(
      { error: "the active repository changed; reload before saving" },
      { status: 409 },
    );
  }
  applySettings(activeRepo, payload);
  return Response.json({ ok: true, ...settingsView(activeRepo) });
}
