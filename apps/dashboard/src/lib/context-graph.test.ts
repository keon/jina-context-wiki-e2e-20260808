import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalNodeContext,
  citationLabels,
  commitShaForNode,
  contextGraphMatches,
  filterContextGraph,
  isCausationQuestion,
  safeExternalUrl,
  selectionIsVisible
} from "./context-graph.ts";
import type { ContextGraphEdge, ContextGraphNode } from "./types.ts";

function node(overrides: Partial<ContextGraphNode> & { readonly id: string }): ContextGraphNode {
  return { kind: "File", label: overrides.id, description: "", evidence: [], ...overrides };
}

function edge(
  overrides: Partial<ContextGraphEdge> & { readonly id: string; readonly source: string; readonly target: string }
): ContextGraphEdge {
  return { predicate: "CONTAINS", plane: "code", evidence: [], ...overrides };
}

const graph = {
  nodes: [
    node({ id: "repo", kind: "Repository" }),
    node({ id: "file", kind: "File" }),
    node({ id: "issue", kind: "Issue" })
  ],
  edges: [
    edge({ id: "contains", source: "repo", target: "file", predicate: "CONTAINS" }),
    edge({ id: "tracks", source: "repo", target: "issue", predicate: "TRACKS" })
  ]
};

test("filterContextGraph hides node kinds, their edges, and hidden edge predicates", () => {
  assert.deepEqual(
    filterContextGraph(graph, new Set(["File"]), new Set()).nodes.map((item) => item.id),
    ["repo", "issue"]
  );
  assert.deepEqual(
    filterContextGraph(graph, new Set(["File"]), new Set()).edges.map((item) => item.id),
    ["tracks"],
    "edges connected to hidden nodes are also hidden"
  );
  assert.deepEqual(
    filterContextGraph(graph, new Set(), new Set(["TRACKS"])).edges.map((item) => item.id),
    ["contains"],
    "edge relationship types can be hidden independently"
  );
});

test("selectionIsVisible checks the filtered graph, not the full one", () => {
  const filtered = filterContextGraph(graph, new Set(["File"]), new Set());
  assert.equal(selectionIsVisible(null, filtered), true);
  assert.equal(selectionIsVisible({ kind: "node", id: "repo" }, filtered), true);
  assert.equal(selectionIsVisible({ kind: "node", id: "file" }, filtered), false);
  assert.equal(selectionIsVisible({ kind: "edge", id: "tracks" }, filtered), true);
  assert.equal(selectionIsVisible({ kind: "edge", id: "contains" }, filtered), false);
});

test("commitShaForNode reads the label or the canonical description", () => {
  assert.equal(commitShaForNode(node({ id: "c", label: "abcdef1234" })), "abcdef1234");
  assert.equal(commitShaForNode(node({ id: "c", label: "entity:1", description: "repo:acme:sha:abcdef1" })), "abcdef1");
  assert.equal(commitShaForNode(node({ id: "c", label: "not a sha" })), null);
});

test("canonicalNodeContext decodes repo and url descriptions", () => {
  assert.equal(canonicalNodeContext("repo:acme/app:path:src/index.ts"), "acme/app · src/index.ts");
  assert.equal(canonicalNodeContext("url:https://github.com/acme/app"), "https://github.com/acme/app");
  assert.equal(canonicalNodeContext("plain text"), "plain text");
});

test("contextGraphMatches links citations to nodes and edges", () => {
  const state = {
    answer: "yes",
    citations: [
      { kind: "entity", id: "file", path: "src/index.ts", startLine: 3, endLine: 9 },
      { kind: "entity", id: "repo" }
    ]
  };
  const cited = {
    nodes: [
      node({ id: "file", kind: "File", path: "src/index.ts" }),
      node({ id: "repo", kind: "Repository", label: "acme/app" })
    ],
    edges: [edge({ id: "contains", source: "repo", target: "file", predicate: "CONTAINS" })]
  };
  const matches = contextGraphMatches(state, cited);
  assert.deepEqual(matches, [
    { kind: "node", id: "file" },
    { kind: "node", id: "repo" },
    { kind: "edge", id: "contains" }
  ]);
  assert.deepEqual(contextGraphMatches({ error: "nope" }, cited), []);
  assert.deepEqual(contextGraphMatches(null, cited), []);
});

test("contextGraphMatches honours evidence line ranges", () => {
  const state = { citations: [{ kind: "file", id: "c1", path: "src/a.ts", startLine: 10, endLine: 20 }] };
  const overlapping = {
    nodes: [node({ id: "n1", evidence: ["src/a.ts:15-18"] })],
    edges: []
  };
  const disjoint = {
    nodes: [node({ id: "n1", evidence: ["src/a.ts:30-40"] })],
    edges: []
  };
  assert.deepEqual(contextGraphMatches(state, overlapping), [{ kind: "node", id: "n1" }]);
  assert.deepEqual(contextGraphMatches(state, disjoint), []);
});

test("citationLabels never expose internal graph identifiers", () => {
  assert.deepEqual(
    citationLabels([
      { kind: "entity", id: "entity_private" },
      { kind: "assertion", id: "assertion_private" },
      { kind: "observation", id: "observation_private" },
      {
        kind: "code",
        id: "blob_private",
        commitSha: "a".repeat(40),
        path: "src/auth.ts",
        startLine: 12,
        endLine: 14
      }
    ]),
    ["Repository entity", "Semantic assertion", "Repository observation", "src/auth.ts:12"]
  );
});

test("isCausationQuestion detects causal phrasings", () => {
  assert.equal(isCausationQuestion("What caused the outage?"), true);
  assert.equal(isCausationQuestion("Which commit introduced the bug?"), true);
  assert.equal(isCausationQuestion("when did the flakiness start"), true);
  assert.equal(isCausationQuestion("Who owns the billing service?"), false);
  assert.equal(isCausationQuestion(undefined), false);
});

test("safeExternalUrl only allows https github.com links", () => {
  assert.equal(safeExternalUrl("https://github.com/acme/app/pull/1"), "https://github.com/acme/app/pull/1");
  assert.equal(safeExternalUrl("http://github.com/acme/app"), undefined);
  assert.equal(safeExternalUrl("https://evil.example/github.com"), undefined);
  assert.equal(safeExternalUrl(undefined), undefined);
});
