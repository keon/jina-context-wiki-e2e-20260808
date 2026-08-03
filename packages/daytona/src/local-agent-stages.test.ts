import assert from "node:assert/strict";
import { test } from "node:test";
import {
  citationAuditRepairPrompt,
  citationAuditCertificationDiagnostic,
  criticStagePrompt,
  DOCUMENTATION_STAGE_SCHEMA,
  documentationPageWorkUnits,
  documentationPlannerPrompt,
  documentationPlannerRepairPrompt,
  documentationWriterPrompt,
  parseCitationAuditStageResult,
  parseCriticStageResult,
  parseDocumentationStagePlan,
  parseResearchStagePlan,
  parseSourceChallengeStageResult,
  reconcileCriticStageResult,
  RESEARCH_STAGE_SCHEMA,
  researchPlannerPrompt,
  researchWorkerPrompt,
  researchPlannerRepairPrompt,
  sourceChallengePromotionDiagnostics,
  sourceChallengeStagePrompt,
  sourceChallengeValidationRepairPrompt
} from "./local-agent-stages.js";

test("citation repairs stay page-scoped and request minimal edits", () => {
  const prompt = citationAuditRepairPrompt({
    repositoryDirectory: "/checkpoint/repository",
    outputDirectory: "/work/public",
    auditInputPath: "/work/audit-input.json",
    auditResultPath: "/work/audit-result.json",
    unsupportedCitationIds: ["citation-1"]
  });

  assert.match(prompt, /bounded source-aware citation repair stage/);
  assert.match(prompt, /smallest edit that fully grounds each exact claimSpan/);
  assert.match(prompt, /declaration but not its use/);
  assert.match(prompt, /Do not leave a rejected target and claim span effectively unchanged/);
  assert.match(prompt, /do not change any other citation/i);
  assert.match(prompt, /VALID:.*Webhook payloads are verified before parsing/);
  assert.match(prompt, /INVALID:.*webhook handler/);
  assert.match(prompt, /additional\/0/);
  assert.match(prompt, /exact case-sensitive path present in the checkpoint snapshot manifest/);
  assert.match(prompt, /natural immutable provider URL/);
  assert.doesNotMatch(prompt, /Own the workflow/i);
  assert.doesNotMatch(prompt, /repository-wide subject discovery/i);
});

test("documentation writers receive the same rendered citation and relevant-history contract", () => {
  const page = {
    id: "architecture",
    path: "architecture.md",
    title: "Architecture",
    purpose: "Explain the runtime.",
    sourceAssignmentIds: ["runtime"],
    maintenanceQuestions: ["How did the current runtime become active?"],
    coverageAreas: ["root"],
    requiredTopics: ["current runtime", "relevant history"],
    historySignalIds: ["runtime-migration"],
    diagram: "architecture" as const,
    dependencies: [],
    change: "add" as const
  };
  const writer = { id: "writer-runtime", objective: "Document the runtime.", pageIds: [page.id] };
  const prompt = documentationWriterPrompt({
    repository: "example/service",
    repositoryDirectory: "/checkpoint/repository",
    outputDirectory: "/work/context",
    writer,
    plan: {
      version: 1,
      hierarchyRationale: "One page explains this fixture.",
      pages: [page],
      writers: [writer],
      retainedHistorySignals: [
        {
          id: "runtime-migration",
          source: "commit",
          providerUrl: "https://github.com/example/service/commit/abcdef1234567890",
          factualPremise: "The commit activated the current runtime.",
          relevanceScore: 95,
          relevanceReason: "The deployed entrypoint still uses the migrated runtime."
        }
      ],
      excludedAreas: [],
      retiredPages: []
    },
    researchPackets: {
      runtime: "Commit https://github.com/example/service/commit/abcdef explains the current runtime migration."
    }
  });

  assert.match(prompt, /Rendered-Markdown citation binding is exact/);
  assert.match(prompt, /INVALID:.*separate assertion/);
  assert.match(prompt, /parenthetical source list creates separate label claims/);
  assert.match(prompt, /additional\/0/);
  assert.match(prompt, /provider URL inside the consequential history assertion/);
  assert.match(prompt, /repository file link does not establish that a historical event occurred/i);
  assert.match(prompt, /one decisive evidence link in a substantive section/);
  assert.match(prompt, /Do not cite every sentence, every supporting detail, or every table row/);
  assert.match(prompt, /avoid repeating the same target in every row/);
  assert.match(prompt, /every planned dependency is present as a relative context link/);
  assert.match(prompt, /Do not guess a line number/);
  assert.match(prompt, /every historySignalIds entry/);
  assert.match(prompt, /Issue evidence must appear when an issue signal is mapped/);
  assert.match(prompt, /Exact host-validated retained history signals mapped to owned pages/);
  assert.match(prompt, /https:\/\/github\.com\/example\/service\/commit\/abcdef1234567890/);
  assert.match(prompt, /separate uncited pure maintenance question/);
  assert.match(prompt, /INVALID:.*unsupported normative question/);
});

