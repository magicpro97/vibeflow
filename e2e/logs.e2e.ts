import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

test.describe("M4: CLI Log UI", () => {
  test("logs pane hidden on initial load", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("#log-pane")).toBeHidden();
  });

  test("logs toggle button exists in header", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    const btn = page.locator("header").getByRole("button", { name: /logs/i });
    await expect(btn).toBeVisible();
  });

  test("clicking logs toggle shows log pane", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("#log-pane")).toBeHidden();
    await page.locator("header").getByRole("button", { name: /logs/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("#log-pane")).toBeVisible();
    // Toggle back
    await page.locator("header").getByRole("button", { name: /logs/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("#log-pane")).toBeHidden();
  });

  test("log pane has clear button", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("header").getByRole("button", { name: /logs/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("#log-pane").getByRole("button", { name: /clear/i })).toBeVisible();
  });
});
