import type { DashboardResponse, ReviewEvent, ReviewIssue, ReviewRun, ViewerResponse } from "./types";

const LOCAL_REVIEW_RUN_ID = "local-review-work-fixture";

export function localDashboardFixtureEnabled(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  if (process.env.NEXT_PUBLIC_DASHBOARD_LOCAL_FIXTURE === "0") {
    return false;
  }
  if (process.env.NEXT_PUBLIC_DASHBOARD_LOCAL_FIXTURE === "1") {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  const localHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const fixtureRoute = ["/reviews", "/issues", "/board"].some((route) =>
    window.location.pathname.startsWith(route),
  );
  return (
    (localHost && fixtureRoute) ||
    window.location.pathname.includes(LOCAL_REVIEW_RUN_ID) ||
    window.localStorage.getItem("jina-dashboard-local-fixture") === "1"
  );
}

export function localReviewRun(reviewRunId: string): ReviewRun | undefined {
  if (process.env.NODE_ENV === "production") {
    return undefined;
  }
  return reviewRunId === LOCAL_REVIEW_RUN_ID ? LOCAL_REVIEW_RUN : undefined;
}

export function mergeLocalDashboardFixture(data: DashboardResponse | null): DashboardResponse {
  const generatedAt = new Date().toISOString();
  const base: DashboardResponse = data ?? {
    generated_at: generatedAt,
    bots: [],
    review_runs: [],
    issues: [],
    projects: [],
    teams: [],
  };
  if (!localDashboardFixtureEnabled()) {
    return base;
  }
  const reviewRuns = [LOCAL_REVIEW_RUN, ...base.review_runs.filter((run) => run.review_run_id !== LOCAL_REVIEW_RUN_ID)];
  const issues = [
    ...LOCAL_ISSUES,
    ...base.issues.filter((issue) => !LOCAL_ISSUES.some((fixtureIssue) => fixtureIssue.id === issue.id)),
  ];
  return {
    ...base,
    generated_at: base.generated_at || generatedAt,
    review_runs: reviewRuns,
    issues,
    projects: [
      LOCAL_PROJECT,
      ...base.projects.filter((project) => project.full_name !== LOCAL_PROJECT.full_name),
    ],
  };
}

export function localViewerFixture(): ViewerResponse | undefined {
  if (!localDashboardFixtureEnabled()) {
    return undefined;
  }
  return {
    auth: { mode: "disabled", enabled: false },
    authenticated: true,
    organizations: [],
    teams: [],
    projects: [LOCAL_PROJECT],
  };
}

const LOCAL_PROJECT = {
  id: "local-fixture-project",
  full_name: "local/review-work-fixture",
  owner: "local",
  name: "review-work-fixture",
  source: "observed" as const,
};

const LOCAL_ISSUES: ReviewIssue[] = [
  {
    id: "local-static-checkout-owner",
    review_run_id: LOCAL_REVIEW_RUN_ID,
    fingerprint: "local-static-checkout-owner",
    file_path: "src/api/checkout.ts",
    line_number: 42,
    severity: "high",
    category: "auth",
    body: "Checkout session can be created before ownership is verified.",
    created_at: "2026-06-22T14:01:00.000Z",
    repository: LOCAL_PROJECT.full_name,
    pull_request: 101,
    pull_request_title: "Local dashboard review work fixture",
    pull_request_url: "https://github.com/local/review-work-fixture/pull/101",
  },
  {
    id: "local-runtime-checkout-owner",
    review_run_id: LOCAL_REVIEW_RUN_ID,
    fingerprint: "local-runtime-checkout-owner",
    file_path: "src/api/checkout.ts",
    line_number: 42,
    severity: "high",
    category: "auth",
    body: "Cross-cart checkout succeeds when a promo code is supplied.",
    created_at: "2026-06-22T14:03:00.000Z",
    repository: LOCAL_PROJECT.full_name,
    pull_request: 101,
    pull_request_title: "Local dashboard review work fixture",
    pull_request_url: "https://github.com/local/review-work-fixture/pull/101",
  },
];

const eventBase = Date.parse("2026-06-22T14:00:00.000Z");

function event(offsetMinutes: number, status: string, payload: Record<string, unknown>): ReviewEvent {
  return {
    status,
    payload,
    recorded_at: new Date(eventBase + offsetMinutes * 60_000).toISOString(),
  };
}

const LOCAL_REVIEW_RUN: ReviewRun = {
  review_run_id: LOCAL_REVIEW_RUN_ID,
  trigger_run_id: "local-trigger-run",
  status: "completed_with_issues",
  bot: { type: "local-fixture", status: "completed" },
  repository: {
    full_name: LOCAL_PROJECT.full_name,
    owner: LOCAL_PROJECT.owner,
    name: LOCAL_PROJECT.name,
  },
  pull_request: {
    number: 101,
    title: "Local dashboard review work fixture",
    html_url: "https://github.com/local/review-work-fixture/pull/101",
    author: "local-dev",
    head_sha: "4f6d2a190c3e7b8a9d1e2f3a4b5c6d7e8f9a0b1c",
    head_ref: "fixture/review-work",
    base_ref: "main",
  },
  result: {
    status: "completed_with_issues",
    changed_files: ["src/api/checkout.ts", "src/ui/CheckoutButton.tsx"],
    diff_stat: [
      "src/api/checkout.ts        | 14 ++++++++++----",
      "src/ui/CheckoutButton.tsx   |  8 +++++---",
      "2 files changed, 15 insertions(+), 7 deletions(-)",
    ].join("\n"),
    codegraph_context: [
      "CheckoutButton submits to createCheckoutSession.",
      "createCheckoutSession now accepts an optional promo code before ownership checks complete.",
      "The fixture is frontend-only and exists to exercise review work rendering.",
    ].join("\n"),
    github_comment_url: "https://github.com/local/review-work-fixture/pull/101#issuecomment-local",
    github_check_run_url: "https://github.com/local/review-work-fixture/actions/runs/local",
  },
  events: [
    event(0, "review_context_completed", {
      changed_files: ["src/api/checkout.ts", "src/ui/CheckoutButton.tsx"],
      diff_stat: "2 files changed, 15 insertions(+), 7 deletions(-)",
      codegraph_context: "CheckoutButton submits to createCheckoutSession.",
    }),
    event(1, "static_review_completed", {
      runner: "local-fixture",
      repository: LOCAL_PROJECT.full_name,
      pull_request_number: 101,
      head_sha: "4f6d2a190c3e7b8a9d1e2f3a4b5c6d7e8f9a0b1c",
      status: "issues_found",
      summary: "Static review found a checkout authorization regression.",
      findings_count: 1,
      publishable_findings_count: 1,
      inline_comment_count: 1,
      unanchored_findings_count: 0,
      changed_files: ["src/api/checkout.ts", "src/ui/CheckoutButton.tsx"],
      diff_stat: "2 files changed, 15 insertions(+), 7 deletions(-)",
      static_review: {
        status: "issues_found",
        summary: "Static review found a checkout authorization regression.",
        commit: "4f6d2a190c3e7b8a9d1e2f3a4b5c6d7e8f9a0b1c",
        changedFiles: ["src/api/checkout.ts", "src/ui/CheckoutButton.tsx"],
        diffStat: "2 files changed, 15 insertions(+), 7 deletions(-)",
        findingsCount: 1,
        publishableFindingsCount: 1,
        inlineCommentCount: 1,
        unanchoredFindingsCount: 0,
        findings: [
          {
            fingerprint: "local-static-checkout-owner",
            file_path: "src/api/checkout.ts",
            line_number: 42,
            risk: "high",
            confidence: "high",
            category: "auth",
            title: "Checkout session can be created before ownership is verified",
            body: "The changed checkout path applies a promo code and creates the session before confirming that the cart belongs to the authenticated user.",
            root_cause: "The authorization check moved below the new promo-code branch.",
            why_it_matters: "A signed-in user could create sessions against another user's cart and expose pricing or payment state.",
            reproduction_or_trace: "Call createCheckoutSession with a cart id owned by a different user and a valid promo code.",
            suggested_fix: "Move the cart ownership check before promo-code lookup and session creation.",
            suggested_change: "await assertCartOwner(cartId, user.id);\nconst promo = await resolvePromoCode(input.promoCode);",
            evidence_files: ["src/api/checkout.ts"],
            evidence_symbols: ["createCheckoutSession", "assertCartOwner"],
          },
        ],
      },
      findings: [
        {
          fingerprint: "local-static-checkout-owner",
          file_path: "src/api/checkout.ts",
          line_number: 42,
          severity: "high",
          category: "auth",
          body: "Checkout session can be created before ownership is verified.",
        },
      ],
    }),
    event(2, "github_static_review_published", {
      github_review_url: "https://github.com/local/review-work-fixture/pull/101#pullrequestreview-static",
      inline_comment_count: 1,
      publishable_findings_count: 1,
    }),
    event(3, "runtime_review_completed", {
      runner: "local-fixture",
      repository: LOCAL_PROJECT.full_name,
      pull_request_number: 101,
      head_sha: "4f6d2a190c3e7b8a9d1e2f3a4b5c6d7e8f9a0b1c",
      status: "issues_found",
      summary: "Runtime review reproduced the cross-cart checkout path.",
      findings_count: 1,
      publishable_findings_count: 1,
      inline_comment_count: 1,
      unanchored_findings_count: 0,
      areas_count: 1,
      tasks_count: 1,
      blocked_count: 0,
      changed_files: ["src/api/checkout.ts", "src/ui/CheckoutButton.tsx"],
      diff_stat: "2 files changed, 15 insertions(+), 7 deletions(-)",
      runtime_review: {
        schemaVersion: 1,
        status: "issues_found",
        summary: "Runtime review reproduced the cross-cart checkout path.",
        commit: "4f6d2a190c3e7b8a9d1e2f3a4b5c6d7e8f9a0b1c",
        changedFiles: ["src/api/checkout.ts", "src/ui/CheckoutButton.tsx"],
        diffStat: "2 files changed, 15 insertions(+), 7 deletions(-)",
        areasCount: 1,
        tasksCount: 1,
        findingsCount: 1,
        publishableFindingsCount: 1,
        inlineCommentCount: 1,
        unanchoredFindingsCount: 0,
        blockedCount: 0,
        nonIssuesCount: 1,
        areas: [
          {
            areaId: "checkout-ownership",
            title: "Checkout ownership validation",
            status: "completed",
            summary: "A focused probe showed the new promo branch can reach session creation before ownership validation.",
            tasks: [
              {
                id: "cross-cart-promo-probe",
                title: "Cross-cart promo checkout probe",
                purpose: "Validate that checkout rejects a cart not owned by the current user when a promo code is supplied.",
                method: "execution",
                actionsTaken: [
                  "Created a focused in-memory checkout probe with two users and one cart.",
                  "Called createCheckoutSession as user B with user A's cart and a valid promo code.",
                  "Captured the call order for ownership validation and payment session creation.",
                ],
                whatWasLearned: "The promo-code branch reaches payment session creation before assertCartOwner runs.",
                auditTrail: [
                  {
                    type: "command",
                    detail: "pnpm exec tsx .jina/runtime-review/probes/checkout-ownership/probe.ts",
                    evidence: ["exitCode=1", "createPaymentSession called before assertCartOwner"],
                  },
                  {
                    type: "reasoning",
                    detail: "Compared the probe call order with the expected safe behavior.",
                    evidence: ["Expected assertCartOwner before resolvePromoCode and createPaymentSession."],
                  },
                ],
                verdict: "issue_found",
                confidence: "high",
              },
            ],
            issues: [],
            nonIssues: [
              {
                hypothesis: "Checkout still rejects valid carts with invalid promo codes.",
                whyDismissed: "The focused probe returned the expected validation error after ownership succeeded.",
                evidence: ["Invalid promo path returned PROMO_NOT_FOUND for the owned cart."],
              },
            ],
            blocked: [],
            toolCalls: [],
          },
        ],
        tasks: [
          {
            id: "cross-cart-promo-probe",
            areaId: "checkout-ownership",
            areaTitle: "Checkout ownership validation",
            title: "Cross-cart promo checkout probe",
            purpose: "Validate that checkout rejects a cart not owned by the current user when a promo code is supplied.",
            method: "execution",
            actionsTaken: [
              "Created a focused in-memory checkout probe with two users and one cart.",
              "Called createCheckoutSession as user B with user A's cart and a valid promo code.",
              "Captured the call order for ownership validation and payment session creation.",
            ],
            whatWasLearned: "The promo-code branch reaches payment session creation before assertCartOwner runs.",
            auditTrail: [
              {
                type: "command",
                detail: "pnpm exec tsx .jina/runtime-review/probes/checkout-ownership/probe.ts",
                evidence: ["exitCode=1", "createPaymentSession called before assertCartOwner"],
              },
            ],
            verdict: "issue_found",
            confidence: "high",
          },
        ],
        findings: [
          {
            fingerprint: "local-runtime-checkout-owner",
            title: "Cross-cart checkout succeeds when a promo code is supplied",
            risk: "high",
            confidence: "high",
            category: "auth",
            file_path: "src/api/checkout.ts",
            line_number: 42,
            body: "The runtime probe showed payment session creation can happen for another user's cart when the request includes a promo code.",
            root_cause: "The new promo branch is evaluated before assertCartOwner.",
            why_it_matters: "The checkout flow can leak cart/payment state and create unauthorized payment sessions.",
            evidence: ["Probe log: createPaymentSession called before assertCartOwner."],
            reproduction_or_trace: "pnpm exec tsx .jina/runtime-review/probes/checkout-ownership/probe.ts",
            suggested_fix: "Run assertCartOwner before promo-code resolution and payment session creation.",
            validation_method: "execution",
            audit_trail: ["Created local checkout probe.", "Ran cross-cart promo checkout probe.", "Observed session creation before owner validation."],
          },
        ],
        blocked: [],
        nonIssues: [
          {
            areaId: "checkout-ownership",
            areaTitle: "Checkout ownership validation",
            hypothesis: "Checkout still rejects valid carts with invalid promo codes.",
            whyDismissed: "The focused probe returned the expected validation error after ownership succeeded.",
            evidence: ["Invalid promo path returned PROMO_NOT_FOUND for the owned cart."],
          },
        ],
      },
      findings: [
        {
          fingerprint: "local-runtime-checkout-owner",
          file_path: "src/api/checkout.ts",
          line_number: 42,
          severity: "high",
          category: "auth",
          body: "Cross-cart checkout succeeds when a promo code is supplied.",
        },
      ],
    }),
    event(4, "github_runtime_review_published", {
      github_review_url: "https://github.com/local/review-work-fixture/pull/101#pullrequestreview-runtime",
      inline_comment_count: 1,
      publishable_findings_count: 1,
    }),
  ],
  created_at: "2026-06-22T14:00:00.000Z",
  updated_at: "2026-06-22T14:04:00.000Z",
  finished_at: "2026-06-22T14:04:00.000Z",
};
