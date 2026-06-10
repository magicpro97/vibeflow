import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "screenshots";

function snapPath(cas: string, sub: string, step: number, desc: string, fmt = "png"): string {
  return join(SCREENSHOT_DIR, `${cas}_${sub}_step${step}_${desc}.${fmt}`);
}

async function waitForPage(page: import("@playwright/test").Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("#intake", { state: "attached" });
  await page.waitForTimeout(1200);
}

test.describe("Full page structure", () => {
  test("renders all top-level sections with correct layout", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.screenshot({
      path: snapPath("full_page", "renders_all_sections", 1, "initial_load"),
      fullPage: true,
    });

    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("header h1")).toHaveText("VibeFlow");
    await expect(page.locator(".live")).toBeVisible();
    await expect(page.locator(".dot")).toBeVisible();
    await expect(page.locator("#themeToggle")).toBeVisible();
    await expect(page.locator("#feedbackBtn")).toBeVisible();

    await expect(page.locator("#intake")).toBeVisible();
    await expect(page.locator("#projectSec")).toBeVisible();
    await expect(page.locator("#workflowSec")).toBeVisible();
    await expect(page.locator("#skillsSec")).toBeVisible();
    await expect(page.locator("#optionsSec")).toBeVisible();
    await expect(page.locator("#discoverSec")).toBeVisible();
    await expect(page.locator("#actionSec")).toBeVisible();
  });

  test("header contains branding, live indicator, and utility buttons", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    const header = page.locator("header");

    await page.screenshot({
      path: snapPath("full_page", "header_branding", 1, "header_view"),
    });

    await expect(header.locator(".logo")).toBeVisible();
    await expect(header.locator("h1")).toHaveText("VibeFlow");
    await expect(header.locator(".sub")).toHaveText("orchestration");
    await expect(header.locator("#themeToggle")).toBeVisible();
    await expect(header.locator("#feedbackBtn")).toHaveText("feedback");
  });

  test("intake wizard has project info and workflow sections", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    await page.screenshot({
      path: snapPath("full_page", "intake_wizard_fields", 1, "project_info"),
    });

    const projectSec = page.locator("#projectSec");
    await expect(projectSec.locator(".tool-details-head")).toContainText("Project Info");
    await expect(projectSec.locator("#docSourceList")).toBeVisible();
    await expect(projectSec.locator("#taskSourceList")).toBeVisible();
    await expect(projectSec.locator("#fileTypesSelect")).toBeVisible();
    await expect(projectSec.locator("#attachInput")).toBeVisible();
    await expect(projectSec.locator("#repoPath")).toBeVisible();
    await expect(projectSec.locator("#detectBtn")).toBeVisible();
    await expect(projectSec.locator("#checkEnginesBtn")).toBeVisible();
    await expect(projectSec.locator("#eng-claude")).toBeChecked();
    await expect(projectSec.locator("#eng-codex")).toBeChecked();
    await expect(projectSec.locator("#eng-copilot")).toBeChecked();

    await page.screenshot({
      path: snapPath("full_page", "intake_wizard_fields", 2, "workflow_section"),
    });

    const workflowSec = page.locator("#workflowSec");
    await expect(workflowSec.locator(".tool-details-head")).toContainText("Goal / task");
    await expect(workflowSec.locator("#goalModes")).toBeVisible();
    await expect(workflowSec.locator("#presetOpenBtn")).toBeVisible();
    await expect(workflowSec.locator("#wfDispatchBtn")).toBeDisabled();
    await expect(workflowSec.locator("#builderView")).toBeVisible();
    await expect(workflowSec.locator("#stageTemplateOut")).toBeVisible();
    await expect(workflowSec.locator("#rawView")).toBeHidden();
  });
});

test.describe("Theme toggle", () => {
  test("toggles between light and dark mode", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    const html = page.locator("html");
    const btn = page.locator("#themeToggle");

    await expect(html).not.toHaveClass(/dark-mode/);
    await page.screenshot({
      path: snapPath("theme", "toggle_dark", 1, "light_mode"),
    });

    await btn.click();
    await page.waitForTimeout(300);
    await expect(html).toHaveClass(/dark-mode/);
    await page.screenshot({
      path: snapPath("theme", "toggle_dark", 2, "dark_mode"),
    });

    await btn.click();
    await expect(html).not.toHaveClass(/dark-mode/);
  });

  test("persists dark mode preference across reload", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#themeToggle").click();
    await page.waitForTimeout(300);
    await expect(page.locator("html")).toHaveClass(/dark-mode/);

    await page.screenshot({
      path: snapPath("theme", "persist_reload", 1, "before_reload_dark"),
    });

    await page.reload();
    await page.waitForTimeout(500);
    await expect(page.locator("html")).toHaveClass(/dark-mode/);

    await page.screenshot({
      path: snapPath("theme", "persist_reload", 2, "after_reload_dark"),
    });
  });
});

