import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// The parser only reads files, so this imports it directly rather than through
// the testing barrel, which registers DOM-dependent cleanup this suite has no
// document for.
import { gridContracts } from "@jina/ui/testing/css-contract";

/**
 * Every grid whose column count the stylesheets fix, and how many lanes each cuts.
 *
 * `assertGridContracts` checks a *rendered* component against these numbers, but
 * only for the components a test happens to render. This inventory covers the
 * other half: it fails when the declared set itself moves, whether or not
 * anything renders it.
 *
 * That is the failure this repo actually had. `ad95426` rewrote styles.css
 * wholesale and updated 13 of 59 components; `.codex-step` went 2 tracks to 3
 * and `.trail__row` went 4 to 2, both against markup nobody touched. Each shipped
 * as a component rendering into a lane far too narrow for it. A changed number
 * here means the markup that fills it has to be re-checked — this test is the
 * prompt to do that, and updating the expectation is the deliberate act of
 * saying it was.
 *
 * Entries are `class: track count`. Media-query overrides and descendant
 * selectors are out of scope for the same reason the parser skips them: a reflow
 * of the same content, and a contract that cannot be resolved from a class list.
 */
const DECLARED_GRIDS: Readonly<Record<string, number>> = {
  "activity-row": 4,
  app: 2,
  "billing-v2__plan-option": 4,
  def__block: 2,
  dl: 2,
  "history-toolbar": 5,
  "integration-row": 3,
  "integration-row__editor": 3,
  "integration-state": 3,
  "issue-meta-row": 2,
  "knowledge-browser": 2,
  "knowledge-graph-loading": 2,
  "knowledge-graph__layout": 2,
  "model-fallbacks": 1,
  "model-provider-card": 2,
  "model-setting-row": 3,
  "model-trigger-card": 2,
  "model-v2-catalog__row": 4,
  "organization-access": 3,
  "organization-invite": 3,
  "run-history-detail__header": 2,
  "run-history-layout": 2,
  "run-history-row": 5,
  "run-history-table-head": 5,
  "session-row": 4,
  "task-detail__fact": 2,
  "task-detail__relationship": 3,
  "task-type-row": 4,
  "task-type-row__identity": 2,
  "task-type-trigger": 2,
  "task-types-layout": 2,
  "task-types-table-head": 4,
  trail__row: 4,
  "usage-overview": 2,
  "usage-recent__row": 5
};

const STYLESHEETS = ["../dashboard/styles.css", "../app/globals.css"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url))
);

function declaredInStylesheets(): Map<string, number> {
  const found = new Map<string, number>();
  for (const stylesheet of STYLESHEETS) {
    for (const [className, contract] of gridContracts(stylesheet)) {
      found.set(className, contract.tracks);
    }
  }
  return found;
}

test("no grid contract appears, disappears, or changes its lane count unnoticed", () => {
  const actual = declaredInStylesheets();

  const added = [...actual.keys()].filter((name) => !(name in DECLARED_GRIDS)).sort();
  assert.deepEqual(
    added,
    [],
    `New fixed-track grid(s). Check the markup that fills them emits enough children, then add them here:\n` +
      added.map((name) => `  ${name}: ${actual.get(name) ?? 0}`).join("\n")
  );

  const removed = Object.keys(DECLARED_GRIDS)
    .filter((name) => !actual.has(name))
    .sort();
  assert.deepEqual(
    removed,
    [],
    `Grid contract(s) no longer declared. Drop them from this inventory: ${removed.join(", ")}`
  );

  const changed = Object.entries(DECLARED_GRIDS)
    .filter(([name, tracks]) => actual.has(name) && actual.get(name) !== tracks)
    .map(([name, tracks]) => `${name}: ${tracks} -> ${actual.get(name) ?? 0}`)
    .sort();
  assert.deepEqual(
    changed,
    [],
    `Track count changed. Re-check the component that fills each one before updating this inventory:\n  ${changed.join("\n  ")}`
  );
});

test("the inventory is read from the stylesheets, not from itself", () => {
  // Guards the guard: if the parser silently stopped finding anything, every
  // assertion above would pass vacuously while protecting nothing.
  const actual = declaredInStylesheets();
  assert.ok(actual.size > 25, `expected the stylesheets to declare many grids, found ${actual.size}`);
  assert.equal(actual.get("trail__row"), 4);
  assert.equal(actual.get("run-history-row"), 5);
});
