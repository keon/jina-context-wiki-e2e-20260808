import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderDashboardPage } from "./page.js";

function dashboardScript(): string {
  const html = renderDashboardPage("https://api.example.test");
  const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  return script;
}

function extractFunction(script: string, source: RegExp, trailer: RegExp): string {
  const match = source.exec(script)?.[0].replace(trailer, "");
  assert.ok(match);
  return match;
}

test("dashboard page renders its main views and valid client script", () => {
  const html = renderDashboardPage("https://api.example.test");

  for (const [path, page] of [
    ["/", "board"],
    ["/history", "history"],
    ["/tasks", "task-types"],
    ["/context-graph", "contextGraph"]
  ]) {
    assert.match(html, new RegExp(`href="${path}" data-page="${page}"`));
  }

  assert.match(html, /aria-label="Task board"/);
  assert.match(html, /aria-label="Task dependency trees"/);
  assert.match(html, /aria-label="Repository context graph"/);
  assert.match(html, /aria-label="Search with citations"/);
  assert.match(html, /Review proposed knowledge/);
  assert.match(html, /Explanation/);
  assert.match(html, /assets\/context-graph-client\.js/);
  assert.match(html, /https:\/\/api\.example\.test/);

  const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("filterContextGraph hides node kinds, their edges, and hidden edge predicates", () => {
  const html = renderDashboardPage("https://api.example.test");
  const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const filterSource =
    /function filterContextGraph\(graph, hiddenNodeKinds, hiddenEdgePredicates\) \{[\s\S]+?\n\}\n\nfunction selectionIsVisible/
      .exec(script)?.[0]
      .replace(/\n\nfunction selectionIsVisible$/, "");
  assert.ok(filterSource);
  const filterContextGraph = new Function(`${filterSource}; return filterContextGraph;`)() as (
    graph: {
      nodes: { id: string; kind: string }[];
      edges: { id: string; source: string; target: string; predicate: string }[];
    },
    hiddenNodeKinds: Set<string>,
    hiddenEdgePredicates: Set<string>
  ) => { nodes: { id: string }[]; edges: { id: string }[] };
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
    filterContextGraph(graph, new Set(["File"]), new Set()).nodes.map((node) => node.id),
    ["repo", "issue"]
  );
  assert.deepEqual(
    filterContextGraph(graph, new Set(["File"]), new Set()).edges.map((edge) => edge.id),
    ["tracks"],
    "edges connected to hidden nodes are also hidden"
  );
  assert.deepEqual(
    filterContextGraph(graph, new Set(), new Set(["TRACKS"])).edges.map((edge) => edge.id),
    ["contains"],
    "edge relationship types can be hidden independently"
  );
});

test("contextGraphMatches highlights only graph elements supported by cited evidence", () => {
  const script = dashboardScript();
  const source = extractFunction(
    script,
    /function contextGraphMatches\(state, graph\) \{[\s\S]+?\n\}\n\nfunction friendlyNodeExplanation/,
    /\n\nfunction friendlyNodeExplanation$/
  );
  const contextGraphMatches = new Function(`${source}; return contextGraphMatches;`)() as (
    state: Record<string, unknown>,
    graph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  ) => { kind: string; id: string }[];
  const graph = {
    nodes: [
      {
        id: "file",
        kind: "File",
        label: "page.ts",
        path: "apps/dashboard/app/page.ts",
        evidence: ["apps/dashboard/app/page.ts:1"]
      },
      { id: "symbol", kind: "Symbol", label: "render", evidence: ["apps/dashboard/app/page.ts:1001"] },
      { id: "issue", kind: "Issue", label: "Guest denial semantics", evidence: ["observation:observation-1"] },
      { id: "unrelated", kind: "Document", label: "denial", description: "unrelated", evidence: ["UNRELATED.md:1"] }
    ],
    edges: [
      {
        id: "declares",
        source: "file",
        target: "symbol",
        predicate: "DECLARES",
        evidence: ["apps/dashboard/app/page.ts:1001"]
      },
      { id: "tracks", source: "file", target: "issue", predicate: "TRACKS", evidence: ["observation:observation-1"] }
    ]
  };
  const state = {
    citations: [
      { kind: "observation", id: "observation-1", repository: "omxyz/jina" },
      {
        kind: "code",
        id: "code-1",
        repository: "omxyz/jina",
        path: "apps/dashboard/app/page.ts",
        startLine: 1001,
        endLine: 1001
      }
    ],
    citedClaims: [],
    calls: []
  };
  const matches = new Set(contextGraphMatches(state, graph).map((match) => `${match.kind}:${match.id}`));
  for (const expected of ["node:file", "node:symbol", "node:issue", "edge:declares", "edge:tracks"]) {
    assert.ok(matches.has(expected), `cited evidence maps to ${expected}`);
  }
  assert.equal(matches.has("node:unrelated"), false, "uncited elements are not highlighted");
});

test("partitionBoardTasks keeps only the latest context graph request current", () => {
  const script = dashboardScript();
  const source = extractFunction(
    script,
    /function partitionBoardTasks\(tasks\) \{[\s\S]+?\n\}\n\nfunction renderColumns/,
    /\n\nfunction renderColumns$/
  );
  const partition = new Function(`${source}; return partitionBoardTasks;`)() as (tasks: unknown[]) => {
    current: { id: string }[];
    history: { id: string }[];
  };
  const metadata = (requestKey: string) => ({ tenantId: "t", repository: "o/r", ref: "main", requestKey });
  const result = partition([
    {
      id: "old-root",
      type: "context_graph_build",
      status: "failed",
      createdAt: "2026-01-01",
      metadata: metadata("old")
    },
    {
      id: "old-project",
      type: "context_graph_project",
      status: "canceled",
      createdAt: "2026-01-01",
      metadata: metadata("old")
    },
    { id: "new-root", type: "context_graph_build", status: "done", createdAt: "2026-01-02", metadata: metadata("new") },
    {
      id: "new-project",
      type: "context_graph_project",
      status: "done",
      createdAt: "2026-01-02",
      metadata: metadata("new")
    },
    { id: "old-review", type: "review_pass", status: "superseded", createdAt: "2026-01-01", metadata: {} },
    { id: "issue", type: "issue_triage", status: "triage", createdAt: "2026-01-02", metadata: {} }
  ]);
  assert.deepEqual(
    result.current.map((task) => task.id),
    ["new-root", "new-project", "issue"]
  );
  assert.deepEqual(
    result.history.map((task) => task.id),
    ["old-root", "old-project", "old-review"]
  );
});

test("buildWorkflowTrees renders the context graph workflow as a rooted chain", () => {
  const script = dashboardScript();
  const source = extractFunction(
    script,
    /function buildWorkflowTrees\(definitions\) \{[\s\S]+?\nfunction renderWorkflowTrees/,
    /\nfunction renderWorkflowTrees$/
  );
  interface WorkflowTreeNode {
    type: string;
    definition: { triggeredBy: { source: string }[] };
    collapsedDependencies: { from: string }[];
    children: { edge: { conditions: string[] }; node: WorkflowTreeNode }[];
  }
  const buildWorkflowTrees = new Function(`${source}; return buildWorkflowTrees;`)() as (
    definitions: unknown[]
  ) => { name: string; roots: WorkflowTreeNode[] }[];
  const dependency = (taskType: string) => ({
    taskType,
    relationships: ["blocks"],
    workflows: ["context_graph_build"],
    required: true,
    conditions: []
  });
  const dependencies: Record<string, unknown[]> = {
    context_graph_build: [
      dependency("context_graph_ingest"),
      dependency("context_graph_assert"),
      dependency("context_graph_project")
    ],
    context_graph_assert: [dependency("context_graph_ingest")],
    context_graph_project: [dependency("context_graph_assert")]
  };
  const definitions = [
    "context_graph_build",
    "context_graph_ingest",
    "context_graph_assert",
    "context_graph_project"
  ].map((type) => ({
    type,
    kind: type.endsWith("build") ? "aggregate" : "dispatchable",
    description: type,
    triggeredBy:
      type === "context_graph_ingest"
        ? [{ source: "POST /context-graph/build", description: "Queues the first executable stage.", conditions: [] }]
        : [],
    dependsOn: dependencies[type] ?? []
  }));
  const workflows = buildWorkflowTrees(definitions);
  assert.deepEqual(
    workflows.map((workflow) => workflow.name),
    ["context_graph_build"]
  );
  const root = workflows[0]?.roots[0];
  assert.equal(root?.type, "context_graph_ingest");
  assert.equal(root?.definition.triggeredBy[0]?.source, "POST /context-graph/build");
  assert.equal(root?.children[0]?.node.type, "context_graph_assert");
  assert.equal(root?.children[0]?.node.children[0]?.node.type, "context_graph_project");
  assert.equal(root?.children[0]?.node.children[0]?.node.children[0]?.node.type, "context_graph_build");
  assert.deepEqual(
    root?.children[0]?.node.children[0]?.node.children[0]?.node.collapsedDependencies.map((edge) => edge.from),
    ["context_graph_ingest", "context_graph_assert"]
  );
});

test("context graph renderer numeric contracts scale with node count", () => {
  const source = readFileSync(new URL("../../app/context-graph-client.ts", import.meta.url), "utf8");
  const numericFunction = (name: string): ((nodeCount: number) => number) => {
    const match = new RegExp(`function ${name}\\(nodeCount: number\\): number \\{[\\s\\S]+?\\n\\}`).exec(source)?.[0];
    assert.ok(match);
    return new Function(`${match.replace(/: number/g, "")}; return ${name};`)() as (nodeCount: number) => number;
  };

  const settleDuration = numericFunction("settleDuration");
  assert.equal(settleDuration(120), 1400);
  assert.equal(settleDuration(500), 1700);
  assert.equal(settleDuration(2000), 2000);
  assert.equal(settleDuration(6000), 2400);

  const topologyLinkDistance = numericFunction("topologyLinkDistance");
  assert.equal(topologyLinkDistance(120), 64);
  assert.equal(topologyLinkDistance(500), 42);
  assert.equal(topologyLinkDistance(2000), 28);
  assert.equal(topologyLinkDistance(6000), 18);

  const initialFitPadding = numericFunction("initialFitPadding");
  assert.equal(initialFitPadding(120), 0.16);
  assert.equal(initialFitPadding(500), 0.22);
  assert.equal(initialFitPadding(2000), 0.26);
  assert.equal(initialFitPadding(6000), 0.3);
});
