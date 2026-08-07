import { computed, expect, stage, test } from "./support/harness.ts";

/**
 * The component gallery, driven by a real browser.
 *
 * `packages/ui/src/primitives.test.tsx` already renders every one of these
 * components and asserts its markup. This suite deliberately asserts nothing
 * that suite can: it only asks questions that need a cascade, a layout and a
 * font — what colour a tone actually resolves to, how many tracks a grid cuts at
 * a given width, whether a pseudo-element's content exists, whether a
 * visually-hidden label is still 1×1 and clipped rather than simply gone.
 *
 * That split matters, because the bugs this repo has actually shipped live on
 * this side of it: a stylesheet rewrite that desynced CSS from 46 untouched
 * components, a `.trail__row` cut from four grid lanes to two against markup
 * nobody changed, statuses rendered as bare text that CSS could not colour. Every
 * one of those passes a DOM-only harness.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/gallery");
  await expect(page.getByRole("heading", { name: "Component gallery", level: 1 })).toBeVisible();
});

test("the gallery renders with no credentials and leaks no formatter placeholder", async ({ page }) => {
  // Every specimen is on the page — a gallery that silently drops a component is
  // a catalog that lies about what exists.
  const specimens = page.locator("[data-specimen]");
  await expect(specimens).toHaveCount(18);

  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  for (const leak of ["undefined", "NaN", "[object Object]", "null"]) {
    expect(text, `the gallery must not print ${leak}`).not.toContain(leak);
  }
});

/* ------------------------------------------ four states, four appearances --- */