test.describe("Feedback modal", () => {
  test("opens and displays the feedback panel with log and form", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#feedbackBtn").click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: snapPath("feedback", "opens_panel", 1, "feedback_modal_open"),
    });

    const modal = page.locator("#feedbackModal");
    await expect(modal).toBeVisible();
    await expect(modal).not.toHaveClass(/hidden/);
    await expect(modal.locator("#feedbackLog")).toBeVisible();
    await expect(modal.locator("#feedbackText")).toBeVisible();
    await expect(modal.locator("#downloadLogBtn")).toBeVisible();
    await expect(modal.locator("#submitFeedbackBtn")).toBeVisible();
    await expect(modal.locator("#cancelFeedbackBtn")).toBeVisible();
    await expect(modal.locator("#feedbackClose")).toBeVisible();
  });

  test("closes feedback modal via close button", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#feedbackBtn").click();
    await expect(page.locator("#feedbackModal")).toBeVisible();

    await page.locator("#feedbackClose").click();
    await page.waitForTimeout(300);
    await expect(page.locator("#feedbackModal")).not.toBeVisible();
  });

  test("closes feedback modal via cancel button", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#feedbackBtn").click();
    await page.locator("#cancelFeedbackBtn").click();
    await page.waitForTimeout(300);
    await expect(page.locator("#feedbackModal")).not.toBeVisible();
  });

  test("download log button creates a downloadable log", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#feedbackBtn").click();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#downloadLogBtn").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/vibeflow-log-/);
  });

  test("feedback log contains state information", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#feedbackBtn").click();
    await page.waitForTimeout(300);

    const logContent = await page.locator("#feedbackLog").textContent();
    expect(logContent).toContain("timestamp:");
    expect(logContent).toContain("userAgent:");
    expect(logContent).toContain("repo:");
  });
});

test.describe("Preset modal", () => {
  test("opens preset modal and lists presets", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#presetOpenBtn").click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: snapPath("preset", "lists_presets", 1, "preset_modal"),
    });

    const modal = page.locator("#presetModal");
    await expect(modal).toBeVisible();
    await expect(modal).not.toHaveClass(/hidden/);

    const cards = modal.locator(".preset-card");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(4);

    const names = await cards.locator(".pc-name").allTextContents();
    expect(names).toContain("Full lifecycle");
    expect(names).toContain("TDD");
    expect(names).toContain("SDD");
  });

  test("applying a preset fills the builder steps", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#presetOpenBtn").click();
    await page.waitForTimeout(300);

    await page.locator(".preset-card", { hasText: "TDD" }).click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: snapPath("preset", "apply_tdd", 1, "after_tdd_applied"),
    });

    const steps = page.locator(".step-card");
    const stepCount = await steps.count();
    expect(stepCount).toBe(3);

    const titleEls = await steps.locator(".step-title").all();
    const titles = await Promise.all(titleEls.map((el) => el.inputValue()));
    expect(titles).toContain("Red — write a failing test");
    expect(titles).toContain("Green — make it pass");
    expect(titles).toContain("Refactor — clean up");
  });

  test("closes preset modal via close button", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("#presetOpenBtn").click();
    await page.locator("#presetClose").click();
    await page.waitForTimeout(300);
    await expect(page.locator("#presetModal")).not.toBeVisible();
  });
});

test.describe("Goal mode switching", () => {
  test("switching to raw content mode shows raw editor", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    page.on("dialog", (d) => d.accept());
    await page.locator('#goalModes .gm-btn[data-mode="raw"]').click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: snapPath("goal_mode", "switch_to_raw", 1, "raw_content_editor"),
    });

    await expect(page.locator("#rawView")).toBeVisible();
    await expect(page.locator("#rawContent")).toBeVisible();
    await expect(page.locator("#builderView")).toBeHidden();
  });

  test("raw content mode button is active after switching", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    page.on("dialog", (d) => d.accept());
    await page.locator('#goalModes .gm-btn[data-mode="raw"]').click();

    const rawBtn = page.locator('#goalModes .gm-btn[data-mode="raw"]');
    await expect(rawBtn).toHaveClass(/active/);
    const builderBtn = page.locator('#goalModes .gm-btn[data-mode="builder"]');
    await expect(builderBtn).not.toHaveClass(/active/);
  });
});

