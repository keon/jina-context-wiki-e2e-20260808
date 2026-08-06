import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoLeakedValues,
  attrOf,
  captureConsole,
  count,
  jsonResponse,
  present,
  renderComponent,
  stubFetch,
  textOf
} from "../testing/render.tsx";
import ContextAdminPage from "./page.tsx";

/**
 * Rendered coverage for the admin console's honesty rules.
 *
 * `lib/jina-api.test.ts` and `lib/status-tone.test.ts` already pin the pure
 * functions: an omitted counter parses to `undefined`, `statusTone` returns
 * `undefined` for a value it does not recognise. Neither says anything about
 * what an operator sees, and the page is where the claim is actually made — a
 * `?? 0` between the parser and the cell would satisfy every existing test while
 * printing "0 backlog" over an outage.
 *
 * `ContextAdminPage` is an async server component, so the test awaits the
 * element tree it returns and renders that. Everything below the top level is
 * synchronous, and all four reads go through `fetch`, which is stubbed.
 */

/* --------------------------------------------------------------- fixtures --- */

const RELEASE = {
  id: "rel_01",
  repository: "acme/payments",
  ref: "refs/heads/main",
  commitSha: "0123456789abcdef",
  completeness: "complete",
  contextStatus: "available",
  createdAt: "2026-02-01T10:00:00.000Z",
  publishedAt: "2026-02-01T10:30:00.000Z"
};

function build(overrides: Record<string, unknown> = {}) {
  return {
    id: "bld_01",
    repository: "acme/payments",
    ref: "refs/heads/main",
    refSequence: 7,
    commitSha: "fedcba9876543210",
    status: "completed",
    stages: [
      { id: "stage_1", type: "derive", title: "Derive pages", status: "done", attempt: 1, updatedAt: RELEASE.createdAt }
    ],
    createdAt: RELEASE.createdAt,
    updatedAt: RELEASE.createdAt,
    ...overrides
  };
}

const DOCUMENT = {
  id: "doc_01",
  logicalId: "payments/retry",
  kind: "context",
  title: "Retry policy",
  summary: "How captures are retried.",
  citations: []
};

const PROJECTOR = {
  name: "context-index",
  status: "healthy",
  checkpoint: "chk_9",
  version: "v3",
  backlog: 0
};

/** Metrics with every counter measured, several of them measured at zero. */
const MEASURED_METRICS = {
  outboxDepthByConsumer: {},
  publishedGenerationCount: 0,
  fragmentCount: 0,
  hierarchyNodeCount: 0,
  embeddingCount: 0,
  projectors: [PROJECTOR],
  quotas: { active: { builds: 0, modelTasks: 0 } }
};

interface Payloads {
  readonly releases?: unknown;
  readonly metrics?: unknown;
  readonly builds?: unknown;
  readonly documents?: unknown;
  readonly progress?: unknown;
}

/** Routes each admin read to its payload; anything unset answers 500. */
function respondWith(payloads: Payloads): (url: string) => Response {
  return (url) => {
    const failed = jsonResponse({ error: "unavailable" }, 500);
    if (url.includes("/context/releases")) return payloads.releases ? jsonResponse(payloads.releases) : failed;
    if (url.includes("/context/metrics")) return payloads.metrics ? jsonResponse(payloads.metrics) : failed;
    if (url.includes("/context/builds/")) return payloads.progress ? jsonResponse(payloads.progress) : failed;
    if (url.includes("/context/builds")) return payloads.builds ? jsonResponse(payloads.builds) : failed;
    if (url.includes("/context/list")) return payloads.documents ? jsonResponse(payloads.documents) : failed;
    return failed;
  };
}

async function renderPage(payloads: Payloads, repository?: string) {
  const log = captureConsole();
  const { requests } = stubFetch(respondWith(payloads));
  const tree = await ContextAdminPage({
    searchParams: Promise.resolve(repository === undefined ? {} : { repository })
  });
  return { ...renderComponent(tree), requests, log };
}

/**
 * Selectors for the shared primitives, which are dressed by CSS Modules in
 * `@jina/ui`: their class names are hashed by the bundler, so `[data-ui]` — the
 * contract that package publishes — is what a test can hold on to.
 *
 * The two error treatments are one component. The page-level banner is the one
 * that announces itself; a per-section notice does not, because five
 * simultaneous interruptions announce nothing.
 */
const PAGE_ALERT = "[data-ui='error-state'][role='alert']";
const SECTION_ERROR = "[data-ui='error-state']";
const EMPTY_STATE = "[data-ui='empty-state']";

