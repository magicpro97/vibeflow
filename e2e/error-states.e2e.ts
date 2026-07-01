import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

test.describe("Edge cases", () => {
  test("stage 1 renders on empty state", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("#repo-path")).toBeVisible();
    await expect(page.locator("#goal")).toBeVisible();
  });

  test("header is always visible on empty state", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("header").getByText("VibeFlow")).toBeVisible();
  });
});
