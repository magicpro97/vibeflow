import type { Page } from "@playwright/test";

export async function waitForPage(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("header", { state: "attached" });
  await page.waitForTimeout(600);
}
