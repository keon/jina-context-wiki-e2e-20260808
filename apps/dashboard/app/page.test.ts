import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(html, /assets\/ontology-graph-client\.js/);
  assert.match(html, /function ensureOntologyRenderer/);
  assert.match(html, /if \(showingOntology\)/);
  assert.match(html, /aria-label="Repository ontology graph"/);
  assert.match(html, /id="ontology-label-layer"/);
  assert.match(html, /id="ontology-minimap"/);
  assert.match(html, /id="graph-runtime-status"/);
  assert.match(html, /aria-label="Graph visibility controls"/);
  assert.match(html, /function filterOntologyGraph/);
  assert.match(html, /function renderGraphControls/);
  assert.match(html, /filterMenuOpen: false/);
  assert.match(html, /filters\.open = ontologyViewState\.filterMenuOpen/);
  assert.match(html, /ontologyViewState\.filterMenuOpen = Boolean\(menu\?\.open\)/);
  assert.match(html, /function ontologyGraphIdentity/);
  assert.match(html, /function resetOntologyViewForGraph/);
  assert.match(html, /function friendlyNodeLabel/);
  assert.match(html, /function friendlyNodeExplanation/);
  assert.match(html, /ontologyRefreshSequence/);
  assert.match(html, /requestSequence !== ontologyRefreshSequence/);
  assert.match(html, /touch-action: none/);
  assert.match(html, /cosmos-node-label/);
  assert.match(html, /cosmos-edge-label/);
  assert.match(html, /ontology-workspace:not\(.has-selection\)/);
  assert.match(html, /function toggleGraphFilter/);
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
  assert.match(html, /Remove all/);
  assert.match(html, /for \(const entry of nodeKinds\) ontologyViewState\.hiddenNodeKinds\.add\(entry\[0\]\)/);
  assert.match(html, /for \(const entry of edgePredicates\) ontologyViewState\.hiddenEdgePredicates\.add\(entry\[0\]\)/);
  assert.match(html, /graph-reset", "Reset"/);
  assert.doesNotMatch(html, /graph-physics-control/);
  assert.doesNotMatch(html, /ontology-description/);
  assert.doesNotMatch(html, /view-switch ontology-view/);
  assert.match(html, /id="context-query"/);
  assert.doesNotMatch(html, /Search your repository/);
  assert.match(html, /placeholder="Ask anything about this repository…"/);
  assert.match(html, /aria-label="Search with citations"/);
  assert.match(html, />↵<\/button>/);
  assert.match(html, /id="context-search-results"/);
  assert.match(html, /function contextGraphMatches/);
  assert.match(html, /function renderContextPrimary/);
  assert.match(html, /function contextMatchConfidence/);
  assert.match(html, /View full evidence/);
  assert.match(html, /let contextEvidenceExpanded = false/);
  assert.match(html, /evidence\.open = contextEvidenceExpanded/);
  assert.match(html, /contextEvidenceExpanded = evidence\.open/);
  assert.match(html, /if \(contextEvidenceExpanded\) return/);
  assert.match(html, /event\.stopPropagation\(\)/);
  assert.match(html, /contextSearchResults\.scrollTop \+= event\.deltaY/);
  assert.match(html, /overscroll-behavior: contain/);
  assert.match(html, /let contextRequestSequence = 0/);
  assert.match(html, /function invalidateContextRequest/);
  assert.match(html, /signal: abortController\.signal/);
  assert.match(html, /ontologyGraphIdentity\(ontologyState\.latest\) !== graphKey/);
  assert.match(html, /ontologyRenderer\.setSearchMatches\(contextGraphMatches/);
  assert.ok(html.indexOf('id="context-query"') < html.indexOf('class="ontology-workspace"'));
  assert.doesNotMatch(html, /id="ontology-search"/);
  assert.doesNotMatch(html, /Search graph…/);
  assert.doesNotMatch(html, /context-drawer/);
  assert.doesNotMatch(html, /ontologyRenderer\.find/);
  assert.doesNotMatch(html, /Grouped layout/);
  assert.match(html, /Cited repository answer/);
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
  assert.match(html, /function renderCounterfactualDetails/);
  assert.match(html, /Basis: /);
  assert.match(html, /Known paths removed/);
  assert.match(html, /Known paths remaining/);
  assert.match(html, /function renderCausalTrace/);
  assert.match(html, /Review proposed knowledge/);
  assert.match(html, /id="assertion-predicate-filter"/);
  assert.match(html, /id="assertion-kind-filter"/);
  assert.match(html, /function renderAssertionReview/);
  assert.match(html, /function assertionRejectionFields/);
  assert.match(html, /await reviewAssertion\(button\.dataset\.assertionId, decision, rejectionCode, reason\)/);
  assert.match(html, /supportingAssertionIds/);
  assert.match(html, /contradictingAssertionIds/);
  for (const kind of ["Feature", "Package", "Service", "Deployment", "Incident", "Issue"]) {
    assert.match(html, new RegExp(`kind-${kind}`));
  }
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

  const contextMatchSource = script.match(/function contextGraphMatches\(state, graph\) \{[\s\S]+?\n\}\n\nfunction friendlyNodeExplanation/)?.[0]
    .replace(/\n\nfunction friendlyNodeExplanation$/, "");
  assert.ok(contextMatchSource);
  const contextGraphMatches = new Function(`${contextMatchSource}; return contextGraphMatches;`)() as (
    state: Record<string, unknown>,
    graph: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }
  ) => Array<{ kind: string; id: string }>;
  const searchableGraph = {
    nodes: [
      { id: "repo", kind: "Repository", label: "omxyz/jina", description: "repo:omxyz/jina", evidence: ["README.md:1"] },
      { id: "file", kind: "File", label: "page.ts", description: "apps/dashboard/app/page.ts", path: "apps/dashboard/app/page.ts", evidence: ["apps/dashboard/app/page.ts:1"] },
      { id: "symbol", kind: "Symbol", label: "renderOntology", description: "function in page.ts", path: "apps/dashboard/app/page.ts", evidence: ["apps/dashboard/app/page.ts:1001"] },
      { id: "issue", kind: "Issue", label: "Guest denial semantics", description: "github issue", evidence: ["observation:observation-1"] },
      { id: "pr", kind: "PullRequest", label: "#5 Fix guest denial semantics", description: "pull request", evidence: ["observation:observation-2"] },
      { id: "commit", kind: "Commit", label: "d80aa666dd41", description: "repo:omxyz/jina:sha:d80aa666dd41a423d2775b8c0c47ba20d53facef", evidence: ["ROOT_CAUSE.md:2"] },
      { id: "unrelated", kind: "Document", label: "denial", description: "unrelated document", evidence: ["UNRELATED.md:1"] },
      { id: "range-source", kind: "Team", label: "Range source", description: "range source", evidence: [] },
      { id: "range-target", kind: "Engineer", label: "Range target", description: "range target", evidence: [] }
    ],
    edges: [
      { id: "declares", source: "file", target: "symbol", predicate: "DECLARES", plane: "code", evidence: ["apps/dashboard/app/page.ts:1001"] },
      { id: "tracks", source: "repo", target: "issue", predicate: "TRACKS", plane: "knowledge", evidence: ["observation:observation-1"] },
      { id: "resolves", source: "pr", target: "issue", predicate: "RESOLVES", plane: "knowledge", evidence: ["observation:observation-2"] },
      { id: "merged", source: "pr", target: "commit", predicate: "MERGED_AS", plane: "knowledge", evidence: ["ROOT_CAUSE.md:2"] },
      { id: "range-only", source: "range-source", target: "range-target", predicate: "AUTHORED_BY", plane: "knowledge", evidence: ["apps/dashboard/app/page.ts:1001"] }
    ]
  };
  const citedState = {
    citations: [
      { kind: "observation", id: "observation-1", repository: "omxyz/jina" },
      { kind: "code", id: "code-1", repository: "omxyz/jina", path: "apps/dashboard/app/page.ts", startLine: 1001, endLine: 1001, commitSha: "d80aa666dd41a423d2775b8c0c47ba20d53facef" }
    ],
    citedClaims: [],
    calls: [{
      items: [{
        title: "#5 Fix guest denial semantics resolves Guest denial semantics",
        data: { predicate: "RESOLVES", issue: { title: "Guest denial semantics" }, commitSha: "d80aa666dd41a423d2775b8c0c47ba20d53facef" },
        citations: [{ kind: "assertion", id: "assertion-1", repository: "omxyz/jina" }]
      }]
    }]
  };
  const citedMatches = new Set(contextGraphMatches(citedState, searchableGraph).map((match) => `${match.kind}:${match.id}`));
  for (const expected of ["node:file", "node:symbol", "node:issue", "node:pr", "node:commit", "edge:declares", "edge:tracks", "edge:resolves", "edge:merged", "edge:range-only"]) {
    assert.ok(citedMatches.has(expected), `cited evidence maps to ${expected}`);
  }
  assert.equal(citedMatches.has("node:unrelated"), false, "retrieval-title substrings do not create unsupported graph matches");
  const withoutFiles = filterOntologyGraph(searchableGraph, new Set(["File", "Symbol"]), new Set()) as typeof searchableGraph;
  const filteredMatches = new Set(contextGraphMatches(citedState, withoutFiles).map((match) => `${match.kind}:${match.id}`));
  assert.equal(filteredMatches.has("node:file"), false, "citation highlights respect active graph visibility filters");
  assert.equal(filteredMatches.has("edge:declares"), false, "hidden graph relationships are not highlighted");

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
  assert.equal(issueTraceSections(issueTrace, "When did the problem first start?")[0]?.value.sha, "334234bffedc");
  assert.equal(issueTraceSections(issueTrace, "Which PR fixed the issue?")[0]?.value.pullRequestNumber, 5);
});

