import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPH_HEIGHT, GRAPH_WIDTH, layoutGraph } from "./graph-layout.ts";
import type { AdminGraphNode } from "./jina-api.ts";

function graphNode(id: string): AdminGraphNode {
  return { id, kind: "File", label: id, description: "", evidence: [] };
}

test("layoutGraph is deterministic and keeps nodes in the viewport", () => {
  const nodes = [graphNode("a"), graphNode("b"), graphNode("c")];
  const edges = [{ id: "ab", source: "a", target: "b", predicate: "DEPENDS_ON", plane: "code" as const, evidence: [] }];

  const first = layoutGraph(nodes, edges);
  assert.deepEqual(first, layoutGraph(nodes, edges));
  assert.equal(first.length, nodes.length);
  for (const node of first) {
    assert.ok(node.x >= 40 && node.x <= GRAPH_WIDTH - 40);
    assert.ok(node.y >= 40 && node.y <= GRAPH_HEIGHT - 40);
  }
});
