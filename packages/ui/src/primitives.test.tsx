import * as React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoLeakedValues, attrOf, count, present, renderComponent, textOf } from "../testing/index.ts";
import { Badge } from "./badge.tsx";
import { BackLink, DetailHeader } from "./detail-header.tsx";
import { EmptyState } from "./empty-state.tsx";
import { ErrorState } from "./error-state.tsx";
import { List, Row } from "./list.tsx";
import { Panel } from "./panel.tsx";
import { Stat, StatRow, Unmeasured } from "./stat.tsx";
import type { Tone } from "./tone.ts";

/**
 * Rendered coverage for the shared primitives.
 *
 * These are asserted here, once, rather than in each app's suite: an extraction
 * whose behaviour is only pinned at one of its two call sites is one app away
 * from drifting back into two implementations.
 *
 * Selectors are `[data-ui="…"]`, never a class. The bundler hashes the class
 * names, so a test that matched on `.stat` would be asserting something only
 * true of the test loader.
 */

/* ------------------------------------------------------------------- badge --- */

const TONES = ["ok", "warn", "bad", "info"] as const satisfies readonly Tone[];

test("a badge carries the tone it was given, and nothing when it was given none", () => {
  for (const tone of TONES) {
    const { container, unmount } = renderComponent(<Badge tone={tone}>{tone}</Badge>);
    assert.equal(attrOf(container, "[data-ui='badge']", "data-tone"), tone);
    // The tone must reach the class list too — `data-tone` alone is not styled.
    const classes = attrOf(container, "[data-ui='badge']", "class") ?? "";
    assert.equal(classes.split(" ").length, 2, `a toned badge carries its base class and one tone class: ${classes}`);
    assert.ok(classes.split(" ").includes(tone), `the ${tone} badge must carry the ${tone} class, got ${classes}`);
    unmount();
  }
});

test("an untoned badge is neutral rather than defaulting to a status colour", () => {
  const { container } = renderComponent(<Badge>Organization</Badge>);

  assert.equal(attrOf(container, "[data-ui='badge']", "data-tone"), null);
  const classes = (attrOf(container, "[data-ui='badge']", "class") ?? "").split(" ");
  assert.equal(classes.length, 1, "a badge stating a fact must not borrow a status tone");
  for (const tone of TONES) assert.ok(!classes.includes(tone), `an untoned badge must not read as ${tone}`);
  assert.equal(textOf(container, "[data-ui='badge']"), "Organization");
});

test("an empty tone is the same as no tone, so a caller may pass one straight through", () => {
  // The dashboard's `statusTone` returns "" for a status it does not recognise.
  // That has to mean neutral, not a crash and not a colour.
  const { container } = renderComponent(<Badge tone="">unrecognised</Badge>);

  assert.equal(attrOf(container, "[data-ui='badge']", "data-tone"), null);
  assert.equal((attrOf(container, "[data-ui='badge']", "class") ?? "").split(" ").length, 1);
});

/* --------------------------------------------- empty is not the same as error --- */

test("an empty state and an error state are distinguishable renders", () => {
  const empty = renderComponent(<EmptyState>No context releases have been published.</EmptyState>);
  assert.ok(present(empty.container, "[data-ui='empty-state']"));
  assert.equal(count(empty.container, "[data-ui='error-state']"), 0);
  // An empty result is a fact about the data, so it announces nothing.
  assert.equal(attrOf(empty.container, "[data-ui='empty-state']", "role"), null);
  const emptyClasses = attrOf(empty.container, "[data-ui='empty-state']", "class");
  empty.unmount();

  const error = renderComponent(
    <ErrorState title="Published releases is unavailable" role="alert">
      <p>The API request for this section failed. This is not an empty result.</p>
    </ErrorState>
  );
  assert.ok(present(error.container, "[data-ui='error-state']"));
  assert.equal(count(error.container, "[data-ui='empty-state']"), 0);
  assert.equal(attrOf(error.container, "[data-ui='error-state']", "role"), "alert");
  assert.match(textOf(error.container, "[data-ui='error-state-title']"), /is unavailable/);

  // The distinction the whole pattern turns on: the two must not resolve to the
  // same styling. Reporting an outage in the empty state's calm centred copy is
  // how a monitoring page hides one.
  assert.notEqual(
    attrOf(error.container, "[data-ui='error-state']", "class"),
    emptyClasses,
    "a failed read must not be dressed as an empty one"
  );
});