test("source challengers must return public manifest paths instead of checkout aliases", () => {
  const prompt = sourceChallengeStagePrompt({
    workerId: "source-challenge",
    repository: "example/service",
    repositoryDirectory: "/checkpoint/repository/work",
    evidencePath: "/checkpoint/evidence.json",
    repositoryInventory: { areas: ["root"], paths: ["src/server.ts"] },
    researchPlan: {} as never,
    researchPackets: {},
    existingTasks: [],
    publicContext: "# Context",
    inputDigest: "a".repeat(64),
    publicSnapshotDigest: "b".repeat(64)
  });

  assert.match(prompt, /exact case-sensitive value from repositoryInventory.paths/);
  assert.match(prompt, /repository\/work\//);
  assert.match(prompt, /additional\/0\//);
  assert.match(prompt, /must never contain the checkpoint mount prefix/);
  assert.match(prompt, /only when the public Context cannot already support that maintenance work/);
  assert.match(prompt, /repository lacks a proposed implementation or focused regression test/);
  assert.match(prompt, /Judge documentation sufficiency/);
});

test("source challenge validation repair is bounded to the rejected structured result", () => {
  const prompt = sourceChallengeValidationRepairPrompt({
    workerId: "source-challenge-3",
    repositoryDirectory: "/checkpoint/repository",
    evidencePath: "/checkpoint/evidence.json",
    repositoryPaths: ["src/server.ts"],
    existingSubjectIds: ["runtime-request-lifecycle"],
    inputDigest: "a".repeat(64),
    publicSnapshotDigest: "b".repeat(64),
    diagnostic: "evidence reference is not a checkpoint repository path: access-service.md",
    previousResult: { worker: { id: "source-challenge-3" } }
  });

  assert.match(prompt, /Preserve every valid field and change only what deterministic validation rejected/);
  assert.match(prompt, /Generated Context page paths are not repository evidence/);
  assert.match(prompt, /src\/server\.ts/);
  assert.match(prompt, /runtime-request-lifecycle/);
  assert.match(prompt, /document path, page title, or newly paraphrased slug is not an existing subject ID/i);
  assert.match(prompt, /access-service\.md/);
  assert.match(prompt, /source-challenge-3/);
  assert.match(prompt, new RegExp("a{64}"));
  assert.match(prompt, new RegExp("b{64}"));
  assert.match(prompt, /host-owned identity fields are immutable/);
});

test("research plans retain typed relevance-scored provider history without reconstructed links", () => {
  assert.ok(RESEARCH_STAGE_SCHEMA.properties.assignments.items.required.includes("retainedHistorySignals"));
  const plan = parseResearchStagePlan({
    version: 1,
    repositorySummary: "A service and client workspace.",
    assignments: [
      {
        id: "request-flow",
        objective: "Trace request execution.",
        focusPaths: ["apps/api", "packages/client"],
        questions: ["Where does validation occur?"],
        reason: "The manifest shows an API boundary.",
        retainedHistorySignals: [
          {
            id: "request-validation-issue",
            source: "issue",
            providerUrl: "https://github.com/example/service/issues/42",
            factualPremise: "Issue 42 requested validation before persistence.",
            relevanceScore: 88,
            relevanceReason: "Current validation source implements the boundary discussed by the captured issue."
          }
        ]
      }
    ]
  });

  assert.deepEqual(plan.assignments[0]?.retainedHistorySignals, [
    {
      id: "request-validation-issue",
      source: "issue",
      providerUrl: "https://github.com/example/service/issues/42",
      factualPremise: "Issue 42 requested validation before persistence.",
      relevanceScore: 88,
      relevanceReason: "Current validation source implements the boundary discussed by the captured issue."
    }
  ]);
  const observationPlan = parseResearchStagePlan({
    ...plan,
    assignments: [
      {
        ...plan.assignments[0],
        retainedHistorySignals: [
          {
            id: "review-observation",
            source: "observation",
            providerUrl: "https://github.com/example/service/pull/42#discussion_r123",
            factualPremise: "The captured review comment identified the retry boundary.",
            relevanceScore: 72,
            relevanceReason: "Current retry code still exposes the reviewed boundary."
          }
        ]
      }
    ]
  });
  assert.equal(observationPlan.assignments[0]?.retainedHistorySignals?.[0]?.source, "observation");
  assert.throws(
    () =>
      parseResearchStagePlan({
        ...plan,
        assignments: [
          {
            ...plan.assignments[0],
            retainedHistorySignals: [
              {
                ...plan.assignments[0]!.retainedHistorySignals![0],
                providerUrl: "https://github.com/example/service/pull/42"
              }
            ]
          }
        ]
      }),
    /does not match its issue signal source/
  );
  assert.throws(
    () =>
      parseResearchStagePlan({
        ...plan,
        assignments: [
          plan.assignments[0],
          {
            ...plan.assignments[0],
            id: "duplicate-signal-owner"
          }
        ]
      }),
    /retained history signal id is duplicated/
  );

  const plannerPrompt = researchPlannerPrompt({
    repository: "example/service",
    repositoryDirectory: "/checkpoint/repository",
    manifestPath: "/inputs/manifest.json",
    evidencePath: "/inputs/evidence.json",
    repositoryAreas: ["apps", "packages", "root"]
  });
  assert.match(plannerPrompt, /\["apps","packages","root"\]/);
  assert.match(plannerPrompt, /typed relevance-scored inventory/);
  assert.match(plannerPrompt, /never construct a URL/);
  assert.match(plannerPrompt, /Use captured issue evidence/);
  assert.match(plannerPrompt, /does not by itself prove the current implementation, causation, resolution/);

  const workerPrompt = researchWorkerPrompt({
    repository: "example/service",
    repositoryDirectory: "/checkpoint/repository",
    evidencePath: "/inputs/evidence.json",
    assignment: plan.assignments[0]
  });
  assert.match(workerPrompt, /request-validation-issue/);
  assert.match(workerPrompt, /Retained history signal accounting/);
  assert.match(workerPrompt, /never infer that an issue was implemented or fixed/);
});

test("research assignments are dynamic, bounded, and uniquely identified", () => {
  const plan = parseResearchStagePlan({
    version: 1,
    repositorySummary: "A service and client workspace.",
    assignments: [
      {
        id: "request-flow",
        objective: "Trace request execution.",
        focusPaths: ["apps/api", "packages/client"],
        questions: ["Where does validation occur?"],
        reason: "The manifest shows an API boundary."
      }
    ]
  });
  assert.equal(plan.assignments[0]?.id, "request-flow");
  assert.throws(
    () =>
      parseResearchStagePlan({
        ...plan,
        assignments: [plan.assignments[0], plan.assignments[0]]
      }),
    /duplicated/
  );
});

test("publication plans map or explicitly exclude every retained history signal exactly once", () => {
  const researchAssignments = [
    {
      id: "runtime",
      objective: "Explain the runtime evolution.",
      focusPaths: ["src"],
      questions: ["How did retry ownership evolve?"],
      reason: "Captured provider records describe a migration.",
      retainedHistorySignals: [
        {
          id: "retry-migration",
          source: "commit" as const,
          providerUrl: "https://github.com/example/service/commit/abcdef1234567890",
          factualPremise: "The commit moved retry ownership into the worker.",
          relevanceScore: 96,
          relevanceReason: "The active worker still owns the cited retry path."
        },
        {
          id: "stale-proposal",
          source: "pull_request" as const,
          providerUrl: "https://github.com/example/service/pull/9",
          factualPremise: "Pull request 9 proposed an alternate retry loop.",
          relevanceScore: 55,
          relevanceReason: "The proposal is adjacent to the current retry subject."
        }
      ]
    }
  ];
  const page = {
    id: "architecture",
    path: "architecture.md",
    title: "Architecture",
    purpose: "Explain the active runtime.",
    sourceAssignmentIds: ["runtime"],
    maintenanceQuestions: ["How did retry ownership evolve?"],
    coverageAreas: ["root"],
    requiredTopics: ["runtime", "retry ownership"],
    historySignalIds: ["retry-migration"],
    diagram: "architecture",
    dependencies: []
  };
  const candidate = {
    version: 1,
    hierarchyRationale: "One subject page owns the material migration.",
    pages: [page],
    writers: [{ id: "writer-runtime", objective: "Explain the runtime.", pageIds: ["architecture"] }],
    excludedAreas: [],
    excludedHistorySignals: [
      {
        historySignalId: "stale-proposal",
        reason:
          "Current source and the research packet show that the unmerged proposal is not an active runtime decision."
      }
    ]
  };

  const parsed = parseDocumentationStagePlan(candidate, {
    researchAssignments,
    repositoryAreas: ["root"]
  });
  assert.deepEqual(parsed.pages[0]?.historySignalIds, ["retry-migration"]);
  assert.deepEqual(
    parsed.retainedHistorySignals?.map((signal) => signal.id),
    ["retry-migration", "stale-proposal"]
  );
  assert.deepEqual(parsed.excludedHistorySignals, candidate.excludedHistorySignals);
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        { ...candidate, excludedHistorySignals: [] },
        { researchAssignments, repositoryAreas: ["root"] }
      ),
    /stale-proposal is neither mapped nor explicitly excluded/
  );
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        {
          ...candidate,
          excludedHistorySignals: [
            ...candidate.excludedHistorySignals,
            { historySignalId: "retry-migration", reason: "Exclude it too." }
          ]
        },
        { researchAssignments, repositoryAreas: ["root"] }
      ),
    /retry-migration is both mapped and excluded/
  );
});

