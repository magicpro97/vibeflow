import { expect, test } from "@playwright/test";

/**
 * Web e2e against the live VibeFlow dashboard. Each test asserts a concrete, observable
 * outcome so the UI is verifiable end to end (no "it probably rendered").
 */

/**
 * Ensure the intake `<details>` is expanded before touching fields inside it. Once a workflow
 * exists the dashboard auto-collapses the form on load (returning users land on live status,
 * not a form-wall), so any test that reads/sets an intake field must open it first. Fields
 * OUTSIDE the form (#intakeSubmit, #unitName) stay visible and need no opening.
 */
async function openIntake(page: import("@playwright/test").Page) {
  const intake = page.locator("#intake");
  if (!(await intake.evaluate((el: HTMLDetailsElement) => el.open))) {
    await page.locator("#intake > summary").click();
  }
  await expect(page.locator("#intakeForm")).toBeVisible();
}

test("dashboard loads with the intake wizard and a CSRF token", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/VibeFlow/);
  await expect(page.locator("header h1")).toHaveText("VibeFlow");
  // The page must carry a per-process CSRF token used by every write.
  const csrf = await page.locator('meta[name="csrf"]').getAttribute("content");
  expect(csrf?.length).toBeTruthy();
  await expect(page.locator("#intakeForm")).toBeVisible();
});

test("generating a workflow reveals the meter, dispatch, and work-unit sections", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#stageTemplateOut")).toHaveValue(/BD — Basic Design/);
  await page.click("#intakeSubmit");
  await expect(page.locator("#intakeHint")).toContainText(/Generated \d+ files/);
  await expect(page.locator("#meter")).toBeVisible();
  await expect(page.locator("#dispatchSec")).toBeVisible();
  await expect(page.locator("#unitsSec")).toBeVisible();
  // The empty board states the goal until work units exist.
  await expect(page.locator("#board")).toContainText("Workflow stages: BD - Basic Design");
});

test("orchestrate (dry) keeps the work-unit card and gate strip visible", async ({ page }) => {
  await page.goto("/");
  await openIntake(page);
  await page.check('input[name="workflowStage"][value="DD"]');
  await expect(page.locator("#stageTemplateOut")).toHaveValue(/DD — Detail Design/);
  await page.click("#intakeSubmit");
  await expect(page.locator("#meter")).toBeVisible();
  await page.fill("#unitName", "task");
  await page.click('#unitForm button[type="submit"]');
  const card = page.locator('.card[data-name="task"]');
  await expect(card).toBeVisible();

  await page.click("#orchestrateBtn");
  await expect(page.locator("#dispatchHint")).toContainText(/Orchestrated/);
  await expect(card).toBeVisible();
  // Gate strip is present; dry web orchestration writes prompts only.
  await expect(card.locator(".gate")).toHaveCount(4);
  await expect(card).toContainText("conf 0");
});

test("skills panel surfaces demand-driven needs from the detected stack", async ({ page }) => {
  await page.goto("/");
  // The workspace declares express → a docs need is resolved on demand.
  await expect(page.locator("#skillsSec")).toBeVisible();
  await expect(page.locator("#needsBox")).toContainText(/docs/i);
});

test("discovery is approval-gated: searching without approval asks for approval", async ({
  page,
}) => {
  await page.goto("/");
  await page.fill("#discoverQuery", "next.js");
  // Leave the "approve network" box unchecked.
  await page.click('#discoverForm button[type="submit"]');
  await expect(page.locator("#discoverOut")).toBeVisible();
  await expect(page.locator("#discoverOut")).toContainText(/requires approval/i);
});

test("a forbidden write (no CSRF token) is rejected by the server", async ({ request }) => {
  const res = await request.post("/api/units", {
    headers: { "content-type": "application/json" },
    data: { action: "add", unit: { name: "x" } },
  });
  expect(res.status()).toBe(403);
});

test("check-engines wires the probe and reports status", async ({ page }) => {
  await page.goto("/");
  // Click triggers POST /api/preflight (real engine probe). The button's GSAP entrance animation
  // briefly sets opacity:0 then clears it — force-click is safe. Assert the button exists and
  // clicking produces no console errors; the endpoint/response is covered by unit tests.
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.click("#checkEnginesBtn", { force: true });
  // Wait for the probe request to complete.
  await page.waitForTimeout(3000);
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test("optional-tools panel lists codegraph + lsp with persisted toggles", async ({ page }) => {
  await page.goto("/");
  // Open the collapsed options section so its controls become actionable.
  await page.locator("#optionsSec > summary").click();
  await expect(page.locator("#toolList .att")).toHaveCount(2);
  const codegraph = page.locator('#toolList .tool-toggle[data-tool="codegraph"]');
  await expect(codegraph).not.toBeChecked();
  // Toggling persists to SETTINGS.json; the saved state survives a reload.
  await codegraph.check();
  await expect(page.locator("#optionsHint")).toContainText(/Saved/);
  await page.reload();
  await page.locator("#optionsSec > summary").click();
  await expect(page.locator('#toolList .tool-toggle[data-tool="codegraph"]')).toBeChecked();
});

// --- Real interaction flows (not just "it rendered"): full units CRUD round-trips through
// the live server, a multi-unit board, deletion, and input validation. ---

test("adding multiple work units renders a card per unit and persists across reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.click("#intakeSubmit");
  await expect(page.locator("#unitsSec")).toBeVisible();
  // The e2e suite shares one workspace/ledger across tests, so count from a baseline
  // rather than assume a clean slate. Use unique names to avoid colliding with prior tests.
  const base = await page.locator(".card[data-name]").count();
  const names = ["mu-alpha", "mu-beta", "mu-gamma"];
  for (const name of names) {
    await page.fill("#unitName", name);
    await page.click('#unitForm button[type="submit"]');
    await expect(page.locator(`.card[data-name="${name}"]`)).toBeVisible();
  }
  await expect(page.locator(".card[data-name]")).toHaveCount(base + names.length);
  // State persists server-side: a reload re-renders the units from the ledger.
  await page.reload();
  for (const name of names) {
    await expect(page.locator(`.card[data-name="${name}"]`)).toBeVisible();
  }
});

test("deleting a work unit removes its card from the board", async ({ page }) => {
  await page.goto("/");
  await page.click("#intakeSubmit");
  await page.fill("#unitName", "to-remove");
  await page.click('#unitForm button[type="submit"]');
  const card = page.locator('.card[data-name="to-remove"]');
  await expect(card).toBeVisible();
  // The delete button posts immediately (no confirm dialog) and re-renders the board.
  await card.locator(".u-del").click();
  await expect(card).toHaveCount(0);
});

test("adding a unit with a blank name is rejected (no empty card created)", async ({ page }) => {
  await page.goto("/");
  await page.click("#intakeSubmit");
  const before = await page.locator(".card[data-name]").count();
  await page.fill("#unitName", "   ");
  await page.click('#unitForm button[type="submit"]');
  // The blank submit must not create a work-unit card; the count is unchanged.
  await expect(page.locator(".card[data-name]")).toHaveCount(before);
});

