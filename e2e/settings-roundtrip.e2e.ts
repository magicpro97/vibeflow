import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";


test.describe("Settings round-trip", () => {
  test("toggle codegraph tool persists after reload", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const toggle = page.locator('.tool-toggle[data-tool="codegraph"]');
    await toggle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // ponytail: default is now true; toggle to opposite state
    const wasChecked = await toggle.isChecked();
    await toggle.click();
    await page.waitForTimeout(500);

    await page.reload();
    await waitForPage(page);

    const afterReload = page.locator('.tool-toggle[data-tool="codegraph"]');
    // After reload, the toggle should be in the opposite state from before click
    if (wasChecked) {
      await expect(afterReload).not.toBeChecked();
    } else {
      await expect(afterReload).toBeChecked();
    }
  });

  test("disabling all tools still renders priority section", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    for (const tool of ["codegraph", "lsp"]) {
      const toggle = page.locator(`.tool-toggle[data-tool="${tool}"]`);
      if (await toggle.isChecked()) {
        await toggle.click();
        await page.waitForTimeout(200);
      }
    }
    await expect(page.locator("#toolPriority")).toBeAttached();
  });

  test("failure protection timeout can be set if exposed", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);

    const input = page.locator("#fp-timeout");
    const count = await input.count();
    if (count > 0) {
      await input.fill("");
      await input.fill("3600");
      await input.dispatchEvent("change");
      await page.waitForTimeout(500);

      const settings = await page.evaluate(async () => {
        const origin = window.location.origin;
        const res = await fetch(origin + "/api/settings");
        return res.json();
      });
      expect(settings.failureProtection?.timeoutSeconds).toBe(3600);
    }
  });
});
