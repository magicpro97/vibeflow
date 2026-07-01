import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";

test.describe("Settings round-trip", () => {
  test("settings panel opens and closes", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("header").getByRole("button", { name: /open settings/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("#settings-title")).toBeVisible();
    await page.getByRole("button", { name: /close settings/i }).click();
    await page.waitForTimeout(200);
    await expect(page.locator("#settings-title")).toBeHidden();
  });

  test("POST /api/settings round-trips via UI — timeout persists", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await page.locator("header").getByRole("button", { name: /open settings/i }).click();
    await page.waitForTimeout(300);

    // Update timeout via API directly (settings panel is complex; API test is faster)
    const csrf = await page.locator('meta[name="vf-token"]').getAttribute("content");
    expect(csrf).toBeTruthy();
    const origin = new URL(page.url()).origin;
    const result = await page.evaluate(
      async ({ base, token }: { base: string; token: string }) => {
        const res = await fetch(`${base}/api/settings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vibeflow-token": token,
            Origin: base,
          },
          body: JSON.stringify({ failureProtection: { timeoutSeconds: 3600 } }),
        });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        return { ok: true, data };
      },
      { base: origin, token: csrf! },
    );
    expect(result.ok).toBe(true);

    // Verify it persisted
    const settings = await page.evaluate(async (base: string) => {
      const res = await fetch(`${base}/api/settings`);
      return res.json();
    }, origin);
    expect(settings.settings?.failureProtection?.timeoutSeconds).toBe(3600);
  });
});
