import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

test.describe("Workflow generation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
  });

  test("stage 1 form is shown (repo path + goal)", async ({ page }) => {
    await expect(page.locator("#repo-path")).toBeVisible();
    await expect(page.locator("#goal")).toBeVisible();
  });

  test("Plan button exists on stage 1", async ({ page }) => {
    await expect(page.locator("#plan-btn")).toBeAttached();
  });
});