/** The stat carrying `label`. Only primitives derived from it reach assertions. */
function stat(container: HTMLElement, label: string): { value: string; unknown: boolean } {
  const found = Array.from(container.querySelectorAll("[data-ui='stat']")).find(
    (element) => element.querySelector("[data-ui='stat-label']")?.textContent === label
  );
  assert.ok(found !== undefined, `no stat labelled ${JSON.stringify(label)} was rendered`);
  return {
    value: found.querySelector("[data-ui='stat-value']")?.textContent ?? "",
    unknown: found.getAttribute("data-measured") === "false"
  };
}

const EVERY_STAT = [
  "Context releases",
  "Repositories",
  "Derived context docs",
  "Projection backlog",
  "Active builds",
  "Active model tasks",
  "Verified checkpoints",
  "Hierarchy nodes"
] as const;

/** What `<Unmeasured>` reads as: a decorative dash plus its screen-reader name. */
const UNMEASURED = "—Unavailable";

/* ------------------------------------------------ unmeasured is not zero --- */

test("counters that were never measured render an em dash, never 0", async () => {
  // Every read fails, so not one of the eight counters has a measurement behind it.
  const { container, log } = await renderPage({});

  for (const label of EVERY_STAT) {
    const { value, unknown } = stat(container, label);
    assert.equal(value, UNMEASURED, `${label} should read as unmeasured, got ${JSON.stringify(value)}`);
    assert.notEqual(value.trim(), "0", `${label} fabricated a zero from a failed read`);
    assert.ok(unknown, `${label} is not marked unknown`);
  }

  // …and the page says so, rather than looking like a quiet, idle system.
  assert.ok(present(container, PAGE_ALERT), "a page with five failed sections must say so");
  assert.match(textOf(container, PAGE_ALERT), /5 sections are not reporting/);
  assert.match(textOf(container, PAGE_ALERT), /were never measured and are not zero/);
  // The operator's other half of that story is the server log.
  assert.equal(log.errors.length, 3, "each attempted section records its failure server-side");
});

test("a counter measured at zero still renders 0", async () => {
  const { container } = await renderPage({
    releases: { releases: [] },
    metrics: MEASURED_METRICS,
    builds: { builds: [] }
  });

  // The distinction the whole page turns on: these eight were all measured, and
  // every one of them measured zero.
  for (const label of EVERY_STAT) {
    assert.equal(stat(container, label).value, "0", `${label} should report its measured zero`);
  }
  assert.equal(count(container, PAGE_ALERT), 0, "nothing failed, so nothing should be reported as failed");
  assert.equal(count(container, "[data-ui='stat'][data-measured='false']"), 0);
});

test("a section that loaded reports its measured counters and its unmeasured ones separately", async () => {
  // The shipped failure this guards: a `finiteNumber(x, 0)` in the parser, or a
  // `?? 0` in the page, turning "the API sent no quota telemetry" into "no
  // capacity is in use". The metrics read succeeds here — it simply does not
  // carry an outbox map or quotas.
  const { container } = await renderPage({
    releases: { releases: [RELEASE] },
    metrics: { publishedGenerationCount: 4, hierarchyNodeCount: 11 },
    builds: { builds: [] },
    documents: { documents: [DOCUMENT] }
  });

  assert.equal(stat(container, "Context releases").value, "4");
  assert.equal(stat(container, "Hierarchy nodes").value, "11");
  // Absent telemetry, from a read that otherwise succeeded.
  for (const label of ["Projection backlog", "Active builds", "Active model tasks"] as const) {
    assert.equal(stat(container, label).value, UNMEASURED, `${label} was not reported and is not zero`);
  }
  // The prose under "Context index health" holds the same line.
  assert.match(textOf(container, "#health .muted"), /—/);
  assert.match(
    textOf(container, "#health .muted"),
    /never measured and are not zero/,
    "a partially measured index must say which counts are missing"
  );
});

test("an unmeasured counter is announced, not just dashed", async () => {
  const { container } = await renderPage({});

  assert.ok(present(container, "[data-ui='stat'] [data-ui='unmeasured']"), "expected the unmeasured sentinel");
  // The em dash is decorative; the accessible name has to carry the meaning.
  assert.equal(textOf(container, "[data-ui='unmeasured'] [aria-hidden='true']"), "—");
  assert.equal(textOf(container, "[data-ui='unmeasured'] span:not([aria-hidden])"), "Unavailable");
  assert.match(attrOf(container, "[data-ui='unmeasured']", "title") ?? "", /not reported, and is not zero/);
});

/* -------------------------------------------------------------- status tone --- */

