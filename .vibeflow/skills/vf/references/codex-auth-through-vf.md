# Codex auth fails inside vf orchestrate (9router, 2026-09 verified)

## Symptom
`vf orchestrate --engine codex --yes` runs but EVERY unit fails instantly:
`[engine-stderr] Error: Your access token could not be refreshed because your refresh token was revoked`
and every review gate reports `measured gate failed: build`. The root cause is NOT the code — codex itself cannot authenticate, so it never writes any file.

## Root cause
On this user's machine codex uses a custom provider (9router at `http://127.0.0.1:20128/v1`) with a static `Authorization` header, but the OLD `~/.codex` home carried a revoked OpenAI OAuth session. When `CODEX_HOME` is NOT explicitly set, codex still attempts to refresh that revoked token before honoring the custom provider — regardless of how correct `config.toml` is.

## Fix (verified: `codex exec` replies `AUTH_OK`)
1. `mv ~/.codex ~/.codex.bak-<date>` (preserves sessions/history).
2. Fresh `~/.codex/config.toml` with ONLY the custom provider + trust for the workspace root:
   ```toml
   model = "clinepass/cline-pass/deepseek-v4-pro"
   model_reasoning_effort = "high"
   model_provider = "9router"

   [projects."/Users/<you>"]
   trust_level = "trusted"

   [model_providers.9router]
   name = "9Router"
   base_url = "http://127.0.0.1:20128/v1"
   wire_api = "responses"

   [model_providers.9router.http_headers]
   Authorization = "Bearer <key>"
   ```
3. `export CODEX_HOME=$HOME/.codex` in the launching terminal session BEFORE `vf orchestrate` — vf subprocesses inherit it. Without the export, codex re-triggers OAuth and fails again.
4. Verify standalone first, from inside the trusted dir: `codex exec "reply with exactly: AUTH_OK"` (literal reply, exit 0). Do this BEFORE any vf dispatch — a broken codex auth wastes a full orchestrate round and leaves every unit `build:fail`.

## Pre-dispatch checklist for vf + codex
- `codex exec "reply AUTH_OK"` succeeds (auth) — else fix `~/.codex`/CODEX_HOME first.
- `vf doctor --probe` shows `codex: ready` (binary + auth probe).
- A dry `vf orchestrate --engine codex` plans without `[engine-stderr]` errors.

## Secret-redaction trap when copying the provider key
Reading the key via `cat`/`grep` in terminal output gets it SECRET-REDACTED (`sk-9b7...468e`); reusing the mangled value writes a broken config. When you must copy a secret from one config to another, do read → write → verify inside ONE Python process (e.g. `python3 - <<'EOF'` heredoc reading `~/.codex/config.toml`, regex-extracting the header, writing the new file) so the secret never round-trips through the agent context. Also: the `execute_code` kernel can hang/time out on trivial file writes — fall back to terminal `python3 - <<'EOF'`; it is deterministic.
