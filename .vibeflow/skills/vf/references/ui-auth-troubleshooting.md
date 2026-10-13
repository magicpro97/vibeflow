# VibeFlow UI Auth Troubleshooting

## Dual auth system

VibeFlow's Bun server has TWO independent auth layers:

| Layer | Mechanism | Used by |
|-------|-----------|---------|
| `ConversationSessionAuthority` | Cookie-based session capability (`vf_conversation_session`) | Conversation namespace routes (`/api/conversations/*`) |
| `guarded()` | CSRF token header (`x-vibeflow-token`) | Legacy routes, root HTML, `/api/markers`, `/api/settings`, `/api/file`, `/api/capabilities`, `/api/hook/*` |

When `vf ui` runs standalone (no conversation authority), `conversation` is undefined. Routes under the conversation namespace return `500 conversation_authority_unavailable`. All other routes use `guarded()` which checks `x-vibeflow-token` against the CSRF token embedded in `/index.html`.

## Bug: GET requests miss CSRF token

**File:** `src/ui/src/conversation-home-http.ts`

**Symptom:** UI shows "Capability index unavailable / Failed to fetch" when clicking Capabilities drawer.

**Root cause:** The `headers()` function only included `x-vibeflow-token` on POST/PATCH:

```ts
function headers(method: "GET" | "PATCH" | "POST"): Record<string, string> {
  const write = method !== "GET";
  return {
    "content-type": "application/json",
    ...(write ? {} : { "cache-control": "no-store" }),
    ...(write && CSRF ? { [UI_LAN_TOKEN_HEADER]: CSRF } : {}),  // ← BUG: GET skipped
  };
}
```

GET requests to `/api/capabilities`, `/api/conversations`, `/api/settings` all lacked the token. The server's `guarded()` check returns 401. The browser `fetch()` sees a non-OK status and throws — the `decode()` function catches it, but since `response.ok` is false, it calls `parseHomeApiError()`, which produces an error message like "Failed to fetch" (or the server's JSON error body).

**Fix:** Remove the `write &&` guard — always send token when available:

```ts
...(CSRF ? { [UI_LAN_TOKEN_HEADER]: CSRF } : {}),
```

## Bug: Capability route uses cookie auth only

**File:** `src/server.ts` (around line 185-215)

**Symptom:** Even with correct CSRF token, `/api/capabilities` returns 401.

**Root cause:** The capability route's `sessions.authorize` function was `conversation?.sessions ?? { authorize: guarded }`. When `conversation` is defined (provided by `buildConversationHttpAuthority`), `sessions.authorize` calls `ConversationSessionAuthority.authorize()`, which checks a cookie (`vf_conversation_session`). The standalone `vf ui` server does NOT set this cookie — it only validates the CSRF header.

**Fix:** Fall back from session auth to CSRF header auth:

```ts
const sessions = conversation?.sessions ?? { authorize: guarded };
const authorizeWithFallback: typeof sessions.authorize = (req) =>
  sessions.authorize(req) || guarded(req);
return handleCapabilityRoute(
  { sessions: { authorize: authorizeWithFallback }, capabilities: {...} },
  req, url, packageIdFromPath
);
```

## Tracing auth failures with curl

```bash
# Get the CSRF token from index.html
TOKEN=$(curl -s http://localhost:PORT | grep -oP 'meta name="vf-token" content="\K[a-f0-9-]+(?=")')

# Test endpoint WITH token (should return 200 or a different error, not 401)
curl -s -w "\nHTTP %{http_code}" -H "x-vibeflow-token: $TOKEN" \
  "http://localhost:PORT/api/capabilities?view=search&scope=project&limit=50"

# Test WITHOUT token (should return 401)
curl -s -w "\nHTTP %{http_code}" \
  "http://localhost:PORT/api/capabilities?view=search&scope=project&limit=50"

# Also test the /state endpoint — unguarded, always returns data
curl -s http://localhost:PORT/state | jq '.work_units | length'
```

HTTP status codes tell the story:
- **401**: Auth layer blocked it (no/invalid token or cookie)
- **503**: Auth passed but service unavailable (capabilities not initialized)
- **500**: Server error (missing conversation authority)

## Quick fix checklist

When UI shows "Capability index unavailable / Failed to fetch":

1. **Kill stale server** — `lsof -ti:4173 | xargs kill -9`
2. **Rebuild** — `bun run build`
3. **Launch** — `node dist/cli.js ui --port 4173 --host 127.0.0.1 --no-open` (NOT `bun run vf ui`)
4. **Check version** — `curl -s http://localhost:4173 | grep vf-version` should match `node -p "require('./package.json').version"`
5. **Check JS bundle hash** — UI HTML asset hashes should match what `bun run --cwd src/ui build` printed
6. **Test capabilities** — `curl -s -H "x-vibeflow-token: $(curl -s http://localhost:4173 | grep -oP 'content=\"\K[a-f0-9-]+(?=")')" http://localhost:4173/api/capabilities?view=search&scope=project&limit=50 | head -c 200`

If step 6 returns `service_unavailable` (503), capabilities are not initialized in this repo — run `vf init` first. If it returns `unauthenticated` (401), the CSRF header isn't being sent or the route doesn't respect it.
