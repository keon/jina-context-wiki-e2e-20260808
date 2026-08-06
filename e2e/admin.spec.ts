import { computed, expect, tabOrder, test } from "./support/harness.ts";
import { DERIVED_DOCUMENT_COUNT, HEADINGS, VERIFIED_CHECKPOINTS } from "./support/fixtures.ts";

/**
 * The admin console, end to end: `next dev` rendering the real server
 * components against a stubbed upstream API, in a real browser, with no
 * credentials.
 *
 * No credentials is not a concession. Admin's inbound gate permits an
 * unauthenticated request only when `NODE_ENV !== "production"` — a value Next
 * inlines at build time and compiles out of every deployed image — and
 * `next dev` is exactly that documented local case. Nothing here weakens it.
 *
 * The console's whole reason for existing is that an operator can believe what
 * it says. Each test below pins one of the claims that makes that true, and each
 * is asserted at the level where it can actually break:
 *
 *   - a counter nobody measured must never render as a zero;
 *   - a section that failed must never render as a section that found nothing;
 *   - the banner must name headings a reader can find on the page;
 *   - a status must reach the eye coloured by what it means, which is a fact
 *     about the stylesheet and not about the DOM;
 *   - and the navigation must not leave a hidden drawer in the tab order.
 *
 * The scenario is state on a single stub process, so this file runs in one
 * worker and each test sets the scenario it needs before navigating. The page is
 * `force-dynamic` and reads with `cache: "no-store"`, so a navigation is a
 * complete re-read.
 */

const STAT_LABELS = [
  "Context releases",
  "Repositories",
  "Derived context docs",
  "Projection backlog",
  "Active builds",
  "Active model tasks",
  "Verified checkpoints",
  "Hierarchy nodes"
] as const;

/** Every stat on the page, as `label -> rendered value`. */
async function statValues(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-ui="stat"]')].map((stat) => [
        stat.querySelector('[data-ui="stat-label"]')?.textContent?.trim() ?? "?",
        stat.querySelector('[data-ui="stat-value"]')?.textContent?.trim() ?? "?"
      ])
    )
  );
}

/* ------------------------------------------------- partial telemetry --- */

test("telemetry the API never sent renders as an em dash, and a measured zero still renders 0", async ({
  page,
  setScenario
}) => {
  await setScenario("partial");
  await page.goto("/");

  const values = await statValues(page);
  expect(Object.keys(values).sort()).toEqual([...STAT_LABELS].sort());

  // Never reported by the stub: no outbox map, no active-build count, no
  // hierarchy node count. Each is an absence, and an absence is not a zero.
  for (const label of ["Projection backlog", "Active builds", "Hierarchy nodes"]) {
    expect(values[label], `${label} was never measured`).toBe("—Unavailable");
  }

  // Measured, and measured at zero — the pair is the whole point. If these two
  // rendered alike an operator could no longer tell an idle system from one
  // nobody managed to read.
  expect(values["Active model tasks"]).toBe("0");
  expect(values["Context releases"]).toBe("3");
  expect(values.Repositories).toBe("3");
  expect(values["Derived context docs"]).toBe(String(DERIVED_DOCUMENT_COUNT));
  expect(values["Verified checkpoints"]).toBe(String(VERIFIED_CHECKPOINTS));

  await expect(page.locator('[data-ui="stat"][data-measured="false"]')).toHaveCount(3);
  await expect(page.locator('[data-ui="stat"][data-measured="true"]')).toHaveCount(5);

  // A projector whose lag was never sampled must not print "0 backlog" beside a
  // degraded status.
  const degradedProjector = page.locator("tr", { hasText: "context-hierarchy" });
  await expect(degradedProjector.locator('[data-ui="unmeasured"]')).toHaveCount(1);
  await expect(page.locator("tr", { hasText: "context-index" }).locator("td").nth(2)).toHaveText("0");

  // Nothing on a fully-rendered page may leak a formatter placeholder.
  const text = await page.locator("main").innerText();
  for (const leak of ["undefined", "NaN", "[object Object]"]) {
    expect(text).not.toContain(leak);
  }

  // No failure anywhere, so no banner.
  await expect(page.locator('[data-ui="error-state"]')).toHaveCount(0);
});

