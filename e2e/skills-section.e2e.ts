import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

test.describe("Skills section", () => {
  test("stage 1 is visible on load (skills fetched in background)", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    // Stage 1 is the intake — skills API is fetched in background
    await expect(page.locator("#repo-path")).toBeAttached();
  });

  test("GET /api/skills returns ok", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    const result = await page.evaluate(async () => {
      const res = await fetch("/api/skills");
      return { status: res.status, ok: res.ok };
    });
    expect(result.ok).toBe(true);
  });
});
