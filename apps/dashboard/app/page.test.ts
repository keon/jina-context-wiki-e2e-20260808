import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboardPage } from "./page.js";

test("dashboard page renders clickable task detail affordances", () => {
  const html = renderDashboardPage("https://api.example.test");

  assert.match(html, /data-task-id/);
  assert.match(html, /href="\/" data-page="board"/);
  assert.match(html, /href="\/history" data-page="history"/);
  assert.match(html, /href="\/tasks" data-page="task-types"/);
  assert.match(html, /href="\/ontology" data-page="ontology"/);
  assert.match(html, /aria-label="Task board"/);
  assert.match(html, /aria-label="Task type list"/);
  assert.match(html, /class="app-header"/);
  assert.match(html, /class="brand-mark"/);
  assert.match(html, /--accent: #8b7cf6/);
  assert.match(html, /background-image: radial-gradient\(circle, #292929 1px/);
  assert.match(html, /function renderColumns/);
  assert.match(html, /function partitionBoardTasks/);
  assert.match(html, /latestRequestByScope/);
  assert.match(html, /id="history-list"/);
  assert.match(html, /id="history-details"/);
  assert.match(html, /function renderHistory/);
  assert.match(html, /function renderHistoryInspector/);
  assert.match(html, /function renderTaskTypes/);
  assert.match(html, /id="task-type-details"/);
  assert.match(html, /function renderTaskTypeInspector/);
  assert.match(html, /Workflow dependency trees/);
  assert.match(html, /completing a prerequisite unblocks/);
  assert.match(html, /aria-label="Task dependency trees"/);
  assert.match(html, /function buildWorkflowTrees/);
  assert.match(html, /function renderWorkflowTrees/);
  assert.match(html, /function renderWorkflowBranch/);
  assert.match(html, /function workflowTrigger/);
  assert.match(html, /function taskTypeTriggerGroup/);
  assert.match(html, /Triggered by/);
  assert.match(html, /Prerequisite tasks/);
  assert.match(html, /No prerequisite task/);
  assert.match(html, /↓ unblocks/);
  assert.match(html, /Also directly waits for:/);
  assert.match(html, /function taskTypeDependencyGroups/);
  assert.match(html, /Depends on/);
  assert.match(html, /Required by/);
  assert.match(html, /workflow: /);
  assert.match(html, /function renderOntology/);
  assert.match(html, /class="ontology-workspace"/);
  assert.match(html, /function appendGraphDefinitions/);
  assert.match(html, /if \(showingOntology\)/);
  assert.match(html, /aria-label="Repository ontology graph"/);
  assert.match(html, /\.kind-Feature circle/);
  assert.match(html, /aria-label="Graph visibility controls"/);
  assert.match(html, /function filterOntologyGraph/);
  assert.match(html, /function renderGraphControls/);
  assert.match(html, /filterMenuOpen: false/);
  assert.match(html, /filters\.open = ontologyViewState\.filterMenuOpen/);
  assert.match(html, /ontologyViewState\.filterMenuOpen = Boolean\(menu\?\.open\)/);
  assert.match(html, /function graphEdgeGeometry/);
  assert.match(html, /function focusedGraphElements/);
  assert.match(html, /function ontologyGraphIdentity/);
  assert.match(html, /function resetOntologyViewForGraph/);
  assert.match(html, /function friendlyNodeLabel/);
  assert.match(html, /function friendlyNodeExplanation/);
  assert.match(html, /function enableGraphDrag/);
  assert.match(html, /function handleGraphPointerMove/);
  assert.match(html, /nodePositions: new Map/);
  assert.match(html, /edgeOffsets: new Map/);
  assert.match(html, /ontologyRefreshSequence/);
  assert.match(html, /requestSequence !== ontologyRefreshSequence/);
  assert.match(html, /touch-action: pan-x pan-y pinch-zoom/);
  assert.match(html, /event\.pointerType === "touch"/);
  assert.doesNotMatch(html, /suppressClickUntil/);
  assert.match(html, /graph-edge-label-button/);
  assert.match(html, /function toggleGraphFilter/);
  assert.match(html, /function makeGraphItemInteractive/);
  assert.match(html, /function renderOntologyInspector/);
  assert.match(html, /button\.disabled = true/);
  assert.match(html, /edit\.disabled = run\.disabled = true/);
  assert.match(html, /function ontologyExplanation/);
  assert.match(html, /function connectedConfidenceSummary/);
  assert.match(html, /function ontologyConfidence/);
  assert.match(html, /function ontologyEvidenceSection/);
  assert.match(html, /function ontologyRelationshipSection/);
  assert.match(html, /data-filter-group/);
  assert.match(html, /Select a node or relationship/);
  assert.match(html, /Visible relationships/);
  assert.match(html, /Connected relationship confidence/);
  assert.match(html, /Nodes do not carry a direct confidence score/);
  assert.match(html, /Direct confidence score stored on this relationship/);
  assert.match(html, /"Explanation"/);
  assert.match(html, /No relationship explanation provided/);
  assert.match(html, /Evidence · /);
  assert.match(html, /Show all/);
  assert.match(html, /Reset layout/);
  assert.match(html, /Select any item to focus only its direct connections/);
  assert.match(html, /Ask with citations/);
  assert.match(html, /function renderIssueTrace/);
  assert.match(html, /function issueTraceEntity/);
  assert.match(html, /function issueTraceSections/);
  assert.match(html, /function renderCauseTrace/);
  assert.match(html, /function traceEvidence/);
  assert.match(html, /function appendTraceCitations/);
  assert.match(html, /trace-fact-label/);
  assert.match(html, /"Why"/);
  assert.match(html, /"Evidence"/);
  assert.match(html, /"Later fix"/);
  assert.match(html, /was caused by/);
  assert.match(html, /No verified pull request or commit relationship has been asserted/);
  assert.match(html, /\/ontology\/ask/);
  assert.match(html, /function renderContextResults/);
  assert.match(html, /function renderContextAnswer/);
  assert.match(html, /function renderContextNotices/);
  assert.match(html, /Cited claims/);
  assert.match(html, /Coverage gap/);
  assert.match(html, /item\.data\.excerpt/);
  assert.doesNotMatch(html, /function renderTaskList/);
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

  const focusedSource = script.match(/function focusedGraphElements\(selection, graph\) \{[\s\S]+?\n\}\n\nfunction friendlyNodeLabel/)?.[0]
    .replace(/\n\nfunction friendlyNodeLabel$/, "");
  assert.ok(focusedSource);
  const focusedGraphElements = new Function(`${focusedSource}; return focusedGraphElements;`)() as (
    selection: { kind: "node" | "edge"; id: string } | null,
    graph: { nodes: Array<{ id: string; kind: string }>; edges: Array<{ id: string; source: string; target: string; predicate: string }> }
  ) => { nodeIds: Set<string>; edgeIds: Set<string> };
  const nodeFocus = focusedGraphElements({ kind: "node", id: "repo" }, graph);
  assert.deepEqual(Array.from(nodeFocus.nodeIds).sort(), ["file", "issue", "repo"]);
  assert.deepEqual(Array.from(nodeFocus.edgeIds).sort(), ["contains", "tracks"]);
  const edgeFocus = focusedGraphElements({ kind: "edge", id: "tracks" }, graph);
  assert.deepEqual(Array.from(edgeFocus.nodeIds).sort(), ["issue", "repo"]);
  assert.deepEqual(Array.from(edgeFocus.edgeIds), ["tracks"]);

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

  const edgeGeometrySource = script.match(/function graphEdgeGeometry\(source, target, index, dragOffset\) \{[\s\S]+?\n\}\n\nfunction svgElement/)?.[0]
    .replace(/\n\nfunction svgElement$/, "");
  assert.ok(edgeGeometrySource);
  const graphEdgeGeometry = new Function(`${edgeGeometrySource}; return graphEdgeGeometry;`)() as (
    source: { x: number; y: number }, target: { x: number; y: number }, index: number, dragOffset?: { x: number; y: number }
  ) => { path: string; labelX: number; labelY: number };
  const geometry = graphEdgeGeometry({ x: 0, y: 0 }, { x: 0, y: 100 }, 0);
  assert.match(geometry.path, / Q /);
  assert.notEqual(geometry.labelX, 0, "curved edges move their clickable label away from overlapping nodes");
  const movedGeometry = graphEdgeGeometry({ x: 0, y: 0 }, { x: 0, y: 100 }, 0, { x: 20, y: 10 });
  assert.equal(movedGeometry.labelX - geometry.labelX, 20, "dragging an edge offsets its curve label horizontally");
  assert.equal(movedGeometry.labelY - geometry.labelY, 10, "dragging an edge offsets its curve label vertically");

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