test("the unmeasured sentinel is announced rather than only dashed", async ({ page, setScenario }) => {
  await setScenario("partial");
  await page.goto("/");

  const sentinel = page.locator('[data-ui="unmeasured"]').first();
  await expect(sentinel.locator('[aria-hidden="true"]')).toHaveText("—");

  const label = sentinel.locator("span:not([aria-hidden])");
  await expect(label).toHaveText("Unavailable");
  // Visually hidden, but still in the accessibility tree: a 1×1 clipped box, not
  // `display: none`. Only a browser resolves the difference.
  expect(await computed(label, "width")).toBe("1px");
  expect(await computed(label, "clip")).not.toBe("auto");
  expect(await computed(label, "display")).not.toBe("none");
  expect(await computed(label, "visibility")).toBe("visible");
});

test("a status reaches the operator coloured by what it means, and an unknown one stays neutral", async ({
  page,
  setScenario
}) => {
  await setScenario("partial");
  await page.goto("/");

  // `statusTone()` stamps `data-tone` because CSS cannot match on text content —
  // before it existed a failed build looked exactly like a completed one. That
  // the attribute then produces distinguishable colours is a claim about
  // globals.css that only the engine can settle.
  const failed = page.locator('td[data-tone="bad"]').first();
  const active = page.locator('td[data-tone="info"]').first();
  const complete = page.locator('td[data-tone="ok"]').first();
  const colours = new Set([
    await computed(failed, "color"),
    await computed(active, "color"),
    await computed(complete, "color")
  ]);
  expect(colours.size, "three tones must be three colours").toBe(3);

  // A status this app has never seen reaches the table verbatim and uncoloured.
  const quarantined = page.locator("td", { hasText: /^quarantined$/ }).first();
  await expect(quarantined).toBeVisible();
  await expect(quarantined).not.toHaveAttribute("data-tone", /.*/);
  expect(colours, "an unrecognised status must not be dressed as a known one").not.toContain(
    await computed(quarantined, "color")
  );

  // The same rule for a release the API described incompletely.
  const unknownCompleteness = page.locator("td", { hasText: /^unknown$/ }).first();
  await expect(unknownCompleteness).not.toHaveAttribute("data-tone", /.*/);
});

test("every data table keeps its visually-hidden caption, its column scopes, and its table layout", async ({
  page,
  setScenario
}) => {
  await setScenario("partial");
  await page.goto("/");

  const tables = page.locator("table.context-table");
  await expect(tables).toHaveCount(4);

  for (let index = 0; index < 4; index += 1) {
    const table = tables.nth(index);
    const caption = table.locator("caption");
    await expect(caption).toHaveCount(1);
    await expect(caption).not.toHaveText("");

    // Hidden from sight, present to a screen reader.
    expect(await computed(caption, "position")).toBe("absolute");
    expect(await computed(caption, "width")).toBe("1px");
    expect(await computed(caption, "display")).not.toBe("none");

    // A `display: block` table splits thead and tbody into separate formatting
    // contexts: headers stop aligning with their columns and the table roles
    // leave the accessibility tree. The stylesheet pins `display: table` for
    // exactly that reason, and this is the only suite that can confirm it held.
    expect(await computed(table, "display")).toBe("table");

    const headers = table.locator("thead th");
    expect(await headers.count()).toBeGreaterThan(0);
    for (const scope of await headers.evaluateAll((cells) => cells.map((cell) => cell.getAttribute("scope")))) {
      expect(scope).toBe("col");
    }
  }

  // Each table is reachable by its accessible name, which is the caption.
  await expect(page.getByRole("table", { name: new RegExp(HEADINGS.releases) })).toBeVisible();
  await expect(page.getByRole("table", { name: new RegExp(HEADINGS.documents) })).toBeVisible();

  // Overflow belongs to the wrapper, and the wrapper is focusable so a
  // keyboard-only reader can scroll it.
  const scroller = page.locator(".table-scroll").first();
  expect(await computed(scroller, "overflow-x")).toBe("auto");
  await expect(scroller).toHaveAttribute("tabindex", "0");
});