test("research and criticism distinguish deployed paths from code that merely exists", () => {
  const research = researchWorkerPrompt({
    repository: "example/service",
    repositoryDirectory: "/checkpoint/repository",
    evidencePath: "/inputs/evidence.json",
    assignment: {
      id: "runtime",
      objective: "Identify the active runtime.",
      focusPaths: ["src"],
      questions: ["Which path is deployed?"],
      reason: "Several implementations coexist."
    }
  });
  const critic = criticStagePrompt({
    workerId: "critic-runtime",
    publicContext: "# Runtime\n",
    questions: "Which path is deployed?",
    snapshotDigest: "a".repeat(64),
    taskCatalogDigest: "b".repeat(64)
  });

  for (const prompt of [research, critic]) {
    assert.match(prompt, /production entrypoint/);
    assert.match(prompt, /local\/test harnesses/);
    assert.match(prompt, /legacy/);
  }
  assert.match(critic, /outside the captured evidence boundary/);
  assert.match(critic, /authoritative provider or control plane/);
  assert.match(critic, /safe decision for each outcome/);
  assert.match(critic, /Judge Context sufficiency/);
  assert.match(critic, /Do not mark it partial merely because/);
  assert.match(critic, /exact same deduplicated pageIds array/);
  assert.match(critic, /not a generated copy of the repository or an exhaustive API\/configuration reference/);
  assert.match(critic, /Missing convenience enumeration/);
});

test("research plan repair receives the rejected candidate, exact diagnostic, and original inputs", () => {
  const prompt = researchPlannerRepairPrompt({
    repository: "acme/service",
    repositoryDirectory: "/checkpoint/repository",
    manifestPath: "/work/repository-manifest.json",
    evidencePath: "/work/evidence.json",
    repositoryAreas: ["apps", "root"],
    invalidPlan: '{"version":1,"assignments":[]}',
    diagnostic: "research plan does not cover repository areas: apps/api"
  });
  assert.match(prompt, /research plan does not cover repository areas: apps\/api/);
  assert.match(prompt, /\/checkpoint\/repository/);
  assert.match(prompt, /\/work\/repository-manifest\.json/);
  assert.match(prompt, /\/work\/evidence\.json/);
  assert.match(prompt, /\["apps","root"\]/);
  assert.match(prompt, /\{"version":1,"assignments":\[\]\}/);
  assert.match(prompt, /repository-relative file\/directory prefix/);
});

test("documentation plans preserve research questions, areas, and exclusive writer ownership", () => {
  const researchAssignments = [
    {
      id: "request-flow",
      objective: "Trace request execution.",
      focusPaths: ["apps/api"],
      questions: ["Where does validation occur?"],
      reason: "The manifest shows an API boundary."
    }
  ];
  const plan = parseDocumentationStagePlan(
    {
      version: 1,
      hierarchyRationale: "Overview links to a focused request-flow page.",
      pages: [
        {
          id: "architecture",
          path: "architecture.md",
          title: "Architecture",
          purpose: "Orient a maintainer.",
          sourceAssignmentIds: ["request-flow"],
          maintenanceQuestions: ["Where does validation occur?"],
          coverageAreas: ["root"],
          requiredTopics: ["system boundary"],
          diagram: "architecture",
          dependencies: ["request-flow"]
        },
        {
          id: "request-flow",
          path: "flows/request-flow.md",
          title: "Request flow",
          purpose: "Explain request validation.",
          sourceAssignmentIds: ["request-flow"],
          maintenanceQuestions: ["Where does validation occur?"],
          coverageAreas: ["apps", "apps/api"],
          requiredTopics: ["validation", "tests"],
          diagram: "sequence",
          dependencies: []
        }
      ],
      writers: [
        {
          id: "writer-platform",
          objective: "Write the platform pages.",
          pageIds: ["architecture", "request-flow"]
        }
      ],
      excludedAreas: []
    },
    {
      researchAssignments,
      repositoryAreas: ["root", "apps", "apps/api"]
    }
  );
  assert.equal(plan.pages.length, 2);
  assert.deepEqual(
    documentationPageWorkUnits(plan).map((unit) => ({
      id: unit.id,
      pageId: unit.pageId,
      path: unit.path,
      sourceWriterId: unit.sourceWriterId
    })),
    [
      {
        id: "page-architecture",
        pageId: "architecture",
        path: "architecture.md",
        sourceWriterId: "writer-platform"
      },
      {
        id: "page-request-flow",
        pageId: "request-flow",
        path: "flows/request-flow.md",
        sourceWriterId: "writer-platform"
      }
    ]
  );
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        {
          ...plan,
          pages: plan.pages.map((page) => ({ ...page, maintenanceQuestions: ["A different question?"] }))
        },
        { researchAssignments, repositoryAreas: ["root", "apps", "apps/api"] }
      ),
    /research maintenance question is absent/
  );
});

