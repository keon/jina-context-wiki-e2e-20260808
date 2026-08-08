import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextOrchestrationDiagnostics,
  parseContextOrchestrationState,
  repositoryContextAreas
} from "./orchestration.js";
import { derivationProgressDocumentPath } from "./progress.js";

test("Context document paths cannot escape or collide with private state", () => {
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

test("complete orchestration accounts for repository areas and published pages", () => {
  const manifest = [{ path: "README.md" }, { path: "src/cache.ts" }, { path: "apps/api/server.ts" }];
  assert.deepEqual(repositoryContextAreas(manifest), ["apps", "apps/api", "root", "src"]);
  assert.deepEqual(
    contextOrchestrationDiagnostics({
      state: orchestration,
      documentPaths: ["architecture.md"],
      manifest: manifest.slice(0, 2),
      sourcePathsByDocumentPath: { "architecture.md": ["README.md", "src/cache.ts"] }
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
});

test("complete orchestration requires a passing context-only critic", () => {
  const diagnostics = contextOrchestrationDiagnostics({
    state: { ...orchestration, reviews: [] },
    documentPaths: ["architecture.md"],
    manifest: [{ path: "README.md" }, { path: "src/cache.ts" }]
  });
  assert.equal(diagnostics.includes("complete orchestration has no completed context-only critic review"), true);
  assert.equal(
    diagnostics.includes("required maintenance question cache-lookup was not tested by a completed critic review"),
    true
  );
});
