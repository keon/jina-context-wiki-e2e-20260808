import assert from "node:assert/strict";
import test from "node:test";
import type { CitationAuditReference, DocumentationPagePlan } from "@jina/daytona";
import { contextPublicSnapshot } from "@jina/context-engine";
import {
  canonicalPublicPageMarkdown,
  contextBoardPublicSnapshot,
  nextPageRepairCheckpointDiagnostics,
  pagePlanStructuralProblems,
  pageRepairCoveragePrompt,
  pageRepairNoProgressProblems,
  pageRepairRegressionProblems,
  pageRepairScopeRegressionProblems,
  publicPageCheckoutAliasProblems,
  retainedPageRepairCheckpoint
} from "./board-page-repair.js";

test("Board snapshots use the authoritative multi-page publication bytes", () => {
  const pages = [
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown: "# Architecture\n\n[Entry](src/main.ts#L1-L2).\n"
    },
    {
      documentPath: "operations/recovery.md",
      title: "Recovery",
      bodyMarkdown: "# Recovery\n\n[Retry](src/retry.ts#L3-L5).\n"
    }
  ];
  assert.equal(contextBoardPublicSnapshot(pages), contextPublicSnapshot(pages));
  assert.doesNotMatch(contextBoardPublicSnapshot(pages), /\n\n<!-- context-page:/);
});

const architecture: DocumentationPagePlan = {
  id: "architecture",
  path: "architecture.md",
  title: "Architecture",
  purpose: "Orient maintainers",
  sourceAssignmentIds: ["system"],
  maintenanceQuestions: ["Where does a request enter?"],
  coverageAreas: ["apps/api"],
  requiredTopics: ["entry points", "trust boundaries"],
  diagram: "architecture",
  dependencies: []
};

const api: DocumentationPagePlan = {
  id: "api",
  path: "interfaces/api.md",
  title: "API",
  purpose: "Explain the API",
  sourceAssignmentIds: ["system"],
  maintenanceQuestions: ["How is the API extended?"],
  coverageAreas: ["apps/api"],
  requiredTopics: ["routing"],
  diagram: "none",
  dependencies: ["architecture"]
};

test("architecture repair preserves plan coverage and the complete public navigation root", () => {
  const prompt = pageRepairCoveragePrompt(architecture, [architecture, api]);
  assert.match(prompt, /binding quality contract/);
  assert.match(prompt, /Where does a request enter/);
  assert.match(prompt, /architecture\.md is the public navigation root/);
  assert.match(prompt, /interfaces\/api\.md/);
  assert.match(prompt, /planned architecture Mermaid diagram is required/);
});

test("page repair resolves dependency IDs to public paths", () => {
  const prompt = pageRepairCoveragePrompt(api, [architecture, api]);
  assert.match(prompt, /Preserve ordinary Markdown navigation.*\.\.\/architecture\.md/);
  assert.match(prompt, /How is the API extended/);
  assert.match(prompt, /No diagram is required/);
  assert.match(prompt, /inflection-normalized plan vocabulary/);
  assert.match(prompt, /retain at least 60%/);
  assert.match(prompt, /plain text or inline code is not a citation/);
  assert.match(prompt, /Never replace a rendered evidence link/);
  assert.match(prompt, /visible label must exactly match its destination/);
  assert.match(prompt, /immediately after the complete core assertion/);
  assert.match(prompt, /Do not collect detached markers at the end of a section/);
  assert.match(prompt, /INVALID:.*additional\/0/);
  assert.match(prompt, /exact case-sensitive path present in the checkpoint snapshot manifest/);
  assert.match(prompt, /captured commit, pull-request, issue, or observation history is relevant/);
  assert.match(prompt, /natural immutable provider URL/);
  assert.match(prompt, /Do not invent future features/);
  assert.match(prompt, /purely descriptive headers and row labels/);
  assert.match(prompt, /preserve the maintenance intent as an explicit question/);
  assert.match(prompt, /Migrate conventional trailing source markers into assertion links/);
  assert.match(prompt, /Split factual premises from pure maintenance questions/);
  assert.match(prompt, /reread every exact structural problem/);
});