test("incremental documentation plans explicitly account for every prior page", () => {
  const researchAssignments = [
    {
      id: "platform",
      objective: "Trace platform changes.",
      focusPaths: ["src"],
      questions: ["How did the platform change?"],
      reason: "The provider frontier advanced."
    }
  ];
  const priorPages = ["architecture.md", "components/api.md", "runbooks/legacy.md"].map((documentPath) => ({
    logicalId: `prior:${documentPath}`,
    documentPath,
    title: documentPath,
    bodyMarkdown: `# ${documentPath}\n\nPrior context.\n`,
    bodySha256: "a".repeat(64),
    revisionId: `kr_${documentPath}`
  }));
  const candidate = {
    version: 1,
    hierarchyRationale: "Retain the overview, revise the API, and add operations.",
    pages: [
      {
        id: "architecture",
        path: "architecture.md",
        title: "Architecture",
        purpose: "Orient maintainers.",
        sourceAssignmentIds: ["platform"],
        maintenanceQuestions: ["How did the platform change?"],
        coverageAreas: ["root"],
        requiredTopics: ["boundaries"],
        diagram: "architecture",
        dependencies: [],
        change: "retain"
      },
      {
        id: "api",
        path: "components/api.md",
        title: "API",
        purpose: "Explain the changed API.",
        sourceAssignmentIds: ["platform"],
        maintenanceQuestions: ["How did the platform change?"],
        coverageAreas: ["src"],
        requiredTopics: ["request flow"],
        diagram: "sequence",
        dependencies: ["architecture"],
        change: "revise"
      },
      {
        id: "deploy",
        path: "operations/deploy.md",
        title: "Deployment",
        purpose: "Explain deployment.",
        sourceAssignmentIds: ["platform"],
        maintenanceQuestions: ["How did the platform change?"],
        coverageAreas: ["src"],
        requiredTopics: ["deployment"],
        diagram: "none",
        dependencies: ["architecture"],
        change: "add"
      }
    ],
    writers: [
      {
        id: "writer-platform",
        objective: "Maintain platform context.",
        pageIds: ["architecture", "api", "deploy"]
      }
    ],
    excludedAreas: [],
    retiredPages: [{ path: "runbooks/legacy.md", reason: "The legacy worker was removed." }]
  };

  const parsed = parseDocumentationStagePlan(candidate, {
    researchAssignments,
    repositoryAreas: ["root", "src"],
    priorPages
  });
  assert.deepEqual(
    parsed.pages.map(({ path, change }) => [path, change]),
    [
      ["architecture.md", "retain"],
      ["components/api.md", "revise"],
      ["operations/deploy.md", "add"]
    ]
  );
  assert.deepEqual(parsed.retiredPages, candidate.retiredPages);
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        { ...candidate, retiredPages: [] },
        { researchAssignments, repositoryAreas: ["root", "src"], priorPages }
      ),
    /silently drops prior pages: runbooks\/legacy\.md/
  );
});

test("documentation dependency paths normalize to exact page ids", () => {
  const researchAssignments = [
    {
      id: "request-flow",
      objective: "Trace request execution.",
      focusPaths: ["apps/api"],
      questions: ["Where does validation occur?"],
      reason: "The manifest shows an API boundary."
    }
  ];
  const plan = parseDocumentationStagePlan(
    {
      version: 1,
      hierarchyRationale: "Overview links to a focused request-flow page.",
      pages: [
        {
          id: "architecture",
          path: "architecture.md",
          title: "Architecture",
          purpose: "Orient a maintainer.",
          sourceAssignmentIds: ["request-flow"],
          maintenanceQuestions: ["Where does validation occur?"],
          coverageAreas: ["root"],
          requiredTopics: ["system boundary"],
          diagram: "architecture",
          dependencies: ["flows/request-flow.md"]
        },
        {
          id: "request-flow",
          path: "flows/request-flow.md",
          title: "Request flow",
          purpose: "Explain request validation.",
          sourceAssignmentIds: ["request-flow"],
          maintenanceQuestions: ["Where does validation occur?"],
          coverageAreas: ["apps/api"],
          requiredTopics: ["validation", "tests"],
          diagram: "sequence",
          dependencies: ["architecture.md"]
        }
      ],
      writers: [
        {
          id: "writer-platform",
          objective: "Write the platform pages.",
          pageIds: ["architecture", "request-flow"]
        }
      ],
      excludedAreas: []
    },
    { researchAssignments, repositoryAreas: ["root", "apps/api"] }
  );

  assert.deepEqual(
    plan.pages.map((page) => page.dependencies),
    [["request-flow"], ["architecture"]]
  );
  assert.deepEqual(
    documentationPageWorkUnits(plan).map((unit) => unit.dependencies),
    [["request-flow"], ["architecture"]]
  );
});

