import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryContextEngineStore } from "../memory/store.js";
import {
  contextOrchestrationDiagnostics,
  parseContextOrchestrationState,
  repositoryContextAreas
} from "./orchestration.js";
import { derivationProgressDocumentPath } from "./progress.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

test("provisional document paths cannot escape or collide with private state", () => {
  assert.equal(derivationProgressDocumentPath("components/context-engine"), "components/context-engine");
  for (const unsafe of [
    "../escape",
    "components/../escape",
    "/absolute",
    ".context-plan",
    "components/.private/page",
    "components/context-engine.md",
    "components//context-engine",
    "components\\..\\escape"
  ]) {
    assert.throws(() => derivationProgressDocumentPath(unsafe), /safe extensionless relative path/);
  }
});

const orchestration = parseContextOrchestrationState({
  version: 4,
  repository: "acme/cache",
  ref: "main",
  commitSha: "a".repeat(40),
  mode: "initial",
  phase: "complete",
  subjects: [
    {
      id: "cache-lifecycle",
      kind: "flow",
      statement: "Cache lookup preserves the expiry lifecycle.",
      priority: "required",
      status: "covered",
      signals: [{ source: "documentation", reference: "README.md" }],
      questions: [
        {
          id: "cache-lookup",
          question: "How does cache lookup work?",
          priority: "required",
          status: "answered",
          pageIds: ["architecture"]
        }
      ],
      pageIds: ["architecture"]
    }
  ],
  items: [
    {
      id: "architecture",
      path: "architecture.md",
      title: "Architecture",
      purpose: "Explain the cache",
      priority: "required",
      status: "complete",
      scope: { paths: ["README.md", "src/cache.ts"], symbols: ["Cache"] },
      questions: ["cache-lookup"],
      requiredEvidence: ["code", "tests"],
      dependencies: []
    }
  ],
  areas: [
    { id: "root", status: "covered", pageIds: ["architecture"] },
    { id: "src", status: "covered", pageIds: ["architecture"] }
  ],
  workers: [
    { id: "cache-research", role: "research", status: "complete", pageIds: ["architecture"] },
    { id: "cache-critic", role: "critic", status: "complete", pageIds: [] }
  ],
  reviews: [
    {
      id: "cache-context-review",
      kind: "context_only",
      status: "complete",
      reviewer: "subagent",
      workerId: "cache-critic",
      results: [
        {
          questionId: "cache-lookup",
          verdict: "pass",
          pageIds: ["architecture"],
          gapIds: [],
          summary: "The architecture page answers the cache lookup task."
        }
      ],
      summary: "The public context explains cache lookup without source reconstruction."
    }
  ],
  gaps: [],
  completionReason: "Every required area is covered."
});

test("the orchestration plan accounts for deterministic repository areas", () => {
  const manifest = [{ path: "README.md" }, { path: "src/cache.ts" }, { path: "apps/api/server.ts" }];
  assert.deepEqual(repositoryContextAreas(manifest), ["apps", "apps/api", "root", "src"]);
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: orchestration,
      documentPaths: ["architecture.md"],
      manifest: manifest.slice(0, 2)
    }),
    []
  );
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: orchestration,
      documentPaths: [],
      manifest: manifest.slice(0, 2)
    }),
    ["orchestration item architecture is complete but architecture.md was not published"]
  );
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: orchestration,
      documentPaths: ["architecture.md"],
      manifest: manifest.slice(0, 2),
      evidenceByDocumentPath: { "architecture.md": ["documentation"] },
      availableEvidence: ["code", "documentation"]
    }),
    ["orchestration item architecture is missing required code evidence"]
  );
});

test("source-bearing areas require citation-backed coverage without prescribing public page structure", () => {
  const manifest = [{ path: "README.md" }, { path: "src/cache.ts" }];
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: orchestration,
      documentPaths: ["architecture.md"],
      manifest,
      sourcePathsByDocumentPath: { "architecture.md": ["README.md", "src/cache.ts"] }
    }),
    []
  );

  const wrongAreaEvidence = contextOrchestrationDiagnostics({
    state: orchestration,
    documentPaths: ["architecture.md"],
    manifest,
    sourcePathsByDocumentPath: { "architecture.md": ["README.md"] }
  });
  assert.deepEqual(wrongAreaEvidence, ["covered repository area src has no citation from that area"]);

  const skippedSourceArea = {
    ...orchestration,
    areas: orchestration.areas.map((area) =>
      area.id === "src" ? { ...area, status: "unsupported" as const, pageIds: [], reason: "not documented" } : area
    )
  };
  assert.equal(
    contextOrchestrationDiagnostics({
      state: skippedSourceArea,
      documentPaths: ["architecture.md"],
      manifest,
      sourcePathsByDocumentPath: { "architecture.md": ["README.md"] }
    }).includes("source-bearing repository area src is not covered"),
    true
  );
});