test("page repair preserves relevant proven facts and escalates after a retained no-progress checkpoint", () => {
  const prompt = pageRepairCoveragePrompt(api, [architecture, api], {
    supportedCitationIds: ["cite_supported"],
    priorCheckpoint: {
      version: 1,
      consecutiveNoProgressPasses: 1,
      attemptedBodyDigest: "a".repeat(64),
      regressionProblems: ["repair produced a byte-identical page"]
    }
  });
  assert.match(prompt, /CONVERGENCE ESCALATION/);
  assert.match(prompt, /Rewrite the complete page/);
  assert.match(prompt, /bounded host limit/);
  assert.match(prompt, /Preserve their supported facts when they remain relevant/);
  assert.match(prompt, /independently audited again/);
  assert.match(prompt, /cite_supported/);
});

test("operator remediation prompt targets the remaining findings after the ordinary loop closes", () => {
  const prompt = pageRepairCoveragePrompt(api, [architecture, api], {
    supportedCitationIds: ["cite_supported"],
    operatorRemediationPass: 9
  });
  assert.match(prompt, /OPERATOR REMEDIATION PASS 9/);
  assert.match(prompt, /Resolve only the exact remaining host findings/);
  assert.match(prompt, /Prefer leaving unrelated proven links unchanged/);
  assert.match(prompt, /Do not repeat a prior edit/);
});

test("structural-only repair prompt does not claim unaudited bindings are semantically supported", () => {
  const prompt = pageRepairCoveragePrompt(api, [architecture, api]);
  assert.match(prompt, /structural findings only; no semantic citation audit exists/);
  assert.match(prompt, /replace or remove an unaudited binding/);
});

test("page repair rejects an unknown dependency instead of weakening navigation", () => {
  assert.throws(
    () => pageRepairCoveragePrompt({ ...api, dependencies: ["missing"] }, [architecture, api]),
    /cannot resolve planned dependency missing/
  );
});

test("page audit enforces planned diagrams, architecture reachability, and page dependencies", () => {
  const plans = [architecture, api];
  assert.deepEqual(pagePlanStructuralProblems(architecture, plans, "# Architecture\n"), [
    "architecture.md is missing its planned architecture Mermaid diagram",
    "architecture.md is missing planned context navigation to interfaces/api.md"
  ]);
  assert.deepEqual(
    pagePlanStructuralProblems(
      architecture,
      plans,
      "# Architecture\n\n[API](interfaces/api.md)\n\n```mermaid\nflowchart LR\n  API --> Worker\n```\n"
    ),
    []
  );
  assert.deepEqual(pagePlanStructuralProblems(api, plans, "# API\n"), [
    "interfaces/api.md is missing planned context navigation to architecture.md"
  ]);
  assert.deepEqual(pagePlanStructuralProblems(api, plans, "# API\n\n[Architecture](../architecture.md)\n"), []);
  assert.deepEqual(
    pagePlanStructuralProblems(
      api,
      plans,
      [
        "# API",
        "[Architecture](../architecture.md)",
        "[Missing](../operations/missing.md)",
        "[Repository README](README.md#L1-L4)",
        "[External](https://example.com/guide.md)"
      ].join("\n\n")
    ),
    ["interfaces/api.md has broken context navigation to ../operations/missing.md"]
  );
});

test("page repair monotonicity accepts fewer structural problems while preserving source bindings", () => {
  const reference = citationReference("cite_supported", "src/server.ts#L10-L18");
  assert.deepEqual(
    pageRepairRegressionProblems({
      priorReferences: [reference],
      priorStructuralProblems: ["ungrounded substantive section in architecture.md: Request path"],
      priorPlanStructuralProblems: [],
      priorSupportedCitationIds: [reference.citationId],
      candidateReferences: [{ ...reference, citationId: "cite_reworded", claimSpan: "The request enters here." }],
      candidateStructuralProblems: [],
      candidatePlanStructuralProblems: []
    }),
    []
  );
});

