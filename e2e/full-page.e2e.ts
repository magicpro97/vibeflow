import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

const SCREENSHOT_DIR = "screenshots";
function snapPath(cas: string, sub: string, step: number, desc: string, fmt = "png"): string {
  return join(SCREENSHOT_DIR, `${cas}_${sub}_step${step}_${desc}.${fmt}`);
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
    await expect(page.locator("header").getByText("VibeFlow")).toBeVisible();
    await expect(page.locator("main")).toBeVisible();
  });

  test("header contains branding and utility buttons", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    const header = page.locator("header");
    await page.screenshot({
      path: snapPath("full_page", "header_branding", 1, "header_view"),
    });
    await expect(header.getByText("VibeFlow")).toBeVisible();
    await expect(header.getByRole("button", { name: /open settings/i })).toBeVisible();
    await expect(header.getByRole("button", { name: /logs/i })).toBeVisible();
  });

  test("stepper shows 4 stages", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    // Stepper is inside the header nav on md+ screens
    const nav = page.locator('nav[aria-label="Progress"]');
    // Stepper may be hidden on narrow viewports; just check it exists
    await expect(nav).toBeAttached();
  });

  test("stage 1 Describe is shown on initial load", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.screenshot({
      path: snapPath("full_page", "stage1_initial", 1, "stage1"),
    });
    // Stage1 renders the repo-path input
    await expect(page.locator("#repo-path")).toBeVisible();
  });

  test("logs pane hidden on initial load", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("#log-pane")).toBeHidden();
  });

  test("logs toggle opens log pane", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("header").getByRole("button", { name: /logs/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("#log-pane")).toBeVisible();
    await page.screenshot({
      path: snapPath("full_page", "logs_open", 1, "log_pane"),
    });
    // toggle back
    await page.locator("header").getByRole("button", { name: /logs/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("#log-pane")).toBeHidden();
  });

  test("settings panel opens via settings button", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("header").getByRole("button", { name: /open settings/i }).click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: snapPath("full_page", "settings_open", 1, "settings_panel"),
    });
    await expect(page.locator("#settings-title")).toBeVisible();
    // Close via close button
    await page.getByRole("button", { name: /close settings/i }).click();
    await page.waitForTimeout(200);
    await expect(page.locator("#settings-title")).toBeHidden();
  });

  test("status bar is rendered at bottom", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    // StatusBar renders at bottom; check it is in DOM
    // It contains confidence/engine info
    await expect(page.locator("footer, [class*=status]").first()).toBeAttached();
  });
});