test("complete orchestration requires evidence-backed subjects mapped to complete pages", () => {
  const withoutSubjects = { ...orchestration, subjects: [] };
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: withoutSubjects,
      documentPaths: ["architecture.md"],
      manifest: [{ path: "README.md" }, { path: "src/cache.ts" }]
    }),
    [
      "orchestration item architecture names unknown maintenance question cache-lookup",
      "complete orchestration item architecture is not mapped from a covered subject",
      "critic review cache-context-review names unknown maintenance question cache-lookup",
      "complete orchestration has no subjects"
    ]
  );
  const invalidSignal = {
    ...orchestration,
    subjects: [
      {
        ...orchestration.subjects[0]!,
        signals: [{ source: "commit" as const, reference: "missing-sha" }]
      }
    ]
  };
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: invalidSignal,
      documentPaths: ["architecture.md"],
      manifest: [{ path: "README.md" }, { path: "src/cache.ts" }],
      availableSubjectSignals: [{ source: "commit", reference: "known-sha" }]
    }),
    [
      "subject cache-lifecycle names unavailable commit signal missing-sha",
      "complete orchestration does not account for captured Git/provider history with a valid subject signal"
    ]
  );
  const wrongSignalType = {
    ...orchestration,
    subjects: [
      {
        ...orchestration.subjects[0]!,
        signals: [{ source: "issue" as const, reference: "known-sha" }]
      }
    ]
  };
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: wrongSignalType,
      documentPaths: ["architecture.md"],
      manifest: [{ path: "README.md" }, { path: "src/cache.ts" }],
      availableSubjectSignals: [{ source: "commit", reference: "known-sha" }]
    }),
    [
      "subject cache-lifecycle names unavailable issue signal known-sha",
      "complete orchestration does not account for captured Git/provider history with a valid subject signal"
    ]
  );
  const accountedHistory = {
    ...orchestration,
    subjects: [
      {
        ...orchestration.subjects[0]!,
        signals: [...orchestration.subjects[0]!.signals, { source: "commit" as const, reference: "known-sha" }]
      }
    ]
  };
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: accountedHistory,
      documentPaths: ["architecture.md"],
      manifest: [{ path: "README.md" }, { path: "src/cache.ts" }],
      availableSubjectSignals: [{ source: "commit", reference: "known-sha" }]
    }),
    []
  );
});

test("complete orchestration requires agent-owned maintenance questions and a context-only critic", () => {
  const withoutReview = { ...orchestration, reviews: [] };
  const unreviewed = contextOrchestrationDiagnostics({
    state: withoutReview,
    documentPaths: ["architecture.md"],
    manifest: [{ path: "README.md" }, { path: "src/cache.ts" }]
  });
  assert.equal(unreviewed.includes("complete orchestration has no completed context-only critic review"), true);
  assert.equal(
    unreviewed.includes("required maintenance question cache-lookup was not tested by a completed critic review"),
    true
  );

  const openQuestion = {
    ...orchestration,
    subjects: [
      {
        ...orchestration.subjects[0]!,
        questions: [{ ...orchestration.subjects[0]!.questions[0]!, status: "open" as const, pageIds: [] }]
      }
    ]
  };
  assert.equal(
    contextOrchestrationDiagnostics({
      state: openQuestion,
      documentPaths: ["architecture.md"],
      manifest: [{ path: "README.md" }, { path: "src/cache.ts" }]
    }).includes("required maintenance question cache-lookup is open"),
    true
  );

  const nonCriticReviewer = {
    ...orchestration,
    workers: orchestration.workers.map((worker) =>
      worker.id === "cache-critic" ? { ...worker, role: "research" as const } : worker
    )
  };
  assert.equal(
    contextOrchestrationDiagnostics({
      state: nonCriticReviewer,
      documentPaths: ["architecture.md"],
      manifest: [{ path: "README.md" }, { path: "src/cache.ts" }]
    }).includes("critic review cache-context-review names non-critic worker cache-critic"),
    true
  );

  const failedLatestReview = {
    ...orchestration,
    gaps: [
      {
        id: "cache-answer-gap",
        severity: "blocking" as const,
        description: "The context does not explain expiry.",
        status: "open" as const
      }
    ],
    reviews: [
      ...orchestration.reviews,
      {
        ...orchestration.reviews[0]!,
        id: "cache-context-review-2",
        results: [
          {
            questionId: "cache-lookup",
            verdict: "fail" as const,
            pageIds: ["architecture"],
            gapIds: ["cache-answer-gap"],
            summary: "The task still requires source reconstruction."
          }
        ]
      }
    ]
  };
  const failedDiagnostics = contextOrchestrationDiagnostics({
    state: failedLatestReview,
    documentPaths: ["architecture.md"],
    manifest: [{ path: "README.md" }, { path: "src/cache.ts" }]
  });
  assert.equal(
    failedDiagnostics.includes("required maintenance question cache-lookup last critic verdict is fail"),
    true
  );
  assert.equal(failedDiagnostics.includes("orchestration has open blocking gap cache-answer-gap"), true);

  const unexercisedPage = {
    ...orchestration,
    reviews: orchestration.reviews.map((review) => ({
      ...review,
      results: review.results.map((result) => ({ ...result, pageIds: [] }))
    }))
  };
  const unexercisedDiagnostics = contextOrchestrationDiagnostics({
    state: unexercisedPage,
    documentPaths: ["architecture.md"],
    manifest: [{ path: "README.md" }, { path: "src/cache.ts" }]
  });
  assert.equal(
    unexercisedDiagnostics.includes("critic review cache-context-review result cache-lookup used no context pages"),
    true
  );
  assert.equal(
    unexercisedDiagnostics.includes(
      "complete orchestration item architecture was not used by a passing context-only critic task"
    ),
    true
  );
});