test("page repair monotonicity rejects structural regressions and invented source namespaces", () => {
  const invented = "repository citation path is unavailable in the snapshot: additional/0/src/server.ts";
  const collision = "citation identity collision in architecture.md: cite_duplicate";
  const problems = pageRepairRegressionProblems({
    priorReferences: [],
    priorStructuralProblems: [
      "ungrounded substantive section in architecture.md: Request path",
      "ungrounded substantive section in architecture.md: Response path"
    ],
    priorPlanStructuralProblems: [],
    candidateReferences: [],
    candidateStructuralProblems: [
      "ungrounded substantive section in architecture.md: Request path",
      invented,
      collision
    ],
    candidatePlanStructuralProblems: []
  });
  assert.match(problems.join("\n"), /structural audit problems increased from 2 to 3/);
  assert.match(problems.join("\n"), /invalid or unavailable source binding.*additional\/0/);
  assert.match(problems.join("\n"), /invalid or unavailable source binding.*identity collision/);
});

test("page repair monotonicity permits citation replacement before independent re-audit", () => {
  const supported = citationReference("cite_supported", "src/server.ts#L10-L18");
  const unsupported = citationReference("cite_unsupported", "src/legacy.ts#L1-L8");
  const candidate = [{ ...unsupported, citationId: "cite_replacement" }];
  const lost = pageRepairRegressionProblems({
    priorReferences: [supported, unsupported],
    priorStructuralProblems: [],
    priorPlanStructuralProblems: [],
    priorSupportedCitationIds: [supported.citationId],
    candidateReferences: candidate,
    candidateStructuralProblems: [],
    candidatePlanStructuralProblems: []
  });
  assert.deepEqual(lost, []);

  const unsupportedRemoved = pageRepairRegressionProblems({
    priorReferences: [supported, unsupported],
    priorStructuralProblems: [],
    priorPlanStructuralProblems: [],
    priorSupportedCitationIds: [supported.citationId],
    candidateReferences: [{ ...supported, citationId: "cite_reworded" }],
    candidateStructuralProblems: [],
    candidatePlanStructuralProblems: []
  });
  assert.deepEqual(unsupportedRemoved, []);
});

test("structural-only monotonicity does not protect every unaudited prior binding", () => {
  const unaudited = citationReference("cite_unaudited", "src/legacy.ts#L1-L8");
  assert.deepEqual(
    pageRepairRegressionProblems({
      priorReferences: [unaudited],
      priorStructuralProblems: ["ungrounded substantive section in architecture.md: Legacy path"],
      priorPlanStructuralProblems: [],
      candidateReferences: [],
      candidateStructuralProblems: [],
      candidatePlanStructuralProblems: []
    }),
    []
  );
});

test("page repair monotonicity rejects dropped navigation or diagram coverage even at equal problem count", () => {
  const coverageProblem = "architecture.md is missing planned context navigation to interfaces/api.md";
  const problems = pageRepairRegressionProblems({
    priorReferences: [],
    priorStructuralProblems: ["ungrounded substantive section in architecture.md: Request path"],
    priorPlanStructuralProblems: [],
    candidateReferences: [],
    candidateStructuralProblems: [coverageProblem],
    candidatePlanStructuralProblems: [coverageProblem]
  });
  assert.deepEqual(problems, [`repair dropped required publication-plan coverage: ${coverageProblem}`]);
});