test("documentation dependencies reject unknown, self, and ambiguous path references", () => {
  const researchAssignments = [
    {
      id: "platform",
      objective: "Explain the platform.",
      focusPaths: ["src"],
      questions: ["How is the platform maintained?"],
      reason: "It is the fixture boundary."
    }
  ];
  const architecture = {
    id: "architecture",
    path: "architecture.md",
    title: "Architecture",
    purpose: "Explain the platform.",
    sourceAssignmentIds: ["platform"],
    maintenanceQuestions: ["How is the platform maintained?"],
    coverageAreas: ["root"],
    requiredTopics: ["platform"],
    diagram: "architecture",
    dependencies: [] as string[]
  };
  const candidate = {
    version: 1,
    hierarchyRationale: "One page is sufficient for the fixture.",
    pages: [architecture],
    writers: [{ id: "writer-platform", objective: "Write the platform page.", pageIds: ["architecture"] }],
    excludedAreas: []
  };
  const expected = { researchAssignments, repositoryAreas: ["root"] };

  assert.throws(
    () =>
      parseDocumentationStagePlan(
        { ...candidate, pages: [{ ...architecture, dependencies: ["missing.md"] }] },
        expected
      ),
    /depends on unknown page missing\.md/
  );
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        { ...candidate, pages: [{ ...architecture, dependencies: ["architecture"] }] },
        expected
      ),
    /depends on itself/
  );
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        { ...candidate, pages: [{ ...architecture, dependencies: ["architecture.md"] }] },
        expected
      ),
    /depends on itself/
  );
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        {
          ...candidate,
          pages: [
            architecture,
            {
              ...architecture,
              id: "duplicate-path",
              dependencies: ["architecture.md"]
            }
          ],
          writers: [
            {
              id: "writer-platform",
              objective: "Write both pages.",
              pageIds: ["architecture", "duplicate-path"]
            }
          ]
        },
        expected
      ),
    /path is duplicated/
  );
});

test("documentation planner contracts identify dependencies as exact page ids", () => {
  assert.ok(DOCUMENTATION_STAGE_SCHEMA.required.includes("retiredPages"));
  assert.ok(DOCUMENTATION_STAGE_SCHEMA.required.includes("excludedHistorySignals"));
  assert.ok(DOCUMENTATION_STAGE_SCHEMA.properties.pages.items.required.includes("change"));
  assert.ok(DOCUMENTATION_STAGE_SCHEMA.properties.pages.items.required.includes("historySignalIds"));
  assert.match(
    DOCUMENTATION_STAGE_SCHEMA.properties.pages.items.properties.dependencies.description,
    /exactly equal the id of another entry in pages/
  );
  const researchPlan = {
    version: 1 as const,
    repositorySummary: "A small service.",
    assignments: [
      {
        id: "platform",
        objective: "Explain the service.",
        focusPaths: ["src"],
        questions: ["How is the service maintained?"],
        reason: "It is the repository boundary."
      }
    ]
  };
  const prompt = documentationPlannerPrompt({
    repository: "example/service",
    repositoryAreas: ["root"],
    researchPlan,
    researchPackets: { platform: "Evidence." }
  });
  const repairPrompt = documentationPlannerRepairPrompt({
    repository: "example/service",
    repositoryAreas: ["root"],
    researchPlan,
    invalidPlan: "{}",
    diagnostic: "dependency architecture.md is unknown"
  });

  assert.match(prompt, /exact stable id of another object in pages/);
  assert.match(prompt, /use "architecture", not the Markdown path "architecture\.md"/);
  assert.match(prompt, /Set change to add on every page/);
  assert.match(prompt, /retiredPages as an empty array/);
  assert.match(prompt, /every retainedHistorySignals entry.*exactly once/);
  assert.match(prompt, /historySignalIds/);
  assert.match(prompt, /excludedHistorySignals/);
  assert.match(repairPrompt, /exactly equal the stable id of another object in pages/);
  assert.match(repairPrompt, /do not create self-dependencies/);
  assert.match(repairPrompt, /complete retained-history accounting/);
  assert.match(repairPrompt, /Set change to add on every page/);
});

test("documentation plans bound each writer while allowing enough specialists for a deep hierarchy", () => {
  const researchAssignments = [
    {
      id: "platform",
      objective: "Explain the platform.",
      focusPaths: ["packages/platform"],
      questions: ["How is the platform maintained?"],
      reason: "The platform has several independently maintained subjects."
    }
  ];
  const pages = Array.from({ length: 5 }, (_, index) => ({
    id: index === 0 ? "architecture" : `subject-${index}`,
    path: index === 0 ? "architecture.md" : `subjects/subject-${index}.md`,
    title: index === 0 ? "Architecture" : `Subject ${index}`,
    purpose: "Explain one independently maintained platform subject.",
    sourceAssignmentIds: ["platform"],
    maintenanceQuestions: ["How is the platform maintained?"],
    coverageAreas: ["root"],
    requiredTopics: ["maintenance"],
    diagram: index === 0 ? "architecture" : "none",
    dependencies: []
  }));
  const candidate = {
    version: 1,
    hierarchyRationale: "Five independently checkpointable pages.",
    pages,
    writers: [
      {
        id: "writer-overloaded",
        objective: "Write every page.",
        pageIds: pages.map((page) => page.id)
      }
    ],
    excludedAreas: []
  };
  assert.throws(
    () => parseDocumentationStagePlan(candidate, { researchAssignments, repositoryAreas: ["root"] }),
    /owns more than 4 pages/
  );
  const parsed = parseDocumentationStagePlan(
    {
      ...candidate,
      writers: pages.map((page, index) => ({
        id: `writer-subject-${index}`,
        objective: `Write ${page.title}.`,
        pageIds: [page.id]
      }))
    },
    { researchAssignments, repositoryAreas: ["root"] }
  );
  assert.equal(parsed.writers.length, 5);
});

