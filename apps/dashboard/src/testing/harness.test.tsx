import assert from "node:assert/strict";
import { test } from "node:test";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDashboard } from "../dashboard/providers.tsx";
import { gridContracts } from "@jina/ui/testing";
import { assertGridContracts, assertNoLeakedValues, attrOf, count, renderComponent, textOf } from "./render.tsx";
import { setDashboardState } from "./stubs/dashboard-providers.tsx";

/**
 * The harness checking itself. If these fail, every other component test in the
 * repo is reporting on the harness rather than on the app.
 */

test("a component renders into a real document", () => {
  const { container } = renderComponent(<p className="probe">rendered</p>);
  assert.equal(textOf(container, ".probe"), "rendered");
  assert.equal(typeof document.body.innerHTML, "string");
});

test("each test starts with an empty document", () => {
  assert.equal(count(document.body, ".probe"), 0);
});

test("next/link, next/navigation and the dashboard providers resolve to test doubles", () => {
  function Probe() {
    const { loading } = useDashboard();
    return (
      <span data-loading={String(loading)} data-path={usePathname()}>
        <Link href="/reviews">Reviews</Link>
      </span>
    );
  }
  setDashboardState({ loading: false });
  const { container } = renderComponent(<Probe />);
  assert.equal(attrOf(container, "a", "href"), "/reviews");
  assert.equal(attrOf(container, "span", "data-loading"), "false");
  assert.equal(attrOf(container, "span", "data-path"), "/");
});

test("the stylesheet's fixed grid track counts are read, and open-ended ones are not", () => {
  const contracts = gridContracts(new URL("../dashboard/styles.css", import.meta.url).pathname);
  // Four lanes: marker, dot, body, type — the exact contract `TrailRow` fills.
  assert.equal(contracts.get("trail__row")?.tracks, 4);
  assert.equal(contracts.get("activity-row")?.tracks, 4);
  assert.equal(contracts.get("usage-recent__row")?.tracks, 5);
  // `repeat(2, …)` sizes itself to its content, so item count is not a contract.
  assert.equal(contracts.get("usage-capabilities"), undefined);
  assert.equal(contracts.get("organization-summary"), undefined);
});

test("the placeholder assertion accepts the app's absence sentinels and rejects leaked ones", () => {
  const { container: honest } = renderComponent(
    <dl>
      <dt>Assignee</dt>
      <dd>—</dd>
      <dt>Updated</dt>
      <dd>Unknown date</dd>
    </dl>
  );
  assertNoLeakedValues(honest, "sentinels");

  const { container: leaked } = renderComponent(<p title="Invalid Date">Undefined</p>);
  assert.throws(() => assertNoLeakedValues(leaked, "leak"), /Undefined|undefined/);
});

test("the grid sweep rejects a child count that cannot fill the declared lanes", () => {
  // `.trail__row` is a real four-track rule; one child leaves three lanes empty.
  const { container } = renderComponent(
    <div className="trail__row">
      <span>only child</span>
    </div>
  );
  assert.throws(() => assertGridContracts(container, "probe"), /trail__row declares 4 tracks/);
});