test("a compact empty state is still an empty state", () => {
  const { container } = renderComponent(<EmptyState compact>Nothing yet.</EmptyState>);
  const classes = (attrOf(container, "[data-ui='empty-state']", "class") ?? "").split(" ");
  assert.equal(classes.length, 2, "compact adds a modifier rather than replacing the base");
  assert.ok(classes.includes("empty"));
  assert.ok(classes.includes("compact"));
});

test("an app may add its own layout class without losing the component's own", () => {
  const { container } = renderComponent(<EmptyState className="billing-v2__empty">Nothing yet.</EmptyState>);
  const classes = (attrOf(container, "[data-ui='empty-state']", "class") ?? "").split(" ");
  assert.ok(classes.includes("empty"), "the component keeps its appearance");
  assert.ok(classes.includes("billing-v2__empty"), "the page keeps its composition");
});

/* -------------------------------------------------- unmeasured is not zero --- */

test("a stat with no value renders the unmeasured sentinel, never 0", () => {
  const { container } = renderComponent(<Stat label="Projection backlog" value={undefined} />);

  assert.equal(attrOf(container, "[data-ui='stat']", "data-measured"), "false");
  assert.ok(present(container, "[data-ui='unmeasured']"), "an unreported figure must render the sentinel");
  assert.notEqual(textOf(container, "[data-ui='stat-value']").trim(), "0", "an unread figure must not read as zero");
  assert.equal(textOf(container, "[data-ui='stat-value']"), "—Unavailable");
  assert.equal(textOf(container, "[data-ui='stat-label']"), "Projection backlog");
});

test("a stat measured at zero still renders 0", () => {
  // The other half of the same claim. If `undefined` and `0` rendered alike the
  // sentinel would be worthless: an operator could no longer tell a caught-up
  // projection from one nobody managed to read.
  const { container } = renderComponent(<Stat label="Projection backlog" value={0} />);

  assert.equal(attrOf(container, "[data-ui='stat']", "data-measured"), "true");
  assert.equal(count(container, "[data-ui='unmeasured']"), 0);
  assert.equal(textOf(container, "[data-ui='stat-value']"), "0");
});

test("a measured stat is grouped and formatted for a reader", () => {
  const { container } = renderComponent(<Stat label="Hierarchy nodes" value={1234567} />);
  assert.equal(textOf(container, "[data-ui='stat-value']"), "1,234,567");
});

test("an unmeasured figure is announced, not just dashed", () => {
  const { container } = renderComponent(<Unmeasured title="No backlog was reported for this projection" />);

  // The em dash is decorative; the accessible name has to carry the meaning.
  assert.equal(textOf(container, "[data-ui='unmeasured'] [aria-hidden='true']"), "—");
  assert.equal(textOf(container, "[data-ui='unmeasured'] span:not([aria-hidden])"), "Unavailable");
  assert.match(attrOf(container, "[data-ui='unmeasured']", "title") ?? "", /No backlog was reported/);
});

test("a stat row of unmeasured figures leaks no formatter placeholder", () => {
  // `value.toLocaleString()` on an absent number is exactly how "undefined" and
  // "NaN" reach a page; the sentinel branch exists to make that unreachable.
  const { container } = renderComponent(
    <StatRow>
      <Stat label="Context releases" value={undefined} />
      <Stat label="Active builds" value={0} />
      <Stat label="Hierarchy nodes" value={11} />
      <Stat label="Projection backlog" value={undefined} />
    </StatRow>
  );

  assertNoLeakedValues(container, "StatRow");
  assert.equal(count(container, "[data-ui='stat']"), 4);
  assert.equal(count(container, "[data-ui='stat'][data-measured='false']"), 2);
});

/* --------------------------------------------------------- list primitives --- */