/* ------------------------------------------------------- degraded reads --- */

test("failed and blocked sections are announced by name, and nothing is dressed as empty", async ({
  page,
  setScenario
}) => {
  await setScenario("degraded");
  await page.goto("/");

  const banner = page.locator('[data-ui="error-state"][role="alert"]');
  await expect(banner).toHaveCount(1);
  await expect(banner.locator('[data-ui="error-state-title"]')).toHaveText("3 sections are not reporting");

  const entries = await banner.locator("li").allInnerTexts();
  expect(entries).toHaveLength(3);

  // The banner has to name headings a reader can actually find. A banner that
  // named the internal loader would send an operator looking for a section that
  // does not exist on the page.
  for (const entry of entries) {
    const heading = entry.split(" — ")[0] ?? "";
    expect(heading, `banner entry "${entry}" must name a heading`).not.toBe("");
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
      `"${heading}" must be a heading on this page`
    ).toHaveCount(1);
  }
  expect(entries.map((entry) => entry.split(" — ")[0])).toEqual([
    HEADINGS.releases,
    HEADINGS.health,
    HEADINGS.documents
  ]);

  // A read that was never attempted says so, rather than reporting the empty
  // fallback it was given.
  expect(entries[2]).toContain(`not attempted because ${HEADINGS.releases} could not be loaded`);
  await expect(banner).toContainText("were never measured and are not zero");

  // Every failed section renders the degraded treatment. None renders the calm
  // centred copy that would report an outage as a fact about the tenant's data.
  await expect(page.locator('[data-ui="error-state"]')).toHaveCount(4);
  await expect(page.locator('[data-ui="empty-state"]')).toHaveCount(0);
  await expect(page.getByText("No context releases have been published")).toHaveCount(0);

  // Only the one section that did load reports a figure; everything else is an
  // absence, and no counter anywhere reads 0.
  const values = await statValues(page);
  expect(values["Verified checkpoints"]).toBe(String(VERIFIED_CHECKPOINTS));
  for (const [label, value] of Object.entries(values)) {
    if (label === "Verified checkpoints") continue;
    expect(value, `${label} must be unmeasured when its read failed`).toBe("—Unavailable");
  }
  expect(Object.values(values), "a failed read must never produce a zero").not.toContain("0");
});

test("a read that succeeded and found nothing is a different render entirely", async ({ page, setScenario }) => {
  await setScenario("empty");
  await page.goto("/");

  await expect(page.locator('[data-ui="error-state"]')).toHaveCount(0);
  // Scoped to the page's own content: Playwright's selectors pierce shadow
  // roots, and Next's development overlay keeps a live region of its own.
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);
  await expect(page.locator('[data-ui="empty-state"]')).toHaveCount(4);
  await expect(page.getByText("No context releases have been published.")).toBeVisible();

  // Measured at nothing is a measurement: these read 0, not "—".
  const values = await statValues(page);
  expect(values["Context releases"]).toBe("0");
  expect(values["Projection backlog"]).toBe("0");
  expect(values["Active builds"]).toBe("0");
});

test("filtering to one repository names it in the empty copy", async ({ page, setScenario }) => {
  await setScenario("partial");
  await page.goto("/");

  await page.getByRole("link", { name: "acme/search", exact: true }).first().click();
  await expect(page).toHaveURL(/\?repository=acme%2Fsearch$/);
  await expect(page.getByText("No agent-derived context documents are published for acme/search.")).toBeVisible();
  // The scope narrows the roll-up rather than leaving it unmeasured.
  expect((await statValues(page)).Repositories).toBe("1");
});