test("an unrecognised build status renders verbatim and carries no tone", async () => {
  const { container } = await renderPage({
    releases: { releases: [RELEASE] },
    metrics: MEASURED_METRICS,
    builds: {
      builds: [
        build({ id: "bld_ok", status: "completed", updatedAt: "2026-02-03T00:00:00.000Z" }),
        build({
          id: "bld_bad",
          status: "failed",
          failureReason: "derivation timed out",
          updatedAt: "2026-02-02T00:00:00.000Z"
        }),
        build({ id: "bld_new", status: "blocked", updatedAt: "2026-02-01T00:00:00.000Z" })
      ]
    },
    documents: { documents: [DOCUMENT] }
  });

  const statusCells = Array.from(container.querySelectorAll("#builds tbody tr td:nth-child(4)"));
  assert.equal(statusCells.length, 3);
  const cellFor = (status: string) => statusCells.find((cell) => cell.textContent?.startsWith(status));
  const toneOf = (status: string): string | null => cellFor(status)?.getAttribute("data-tone") ?? null;
  const textFor = (status: string): string => cellFor(status)?.textContent ?? "";

  assert.match(textFor("blocked"), /^blocked/, "a status this app has never seen must reach the table verbatim");
  assert.equal(
    toneOf("blocked"),
    null,
    "an unrecognised status must be neither green nor red — colouring it would assert something the data does not support"
  );

  // The mechanism works; only the unknown value is left neutral.
  assert.equal(toneOf("completed"), "ok");
  assert.equal(toneOf("failed"), "bad");
  assert.match(textFor("failed"), /derivation timed out/);
});

test("a release whose completeness the API never sent is neutral, not healthy", async () => {
  const { container } = await renderPage({
    releases: { releases: [{ ...RELEASE, completeness: undefined, contextStatus: undefined }] },
    metrics: MEASURED_METRICS,
    builds: { builds: [] },
    documents: { documents: [] }
  });

  const cells = Array.from(container.querySelectorAll("#releases tbody tr td"));
  assert.equal(cells[4]?.textContent, "unknown");
  assert.equal(cells[5]?.textContent, "unknown");
  // "unknown" is a gap in what was measured, which is not evidence of failure.
  assert.equal(cells[4]?.getAttribute("data-tone") ?? null, null);
  assert.equal(cells[5]?.getAttribute("data-tone") ?? null, null);
});

/* --------------------------------------------------------- failed sections --- */

test("a failed read renders its degraded treatment instead of confident empty copy", async () => {
  // Releases fail; everything else is fine. "No context releases have been
  // published" over a failed read is the shipped bug: it reports an outage as a
  // fact about the tenant's data.
  const { container } = await renderPage({
    metrics: MEASURED_METRICS,
    builds: { builds: [] }
  });

  assert.equal(count(container, `#releases ${EMPTY_STATE}`), 0, "a failed read must not render the empty state");
  assert.doesNotMatch(textOf(container, "#releases"), /No context releases have been published/);

  assert.ok(present(container, `#releases ${SECTION_ERROR}`), "a failed section must say it is unavailable");
  assert.match(textOf(container, `#releases ${SECTION_ERROR}`), /Published releases is unavailable/);
  assert.match(textOf(container, `#releases ${SECTION_ERROR}`), /This is not an empty result/);
  assert.equal(count(container, "#releases table"), 0, "no table stands in for a section that did not load");
});

test("a section that depends on a failed one reports as not attempted, not as empty", async () => {
  const { container, requests } = await renderPage({
    metrics: MEASURED_METRICS,
    builds: { builds: [] }
  });

  assert.equal(count(container, `#documents ${EMPTY_STATE}`), 0);
  assert.match(
    textOf(container, `#documents ${SECTION_ERROR}`),
    /not attempted because Published releases could not be loaded/
  );
  // And it really was not attempted — a blocked read must not be issued.
  assert.equal(
    requests.filter((url) => url.includes("/context/list")).length,
    0,
    "the derived-context read needs the release list it did not get"
  );

  assert.match(textOf(container, PAGE_ALERT), /2 sections are not reporting/);
});

test("an empty read still renders the empty state, so the two are distinguishable", async () => {
  const { container } = await renderPage({
    releases: { releases: [] },
    metrics: MEASURED_METRICS,
    builds: { builds: [] }
  });

  assert.equal(count(container, `#releases ${SECTION_ERROR}`), 0);
  assert.match(textOf(container, `#releases ${EMPTY_STATE}`), /No context releases have been published/);
  assert.equal(count(container, PAGE_ALERT), 0);
});

