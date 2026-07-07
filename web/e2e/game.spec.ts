import { expect, test } from "@playwright/test";

const PARA = [
  "These resources become more valuable as your understanding grows.",
  "Every practice session builds on the last one.",
  "Learning a new language takes time and patience.",
  "Focus on the sounds that challenge you most.",
].join("\n");

test.beforeEach(async ({ page }) => {
  await page.goto("/?demo");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".pt-entry");
});

test("full round: ready, fail with diagnosis, pass, navigate", async ({
  page,
}) => {
  await page.fill(".pt-entry", PARA);
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".pt-actionbar")).toContainText("A leer");

  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-tok", { timeout: 15_000 });
  await expect(page.locator(".pt-practice-table")).toContainText("A practicar");
  await expect(page.locator(".pt-practice-table")).toContainText("fallada");
  await expect(page.locator(".pt-actionbar")).toContainText("Sigue practicando");
  const scorecard = page.locator(".pt-scorecard");
  await expect(scorecard).toContainText("Puntaje");
  await expect(scorecard).not.toContainText("objetivo");

  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-celebrate", { timeout: 15_000 });
  await expect(page.locator(".pt-celebrate")).toContainText("derrotada");
  await expect(page.locator(".pt-celebrate")).not.toContainText("Siguiente");
  await expect(page.locator(".pt-actionbar")).toContainText("Siguiente oración");

  await page.keyboard.press("w");
  await expect(page.locator(".pt-meta")).toContainText("2");

  const noScroll = await page.evaluate(
    () => document.documentElement.scrollHeight <= window.innerHeight + 1,
  );
  expect(noScroll).toBe(true);
});

test("the word gauntlet gathers failed words and is beatable", async ({
  page,
}) => {
  await page.fill(".pt-entry", PARA);
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".pt-actionbar")).toContainText("A leer");

  // Fail sentence 1 so its weak words feed the gauntlet, then move on
  // without redeeming them.
  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-tok", { timeout: 15_000 });
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await expect(page.locator(".pt-meta")).toContainText("Reto de palabras", {
    ignoreCase: true,
  });

  // Demo scorer: first attempt at any reference fails, second passes.
  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-tok", { timeout: 15_000 });
  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-celebrate", { timeout: 15_000 });
  await expect(page.locator(".pt-celebrate")).toContainText("Reto superado");
});

test("a gauntlet with no failed words is a free pass", async ({ page }) => {
  await page.fill(".pt-entry", PARA);
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".pt-actionbar")).toContainText("A leer");

  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await expect(page.locator(".pt-meta")).toContainText("Jefe final", {
    ignoreCase: true,
  });
});

test("rail drawer on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 860 });
  await page.fill(".pt-entry", PARA);
  await page.keyboard.press("Shift+Enter");
  await page.click(".pt-rail-toggle");
  await expect(page.locator(".pt-rail.drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".pt-rail.drawer")).toHaveCount(0);
  await expect(page.locator(".pt-meta")).toBeVisible();
});