test("a plan is checkpointed before its first page and restored for retry", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_plan",
    stageId: "cs_plan",
    checkpointId: "ck_plan",
    pages: [],
    orchestration,
    at: "2026-07-28T11:00:00.000Z"
  });
  assert.equal((await store.derivationProgress(TENANT, "cb_plan")).orchestration?.state.phase, "complete");
  assert.equal((await store.derivationProgress(TENANT, "cb_plan")).orchestration?.checkpointSequence, 1);
  assert.equal((await store.derivationOrchestration(TENANT, "cs_plan"))?.items[0]?.id, "architecture");
});

test("a stopped run resumes pending pages without treating them as published", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_1",
    stageId: "cs_1",
    checkpointId: "ck_1",
    pages: [
      {
        documentPath: "architecture",
        title: "Architecture",
        bodyMarkdown: "# Architecture\n\nfirst\n",
        contentDigest: "digest-1",
        validationStatus: "pending",
        diagnostics: []
      }
    ],
    at: "2026-07-28T12:00:00.000Z"
  });

  // The agent rewrites a page it is still working on, so the newest body wins
  // while the moment it first appeared is preserved.
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_1",
    stageId: "cs_1",
    checkpointId: "ck_1",
    pages: [
      {
        documentPath: "architecture",
        title: "Architecture",
        bodyMarkdown: "# Architecture\n\nfirst and second\n",
        contentDigest: "digest-2",
        validationStatus: "pending",
        diagnostics: []
      },
      {
        documentPath: "flows/publish",
        title: "Publish",
        bodyMarkdown: "# Publish\n\nflow\n",
        contentDigest: "digest-3",
        validationStatus: "pending",
        diagnostics: []
      }
    ],
    at: "2026-07-28T12:01:00.000Z"
  });

  // Nothing committed the stage, which is what being stopped looks like: the
  // work is still here to be resumed from.
  const resumable = await store.derivationProgressPages(TENANT, "cs_1");
  assert.deepEqual(resumable.map((page) => page.documentPath).sort(), ["architecture", "flows/publish"]);
  assert.equal(
    resumable.every((page) => page.validationStatus === "pending"),
    true
  );
  assert.equal(resumable.find((page) => page.documentPath === "architecture")?.bodyMarkdown.includes("second"), true);

  const snapshot = await store.derivationProgress(TENANT, "cb_1");
  assert.deepEqual(
    snapshot.pages.map((page) => page.documentPath),
    ["architecture", "flows/publish"]
  );
  assert.equal(snapshot.pages[0]?.firstSeenAt, "2026-07-28T12:00:00.000Z");
  assert.equal(snapshot.pages[0]?.updatedAt, "2026-07-28T12:01:00.000Z");
  assert.equal(snapshot.updatedAt, "2026-07-28T12:01:00.000Z");

  // Once the pages exist as revisions this must stop shadowing the catalog.
  await store.clearDerivationProgress(TENANT, "cs_1");
  assert.deepEqual(await store.derivationProgressPages(TENANT, "cs_1"), []);
  assert.deepEqual((await store.derivationProgress(TENANT, "cb_1")).pages, []);
});