test.describe("Workflow tabs", () => {
  test("single workflow mode — no add-workflow button", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    await page.screenshot({
      path: snapPath("workflow_tabs", "single_workflow", 1, "one_tab_no_add"),
    });

    const tabs = page.locator(".wf-tab");
    await expect(tabs).toHaveCount(1);
    await expect(page.locator(".wf-tab-add")).toHaveCount(0);
  });

  test("workflow name can be edited", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const firstName = await page.locator(".wf-name").inputValue();
    expect(firstName.length).toBeGreaterThan(0);

    await page.locator(".wf-name").fill("My workflow");
    await page.waitForTimeout(300);

    await expect(page.locator(".wf-name")).toHaveValue("My workflow");

    await page.screenshot({
      path: snapPath("workflow_tabs", "edit_name", 1, "renamed_workflow"),
    });
  });
});

test.describe("Optional tools section", () => {
  test("tools section is rendered with toggle options", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    await page.locator("#optionsSec").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const hasSummary = await page.locator("#optionsSec > summary").count();
    if (hasSummary) {
      await page.locator("#optionsSec > summary").click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: snapPath("optional_tools", "section_rendered", 1, "tools_expanded"),
    });

    await expect(page.locator("#toolList")).toBeVisible();
    await expect(page.locator("#optionsHint")).toBeAttached();
    await expect(page.locator("#toolPriority")).toBeVisible();
  });
});

test.describe("Discovery section", () => {
  test("discovery form is fully rendered", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.screenshot({
      path: snapPath("discovery", "form_rendered", 1, "discovery_section"),
    });

    await expect(page.locator("#discoverSec")).toBeVisible();
    await expect(page.locator("#discoverKind")).toBeVisible();
    await expect(page.locator("#discoverQuery")).toBeVisible();
    await expect(page.locator("#discoverApprove")).toBeVisible();
    await expect(page.locator('#discoverForm button[type="submit"]')).toBeVisible();
  });

  test("searching without query shows a prompt", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.fill("#discoverQuery", "");
    await page.click('#discoverForm button[type="submit"]');
    await expect(page.locator("#discoverHint")).toContainText(/query required/i);
  });
});

test.describe("Project Info source controls", () => {
  test("can add and remove doc sources", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const addBtn = page.locator("#docSourceAdd");
    await addBtn.click();
    await addBtn.click();
    await page.waitForTimeout(200);

    const rows = page.locator("#docSourceList .group-row");
    await expect(rows).toHaveCount(3);

    await page.screenshot({
      path: snapPath("source_controls", "doc_sources", 1, "three_doc_rows"),
    });

    await rows.first().locator(".group-del").click();
    await expect(page.locator("#docSourceList .group-row")).toHaveCount(2);
  });

  test("can add and remove task sources", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const addBtn = page.locator("#taskSourceAdd");
    await addBtn.click();
    await addBtn.click();
    await addBtn.click();

    const rows = page.locator("#taskSourceList .group-row");
    await expect(rows).toHaveCount(4);
  });

  test("file type selection adds chips and removal works", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    await page.locator("#fileTypesSelect").selectOption("pdf");
    await expect(page.locator("#fileTypesChips .chip")).toHaveCount(1);
    await expect(page.locator("#fileTypesChips .chip")).toContainText("pdf");

    await page.locator("#fileTypesSelect").selectOption("json");
    await expect(page.locator("#fileTypesChips .chip")).toHaveCount(2);

    await page.screenshot({
      path: snapPath("source_controls", "file_type_chips", 1, "two_chips"),
    });

    await page.locator("#fileTypesChips .chip-x").first().click();
    await expect(page.locator("#fileTypesChips .chip")).toHaveCount(1);
  });
});