test("documentation coverage annotations normalize to the longest deterministic ancestor", () => {
  const researchAssignments = [
    {
      id: "context-runtime",
      objective: "Trace context runtime behavior.",
      focusPaths: ["packages/context-engine/src/derive"],
      questions: ["How is context derived?"],
      reason: "It is a maintenance boundary."
    }
  ];
  const candidate = {
    version: 1,
    hierarchyRationale: "One focused page covers the small fixture.",
    pages: [
      {
        id: "architecture",
        path: "architecture.md",
        title: "Architecture",
        purpose: "Explain context derivation.",
        sourceAssignmentIds: ["context-runtime"],
        maintenanceQuestions: ["How is context derived?"],
        coverageAreas: ["root", "packages/context-engine/src/derive/service.ts"],
        requiredTopics: ["Derivation"],
        diagram: "architecture",
        dependencies: []
      }
    ],
    writers: [
      {
        id: "writer-context",
        objective: "Write context documentation.",
        pageIds: ["architecture"]
      }
    ],
    excludedAreas: []
  };

  const parsed = parseDocumentationStagePlan(candidate, {
    researchAssignments,
    repositoryAreas: ["packages/context-engine", "root"]
  });
  assert.deepEqual(parsed.pages[0]?.coverageAreas, ["root", "packages/context-engine"]);
  assert.throws(
    () =>
      parseDocumentationStagePlan(
        {
          ...candidate,
          pages: [{ ...candidate.pages[0], coverageAreas: ["root", "packages"] }]
        },
        {
          researchAssignments,
          repositoryAreas: ["packages", "packages/context-engine", "root"]
        }
      ),
    /packages\/context-engine is neither covered nor explicitly excluded/
  );
});

test("critic results bind their worker and require gaps for non-passing tasks", () => {
  const result = {
    snapshotDigest: "a".repeat(64),
    taskCatalogDigest: "b".repeat(64),
    worker: { id: "critic-pass-1", summary: "One missing invariant." },
    review: {
      id: "review-1",
      kind: "context_only",
      status: "complete",
      reviewer: "subagent",
      workerId: "critic-pass-1",
      results: [
        {
          questionId: "change-request",
          verdict: "partial",
          pageIds: ["request-flow"],
          gapIds: ["request-invariant"],
          summary: "The flow is present but its transaction invariant is absent."
        }
      ],
      summary: "Repair the transaction invariant."
    },
    gaps: [
      {
        id: "request-invariant",
        severity: "blocking",
        description: "Explain the transaction boundary.",
        status: "open"
      }
    ],
    attempts: [
      {
        questionId: "change-request",
        pageIds: ["request-flow"],
        headings: ["Request lifecycle"],
        entrypoints: ["createRequest"],
        importantSymbols: ["RequestState"],
        changePlan: ["Update validation before persistence."],
        controlFlow: [],
        state: [],
        invariants: [],
        configuration: [],
        verification: ["Run the request flow test."],
        failureTriage: [],
        blockingUnknowns: ["The transaction invariant is undocumented."]
      }
    ]
  };
  assert.equal(
    parseCriticStageResult(result, "critic-pass-1", {
      snapshotDigest: "a".repeat(64),
      taskCatalogDigest: "b".repeat(64),
      questionIds: ["change-request"]
    }).review.results[0]?.verdict,
    "partial"
  );
  assert.throws(
    () =>
      parseCriticStageResult(
        {
          ...result,
          review: {
            ...result.review,
            results: [{ ...result.review.results[0], gapIds: [] }]
          }
        },
        "critic-pass-1"
      ),
    /requires a gap/
  );
  assert.throws(
    () =>
      parseCriticStageResult(
        {
          ...result,
          gaps: [{ ...result.gaps[0], severity: "urgent" }]
        },
        "critic-pass-1"
      ),
    /gaps\[0\]\.severity is invalid/
  );
  assert.throws(
    () =>
      parseCriticStageResult(
        {
          ...result,
          review: {
            ...result.review,
            results: [{ ...result.review.results[0], gapIds: ["unknown-gap"] }]
          }
        },
        "critic-pass-1"
      ),
    /references unknown gap unknown-gap/
  );
  assert.throws(
    () =>
      parseCriticStageResult(
        {
          ...result,
          review: {
            ...result.review,
            results: [
              {
                ...result.review.results[0],
                verdict: "pass",
                gapIds: []
              }
            ]
          },
          gaps: [],
          attempts: [
            {
              ...result.attempts[0],
              blockingUnknowns: []
            }
          ]
        },
        "critic-pass-1",
        {
          snapshotDigest: "a".repeat(64),
          taskCatalogDigest: "b".repeat(64),
          questionIds: ["change-request"],
          requiredAnswerPartsByQuestionId: {
            "change-request": ["control_flow"]
          }
        }
      ),
    /has no required control_flow/
  );
});

test("critic reconciliation repairs redundant bookkeeping without upgrading verdicts", () => {
  const expected = {
    snapshotDigest: "a".repeat(64),
    taskCatalogDigest: "b".repeat(64),
    questionIds: ["task-123"],
    requiredAnswerPartsByQuestionId: { "task-123": ["control_flow" as const] }
  };
  const raw = {
    snapshotDigest: "wrong",
    taskCatalogDigest: "wrong",
    worker: { id: "wrong", summary: "Checked the task." },
    review: {
      id: "review-1",
      kind: "context_only",
      status: "complete",
      reviewer: "subagent",
      workerId: "wrong",
      results: [
        {
          questionId: "task- 123",
          verdict: "pass",
          pageIds: ["architecture"],
          gapIds: [],
          summary: "The answer is incomplete."
        },
        {
          questionId: "task-123",
          verdict: "partial",
          pageIds: ["operations"],
          gapIds: ["gap- 1"],
          summary: "Control flow is missing."
        }
      ],
      summary: "One gap remains."
    },
    gaps: [
      { id: "gap-1", severity: "advisory", description: "Missing detail.", status: "open" },
      { id: "gap- 1", severity: "blocking", description: "Missing control flow.", status: "open" }
    ],
    attempts: [
      {
        questionId: "task-123",
        pageIds: ["operations"],
        headings: ["Operations"],
        entrypoints: ["start"],
        importantSymbols: ["Service"],
        changePlan: ["Update the service."],
        controlFlow: [],
        state: [],
        invariants: [],
        configuration: [],
        verification: ["Run tests."],
        failureTriage: [],
        blockingUnknowns: ["Control flow is missing."]
      },
      {
        questionId: "task-unattached",
        pageIds: [],
        headings: [],
        entrypoints: [],
        importantSymbols: [],
        changePlan: [],
        controlFlow: [],
        state: [],
        invariants: [],
        configuration: [],
        verification: [],
        failureTriage: [],
        blockingUnknowns: []
      }
    ]
  };

  const reconciled = reconcileCriticStageResult(raw, "critic-pass-1", expected);
  const parsed = parseCriticStageResult(reconciled.value, "critic-pass-1", expected);
  assert.equal(parsed.review.results.length, 1);
  assert.equal(parsed.review.results[0]?.verdict, "partial");
  assert.deepEqual(parsed.review.results[0]?.pageIds, ["architecture", "operations"]);
  assert.deepEqual(parsed.attempts[0]?.pageIds, ["architecture", "operations"]);
  assert.equal(parsed.attempts.length, 1);
  assert.equal(parsed.gaps.length, 1);
  assert.equal(parsed.gaps[0]?.severity, "blocking");
  assert.ok(reconciled.corrections.length >= 5);
});

