import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboardPage } from "./page.js";

test("dashboard page renders its navigation and keeps embedded behavior executable", () => {
  const html = renderDashboardPage("https://api.example.test");

  assert.match(html, /data-task-id/);
  for (const page of ["board", "history", "task-types", "ontology"]) {
    assert.match(html, new RegExp(`data-page="${page}"`));
  }
  assert.match(html, /aria-label="Task board"/);
  assert.match(html, /aria-label="Task type list"/);
  assert.match(html, /aria-label="Repository ontology graph"/);
  assert.match(html, /aria-label="Graph visibility controls"/);
  assert.match(html, /id="ontology-search"/);
  assert.match(html, /Ask with citations/);
  assert.match(html, /Dependencies & relationships/);
  assert.match(html, /Comments & activity/);
  assert.match(html, /#task=/);
  assert.match(html, /https:\/\/api\.example\.test/);

  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));

  const filterSource = script.match(/function filterOntologyGraph\(graph, hiddenNodeKinds, hiddenEdgePredicates\) \{[\s\S]+?\n\}\n\nfunction selectionIsVisible/)?.[0]
    .replace(/\n\nfunction selectionIsVisible$/, "");
  assert.ok(filterSource);
  const filterOntologyGraph = new Function(`${filterSource}; return filterOntologyGraph;`)() as (
    graph: { nodes: Array<{ id: string; kind: string }>; edges: Array<{ id: string; source: string; target: string; predicate: string }> },
    hiddenNodeKinds: Set<string>,
    hiddenEdgePredicates: Set<string>
  ) => { nodes: Array<{ id: string }>; edges: Array<{ id: string }> };
  const graph = {
    nodes: [
      { id: "repo", kind: "Repository" },
      { id: "file", kind: "File" },
      { id: "issue", kind: "Issue" }
    ],
    edges: [
      { id: "contains", source: "repo", target: "file", predicate: "CONTAINS" },
      { id: "tracks", source: "repo", target: "issue", predicate: "TRACKS" }
    ]
  };
  assert.deepEqual(
    filterOntologyGraph(graph, new Set(["File"]), new Set()).nodes.map((node) => node.id),
    ["repo", "issue"]
  );
  assert.deepEqual(
    filterOntologyGraph(graph, new Set(["File"]), new Set()).edges.map((edge) => edge.id),
    ["tracks"],
    "edges connected to hidden nodes are also hidden"
  );
  assert.deepEqual(
    filterOntologyGraph(graph, new Set(), new Set(["TRACKS"])).edges.map((edge) => edge.id),
    ["contains"],
    "edge relationship types can be hidden independently"
  );

  const searchSource = script.match(/function ontologySearchMatches\(graph, visibleGraph, labels, query, limit\) \{[\s\S]+?\n\}\n\nfunction renderOntologySearchResults/)?.[0]
    .replace(/\n\nfunction renderOntologySearchResults$/, "");
  assert.ok(searchSource);
  const ontologySearchMatches = new Function("humanize", `${searchSource}; return ontologySearchMatches;`)(
    (value: string) => value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())
  ) as (
    graph: { nodes: Array<Record<string, string>>; edges: Array<Record<string, string>> },
    visibleGraph: { nodes: Array<Record<string, string>>; edges: Array<Record<string, string>> },
    labels: Record<string, string>,
    query: string,
    limit: number
  ) => Array<{ kind: string; id: string; label: string }>;
  const searchableGraph = {
    nodes: [
      { id: "repo", kind: "Repository", label: "omxyz/jina", description: "repo:omxyz/jina" },
      { id: "file", kind: "File", label: "page.ts", path: "apps/dashboard/app/page.ts" },
      { id: "issue", kind: "Issue", label: "Guest denial semantics" }
    ],
    edges: [
      { id: "contains", source: "repo", target: "file", predicate: "CONTAINS", plane: "code" },
      { id: "tracks", source: "repo", target: "issue", predicate: "TRACKS", plane: "knowledge" }
    ]
  };
  const labels = { repo: "omxyz/jina", file: "Dashboard page", issue: "Guest denial semantics" };
  assert.deepEqual(
    ontologySearchMatches(searchableGraph, searchableGraph, labels, "guest denial", 10).map((result) => [result.kind, result.id]),
    [["node", "issue"], ["edge", "tracks"]],
    "search covers friendly node labels and relationship endpoints"
  );
  const withoutFiles = filterOntologyGraph(searchableGraph, new Set(["File"]), new Set()) as typeof searchableGraph;
  assert.deepEqual(
    ontologySearchMatches(searchableGraph, withoutFiles, labels, "dashboard page", 10),
    [],
    "search respects active graph visibility filters"
  );

  const graphIdentitySource = script.match(/function ontologyGraphIdentity\(graph\) \{[\s\S]+?\n\}\n\nfunction resetOntologyViewForGraph/)?.[0]
    .replace(/\n\nfunction resetOntologyViewForGraph$/, "");
  assert.ok(graphIdentitySource);
  const ontologyGraphIdentity = new Function(`${graphIdentitySource}; return ontologyGraphIdentity;`)() as (
    graph: { id?: string; repository: string; ref: string; commitSha: string; generatedAt: string }
  ) => string;
  assert.notEqual(
    ontologyGraphIdentity({ repository: "org/old", ref: "main", commitSha: "a", generatedAt: "2026-01-01" }),
    ontologyGraphIdentity({ repository: "org/new", ref: "main", commitSha: "a", generatedAt: "2026-01-01" }),
    "view state is scoped to the repository graph identity"
  );

  const friendlyLabelSource = script.match(/function mergePullRequestsForCommit\(node, graph\) \{[\s\S]+?\n\}\n\nfunction friendlyNodeExplanation/)?.[0]
    .replace(/\n\nfunction friendlyNodeExplanation$/, "");
  assert.ok(friendlyLabelSource);
  const friendlyNodeLabel = new Function(`${friendlyLabelSource}; return friendlyNodeLabel;`)() as (
    node: { id: string; kind: string; label: string; description?: string },
    graph: { nodes: Array<{ id: string; kind: string; label: string }>; edges: Array<{ source: string; target: string; predicate: string }> }
  ) => string;
  const commit = { id: "commit", kind: "Commit", label: "d80aa666dd41", description: "repo:omxyz/jina-ontology-e2e:sha:d80aa666dd41a423d2775b8c0c47ba20d53facef" };
  const pullRequest = { id: "pr", kind: "PullRequest", label: "#2 Document guest denial semantics" };
  const commitGraph = {
    nodes: [commit, pullRequest],
    edges: [{ source: "pr", target: "commit", predicate: "MERGED_AS" }]
  };
  assert.equal(friendlyNodeLabel(commit, commitGraph), "Merge commit · #2 Document guest denial semantics");
  const secondPullRequest = { id: "pr-2", kind: "PullRequest", label: "#3 Conflicting merge attribution" };
  const ambiguousCommitGraph = {
    nodes: [commit, pullRequest, secondPullRequest],
    edges: [
      { source: "pr", target: "commit", predicate: "MERGED_AS" },
      { source: "pr-2", target: "commit", predicate: "MERGED_AS" }
    ]
  };
  assert.equal(friendlyNodeLabel(commit, ambiguousCommitGraph), "Commit · d80aa666dd41");
  assert.equal(
    friendlyNodeLabel(commit, { ...ambiguousCommitGraph, edges: ambiguousCommitGraph.edges.slice().reverse() }),
    "Commit · d80aa666dd41",
    "ambiguous merge attribution does not depend on edge ordering"
  );
  assert.equal(
    friendlyNodeLabel(
      { id: "not-sha", kind: "Commit", label: "not-a-sha", description: "ticket 123456789abcde" },
      { nodes: [], edges: [] }
    ),
    "not-a-sha",
    "arbitrary hexadecimal description text is not treated as a commit SHA"
  );
  assert.equal(
    friendlyNodeLabel(
      { id: "symbol", kind: "Symbol", label: "entity:symbol-a", description: "repo:omxyz/jina:moniker:src/app.ts:Thing" },
      { nodes: [], edges: [] }
    ),
    "Symbol · omxyz/jina · src/app.ts:Thing",
    "technical labels retain repository and moniker context"
  );

  const confidenceSource = script.match(/function connectedConfidenceSummary\(edges\) \{[\s\S]+?\n\}\n\nfunction ontologyConfidence/)?.[0]
    .replace(/\n\nfunction ontologyConfidence$/, "");
  assert.ok(confidenceSource);
  const connectedConfidenceSummary = new Function(`${confidenceSource}; return connectedConfidenceSummary;`)() as (
    edges: Array<{ confidence?: number }>
  ) => { value?: number; scoredCount: number; totalCount: number };
  assert.deepEqual(
    connectedConfidenceSummary([{ confidence: 0.8 }, {}, { confidence: 1 }]),
    { value: 0.9, scoredCount: 2, totalCount: 3 },
    "node confidence is derived only from scored connected relationships"
  );
  assert.deepEqual(
    connectedConfidenceSummary([{}, {}]),
    { value: undefined, scoredCount: 0, totalCount: 2 },
    "nodes without scored relationships do not invent a confidence value"
  );

  const partitionSource = script.match(/function partitionBoardTasks\(tasks\) \{[\s\S]+?\n\}\n\nfunction renderColumns/)?.[0]
    .replace(/\n\nfunction renderColumns$/, "");
  assert.ok(partitionSource);
  const partition = new Function(`${partitionSource}; return partitionBoardTasks;`)() as (tasks: unknown[]) => {
    current: Array<{ id: string }>;
    history: Array<{ id: string }>;
  };
  const result = partition([
    { id: "old-root", type: "ontology_build", status: "failed", createdAt: "2026-01-01", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "old" } },
    { id: "old-project", type: "ontology_project", status: "canceled", createdAt: "2026-01-01", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "old" } },
    { id: "new-root", type: "ontology_build", status: "done", createdAt: "2026-01-02", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "new" } },
    { id: "new-project", type: "ontology_project", status: "done", createdAt: "2026-01-02", metadata: { tenantId: "t", repository: "o/r", ref: "main", requestKey: "new" } },
    { id: "old-review", type: "review_pass", status: "superseded", createdAt: "2026-01-01", metadata: {} },
    { id: "issue", type: "issue_triage", status: "triage", createdAt: "2026-01-02", metadata: {} }
  ]);
  assert.deepEqual(result.current.map((task) => task.id), ["new-root", "new-project", "issue"]);
  assert.deepEqual(result.history.map((task) => task.id), ["old-root", "old-project", "old-review"]);

  const workflowSource = script.match(/function buildWorkflowTrees\(definitions\) \{[\s\S]+?\nfunction renderWorkflowTrees/)?.[0]
    .replace(/\nfunction renderWorkflowTrees$/, "");
  assert.ok(workflowSource);
  const buildWorkflowTrees = new Function(`${workflowSource}; return buildWorkflowTrees;`)() as (definitions: unknown[]) => Array<{
    name: string;
    roots: Array<{
      type: string;
      definition: { triggeredBy: Array<{ source: string }> };
      collapsedDependencies: Array<{ from: string }>;
      children: Array<{ edge: { conditions: string[] }; node: any }>;
    }>;
  }>;
  const dependencies = {
    ontology_build: [
      { taskType: "ontology_ingest", relationships: ["blocks"], workflows: ["ontology_build"], required: true, conditions: [] },
      { taskType: "ontology_assert", relationships: ["blocks"], workflows: ["ontology_build"], required: true, conditions: [] },
      { taskType: "ontology_project", relationships: ["blocks"], workflows: ["ontology_build"], required: true, conditions: [] }
    ],
    ontology_assert: [{ taskType: "ontology_ingest", relationships: ["blocks"], workflows: ["ontology_build"], required: true, conditions: [] }],
    ontology_project: [{ taskType: "ontology_assert", relationships: ["blocks"], workflows: ["ontology_build"], required: true, conditions: [] }],
    pr_review: [
      { taskType: "review_pass", relationships: ["blocks"], workflows: ["pr_review"], required: true, conditions: [] },
      { taskType: "publish", relationships: ["blocks", "publishes"], workflows: ["pr_review"], required: true, conditions: [] }
    ],
    review_pass: [{ taskType: "context", relationships: ["context_for"], workflows: ["pr_review"], required: true, conditions: ["when external context is requested"] }],
    publish: [{ taskType: "review_pass", relationships: ["blocks"], workflows: ["pr_review"], required: true, conditions: [] }]
  } as Record<string, unknown[]>;
  const definitions = [
    "pr_review", "review_pass", "context", "publish",
    "ontology_build", "ontology_ingest", "ontology_assert", "ontology_project"
  ].map((type) => ({
    type,
    kind: type.endsWith("build") || type === "pr_review" ? "aggregate" : "dispatchable",
    description: type,
    triggeredBy: type === "ontology_ingest" ? [{
      source: "POST /ontology/build",
      description: "Creates and queues the first executable Ontology task.",
      workflows: ["ontology_build"],
      conditions: []
    }] : [],
    dependsOn: dependencies[type] || []
  }));
  const workflows = buildWorkflowTrees(definitions);
  assert.deepEqual(workflows.map((workflow) => workflow.name), ["pr_review", "ontology_build"]);

  const reviewRoot = workflows[0]?.roots[0];
  assert.equal(reviewRoot?.type, "context");
  assert.deepEqual(reviewRoot?.children[0]?.edge.conditions, ["when external context is requested"]);
  assert.equal(reviewRoot?.children[0]?.node.type, "review_pass");
  assert.equal(reviewRoot?.children[0]?.node.children[0]?.node.type, "publish");
  assert.equal(reviewRoot?.children[0]?.node.children[0]?.node.children[0]?.node.type, "pr_review");
  assert.deepEqual(reviewRoot?.children[0]?.node.children[0]?.node.children[0]?.node.collapsedDependencies.map((edge: { from: string }) => edge.from), ["review_pass"]);

  const ontologyRoot = workflows[1]?.roots[0];
  assert.equal(ontologyRoot?.type, "ontology_ingest");
  assert.equal(ontologyRoot?.definition.triggeredBy[0]?.source, "POST /ontology/build");
  assert.equal(ontologyRoot?.children[0]?.node.type, "ontology_assert");
  assert.equal(ontologyRoot?.children[0]?.node.children[0]?.node.type, "ontology_project");
  assert.equal(ontologyRoot?.children[0]?.node.children[0]?.node.children[0]?.node.type, "ontology_build");
  assert.deepEqual(
    ontologyRoot?.children[0]?.node.children[0]?.node.children[0]?.node.collapsedDependencies.map((edge: { from: string }) => edge.from),
    ["ontology_ingest", "ontology_assert"]
  );

  const issueTraceOrderingSource = script.match(/function isCausationQuestion\(question\) \{[\s\S]+?\n\}\n\nfunction renderIssueTrace/)?.[0]
    .replace(/\n\nfunction renderIssueTrace$/, "");
  assert.ok(issueTraceOrderingSource);
  const issueTraceSections = new Function(`${issueTraceOrderingSource}; return issueTraceSections;`)() as (
    trace: Record<string, unknown>,
    question: string
  ) => Array<{ kind: string; value: { sha?: string; pullRequestNumber?: number } }>;
  const issueTrace = {
    introducedBy: [{ sha: "334234bffedc" }],
    resolutions: [{ pullRequestNumber: 5 }]
  };
  assert.deepEqual(
    issueTraceSections(issueTrace, 'Which PR or commit caused "Administrators cannot delete resources", and why?')
      .map((section) => section.kind),
    ["cause", "resolution"]
  );
  assert.equal(issueTraceSections(issueTrace, "Which PR fixed the issue?")[0]?.value.pullRequestNumber, 5);
});
