import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboardPage } from "./page.js";

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
  assert.match(html, /aria-label="Repository contextGraph graph"/);
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