test("ontology graph settles quickly without continuous camera fitting", () => {
  const source = readFileSync(new URL("../../app/ontology-graph-client.ts", import.meta.url), "utf8");

  assert.match(source, /simulationFriction: 0\.45/);
  assert.match(source, /simulationDecay: 150/);
  assert.match(source, /simulationGravity: 0\.012/);
  assert.match(source, /simulationRepulsion: 1\.6/);
  assert.match(source, /simulationLinkDistance: 64/);
  assert.match(source, /simulationLinkDistance: topologyLinkDistance\(data\.nodes\.length\)/);
  assert.doesNotMatch(source, /lastAutoFit/);
  assert.doesNotMatch(source, /now - this\.lastAutoFit/);
  assert.doesNotMatch(source, /scheduleFitSequence/);
  assert.doesNotMatch(source, /fitTimers/);
  assert.doesNotMatch(source, /warmupSteps/);
  assert.match(source, /this\.graph\.fitView\(0, initialFitPadding\(data\.nodes\.length\), true\);\n\s+this\.startSettling\(0\.65/);
  assert.match(source, /if \(reusedPositionCount === 0\) centerPositions\(positions\)/);
  assert.match(source, /function centerPositions\(positions: Float32Array\): void/);
  assert.match(source, /const GRAPH_SPACE_CENTER = GRAPH_SPACE_SIZE \/ 2/);
  assert.match(source, /spaceSize: GRAPH_SPACE_SIZE/);
  assert.match(source, /- centerX \+ GRAPH_SPACE_CENTER/);

  const settleDurationSource = source.match(/function settleDuration\(nodeCount: number\): number \{[\s\S]+?\n\}/)?.[0];
  assert.ok(settleDurationSource);
  const settleDuration = new Function(`${settleDurationSource.replace(/: number/g, "")}; return settleDuration;`)() as (nodeCount: number) => number;
  assert.equal(settleDuration(120), 1400);
  assert.equal(settleDuration(500), 1700);
  assert.equal(settleDuration(2000), 2000);
  assert.equal(settleDuration(6000), 2400);

  const topologyLinkDistanceSource = source.match(/function topologyLinkDistance\(nodeCount: number\): number \{[\s\S]+?\n\}/)?.[0];
  assert.ok(topologyLinkDistanceSource);
  const topologyLinkDistance = new Function(`${topologyLinkDistanceSource.replace(/: number/g, "")}; return topologyLinkDistance;`)() as (nodeCount: number) => number;
  assert.equal(topologyLinkDistance(120), 64);
  assert.equal(topologyLinkDistance(500), 42);
  assert.equal(topologyLinkDistance(2000), 28);
  assert.equal(topologyLinkDistance(6000), 18);

  const initialFitPaddingSource = source.match(/function initialFitPadding\(nodeCount: number\): number \{[\s\S]+?\n\}/)?.[0];
  assert.ok(initialFitPaddingSource);
  const initialFitPadding = new Function(`${initialFitPaddingSource.replace(/: number/g, "")}; return initialFitPadding;`)() as (nodeCount: number) => number;
  assert.equal(initialFitPadding(120), 0.16);
  assert.equal(initialFitPadding(500), 0.22);
  assert.equal(initialFitPadding(2000), 0.26);
  assert.equal(initialFitPadding(6000), 0.3);
});
