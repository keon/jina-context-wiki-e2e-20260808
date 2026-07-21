import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANVAS_EDGE_LIMIT,
  CANVAS_NODE_LIMIT,
  canvasFallbackStatus,
  canvasGraphSlice,
  chooseRendererMode
} from "./ontology-renderer-policy.js";

test("large graphs keep the WebGL renderer when GPU support exists", () => {
  assert.equal(chooseRendererMode(true), "webgl");
  assert.equal(chooseRendererMode(false), "canvas");
});

test("Canvas fallback deterministically bounds a large graph without dangling edges", () => {
  const nodes = Array.from({ length: 5_000 }, (_, index) => ({ id: `node-${index}` }));
  const edges = Array.from({ length: 20_000 }, (_, index) => ({
    id: `edge-${index}`,
    source: `node-${index % nodes.length}`,
    target: `node-${(index * 17 + 11) % nodes.length}`
  }));
  const first = canvasGraphSlice(nodes, edges);
  const second = canvasGraphSlice(nodes, edges);

  assert.equal(first.truncated, true);
  assert.equal(first.nodes.length, CANVAS_NODE_LIMIT);
  assert.ok(first.edges.length <= CANVAS_EDGE_LIMIT);
  assert.deepEqual(first, second);
  const selectedIds = new Set(first.nodes.map((node) => node.id));
  assert.equal(first.edges.every((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)), true);
  assert.equal(
    canvasFallbackStatus(nodes.length, edges.length, first.nodes.length, first.edges.length),
    `Canvas fallback · rendering 1,200 of 5,000 nodes · ${first.edges.length.toLocaleString()} of 20,000 edges`
  );
});

test("Canvas fallback leaves small graphs intact", () => {
  const nodes = [{ id: "a" }, { id: "b" }];
  const edges = [{ id: "a-b", source: "a", target: "b" }];
  const selected = canvasGraphSlice(nodes, edges);
  assert.equal(selected.nodes, nodes);
  assert.equal(selected.edges, edges);
  assert.equal(selected.truncated, false);
  assert.equal(canvasFallbackStatus(2, 1, 2, 1), "Canvas fallback · 2 nodes · 1 edge");
});
