import { expect, test } from "@playwright/test";

const PARA = [
  "These resources become more valuable as your understanding grows.",
  "Every practice session builds on the last one.",
  "Learning a new language takes time and patience.",
].join("\n");

test("a refresh restores position and view", async ({ page }) => {
  await page.goto("/?demo");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".pt-entry");

  await page.fill(".pt-entry", PARA);
  await page.keyboard.press("Shift+Enter");
  await page.waitForSelector(".pt-actionbar");
  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-tok", { timeout: 15_000 });
  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-celebrate", { timeout: 15_000 });
  await page.keyboard.press("Space");
  await expect(page.locator(".pt-meta")).toContainText("2");

  await page.reload();
  await expect(page.locator(".pt-meta")).toContainText("2");
  await expect(page.locator(".pt-row .row-num.done")).toHaveCount(1);
  await expect(page.locator(".pt-row .row-score.c-green")).toHaveCount(1);

  await page.keyboard.press("Space");
  await page.waitForSelector(".pt-tok", { timeout: 15_000 });
  await page.reload();
  await page.waitForSelector(".pt-tok", { timeout: 15_000 });
  await expect(page.locator(".pt-practice-table")).toContainText("A practicar");
  await expect(page.locator(".pt-actionbar")).toContainText("Sigue practicando");
  await expect(page.locator(".pt-meta")).toContainText("INTENTO 1", {
    ignoreCase: true,
  });

  await page.keyboard.press("Escape");
  await page.waitForSelector(".pt-start");
  await page.reload();
  await page.waitForSelector(".pt-start");
  await expect(page.locator(".pt-meta")).toHaveCount(0);
  await expect(page.locator(".pt-entry")).toHaveValue(/resources/);
});

test("a stale verdict is re-judged under current rules on restore", async ({
  page,
}) => {
  const run = {
    sentences: ["The crop was saved and the Pilgrims never faced starvation again"],
    index: 0,
    status: ["failed"],
    bestHp: [88],
    errors: [{ pilgrims: 1 }],
    streak: 0,
    combo: 0,
    runXp: 0,
    totalAttempts: 1,
    wordAttempts: 1,
    screen: "fail",
    assessment: {
      recognizedText: "x",
      accuracy: 88,
      pronunciation: 88,
      completeness: 100,
      fluency: 90,
      words: [
        "the crop was saved and the pilgrims never faced starvation again"
          .split(" ")
          .map((word) => ({
            word,
            accuracy: word === "pilgrims" ? 78 : 95,
            errorType: "None",
            phonemes: [],
          })),
      ].flat(),
      error: null,
      audioUrl: null,
    },
  };
  await page.goto("/?demo");
  await page.evaluate(
    ([r, s]) => {
      localStorage.clear();
      localStorage.setItem("pronunciation-tetris.run", r as string);
      localStorage.setItem("pronunciation-tetris.settings", s as string);
    },
    [
      JSON.stringify(run),
      JSON.stringify({ passThreshold: 85, endSilenceMs: 1500 }),
    ],
  );
  await page.reload();
  await page.waitForSelector(".pt-celebrate", { timeout: 10_000 });
  await expect(page.locator(".pt-celebrate")).toContainText("88");
});