test("an invalid rewrite stays observable without erasing the last resumable page", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_lkg",
    stageId: "cs_lkg",
    checkpointId: "ck_lkg",
    pages: [
      {
        documentPath: "architecture",
        title: "Architecture",
        bodyMarkdown: "# Architecture\n\nresumable body\n",
        contentDigest: "digest-good",
        validationStatus: "pending",
        diagnostics: ["pending review"]
      }
    ],
    at: "2026-07-28T12:00:00.000Z"
  });
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_lkg",
    stageId: "cs_lkg",
    checkpointId: "ck_lkg",
    pages: [
      {
        documentPath: "architecture",
        title: "Broken architecture",
        bodyMarkdown: "# Broken\n\ntruncated",
        contentDigest: "digest-invalid",
        validationStatus: "invalid",
        diagnostics: ["missing citation"]
      }
    ],
    at: "2026-07-28T12:01:00.000Z"
  });

  const visible = await store.derivationProgressPage(TENANT, "cb_lkg", "architecture");
  assert.equal(visible?.validationStatus, "invalid");
  assert.equal(visible?.bodyMarkdown, "# Broken\n\ntruncated");
  assert.deepEqual(visible?.diagnostics, ["missing citation"]);
  assert.equal(visible?.checkpointSequence, 2);

  const resumable = await store.derivationProgressPages(TENANT, "cs_lkg");
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0]?.title, "Architecture");
  assert.equal(resumable[0]?.bodyMarkdown, "# Architecture\n\nresumable body\n");
  assert.equal(resumable[0]?.contentDigest, "digest-good");
  assert.equal(resumable[0]?.validationStatus, "pending");
  assert.deepEqual(resumable[0]?.diagnostics, ["pending review"]);
  assert.equal(resumable[0]?.checkpointSequence, 1);

  await store.clearDerivationProgress(TENANT, "cs_lkg");
  assert.deepEqual(await store.derivationProgressPages(TENANT, "cs_lkg"), []);
});

test("an invalid first candidate is observable but not resumable", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_invalid",
    stageId: "cs_invalid",
    checkpointId: "ck_invalid",
    pages: [
      {
        documentPath: "architecture",
        title: "Broken",
        bodyMarkdown: "# Broken\n",
        validationStatus: "invalid",
        diagnostics: ["invalid"]
      }
    ],
    at: "2026-07-28T12:00:00.000Z"
  });

  assert.equal((await store.derivationProgressPage(TENANT, "cb_invalid", "architecture"))?.validationStatus, "invalid");
  assert.deepEqual(await store.derivationProgressPages(TENANT, "cs_invalid"), []);
});

test("a page can be read before the build that wrote it has committed", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_1",
    stageId: "cs_1",
    checkpointId: "ck_1",
    pages: [{ documentPath: "flows/publish", title: "Publish", bodyMarkdown: "# Publish\n\nthe flow\n" }],
    at: "2026-07-28T12:00:00.000Z"
  });
  // The listing is polled every few seconds and omits bodies, so a page somebody
  // opened is fetched on its own rather than never being readable until commit.
  const page = await store.derivationProgressPage(TENANT, "cb_1", "flows/publish");
  assert.equal(page?.bodyMarkdown.includes("the flow"), true);
  assert.equal(await store.derivationProgressPage(TENANT, "cb_1", "flows/absent"), undefined);
  // Scoped like everything else: another tenant reads nothing.
  assert.equal(
    await store.derivationProgressPage("22222222-2222-4222-8222-222222222222", "cb_1", "flows/publish"),
    undefined
  );
});

test("private derivation checkpoints are stage and tenant scoped and clear with progress", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationPrivateCheckpoint({
    tenantId: TENANT,
    buildId: "cb_private",
    stageId: "cs_private",
    checkpointId: "ck_private",
    artifact: {
      uri: "memory://private",
      key: "tenant/private",
      contentType: "application/octet-stream",
      bytes: 99,
      sha256: "a".repeat(64)
    },
    plaintextDigest: "b".repeat(64),
    bytes: 64,
    at: "2026-07-29T12:00:00.000Z"
  });
  const restored = await store.derivationPrivateCheckpoint(TENANT, "cs_private");
  assert.equal(restored?.artifact.key, "tenant/private");
  assert.equal(restored?.checkpointSequence, 1);
  assert.equal(
    await store.derivationPrivateCheckpoint("22222222-2222-4222-8222-222222222222", "cs_private"),
    undefined
  );
  await store.clearDerivationProgress(TENANT, "cs_private");
  assert.equal(await store.derivationPrivateCheckpoint(TENANT, "cs_private"), undefined);
});

test("one tenant cannot watch another tenant's build", async () => {
  const store = new MemoryContextEngineStore();
  await store.recordDerivationProgress({
    tenantId: TENANT,
    buildId: "cb_1",
    stageId: "cs_1",
    checkpointId: "ck_1",
    pages: [{ documentPath: "architecture", title: "Architecture", bodyMarkdown: "# Architecture\n" }],
    at: "2026-07-28T12:00:00.000Z"
  });
  const other = await store.derivationProgress("22222222-2222-4222-8222-222222222222", "cb_1");
  assert.deepEqual(other.pages, []);
});