test("source challenges preserve existing ids and add distinct evidence-backed maintenance tasks", () => {
  const challenge = {
    version: 1,
    inputDigest: "c".repeat(64),
    publicSnapshotDigest: "d".repeat(64),
    worker: {
      id: "source-challenge",
      summary: "The draft omitted retry ownership."
    },
    acceptedTaskIds: ["change-request"],
    addedTasks: [
      {
        id: "challenge-debug-retry-owner",
        subjectId: "retry-ownership",
        subjectKind: "flow",
        subjectStatement: "Retry ownership crosses the API and worker lease boundary.",
        intent: "debug",
        question: "How should a maintainer trace and repair a task that is repeatedly reclaimed after lease expiry?",
        material: true,
        requiredAnswerParts: ["entrypoints", "control_flow", "invariants", "verification"],
        evidence: [
          {
            source: "code",
            reference: "src/worker.ts",
            exactQuote: "renewLease",
            reason: "The worker owns renewal before completion."
          }
        ],
        reason: "The existing request-change task does not test lease recovery."
      }
    ],
    omittedSubjects: [
      {
        id: "retry-ownership",
        kind: "flow",
        statement: "Retry ownership crosses the API and worker lease boundary.",
        material: true,
        evidence: [
          {
            source: "tests",
            reference: "src/worker.test.ts",
            exactQuote: "reclaims an expired lease",
            reason: "The test establishes recovery as maintained behavior."
          }
        ],
        reason: "No current subject explains which layer may retry.",
        taskIds: ["challenge-debug-retry-owner"]
      }
    ],
    summary: "Promote retry ownership and test it from context."
  };
  const expected = {
    workerId: "source-challenge",
    inputDigest: "c".repeat(64),
    publicSnapshotDigest: "d".repeat(64),
    existingTasks: [{ id: "change-request", question: "How is a request changed safely?" }],
    existingSubjectIds: ["request-flow"],
    repositoryPaths: ["src/worker.ts", "src/worker.test.ts"]
  };
  const parsed = parseSourceChallengeStageResult(challenge, expected);
  assert.equal(parsed.addedTasks[0]?.requiredAnswerParts[1], "control_flow");
  assert.throws(
    () => parseSourceChallengeStageResult({ ...challenge, acceptedTaskIds: ["invented-task"] }, expected),
    /accepted invented task id/
  );
  assert.throws(
    () =>
      parseSourceChallengeStageResult(
        {
          ...challenge,
          addedTasks: [
            {
              ...challenge.addedTasks[0],
              question: "  HOW   IS A REQUEST CHANGED SAFELY? "
            }
          ]
        },
        expected
      ),
    /question is duplicated/
  );
  assert.throws(
    () =>
      parseSourceChallengeStageResult(
        {
          ...challenge,
          addedTasks: [{ ...challenge.addedTasks[0], material: false }]
        },
        expected
      ),
    /material omitted subject.*requires a material added task/
  );
});

test("material source challenges block publication until the worker, subject, and task are promoted", () => {
  const challenge = parseSourceChallengeStageResult(
    {
      version: 1,
      inputDigest: "e".repeat(64),
      publicSnapshotDigest: "f".repeat(64),
      worker: { id: "source-challenge", summary: "Found an omitted retry task." },
      acceptedTaskIds: ["request-change"],
      addedTasks: [
        {
          id: "challenge-retry",
          subjectId: "request-flow",
          subjectKind: "flow",
          subjectStatement: "Requests have a retry lifecycle.",
          intent: "debug",
          question: "How is a failed request safely retried?",
          material: true,
          requiredAnswerParts: ["entrypoints", "failure_triage", "verification"],
          evidence: [
            {
              source: "code",
              reference: "src/request.ts",
              exactQuote: "retryRequest",
              reason: "This is the retry entrypoint."
            }
          ],
          reason: "The original task does not cover retry failure."
        }
      ],
      omittedSubjects: [],
      summary: "Test retry behavior."
    },
    {
      workerId: "source-challenge",
      inputDigest: "e".repeat(64),
      publicSnapshotDigest: "f".repeat(64),
      existingTasks: [{ id: "request-change", question: "How is a request changed?" }],
      existingSubjectIds: ["request-flow"],
      repositoryPaths: ["src/request.ts"]
    }
  );
  const base = {
    subjects: [
      {
        id: "request-flow",
        kind: "flow",
        status: "covered",
        questions: []
      }
    ],
    workers: []
  } as unknown as Parameters<typeof sourceChallengePromotionDiagnostics>[0];
  assert.match(sourceChallengePromotionDiagnostics(base, challenge).join("\n"), /source challenge worker/);
  const promoted = {
    ...base,
    subjects: [
      {
        id: "request-flow",
        kind: "flow",
        status: "covered",
        questions: [
          {
            id: "challenge-retry",
            question: "How is a failed request safely retried?",
            priority: "required",
            status: "answered",
            pageIds: ["request-flow"]
          }
        ]
      }
    ],
    workers: [
      {
        id: "source-challenge",
        role: "research",
        status: "complete",
        pageIds: []
      }
    ]
  } as unknown as Parameters<typeof sourceChallengePromotionDiagnostics>[0];
  assert.deepEqual(sourceChallengePromotionDiagnostics(promoted, challenge), []);
});

