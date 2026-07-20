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
  assert.match(html, /function renderColumns/);
  assert.match(html, /function partitionBoardTasks/);
  assert.match(html, /latestRequestByScope/);
  assert.match(html, /showingHistory \? partition\.history : partition\.current/);
  assert.match(html, /function renderTaskTypes/);
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
  assert.match(html, /if \(showingOntology\)/);
  assert.match(html, /aria-label="Repository ontology graph"/);
  assert.match(html, /\.kind-Feature circle/);
  assert.match(html, /aria-label="Graph visibility controls"/);
  assert.match(html, /function filterOntologyGraph/);
  assert.match(html, /function renderGraphControls/);
  assert.match(html, /function toggleGraphFilter/);
  assert.match(html, /function makeGraphItemInteractive/);
  assert.match(html, /function renderOntologyInspector/);
  assert.match(html, /data-filter-group/);
  assert.match(html, /Select a node or relationship/);
  assert.match(html, /Visible relationships/);
  assert.match(html, /No rationale provided/);
  assert.match(html, /Show all/);
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
