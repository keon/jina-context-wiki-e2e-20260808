import { expect, stage, test } from "./support/harness.ts";

/**
 * Pixel baselines for the gallery — opt-in, and not committed.
 *
 * Run it with:
 *
 *     pnpm test:e2e:visual:update    # capture baselines for this machine
 *     pnpm test:e2e:visual           # compare against them
 *
 * The project only exists when `PLAYWRIGHT_VISUAL=1`, so a default run — and CI
 * — never reaches these tests. `playwright.config.ts` explains why at length; the
 * short version is that a baseline captured on macOS fails on every Linux runner
 * because the two rasterise the same font differently, and a baseline only CI
 * can produce is one no developer can maintain. Committing either kind buys a
 * suite that is red until people stop reading it. What this is good for is the
 * loop it was written for: capture, change a component, compare.
 *
 * What is committed instead is the deterministic half of the same idea, in
 * `gallery.spec.ts` and `admin.spec.ts`: computed colours, resolved
 * pseudo-element content, grid track counts, focus order. Chromium computes
 * those identically on every platform; only their rasterisation differs.
 *
 * Snapshots are scoped to one specimen's stage rather than to the page, so a
 * change to one component invalidates one baseline. A full-page capture is taken
 * too, deliberately last, as the "did everything move" canary — it is also the
 * one that churns most, which is the argument in miniature.
 */

/** Every specimen the gallery renders, in the order it renders them. */
const SPECIMENS = [
  "section-loading",
  "section-empty",
  "section-error",
  "section-ready",
  "badge-tones",
  "tone-dot",
  "tooltip",
  "status-tones",
  "stat-row",
  "unmeasured",
  "relative-time",
  "panel",
  "panel-count",
  "list-rows",
  "detail-header",
  "back-link",
  "empty-state",
  "error-state"
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/gallery");
  await expect(page.getByRole("heading", { name: "Component gallery", level: 1 })).toBeVisible();
  // A capture taken while a webfont is still swapping is a capture of the
  // fallback stack.
  await page.evaluate(() => document.fonts.ready);
});

for (const name of SPECIMENS) {
  test(`specimen ${name}`, async ({ page }) => {
    await expect(stage(page, name)).toHaveScreenshot(`${name}.png`);
  });
}

test("the whole gallery", async ({ page }) => {
  await expect(page).toHaveScreenshot("gallery.png", { fullPage: true });
});