test("citation audits bind exact digests and cover every stable citation exactly once", () => {
  const citationIds = [`cite_${"a".repeat(20)}`, `cite_${"b".repeat(20)}`];
  const expected = {
    workerId: "citation-audit",
    inputDigest: "c".repeat(64),
    publicSnapshotDigest: "d".repeat(64),
    citationIds
  };
  const audit = {
    version: 1,
    inputDigest: expected.inputDigest,
    publicSnapshotDigest: expected.publicSnapshotDigest,
    worker: { id: "citation-audit", summary: "One claim needs a narrower range." },
    results: [
      {
        citationId: citationIds[0],
        verdict: "supported",
        rationale: "The exact branch entails this clause.",
        correction: null
      },
      {
        citationId: citationIds[1],
        verdict: "unsupported",
        rationale: "The excerpt names retries but not the claimed limit.",
        correction: {
          path: "src/retry.ts",
          startLine: 12,
          endLine: 18,
          providerUrl: null,
          exactSourceAnchor: "maximumAttempts"
        }
      }
    ],
    summary: "Repair the retry assertion."
  };
  const parsed = parseCitationAuditStageResult(audit, expected);
  assert.equal(parsed.results[1]?.correction?.path, "src/retry.ts");
  assert.throws(
    () => parseCitationAuditStageResult({ ...audit, results: [audit.results[0]] }, expected),
    /omitted citation/
  );
  assert.throws(
    () =>
      parseCitationAuditStageResult(
        { ...audit, results: [audit.results[0], audit.results[0], audit.results[1]] },
        expected
      ),
    /duplicates citation/
  );
  assert.throws(
    () =>
      parseCitationAuditStageResult(
        {
          ...audit,
          results: [{ ...audit.results[0], citationId: `cite_${"e".repeat(20)}` }, audit.results[1]]
        },
        expected
      ),
    /invented citation/
  );
  assert.throws(() => parseCitationAuditStageResult({ ...audit, extra: true }, expected), /unexpected property extra/);
});

test("invalid citation audit correction hints are discarded without weakening the verdict", () => {
  const citationId = `cite_${"a".repeat(20)}`;
  const expected = {
    workerId: "citation-audit",
    inputDigest: "c".repeat(64),
    publicSnapshotDigest: "d".repeat(64),
    citationIds: [citationId]
  };
  const result = {
    version: 1,
    inputDigest: expected.inputDigest,
    publicSnapshotDigest: expected.publicSnapshotDigest,
    worker: { id: "citation-audit", summary: "Audited." },
    results: [
      {
        citationId,
        verdict: "unsupported",
        rationale: "Wrong range.",
        correction: {
          path: "src/retry.ts",
          startLine: 1,
          endLine: 121,
          providerUrl: null,
          exactSourceAnchor: null
        }
      }
    ],
    summary: "Repair it."
  };
  assert.equal(parseCitationAuditStageResult(result, expected).results[0]?.correction, null);
  assert.equal(
    parseCitationAuditStageResult(
      {
        ...result,
        results: [
          {
            ...result.results[0],
            verdict: "supported",
            correction: {
              path: null,
              startLine: null,
              endLine: null,
              providerUrl: "https://github.com/acme/cache/issues/1",
              exactSourceAnchor: "retry limit"
            }
          }
        ]
      },
      expected
    ).results[0]?.correction,
    null
  );
});

test("final publication requires an unchanged digest-bound all-supported citation audit", () => {
  const inputDigest = "a".repeat(64);
  const publicSnapshotDigest = "b".repeat(64);
  const auditDigest = "c".repeat(64);
  const audit = {
    version: 1 as const,
    inputDigest,
    publicSnapshotDigest,
    worker: { id: "citation-audit", summary: "All claims supported." },
    results: [
      {
        citationId: `cite_${"d".repeat(20)}`,
        verdict: "supported" as const,
        rationale: "The exact branch entails the assertion.",
        correction: null
      }
    ],
    summary: "Certified."
  };
  const complete = {
    certificationDigest: auditDigest,
    audit,
    auditDigest,
    checkpoint: {
      inputDigest,
      publicSnapshotDigest,
      outputDigest: auditDigest,
      citationIds: [audit.results[0]!.citationId]
    },
    persistedInputDigest: inputDigest,
    persistedCitationIds: [audit.results[0]!.citationId],
    expectedInputDigest: inputDigest,
    currentCitationIds: [audit.results[0]!.citationId],
    currentPublicSnapshotDigest: publicSnapshotDigest,
    worker: { role: "research", status: "complete" }
  };
  assert.equal(citationAuditCertificationDiagnostic(complete), undefined);
  assert.match(
    citationAuditCertificationDiagnostic({ ...complete, audit: undefined }) ?? "",
    /no persisted source-aware citation audit/
  );
  assert.match(
    citationAuditCertificationDiagnostic({
      ...complete,
      audit: {
        ...audit,
        results: [{ ...audit.results[0]!, verdict: "unsupported" as const }]
      }
    }) ?? "",
    /unsupported public claims/
  );
  assert.match(
    citationAuditCertificationDiagnostic({
      ...complete,
      currentPublicSnapshotDigest: "e".repeat(64)
    }) ?? "",
    /public context bytes differ/
  );
  assert.match(
    citationAuditCertificationDiagnostic({
      ...complete,
      persistedCitationIds: []
    }) ?? "",
    /checkpoint input digests do not match/
  );
  assert.match(
    citationAuditCertificationDiagnostic({
      ...complete,
      expectedInputDigest: "f".repeat(64)
    }) ?? "",
    /checkpoint input digests do not match/
  );
  assert.match(
    citationAuditCertificationDiagnostic({
      ...complete,
      currentCitationIds: [`cite_${"e".repeat(20)}`]
    }) ?? "",
    /checkpoint input digests do not match/
  );
});
