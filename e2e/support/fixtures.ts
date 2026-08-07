/**
 * The upstream Jina API, as three fixed answers.
 *
 * The admin console is a read-only projection of five API reads, so a stub that
 * answers those five reads exercises the whole page — the same approach the
 * node component suite takes with a stubbed `fetch`, moved up one level so a
 * real Next server does the rendering and a real browser does the layout.
 *
 * Three scenarios, each pinning a claim the page makes:
 *
 *   `partial`  every read succeeds, but the telemetry is incomplete. Some
 *              counters are measured, one is measured at zero, and three were
 *              never reported. This is the shape that produced the shipped bug
 *              the `Unmeasured` sentinel exists for: absent quota telemetry
 *              rendered as idle capacity.
 *   `degraded` two reads fail, and a third is never attempted because the read
 *              it depends on failed. Nothing may render as an empty result.
 *   `empty`    every read succeeds and finds nothing. This is the render the
 *              degraded one must not be mistaken for.
 *
 * Every timestamp is fixed. The admin page formats absolute UTC, so these are
 * already stable, but a fixture with `Date.now()` in it is a baseline that
 * rewrites itself — see the frozen clock in `harness.ts`.
 */

const SCENARIOS = ["partial", "degraded", "empty"] as const;

export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: string): value is Scenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** The heading each section renders, and which the degraded banner must name. */
export const HEADINGS = {
  releases: "Published releases",
  builds: "Build and checkpoint state",
  health: "Context index health",
  documents: "Agent-derived context"
} as const;

const PUBLISHED_AT = "2026-03-01T11:04:00.000Z";
const CREATED_AT = "2026-03-01T09:41:00.000Z";
const UPDATED_AT = "2026-03-01T11:50:00.000Z";

const RELEASES = [
  {
    id: "rel_payments_41",
    repository: "acme/payments",
    ref: "refs/heads/main",
    commitSha: "0123456789abcdef0123",
    completeness: "complete",
    contextStatus: "available",
    createdAt: CREATED_AT,
    publishedAt: PUBLISHED_AT
  },
  {
    id: "rel_ledger_12",
    repository: "acme/ledger",
    ref: "refs/heads/main",
    commitSha: "fedcba9876543210fedc",
    completeness: "partial",
    contextStatus: "partial",
    createdAt: CREATED_AT,
    publishedAt: CREATED_AT
  },
  {
    // No `completeness` and no `contextStatus`: the parsers resolve both to
    // "unknown", and an unknown state must reach the operator uncoloured rather
    // than being presented as healthy.
    id: "rel_search_03",
    repository: "acme/search",
    ref: "refs/heads/main",
    commitSha: "abcdefabcdefabcdefab",
    createdAt: "2026-02-28T22:15:00.000Z"
  }
] as const;

const STAGE_DONE = {
  id: "stage_plan",
  type: "plan",
  title: "Plan pages",
  status: "done",
  attempt: 1,
  updatedAt: UPDATED_AT
};

const BUILDS = [
  {
    id: "bld_payments_active",
    repository: "acme/payments",
    ref: "refs/heads/main",
    refSequence: 41,
    commitSha: "0123456789abcdef0123",
    status: "active",
    derivationTokenBudget: 4_000_000,
    consumedModelTokens: 1_250_000,
    stages: [
      STAGE_DONE,
      {
        id: "stage_derive",
        type: "derive",
        title: "Derive pages",
        status: "in_progress",
        attempt: 2,
        modelTotalTokens: 812_000,
        lastRetryFailureReason: "model timeout",
        updatedAt: UPDATED_AT
      }
    ],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT
  },
  {
    id: "bld_ledger_failed",
    repository: "acme/ledger",
    ref: "refs/heads/main",
    refSequence: 12,
    commitSha: "fedcba9876543210fedc",
    status: "failed",
    failureCode: "citation_gate",
    failureReason: "3 claims resolved to no anchor",
    // No token budget and no consumed figure: the cell must read "not recorded"
    // rather than inventing a zero-of-zero budget.
    stages: [
      STAGE_DONE,
      {
        id: "stage_certify",
        type: "certify",
        title: "Certify catalog",
        status: "failed",
        attempt: 3,
        failureCode: "citation_gate",
        failureReason: "3 claims resolved to no anchor",
        updatedAt: CREATED_AT
      }
    ],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  },
  {
    // A status this app has never seen. It must reach the table verbatim and
    // carry no tone — colouring an unknown status as healthy is the failure
    // `statusTone()` returns `undefined` to prevent.
    id: "bld_search_quarantined",
    repository: "acme/search",
    ref: "refs/heads/main",
    refSequence: 3,
    commitSha: "abcdefabcdefabcdefab",
    status: "quarantined",
    stages: [STAGE_DONE],
    createdAt: "2026-02-28T22:15:00.000Z",
    updatedAt: "2026-02-28T22:15:00.000Z"
  }
] as const;