test("page repair scope rejects loss of planned topics and maintenance questions", () => {
  const prior = [
    "# API",
    "",
    "## Request routing",
    "Request routing starts at an API entry point.",
    "",
    "## Extension workflow",
    "Maintainers can extend the API by adding another routed endpoint.",
    "",
    fillerWords(100)
  ].join("\n");
  const candidate = ["# API", "", "## General notes", fillerWords(100)].join("\n");
  const problems = pageRepairScopeRegressionProblems({
    page: api,
    priorBodyMarkdown: prior,
    candidateBodyMarkdown: candidate
  });
  assert.match(problems.join("\n"), /dropped planned required topic coverage.*routing/);
  assert.match(problems.join("\n"), /dropped planned maintenance question coverage.*API extended/);
});

test("page repair scope permits inflection changes and focused evidence-driven rewriting", () => {
  const prior = [
    "# API",
    "",
    "## Request routing",
    "The API is extended through routed endpoint registration.",
    "",
    fillerWords(100)
  ].join("\n");
  const candidate = [
    "# API",
    "",
    "## Request routes",
    "Maintainers extend the API through route registration.",
    "",
    fillerWords(65)
  ].join("\n");
  assert.deepEqual(
    pageRepairScopeRegressionProblems({
      page: api,
      priorBodyMarkdown: prior,
      candidateBodyMarkdown: candidate
    }),
    []
  );
});

test("page repair scope rejects material hollowing and section collapse", () => {
  const prior = [
    "# API",
    "",
    "## Entry",
    fillerWords(50),
    "## Control flow",
    fillerWords(50),
    "## State",
    fillerWords(50),
    "## Failure recovery",
    fillerWords(50),
    "## Verification",
    fillerWords(50),
    "## Operations",
    fillerWords(50)
  ].join("\n\n");
  const candidate = ["# API", "", "## Summary", fillerWords(100)].join("\n");
  const problems = pageRepairScopeRegressionProblems({
    page: { ...api, requiredTopics: [], maintenanceQuestions: [] },
    priorBodyMarkdown: prior,
    candidateBodyMarkdown: candidate
  });
  assert.match(problems.join("\n"), /materially hollowed the page/);
  assert.match(problems.join("\n"), /collapsed the page from 6 to 1 substantive section/);
});

test("page repair scope rejects a shallow replacement even when the prior page is also small", () => {
  assert.deepEqual(
    pageRepairScopeRegressionProblems({
      page: { ...api, requiredTopics: [], maintenanceQuestions: [] },
      priorBodyMarkdown: "# API\n\nA short checkpoint.",
      candidateBodyMarkdown: "# API\n\nA different short checkpoint."
    }),
    ["repair returned a shallow page shorter than 400 characters"]
  );
});

test("a rejected repair completes with only the prior checkpoint result envelope", () => {
  const priorArtifact = {
    key: "context-v2/build/prior.json",
    sha256: "a".repeat(64)
  };
  assert.deepEqual(
    retainedPageRepairCheckpoint({
      regressionProblems: ["repair lost a valid reference"],
      retainedArtifact: priorArtifact,
      priorPublicSnapshotDigest: "b".repeat(64)
    }),
    {
      version: 1,
      outputArtifact: priorArtifact,
      publicSnapshotDigest: "b".repeat(64)
    }
  );
  assert.equal(
    retainedPageRepairCheckpoint({
      regressionProblems: [],
      retainedArtifact: priorArtifact,
      priorPublicSnapshotDigest: "b".repeat(64)
    }),
    undefined
  );
});

