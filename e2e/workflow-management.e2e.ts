import { expect, test } from "@playwright/test";
import { waitForPage } from "./helpers";


test.describe("Workflow state via API", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
  });

  test("POST /api/init returns 200 with CSRF token", async ({ page }) => {
    // Extract CSRF token from the page meta tag
    const csrf = await page.locator('meta[name="vf-token"]').getAttribute("content");
    expect(csrf).toBeTruthy();

    const base = page.url().replace(/\/$/, "");
    const result = await page.evaluate(
      async ({ origin, token }: { origin: string; token: string }) => {
        const res = await fetch(origin + "/api/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vibeflow-token": token,
          },
          body: JSON.stringify({ goal: "API test" }),
        });
        // Clean up: delete the workflow state we just created
        await fetch(origin + "/api/workflow", {
          method: "DELETE",
          headers: { "x-vibeflow-token": token },
        });
        return { ok: res.ok, status: res.status };
      },
      { origin: base, token: csrf ?? "" },
    );
    expect(result.status).toBe(200);
  });
});