test("loading, empty, error and ready are four distinguishable renders", async ({ page }) => {
  const loading = stage(page, "section-loading");
  const empty = stage(page, "section-empty");
  const error = stage(page, "section-error");
  const ready = stage(page, "section-ready");

  // Markup: an in-flight read announces itself, a finished one does not, and a
  // failed one is a different component altogether.
  await expect(loading.locator('[data-ui="empty-state"][role="status"]')).toHaveCount(1);
  await expect(empty.locator('[data-ui="empty-state"]')).toHaveCount(1);
  await expect(empty.locator('[data-ui="empty-state"][role]')).toHaveCount(0);
  await expect(error.locator('[data-ui="error-state"]')).toHaveCount(1);
  await expect(error.locator('[data-ui="empty-state"]')).toHaveCount(0);
  await expect(ready.locator('[data-ui="row"]')).toHaveCount(3);

  // Appearance: this is the half a DOM harness cannot reach. The primitives'
  // class names are hashed, so "the classes differ" is all a node test can say;
  // whether the two actually *look* different is a question for the engine.
  const emptyBox = empty.locator('[data-ui="empty-state"]');
  const errorBox = error.locator('[data-ui="error-state"]');

  expect(await computed(emptyBox, "text-align")).toBe("center");
  expect(await computed(errorBox, "text-align")).toBe("left");
  expect(await computed(emptyBox, "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(await computed(errorBox, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
  expect(await computed(emptyBox, "border-left-width")).toBe("0px");
  expect(await computed(errorBox, "border-left-width")).toBe("3px");
  expect(await computed(emptyBox, "color")).not.toBe(await computed(errorBox, "color"));

  // The error state's marker glyph is drawn by a pseudo-element, so it exists in
  // no DOM at all.
  const marker = error.locator('[data-ui="error-state-title"]');
  expect(await computed(marker, "content", "::before")).toBe('"!"');

  // And the copy is the point of the whole distinction.
  await expect(error).toContainText("This is not an empty result.");
  await expect(empty).not.toContainText("failed");
});

/* -------------------------------------------------------------- the tones --- */

test("every badge tone resolves to a colour of its own, and an untoned badge to none of them", async ({ page }) => {
  const badges = stage(page, "badge-tones");
  const tones = ["ok", "warn", "bad", "info"] as const;

  const colours = new Map<string, string>();
  for (const tone of tones) {
    const badge = badges.locator(`[data-ui="badge"][data-tone="${tone}"]`);
    await expect(badge).toHaveCount(1);
    colours.set(tone, `${await computed(badge, "color")}|${await computed(badge, "background-color")}`);
  }
  expect(
    new Set(colours.values()).size,
    `four tones must be four appearances: ${[...colours].map(([tone, look]) => `${tone}=${look}`).join(", ")}`
  ).toBe(4);

  // Two untoned badges: one that was given nothing and one that was given "",
  // which is what the dashboard's `statusTone` returns for a status it does not
  // recognise. Both must read neutral rather than borrowing a status colour.
  const untoned = badges.locator('[data-ui="badge"]:not([data-tone])');
  await expect(untoned).toHaveCount(2);
  const neutral = `${await computed(untoned.first(), "color")}|${await computed(untoned.first(), "background-color")}`;
  expect([...colours.values()], "an untoned badge must not read as a status").not.toContain(neutral);
  expect(await computed(untoned.nth(1), "color")).toBe(await computed(untoned.first(), "color"));
});

test("a tone dot carries its tone as a fill and names itself for a screen reader", async ({ page }) => {
  const dots = stage(page, "tone-dot");
  const fills = new Set<string>();
  for (const tone of ["ok", "warn", "bad", "info"] as const) {
    const dot = dots.locator(`[data-ui="tone-dot"][data-tone="${tone}"]`);
    await expect(dot).toHaveAttribute("aria-label", `Status: ${tone}`);
    fills.add(await computed(dot, "background-color"));
  }
  const neutral = dots.locator('[data-ui="tone-dot"]:not([data-tone])');
  await expect(neutral).toHaveAttribute("aria-label", "Status: not reported");
  expect(fills.size).toBe(4);
  expect(fills, "an unreported status must not be filled as a measured one").not.toContain(
    await computed(neutral, "background-color")
  );

  // Round, not square: the dot is drawn entirely by CSS, so its shape is only
  // ever asserted here.
  await expect(neutral).toHaveCSS("border-radius", "50%");
});

test("a tooltip mounts on hover, escapes its container's clip, and disappears again", async ({ page }) => {
  const specimen = stage(page, "tooltip");
  const bubble = specimen.locator('[data-ui="tooltip-bubble"]');

  await expect(bubble).toHaveCount(0);
  await specimen.getByRole("button", { name: "Checkpoint sampling" }).hover();
  await expect(bubble).toHaveText("Sampled for up to 12 active builds");
  await expect(bubble).toHaveRole("tooltip");

  // `position: fixed` is the whole reason this component exists rather than an
  // absolutely-positioned span: every panel and section in both apps sets
  // `overflow: hidden` on itself, which would clip the bubble.
  expect(await computed(bubble, "position")).toBe("fixed");

  await page.mouse.move(0, 0);
  await expect(bubble).toHaveCount(0);
});

test("the status map colours what it recognises and leaves what it does not", async ({ page }) => {
  const table = stage(page, "status-tones");

  // The visually-hidden caption is the table's accessible name.
  await expect(page.getByRole("table", { name: /Every status the admin console colours/ })).toBeVisible();

  const ok = table.locator('td[data-tone="ok"]').first();
  const bad = table.locator('td[data-tone="bad"]').first();
  const untoned = table.locator("tr", { hasText: "quarantined" }).locator("td").nth(1);

  await expect(untoned).not.toHaveAttribute("data-tone", /.*/);
  const plain = await computed(untoned, "color");
  expect(plain).not.toBe(await computed(ok, "color"));
  expect(plain).not.toBe(await computed(bad, "color"));
  expect(await computed(ok, "color")).not.toBe(await computed(bad, "color"));

  // A tone also lifts the cell out of the muted table colour, which is a font
  // weight rather than a colour and so is invisible to every other suite.
  expect(await computed(ok, "font-weight")).toBe("500");
});

/* ------------------------------------------------------------- the figures --- */

test("an unmeasured figure renders the sentinel, never 0, and stays announced", async ({ page }) => {
  const stats = stage(page, "stat-row");

  const unmeasured = stats.locator('[data-ui="stat"][data-measured="false"]');
  await expect(unmeasured).toHaveCount(1);
  await expect(unmeasured.locator('[data-ui="stat-value"]')).toHaveText("—Unavailable");
  await expect(unmeasured.locator('[data-ui="stat-label"]')).toHaveText("Projection backlog");

  // The other half of the claim: a genuine zero still reads 0, or the sentinel
  // would be worthless.
  const zero = stats.locator('[data-ui="stat"]', { hasText: "Active builds" });
  await expect(zero).toHaveAttribute("data-measured", "true");
  await expect(zero.locator('[data-ui="stat-value"]')).toHaveText("0");
  await expect(stats.locator('[data-ui="stat"]', { hasText: "Wiki releases" })).toContainText("1,234,567");

  // "Unavailable" carries the meaning for a screen reader, so it has to still be
  // in the accessibility tree while being invisible — a distinction that only
  // exists once something computes `clip` and a used width.
  const label = unmeasured.locator('[data-ui="unmeasured"] span:not([aria-hidden])');
  expect(await computed(label, "width")).toBe("1px");
  expect(await computed(label, "clip")).not.toBe("auto");
  expect(await computed(label, "display")).not.toBe("none");
  expect(await computed(label, "visibility")).toBe("visible");
});

test("the stat grid cuts the lanes its stylesheet declares, at every breakpoint", async ({ page }) => {
  // This is the failure mode this repo shipped twice: a stylesheet-only rewrite
  // moved a grid's track count while its markup stayed put, and every component
  // rendering into it landed in a lane far too narrow. Track counts are resolved
  // by layout, so nothing short of a browser can check them.
  const row = stage(page, "stat-row").locator('[data-ui="stat-row"]');

  const tracks = async () => (await computed(row, "grid-template-columns")).split(" ").length;

  expect(await tracks(), "four lanes above 1100px").toBe(4);
  await page.setViewportSize({ width: 1000, height: 800 });
  expect(await tracks(), "two lanes below 1100px").toBe(2);
  await page.setViewportSize({ width: 680, height: 800 });
  expect(await tracks(), "two lanes below 700px").toBe(2);
  await page.setViewportSize({ width: 400, height: 800 });
  expect(await tracks(), "one lane below 430px").toBe(1);
});

test("a timestamp rendered from the clock is frozen, so a baseline cannot churn", async ({ page }) => {
  // The probe is client-only and reads the browser's clock. Without
  // `clock.setFixedTime` this string changes every minute, which is exactly how
  // a screenshot baseline becomes noise. If this assertion ever fails, the
  // determinism control has stopped working — not the component.
  await expect(stage(page, "relative-time").locator('[data-ui="row-meta"]')).toHaveText("updated 12m ago");
});

/* ----------------------------------------------------------- the structure --- */

test("a row emits only the lanes it was given, and only the interactive ones reach the keyboard", async ({ page }) => {
  const rows = stage(page, "list-rows");

  const bare = rows.locator('[data-ui="row"]', { hasText: "Only a title" });
  await expect(bare.locator('[data-ui="row-meta"]')).toHaveCount(0);
  await expect(bare.locator('[data-ui="row-lead"]')).toHaveCount(0);
  await expect(bare).not.toHaveAttribute("tabindex", /.*/);

  const routed = rows.locator('a[data-ui="row"]');
  await expect(routed).toHaveAttribute("href", "/gallery#list-rows");

  const clickable = rows.locator('[data-ui="row"][role="button"]');
  await expect(clickable).toHaveAttribute("tabindex", "0");
  await clickable.focus();
  await expect(clickable).toBeFocused();

  // The row's title lane is set not to wrap so the list keeps an even rhythm;
  // without the `white-space` rule `text-overflow` never fires. Both are
  // resolved styles, so this is the only place the pair is checked.
  const title = rows.locator('[data-ui="row-title"]').first();
  expect(await computed(title, "white-space")).toBe("nowrap");
  expect(await computed(title, "text-overflow")).toBe("ellipsis");
});

test("a panel shows a count only when it was given one", async ({ page }) => {
  const panels = stage(page, "panel").locator('[data-ui="panel"]');
  await expect(panels).toHaveCount(3);
  await expect(panels.nth(0).locator('[data-ui="panel-count"]')).toHaveText("3");
  await expect(panels.nth(1).locator('[data-ui="panel-count"]')).toHaveCount(0);
  await expect(panels.nth(2).locator('[data-ui="panel-actions"]')).toHaveCount(1);

  // The card clips its own corners so a flush list inside keeps them.
  expect(await computed(panels.first(), "overflow-x")).toBe("hidden");
});

test("a detail header is the page heading, and a back link keeps its affordance in front", async ({ page }) => {
  const header = stage(page, "detail-header");
  await expect(header.locator('h1[data-ui="detail-title"]').first()).toHaveText("Review run 4c1f9a");
  await expect(header.locator('[data-ui="detail-badges"] [data-ui="badge"]')).toHaveCount(3);
  // The reduced header emits neither lane rather than emitting them empty.
  await expect(header.locator('[data-ui="detail-header"]').nth(1).locator('[data-ui="detail-badges"]')).toHaveCount(0);
  await expect(header.locator('[data-ui="detail-header"]').nth(1).locator('[data-ui="detail-actions"]')).toHaveCount(0);

  await expect(stage(page, "back-link").locator('[data-ui="back-link"]').first()).toHaveText("← All reviews");
});

test("the empty state announces nothing and the error state announces once", async ({ page }) => {
  const empty = stage(page, "empty-state");
  const error = stage(page, "error-state");

  // Three empty states, exactly one of which is a live region: an empty result
  // is a fact, an in-flight read is news.
  await expect(empty.locator('[data-ui="empty-state"]')).toHaveCount(3);
  await expect(empty.locator('[data-ui="empty-state"][role="status"]')).toHaveCount(1);

  await expect(error.locator('[data-ui="error-state"][role="alert"]')).toHaveCount(1);
  // The flush variant sits inside a bordered card and keeps only the rule that
  // separates it from the heading above.
  const flush = error.locator('[data-ui="panel"] [data-ui="error-state"]');
  expect(await computed(flush, "border-bottom-width")).toBe("0px");
  expect(await computed(flush, "border-top-width")).toBe("1px");
  expect(await computed(flush, "border-top-left-radius")).toBe("0px");
});