test("a row lays out the lanes it was given and omits the ones it was not", () => {
  const { container } = renderComponent(
    <List>
      <Row title="acme/payments" meta="updated just now" trailing={<Badge tone="ok">complete</Badge>} />
      <Row title="bare" />
    </List>
  );

  assert.equal(count(container, "[data-ui='row']"), 2);
  assert.equal(count(container, "[data-ui='row-meta']"), 1, "a row with no meta must not emit an empty lane");
  assert.equal(count(container, "[data-ui='row-trail']"), 1);
  assert.equal(count(container, "[data-ui='row-lead']"), 0);
  assert.equal(textOf(container, "[data-ui='row-title']"), "acme/payments");
});

test("a row with an href renders through the link component it was handed", () => {
  // The coupling this package refuses to import: without it every routed
  // navigation in the dashboard would become a full document load.
  const seen: string[] = [];
  const Link = ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => {
    seen.push(href);
    return (
      <a className={className} href={href} data-routed="true">
        {children}
      </a>
    );
  };

  const { container } = renderComponent(<Row href="/issues/1" linkComponent={Link} title="An issue" />);

  assert.deepEqual(seen, ["/issues/1"]);
  assert.equal(attrOf(container, "a", "data-routed"), "true");
  assert.equal(attrOf(container, "a", "href"), "/issues/1");
});

test("a row with an href but no link component still renders a working anchor", () => {
  const { container } = renderComponent(<Row href="/issues/1" title="An issue" />);
  assert.equal(attrOf(container, "a[data-ui='row']", "href"), "/issues/1");
});

test("a clickable row is reachable by keyboard, and a static one is not in the tab order", () => {
  const clickable = renderComponent(<Row onClick={() => undefined} title="Open" />);
  assert.equal(attrOf(clickable.container, "[data-ui='row']", "role"), "button");
  assert.equal(attrOf(clickable.container, "[data-ui='row']", "tabindex"), "0");
  clickable.unmount();

  const inert = renderComponent(<Row title="Just text" />);
  assert.equal(attrOf(inert.container, "[data-ui='row']", "role"), null);
  assert.equal(attrOf(inert.container, "[data-ui='row']", "tabindex"), null);
});

/* ------------------------------------------------------- panel and heading --- */

test("a panel shows a count only when it was given one", () => {
  const withCount = renderComponent(
    <Panel title="Members" count={0}>
      <List />
    </Panel>
  );
  // Zero is a count, not an absence: `count={0}` must render "0".
  assert.equal(textOf(withCount.container, "[data-ui='panel-count']"), "0");
  withCount.unmount();

  const withoutCount = renderComponent(
    <Panel title="Members">
      <List />
    </Panel>
  );
  assert.equal(count(withoutCount.container, "[data-ui='panel-count']"), 0);
  assert.equal(count(withoutCount.container, "[data-ui='panel-actions']"), 0);
  assert.equal(textOf(withoutCount.container, "[data-ui='panel-title']"), "Members");
});

test("a detail header emits only the lanes it was given", () => {
  const { container } = renderComponent(
    <DetailHeader kicker="acme/payments" title="Review run" badges={<Badge tone="ok">passed</Badge>} />
  );

  assert.equal(textOf(container, "[data-ui='detail-title']"), "Review run");
  assert.equal(textOf(container, "[data-ui='detail-kicker']"), "acme/payments");
  assert.equal(count(container, "[data-ui='detail-badges']"), 1);
  assert.equal(count(container, "[data-ui='detail-actions']"), 0);
  assert.equal(count(container, "h1[data-ui='detail-title']"), 1, "the detail title is the page's heading");
});

test("a back link keeps its affordance in front of the label", () => {
  const { container } = renderComponent(<BackLink href="/reviews">All reviews</BackLink>);
  assert.equal(attrOf(container, "[data-ui='back-link']", "href"), "/reviews");
  assert.equal(textOf(container, "[data-ui='back-link']"), "← All reviews");
});

/* --------------------------------------------------------- no leaked values --- */

test("the primitives render no formatter placeholders when handed nothing", () => {
  const { container } = renderComponent(
    <div>
      <DetailHeader title="Untitled" />
      <Panel title="Empty">
        <List>
          <Row title="Only a title" />
        </List>
        <EmptyState>Nothing here yet.</EmptyState>
      </Panel>
      <Badge>{""}</Badge>
      <Stat label="Never measured" value={undefined} />
    </div>
  );

  assertNoLeakedValues(container, "the shared primitives");
});
