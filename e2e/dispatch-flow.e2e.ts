import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

test.describe("Dispatch button", () => {
  test("dispatch button absent on stage 1", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    // Stage 1 (Describe) never shows a dispatch button — it's a Stage 2 element
    await expect(page.getByRole("button", { name: /^dispatch$/i })).toHaveCount(0);
  });
});