/* ----------------------------------------------------------- navigation --- */

test("a collapsed sidebar hides its labels and names each item in a tooltip instead", async ({ page, setScenario }) => {
  await setScenario("partial");
  await page.goto("/");

  const item = page.locator('.admin-nav__item[data-label="Context releases"]');
  await expect(item.locator(".admin-nav__label")).toBeVisible();

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.locator(".admin-app--collapsed")).toHaveCount(1);

  // The label is gone from sight…
  expect(await computed(item.locator(".admin-nav__label"), "display")).toBe("none");

  // …and its replacement is a pseudo-element whose content is drawn from the
  // markup's own `data-label`. There is no node for it: no DOM-level harness can
  // see this at all, and a collapsed rail with no tooltip is an unlabelled row
  // of icons.
  expect(await computed(item, "content", "::after")).toBe('"Context releases"');
  expect(await computed(item, "display", "::after")).toBe("none");
  await item.hover();
  expect(await computed(item, "display", "::after")).toBe("block");
  expect(await computed(item, "position", "::after")).toBe("fixed");

  // The choice survives a reload, which is the only reason it is stored at all.
  await page.reload();
  await expect(page.locator(".admin-app--collapsed")).toHaveCount(1);
  expect(await page.evaluate(() => window.localStorage.getItem("jina-admin-sidebar-collapsed"))).toBe("true");
});

test("the mobile drawer is out of the tab order while it is closed", async ({ page, setScenario }) => {
  await setScenario("partial");
  await page.goto("/");
  // Below the 700px breakpoint the sidebar becomes an off-canvas drawer.
  await page.setViewportSize({ width: 390, height: 780 });

  const sidebar = page.locator("#admin-sidebar");
  // `visibility: hidden` rather than only `translateX(-102%)`: a translated
  // drawer is off screen but still focusable, so a keyboard reader tabs into a
  // menu they cannot see. Nothing without layout can tell the two apart.
  expect(await computed(sidebar, "visibility")).toBe("hidden");

  const closed = await tabOrder(page, 8);
  expect(
    closed.filter((entry) => entry.startsWith("admin-sidebar::")),
    `focus walked into the closed drawer: ${closed.join(", ")}`
  ).toHaveLength(0);

  // Opening it moves focus to the close button, because the drawer sits before
  // its own trigger in the DOM.
  await page.getByRole("button", { name: "Open navigation" }).click();
  expect(await computed(sidebar, "visibility")).toBe("visible");
  await expect(page.getByRole("button", { name: "Close navigation" }).first()).toBeFocused();

  const open = await tabOrder(page, 4);
  expect(
    open.some((entry) => entry.startsWith("admin-sidebar::")),
    `the open drawer must be reachable: ${open.join(", ")}`
  ).toBe(true);

  // Escape closes it and hands focus back to the trigger.
  await page.getByRole("button", { name: "Open navigation" }).focus();
  await page.keyboard.press("Escape");
  expect(await computed(sidebar, "visibility")).toBe("hidden");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
});

test("the command palette traps focus and returns it to whatever opened it", async ({ page, setScenario }) => {
  await setScenario("partial");
  await page.goto("/");

  const search = page.getByRole("button", { name: "Search", exact: true });
  await search.click();

  const dialog = page.getByRole("dialog", { name: "Search admin" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Search admin sections" })).toBeFocused();

  await dialog.getByRole("textbox").fill("health");
  await expect(dialog.getByRole("link")).toHaveCount(1);
  await expect(dialog.getByRole("link")).toContainText("Index health");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // `aria-modal="true"` promised the rest of the page was unreachable, so
  // closing has to give focus back rather than dropping it on the body.
  await expect(search).toBeFocused();
});
