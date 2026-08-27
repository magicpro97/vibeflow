import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function captureIfRequested(page, filename) {
  const directory = process.env.VF_LANDING_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, filename) });
}

test("landing is accessible and compact at desktop size", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Keep your AI CLIs. Lose the re-brief.",
  );

  const transcript = page.getByRole("region", { name: "VibeFlow terminal transcript" });
  await expect(transcript).toHaveAttribute("tabindex", "0");

  const headlineLines = await page.locator(".hero h1").evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
    const rowTops = [...range.getClientRects()]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => rect.top)
      .sort((left, right) => left - right);
    return rowTops.reduce(
      (rows, top, index) =>
        rows + (index === 0 || top - rowTops[index - 1] > lineHeight / 2 ? 1 : 0),
      0,
    );
  });
  const headlineOverflows = await page
    .locator(".hero h1 span")
    .evaluateAll((nodes) => nodes.some((node) => node.scrollWidth > node.clientWidth));
  const ledeWords = await page
    .locator(".hero-lede")
    .evaluate((node) => (node.textContent ?? "").trim().split(/\s+/u).filter(Boolean).length);
  expect(headlineLines).toBeLessThanOrEqual(2);
  expect(headlineOverflows).toBe(false);
  expect(ledeWords).toBeLessThanOrEqual(20);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  const reliabilityCards = await page.locator(".reliability-card").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top };
    }),
  );
  expect(reliabilityCards).toHaveLength(4);
  expect(reliabilityCards[0]?.top).toBe(reliabilityCards[1]?.top);
  expect(reliabilityCards[2]?.top).toBe(reliabilityCards[3]?.top);
  expect(reliabilityCards[2]?.top).toBeGreaterThan(reliabilityCards[0]?.top ?? 0);
  expect(reliabilityCards[0]?.left).toBe(reliabilityCards[2]?.left);
  expect(reliabilityCards[1]?.left).toBe(reliabilityCards[3]?.left);

  const primaryCta = page.getByRole("link", { name: "Install VibeFlow" });
  const primaryCtaBox = await primaryCta.boundingBox();
  expect(primaryCtaBox).not.toBeNull();
  expect((primaryCtaBox?.y ?? 0) + (primaryCtaBox?.height ?? 0)).toBeLessThanOrEqual(720);
  await captureIfRequested(page, "landing-desktop-1280x720.png");

  await transcript.focus();
  await expect(transcript).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("landing remains overflow-free on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const primaryCta = page.getByRole("link", { name: "Install VibeFlow" });
  await expect(primaryCta).toBeVisible();
  const primaryCtaBox = await primaryCta.boundingBox();
  expect(primaryCtaBox).not.toBeNull();
  expect((primaryCtaBox?.y ?? 0) + (primaryCtaBox?.height ?? 0)).toBeLessThanOrEqual(844);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await captureIfRequested(page, "landing-mobile-390x844.png");
});