/** Sampled only for builds whose status is "active". */
const BUILD_PROGRESS: Readonly<Record<string, unknown>> = {
  bld_payments_active: {
    buildId: "bld_payments_active",
    repository: "acme/payments",
    ref: "refs/heads/main",
    status: "active",
    derivationTokenBudget: 4_000_000,
    consumedModelTokens: 1_250_000,
    activeModelReservedTokens: 96_000,
    consumedExecutionSeconds: 5_400,
    // `remainingExecutionSeconds` is deliberately absent: a budget rendered
    // against a fabricated 0 remaining reads as exhausted.
    stages: [
      STAGE_DONE,
      {
        id: "stage_derive",
        type: "derive",
        title: "Derive pages",
        status: "in_progress",
        attempt: 2,
        modelTotalTokens: 812_000,
        updatedAt: UPDATED_AT
      }
    ],
    pages: [
      {
        documentPath: "payments/retry.md",
        title: "Retry policy",
        bytes: 4_210,
        validationStatus: "valid",
        diagnostics: [],
        checkpointSequence: 1,
        updatedAt: UPDATED_AT
      },
      {
        documentPath: "payments/capture.md",
        title: "Capture lifecycle",
        bytes: 8_940,
        validationStatus: "valid",
        diagnostics: [],
        checkpointSequence: 2,
        updatedAt: UPDATED_AT
      },
      {
        documentPath: "payments/refunds.md",
        title: "Refunds",
        bytes: 2_120,
        validationStatus: "invalid",
        diagnostics: ["citation 4 resolved to no anchor"],
        checkpointSequence: 3,
        updatedAt: UPDATED_AT
      }
    ],
    updatedAt: UPDATED_AT
  }
};

/** The count the "Verified checkpoints" stat must report in `partial`. */
export const VERIFIED_CHECKPOINTS = 2;

const DOCUMENTS: Readonly<Record<string, readonly unknown[]>> = {
  rel_payments_41: [
    {
      id: "doc_retry",
      logicalId: "payments/retry",
      kind: "context",
      title: "Retry policy",
      summary: "How captures are retried after a gateway timeout.",
      citations: [{ claim: "Captures retry three times", anchor: { sourceType: "file", sourceId: "src/retry.ts" } }]
    },
    {
      id: "doc_capture",
      logicalId: "payments/capture",
      kind: "runbook",
      title: "Capture lifecycle",
      summary: "States a capture moves through.",
      citations: []
    }
  ],
  rel_ledger_12: [
    {
      id: "doc_posting",
      logicalId: "ledger/posting",
      kind: "context",
      title: "Posting rules",
      summary: "When an entry is posted to the ledger.",
      citations: []
    }
  ],
  rel_search_03: []
};

/** The count the "Derived context docs" stat must report in `partial`. */
export const DERIVED_DOCUMENT_COUNT = 3;

/**
 * Telemetry with holes in it.
 *
 * `quotas.active.modelTasks` is measured at zero and sits directly beside
 * `quotas.active.builds`, which was never reported. If the page rendered both
 * the same way the sentinel would be worthless — an operator could no longer
 * tell an idle system from one nobody managed to read.
 */
const PARTIAL_METRICS = {
  publishedGenerationCount: 3,
  fragmentCount: 0,
  embeddingCount: 0,
  // hierarchyNodeCount: never reported.
  // outboxDepthByConsumer: never reported, so the projection backlog is unknown.
  quotas: { active: { modelTasks: 0 } },
  projectors: [
    { name: "context-index", status: "healthy", checkpoint: "chk_9182", backlog: 0, version: "v3" },
    // A degraded projector whose lag was never measured: the row must not print
    // "0 backlog" beside a warning status.
    { name: "context-hierarchy", status: "degraded", checkpoint: "chk_9101", version: "v3" }
  ]
};

/** Every counter measured at nothing, which is a different claim entirely. */
const EMPTY_METRICS = {
  publishedGenerationCount: 0,
  fragmentCount: 0,
  hierarchyNodeCount: 0,
  embeddingCount: 0,
  outboxDepthByConsumer: {},
  quotas: { active: { builds: 0, modelTasks: 0 } },
  projectors: []
};

export interface StubReply {
  readonly status: number;
  readonly body: unknown;
}

const FAILED: StubReply = { status: 500, body: { error: "stub: upstream unavailable" } };

/**
 * Answers one admin API read.
 *
 * `pathname` and `search` come straight off the request; the admin client only
 * ever issues these five shapes.
 */
export function replyFor(scenario: Scenario, pathname: string, search: URLSearchParams): StubReply | undefined {
  if (pathname === "/context/releases") {
    if (scenario === "degraded") return FAILED;
    return { status: 200, body: { releases: scenario === "empty" ? [] : RELEASES } };
  }

  if (pathname === "/context/metrics") {
    if (scenario === "degraded") return FAILED;
    return { status: 200, body: scenario === "empty" ? EMPTY_METRICS : PARTIAL_METRICS };
  }

  if (pathname === "/context/builds") {
    return { status: 200, body: { builds: scenario === "empty" ? [] : BUILDS } };
  }

  if (pathname === "/context/list") {
    const releaseId = search.get("releaseId") ?? "";
    return { status: 200, body: { documents: DOCUMENTS[releaseId] ?? [] } };
  }

  const progressMatch = /^\/context\/builds\/([^/]+)\/progress$/.exec(pathname);
  if (progressMatch) {
    const buildId = decodeURIComponent(progressMatch[1] ?? "");
    const progress = BUILD_PROGRESS[buildId];
    // A build with no sampled progress is a 404 the client swallows, not a
    // failure of the whole page.
    return progress === undefined
      ? { status: 404, body: { error: "stub: no progress" } }
      : { status: 200, body: progress };
  }

  return undefined;
}