test("a repository filter names itself in the empty copy", async () => {
  const { container } = await renderPage(
    { releases: { releases: [] }, metrics: MEASURED_METRICS, builds: { builds: [] } },
    "acme/payments"
  );

  assert.match(
    textOf(container, `#releases ${EMPTY_STATE}`),
    /No context releases have been published for acme\/payments/
  );
});

/* ------------------------------------------------------------ table naming --- */

test("every data table keeps an accessible name and column-scoped headers", async () => {
  const { container } = await renderPage({
    releases: { releases: [RELEASE] },
    metrics: MEASURED_METRICS,
    builds: { builds: [build()] },
    documents: { documents: [DOCUMENT] }
  });

  const tables = Array.from(container.querySelectorAll("table.context-table"));
  assert.equal(tables.length, 4, "releases, builds, index health and derived context each render a table");

  for (const table of tables) {
    const caption = table.querySelector("caption");
    const name = caption?.textContent ?? "";
    assert.ok(caption !== null, "a data table without a caption has no accessible name");
    assert.ok(caption.classList.contains("sr-only"), `the caption of ${name} must be the accessible name, not chrome`);
    assert.ok(name.trim().length > 0, "a caption with no text names nothing");

    // The scroll wrapper is focusable, so it needs its own name; it borrows the
    // caption's.
    const wrapper = table.closest(".table-scroll");
    assert.ok(wrapper !== null, `the table for ${name} must sit inside its scroll region`);
    assert.equal(wrapper.getAttribute("role"), "region");
    assert.equal(wrapper.getAttribute("tabindex"), "0");
    assert.equal(wrapper.getAttribute("aria-labelledby"), caption.getAttribute("id"));

    const scopes = Array.from(table.querySelectorAll("thead th")).map((header) => header.getAttribute("scope"));
    assert.ok(scopes.length > 0, `the table for ${name} has no column headers`);
    assert.deepEqual(
      scopes,
      scopes.map(() => "col"),
      `every header in "${name}" must be column-scoped`
    );
  }

  assert.deepEqual(
    tables.map((table) => table.querySelector("caption")?.getAttribute("id")),
    ["releases-table-caption", "builds-table-caption", "health-table-caption", "documents-table-caption"]
  );
});

test("a table states its whole population in its accessible name", async () => {
  const { container } = await renderPage({
    releases: { releases: [RELEASE] },
    metrics: MEASURED_METRICS,
    builds: { builds: [build()] },
    documents: { documents: [DOCUMENT] }
  });

  assert.match(textOf(container, "#releases-table-caption"), /1 release shown/);
  assert.match(textOf(container, "#builds-table-caption"), /1 build shown/);
});

/* --------------------------------------------------------- no leaked values --- */

test("a fully populated page renders no formatter placeholders", async () => {
  const { container } = await renderPage({
    releases: { releases: [RELEASE] },
    metrics: MEASURED_METRICS,
    builds: { builds: [build()] },
    documents: { documents: [DOCUMENT] }
  });

  assertNoLeakedValues(container, "ContextAdminPage");
});

test("a page assembled from sparse and malformed rows renders no formatter placeholders", async () => {
  // Every optional field the API may omit, plus an unparseable stamp and a
  // budget with no consumption reported against it.
  const { container } = await renderPage({
    releases: { releases: [{ ...RELEASE, commitSha: undefined, publishedAt: undefined }] },
    metrics: { projectors: [{ name: "context-index", status: "unknown", checkpoint: "chk", version: "v1" }] },
    builds: {
      builds: [
        build({
          commitSha: undefined,
          status: "active",
          derivationTokenBudget: 1_000_000,
          consumedExecutionSeconds: 4200,
          updatedAt: "not-a-timestamp",
          stages: [
            {
              id: "stage_1",
              type: "derive",
              title: "Derive pages",
              status: "in_progress",
              attempt: 2,
              updatedAt: "not-a-timestamp"
            }
          ]
        })
      ]
    },
    progress: {
      buildId: "bld_01",
      repository: "acme/payments",
      ref: "refs/heads/main",
      stages: [],
      pages: [],
      updatedAt: RELEASE.createdAt
    },
    documents: { documents: [{ id: "doc_02", logicalId: "payments/retry" }] }
  });

  assertNoLeakedValues(container, "ContextAdminPage");
  // The two figures the API never reported stay unmeasured rather than reading
  // as untouched headroom / a healthy, caught-up projection.
  assert.match(textOf(container, "#builds tbody tr td:nth-child(5)"), /—/);
  assert.match(textOf(container, "#health tbody tr td:nth-child(3)"), /—/);
});
