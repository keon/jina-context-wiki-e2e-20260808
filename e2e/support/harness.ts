import { expect, test as base, type Locator, type Page } from "@playwright/test";
import type { Scenario } from "./fixtures.ts";

/**
 * The determinism the browser suites run under, in one place.
 *
 * A browser test that is allowed to vary is a test that will be re-run until it
 * passes, and then trusted less than the code it covers. Four things move on
 * their own here, and each is pinned:
 *
 *   1. **Viewport.** Fixed in `playwright.config.ts`, at a width above the
 *      1100px and 700px breakpoints both stylesheets carry, so the default run
 *      exercises the desktop layout. The mobile-drawer test resizes on purpose
 *      and says so.
 *   2. **Motion.** Transitions and animations are zeroed, the caret is made
 *      transparent, and smooth scrolling is turned off. The admin drawer's
 *      `transition: visibility 0s linear 180ms` is the reason this is not
 *      cosmetic: without it, "the closed drawer is out of the tab order" is only
 *      true 180 milliseconds after it closes, and the assertion becomes a race.
 *   3. **Time.** `Date.now()` is fixed. Nothing rendered from the clock can
 *      churn — see the `relative-time` specimen, which exists to prove the freeze
 *      is in force rather than merely configured.
 *   4. **Dev chrome.** Next's development overlay mounts a `<nextjs-portal>` of
 *      its own outside the app tree. It is hidden so it cannot appear in a
 *      capture or in a focus walk.
 *
 * Locale and timezone are pinned in the config for the same reason, even though
 * the admin page formats with an explicit `en-US` and an ISO string today: the
 * next `toLocaleString()` someone writes without a locale should fail in CI, not
 * only on a machine set to a different one.
 */

/**
 * 12 minutes after the gallery's `RELATIVE_TIME_ORIGIN`, so the relative
 * timestamp specimen reads exactly "12m ago" and any drift in the freeze shows
 * up as a failed assertion rather than as a rewritten baseline.
 */
const FROZEN_TIME = new Date("2026-03-01T12:12:00.000Z");

const STUB_API_URL = `http://127.0.0.1:${process.env.STUB_API_PORT ?? 4310}`;

const DETERMINISM_CSS = `
*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
nextjs-portal { display: none !important; }
`;

export const test = base.extend<{
  /** Switches the stubbed upstream API before the next navigation. */
  setScenario: (scenario: Scenario) => Promise<void>;
}>({
  page: async ({ page }, use) => {
    // Fixed, not frozen: `setFixedTime` pins `Date.now()` and `new Date()` while
    // leaving real timers running, so React's scheduler and Next's dev client
    // still make progress. `clock.install()` would pause both and hang hydration.
    await page.clock.setFixedTime(FROZEN_TIME);
    await page.addInitScript((css: string) => {
      const inject = () => {
        const style = document.createElement("style");
        style.setAttribute("data-e2e-determinism", "");
        style.textContent = css;
        document.head.append(style);
      };
      if (document.head) inject();
      else document.addEventListener("DOMContentLoaded", inject, { once: true });
    }, DETERMINISM_CSS);
    await use(page);
  },

  setScenario: async ({ request }, use) => {
    await use(async (scenario: Scenario) => {
      const response = await request.post(`${STUB_API_URL}/__scenario/${scenario}`);
      expect(response.ok(), `stub API refused scenario ${scenario}`).toBeTruthy();
    });
  }
});

export { expect } from "@playwright/test";

/** The addressable box a gallery specimen renders into. */
export function stage(page: Page, name: string): Locator {
  return page.locator(`[data-specimen="${name}"] [data-specimen-stage]`);
}

/** One resolved CSS property, as the browser computed it. */
export function computed(locator: Locator, property: string, pseudo?: string): Promise<string> {
  return locator.evaluate(
    (element, [name, selector]) => getComputedStyle(element, selector || undefined).getPropertyValue(name),
    [property, pseudo ?? ""] as const
  );
}

/**
 * Walks the tab order from the top of the document and reports where focus
 * landed, as `id`/`data-*`-bearing descriptions.
 *
 * Used to assert a negative — that a closed drawer is genuinely unreachable —
 * which is the only form of the claim worth making. `visibility: hidden` is what
 * removes it, and no DOM-only harness models that.
 */
export async function tabOrder(page: Page, steps: number): Promise<string[]> {
  await page.locator("body").click({ position: { x: 2, y: 2 }, force: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press("Tab");
    seen.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return "<none>";
        const owner = active.closest("[id]")?.id ?? "";
        const label = active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40) ?? "";
        return `${owner}::${active.tagName.toLowerCase()}::${label}`;
      })
    );
  }
  return seen;
}
