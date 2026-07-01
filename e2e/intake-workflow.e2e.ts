import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

test.describe("Intake elements", () => {
  test("repo path input exists on stage 1", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("#repo-path")).toBeAttached();
  });

  test("use current directory button exists", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    // Stage1 has a 'use current directory' button
    await expect(page.getByRole("button", { name: /use current directory/i })).toBeAttached();
  });

  test("goal textarea exists", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expect(page.locator("#goal")).toBeAttached();
  });
});