test("page repair detects byte-identical and structural-only no-progress attempts", () => {
  const problem = "ungrounded substantive section in architecture.md: Request path";
  assert.deepEqual(
    pageRepairNoProgressProblems({
      priorBodyMarkdown: "# Architecture\n",
      candidateBodyMarkdown: "# Architecture\n",
      priorStructuralProblems: [problem],
      candidateStructuralProblems: [problem],
      semanticAuditPresent: true
    }),
    ["repair produced a byte-identical page"]
  );
  assert.deepEqual(
    pageRepairNoProgressProblems({
      priorBodyMarkdown: "# Architecture\n\n",
      candidateBodyMarkdown: "# Architecture\n",
      priorStructuralProblems: [],
      candidateStructuralProblems: [],
      semanticAuditPresent: true
    }),
    ["repair changed only trailing whitespace"]
  );
  assert.deepEqual(
    pageRepairNoProgressProblems({
      priorBodyMarkdown: "# Architecture\n\nOld prose.\n",
      candidateBodyMarkdown: "# Architecture\n\nReworded prose.\n",
      priorStructuralProblems: [problem],
      candidateStructuralProblems: [problem],
      semanticAuditPresent: false
    }),
    ["structural-only repair left the complete structural problem set unchanged"]
  );
  assert.deepEqual(
    pageRepairNoProgressProblems({
      priorBodyMarkdown: "# Architecture\n\nOld prose.\n",
      candidateBodyMarkdown: "# Architecture\n\nReworded prose.\n",
      priorStructuralProblems: [],
      candidateStructuralProblems: [],
      semanticAuditPresent: true
    }),
    []
  );
});

test("retained checkpoint diagnostics increment deterministic no-progress state", () => {
  const priorCheckpoint = {
    version: 1 as const,
    consecutiveNoProgressPasses: 1,
    attemptedBodyDigest: "a".repeat(64),
    regressionProblems: ["first"]
  };
  assert.deepEqual(
    nextPageRepairCheckpointDiagnostics({
      priorCheckpoint,
      attemptedBodyDigest: "b".repeat(64),
      regressionProblems: ["second"]
    }),
    {
      version: 1,
      consecutiveNoProgressPasses: 2,
      attemptedBodyDigest: "b".repeat(64),
      regressionProblems: ["second"]
    }
  );
  assert.throws(
    () =>
      nextPageRepairCheckpointDiagnostics({
        attemptedBodyDigest: "b".repeat(64),
        regressionProblems: []
      }),
    /require a no-progress or regression problem/
  );
});

test("public Context detects raw portable checkout aliases but not repository-relative source paths", () => {
  assert.equal(
    canonicalPublicPageMarkdown(
      "[claim](../../repository/additional/0/src/server.ts#L1-L2) and [bare](additional/0/src/api.ts#L3)"
    ),
    "[claim](src/server.ts#L1-L2) and [bare](src/api.ts#L3)"
  );
  assert.deepEqual(publicPageCheckoutAliasProblems("[claim](additional/0/src/server.ts#L1-L2)"), [
    "public Context contains a private checkout alias: additional/0/"
  ]);
  assert.deepEqual(
    publicPageCheckoutAliasProblems(
      "Loaded from repository/additional/0/src/server.ts and ../../repository/work/packages/api/src/index.ts."
    ),
    [
      "public Context contains a private checkout alias: repository/additional/0/",
      "public Context contains a private checkout alias: ../../repository/work/"
    ]
  );
  assert.deepEqual(publicPageCheckoutAliasProblems("[claim](src/server.ts#L1-L2)"), []);
});

function citationReference(citationId: string, target: string): CitationAuditReference {
  const [pathOrUrl = "", range = ""] = target.split("#");
  const lines = /^L(\d+)-L(\d+)$/.exec(range);
  return {
    citationId,
    claimId: `claim_${citationId}`,
    documentPath: "architecture.md",
    label: "The request enters here",
    claimSpan: "The request enters here.",
    target,
    sourceType: "blob",
    sourceId: "a".repeat(40),
    contentDigest: "b".repeat(64),
    pathOrUrl,
    startLine: Number(lines?.[1] ?? 1),
    endLine: Number(lines?.[2] ?? 1),
    excerpt: "export function request() {}"
  };
}

function fillerWords(count: number): string {
  return Array.from({ length: count }, (_, index) => `detail${index}`).join(" ");
}
