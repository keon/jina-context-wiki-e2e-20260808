import assert from "node:assert/strict";
import { test } from "node:test";
import { assertGridContracts, assertNoLeakedValues, renderComponent } from "../testing/render.tsx";
import { setDashboardState } from "../testing/stubs/dashboard-providers.tsx";
import IssuesPage from "./issues/page.tsx";
import ReviewsPage from "./reviews/page.tsx";
import type { DashboardResponse, ReviewIssue, ReviewRun } from "./lib/types.ts";

/**
 * REGRESSION: the list pages greeted a still-loading feed with their empty
 * state. /reviews said "No reviews recorded yet." to everybody on first paint,
 * and again after every failed refresh that left the feed at zero rows — two
 * different situations, both reported as the one situation that means "your
 * workspace has nothing in it".
 *
 * Loading, failed, empty and populated are four distinct claims about the data.
 * These tests hold each page to rendering four distinguishable things.
 */

const RUN: ReviewRun = {
  review_run_id: "run_1",
  status: "completed",
  bot: { type: "review", status: "completed" },
  repository: { full_name: "acme/payments" },
  pull_request: { number: 42, title: "Retry failed captures", head_sha: "0123456789abcdef", head_ref: "retry" },
  events: [],
  created_at: "2026-02-01T10:00:00.000Z",
  updated_at: "2026-02-01T11:00:00.000Z"
};

const ISSUE: ReviewIssue = {
  id: "issue_1",
  review_run_id: "run_1",
  fingerprint: "fp_1",
  severity: "high",
  category: "correctness",
  body: "The retry loop can double-charge.",
  created_at: "2026-02-01T11:00:00.000Z",
  repository: "acme/payments",
  pull_request: 42,
  file_path: "src/retry.ts",
  line_number: 18
};

function feed(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    generated_at: "2026-02-01T11:00:00.000Z",
    bots: [],
    review_runs: [],
    issues: [],
    projects: [],
    teams: [],
    ...overrides
  };
}

interface PageCase {
  readonly name: string;
  readonly Page: () => React.JSX.Element;
  readonly populated: DashboardResponse;
  readonly emptyCopy: RegExp;
  readonly rowSelector: string;
}

const PAGES: readonly PageCase[] = [
  {
    name: "reviews",
    Page: ReviewsPage,
    populated: feed({ review_runs: [RUN] }),
    emptyCopy: /No reviews recorded yet/,
    rowSelector: ".row"
  },
  {
    name: "issues",
    Page: IssuesPage,
    populated: feed({ issues: [ISSUE] }),
    emptyCopy: /No issues recorded from final reviews yet/,
    rowSelector: ".row"
  }
];

for (const { name, Page, populated, emptyCopy, rowSelector } of PAGES) {
  test(`/${name} tells loading, failed, empty and populated apart`, () => {
    const renders = new Map<string, string>();

    // Loading: no answer has arrived. This is the one that used to read as empty.
    setDashboardState({ data: null, loading: true, error: null });
    const loading = renderComponent(<Page />);
    renders.set("loading", loading.container.textContent ?? "");
    assert.equal(loading.container.querySelector(".empty"), null, `/${name} claimed emptiness while loading`);
    assert.doesNotMatch(loading.container.textContent ?? "", emptyCopy);
    loading.unmount();

    // Failed: the read did not succeed, so the row count says nothing.
    setDashboardState({ data: null, loading: false, error: "Dashboard API returned 503" });
    const failed = renderComponent(<Page />);
    renders.set("failed", failed.container.textContent ?? "");
    assert.equal(failed.container.querySelector(".empty"), null, `/${name} reported a failed read as empty`);
    assert.ok(failed.container.querySelector(".notice--bad"), `/${name} did not surface the failure`);
    assert.doesNotMatch(failed.container.textContent ?? "", emptyCopy);
    failed.unmount();

    // Empty: a successful read of a workspace with nothing in it.
    setDashboardState({ data: feed(), loading: false, error: null });
    const empty = renderComponent(<Page />);
    renders.set("empty", empty.container.textContent ?? "");
    assert.ok(empty.container.querySelector(".empty"), `/${name} did not report a genuinely empty feed`);
    assert.match(empty.container.textContent ?? "", emptyCopy);
    empty.unmount();

    // Populated.
    setDashboardState({ data: populated, loading: false, error: null });
    const ready = renderComponent(<Page />);
    renders.set("ready", ready.container.textContent ?? "");
    assert.equal(ready.container.querySelectorAll(rowSelector).length, 1);
    assert.doesNotMatch(ready.container.textContent ?? "", emptyCopy);

    assert.equal(new Set(renders.values()).size, 4, `/${name} renders two of its four states identically`);
  });

  test(`/${name} keeps the last good feed visible when a refresh fails`, () => {
    setDashboardState({ data: populated, loading: false, error: "Dashboard API returned 503" });
    const { container } = renderComponent(<Page />);

    assert.equal(container.querySelectorAll(rowSelector).length, 1, "the last good feed should stay on screen");
    assert.ok(container.querySelector(".notice--bad"), "the failure should be surfaced alongside it");
    assert.equal(container.querySelector(".empty"), null);
  });

  test(`/${name} renders no formatter placeholders and honours its grid contracts`, () => {
    setDashboardState({ data: populated, loading: false, error: null });
    const { container } = renderComponent(<Page />);

    assertNoLeakedValues(container, `/${name}`);
    assertGridContracts(container, `/${name}`);
  });
}

test("a row with nothing to say in its meta line uses the absence sentinel", () => {
  // `meta || "—"` — the row for a run with no repository, branch or status
  // summary must not render an empty strip or a stray separator.
  setDashboardState({
    data: feed({
      review_runs: [{ ...RUN, status: "", repository: {}, pull_request: {} }]
    }),
    loading: false,
    error: null
  });
  const { container } = renderComponent(<ReviewsPage />);

  assert.equal(container.querySelector(".row__meta")?.textContent, "—");
  assertNoLeakedValues(container, "/reviews");
});