test.describe("Workflow builder steps", () => {
  test("builder is initialized with Full lifecycle preset steps", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const steps = page.locator(".step-card");
    await expect(steps).toHaveCount(7);

    await page.screenshot({
      path: snapPath("builder", "full_lifecycle", 1, "seven_steps"),
    });

    const firstTitle = await steps.first().locator(".step-title").inputValue();
    expect(firstTitle).toMatch(/BD.*Basic Design/);

    const lastTitle = await steps.last().locator(".step-title").inputValue();
    expect(lastTitle).toMatch(/RV.*Review \/ Verify/);
  });

  test("can edit a step title, description, and prompt", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const stepCard = page.locator(".step-card").first();
    const titleInput = stepCard.locator(".step-title");
    const titleEditBtn = stepCard.locator('.field[data-edit="title"] .field-edit');

    await titleEditBtn.click();
    await page.waitForTimeout(200);
    await titleInput.fill("Custom step title");
    await expect(titleInput).toHaveValue("Custom step title");

    const promptInput = stepCard.locator(".sf-prompt");
    await promptInput.fill("Custom agent prompt");
    await expect(promptInput).toHaveValue("Custom agent prompt");

    await page.screenshot({
      path: snapPath("builder", "edit_step", 1, "edited_step_fields"),
    });
  });

  test("adding a step inserts a new step card", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const before = await page.locator(".step-card").count();
    await page.locator(".step-insert button").first().click();
    const after = await page.locator(".step-card").count();
    expect(after).toBe(before + 1);
  });

  test("removing a step removes the step card", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const before = await page.locator(".step-card").count();
    await page.locator(".step-remove").first().click();
    const after = await page.locator(".step-card").count();
    expect(after).toBe(before - 1);
  });

  test("editing steps updates the preview textarea", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const preview = page.locator("#stageTemplateOut");
    await expect(preview).not.toHaveValue("");
    await expect(preview).not.toHaveValue(/Add steps/);

    await page.screenshot({
      path: snapPath("builder", "preview_updates", 1, "preview_content"),
    });
  });
});

test.describe("Workflow builder prompt editing", () => {
  test("editing a prompt updates the preview", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const preview = page.locator("#stageTemplateOut");
    const initialValue = await preview.inputValue();
    expect(initialValue.length).toBeGreaterThan(0);

    const firstCard = page.locator(".step-card").first();
    const promptInput = firstCard.locator(".sf-prompt");
    await promptInput.fill("run");
    await page.waitForTimeout(300);

    await expect(promptInput).toHaveValue("run");
    await expect(preview).not.toHaveValue(initialValue);

    await page.screenshot({
      path: snapPath("builder", "edit_prompt", 1, "after_prompt_edit"),
    });
  });
});

test.describe("Workflow dispatch modal", () => {
  test("dispatch button is disabled before generate", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.screenshot({
      path: snapPath("dispatch", "disabled_before", 1, "dispatch_disabled"),
    });
    await expect(page.locator("#wfDispatchBtn")).toBeDisabled();
  });

  test("dispatch modal opens when enabled and clicked", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.click("#intakeSubmit");
    await page.waitForTimeout(400);

    const reviewModal = page.locator("#reviewModal");
    await expect(reviewModal).toBeVisible();

    await page.screenshot({
      path: snapPath("dispatch", "review_modal", 1, "review_modal_open"),
    });

    await page.locator("#reviewCancel").click();
    await page.waitForTimeout(300);
    await expect(reviewModal).not.toBeVisible();
  });
});

test.describe("Review modal", () => {
  test("review modal opens on generate click with workflow content", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.click("#intakeSubmit");
    await page.waitForTimeout(400);

    await page.screenshot({
      path: snapPath("review", "opens_with_content", 1, "review_modal_content"),
    });

    const modal = page.locator("#reviewModal");
    await expect(modal).toBeVisible();
    await expect(modal.locator("#reviewContent")).toBeVisible();
    await expect(modal.locator("#reviewCancel")).toBeVisible();
    await expect(modal.locator("#reviewConfirm")).toBeVisible();
    await expect(modal.locator("#reviewNotes")).toBeVisible();
    await expect(modal.locator("#reviewHint")).toBeAttached();

    const content = await modal.locator("#reviewContent").inputValue();
    expect(content).toContain("Master configuration");
    expect(content).toContain("Workflow");
  });

  test("cancel closes the review modal", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.click("#intakeSubmit");
    await page.waitForTimeout(300);
    await page.locator("#reviewCancel").click();
    await page.waitForTimeout(300);
    await expect(page.locator("#reviewModal")).not.toBeVisible();
  });
});

test.describe("Empty states", () => {
  test("meter is hidden on initial load", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.screenshot({
      path: snapPath("empty", "meter_hidden", 1, "meter_hidden_initial"),
    });
    await expect(page.locator("#meter")).toBeHidden();
  });

  test("skills section shows initial state", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("#skillsSec")).toBeVisible();
  });
});

test.describe("CSRF token", () => {
  test("page carries a per-process CSRF token", async ({ page }) => {
    await page.goto("/");
    const csrf = await page.locator('meta[name="csrf"]').getAttribute("content");
    expect(csrf?.length).toBeTruthy();
  });
});

test.describe("Page title and metadata", () => {
  test("has correct page title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/VibeFlow/);
  });

  test("has correct viewport meta tag", async ({ page }) => {
    await page.goto("/");
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).toContain("width=device-width");
  });
});
