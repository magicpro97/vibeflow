---
name: real-user-ui-qa
description: Use when validating a local web UI as a real user through Bun and Playwright, especially after UI changes or when mobile, zoom, accessibility, focus, console, or network regressions are possible.
compatibility: Bun 1.4, @playwright/test, and project-local Playwright browsers.
capabilities:
  - local web UI
  - Playwright
  - responsive
  - accessibility
  - keyboard focus
  - browser diagnostics
triggers:
  - real-user QA
---

# Real-User UI QA

Exercise complete user journeys against the built local app. Test visible behavior and browser evidence, not isolated handlers or guessed selectors. Keep credentials out of the run.

## When to use

- UI, component, route, DTO, or browser-facing behavior changed.
- User asks for smoke, acceptance, exploratory, responsive, accessibility, or real-user QA.
- Failure may involve layout, keyboard focus, browser diagnostics, API calls, or server state.

## When not to use

- Pure backend, library, documentation, or static type-only changes with no browser surface.
- Unit-level behavior already proves no browser interaction is involved.
- Production or third-party sites, real accounts, or credentialed flows. Stop and request a safe local fixture instead.

## Steps

1. Read `package.json`, `playwright.config.*`, and the relevant UI flow before acting. Use project scripts and existing fixtures; do not guess selectors. Confirm target URL, server command, port, test match, and cleanup ownership.
2. Build first with the repository's Bun command (`bun run build`). Restart any existing local UI/server process from the fresh build; never test stale assets. Prefer the project's Playwright config/webServer so it owns one isolated server, workspace, temp root, and teardown.
3. Run one complete happy-path journey with the repository's canonical flow: `bun run build`, then `bunx playwright test e2e/conversation-home.spec.ts` (or the exact focused spec required by the change). This uses local Bun, `playwright.config.ts`, its isolated webServer, and Playwright-owned teardown. Navigate through visible controls and realistic pointer/keyboard actions; assert URL/state/DOM plus the relevant response. Do not replace the journey with API calls or `page.evaluate` shortcuts.
4. Repeat meaningful states at narrow viewports, at minimum 320x740 and 390x844 when mobile matters. Check no horizontal overflow, controls stay in viewport, touch targets are usable, content scrolls, and overlays remain reachable. Check 200% text zoom by increasing the root font size or using the project's equivalent; verify layout, focus, and controls again.
5. Check accessibility and focus: run the installed `@axe-core/playwright` check on each important state; use semantic roles/names, keyboard Tab/Enter/Escape/arrow flows, visible focus, focus restoration after dialogs/menus, and inert/hidden closed regions. Assert `document.activeElement` or locator focus where behavior matters.
6. Register listeners before first navigation for `pageerror`, console messages of type `error`, and `requestfailed`; collect response/request status for the journey. Fail on unexpected browser errors, failed requests, or unexpected 4xx/5xx. Allow only responses deliberately produced by the scenario, and record those exceptions explicitly.
7. If server code or generated assets changed, stop the server and rerun build before the final run. Keep test state isolated and deterministic: unique throwaway workspace/temp paths, one worker for shared state, no sleeps/retries to hide races, and no credential-like environment variables, storage state, cookies, tokens, or API keys. Use fake probes/local fixtures only.
8. Clean up on success and failure: close pages/contexts/browsers, stop only the server/processes owned by this run, remove throwaway workspace/temp artifacts, and preserve trace/screenshots/logs for failures. Do not kill unrelated user processes or delete the repository.

## Verification

- Focused full-flow Playwright command exits 0 against freshly built local assets.
- Responsive checks cover required mobile viewport(s) and 200% text zoom without horizontal overflow or clipped/unreachable controls.
- Axe reports no untriaged violations; keyboard focus and restoration assertions pass.
- No unexpected `pageerror`, console error, `requestfailed`, or HTTP error remains; intentional fixture responses are named in the test.
- Build was rerun after relevant server/generated-asset changes; owned server, browser, and temporary resources are cleaned up.
- Report exact command, URL/viewport states, intentional exceptions, artifacts, and any skipped coverage. Never report credentials or secret values.
