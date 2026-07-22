import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkflowTrees } from "./workflow-trees.ts";
import type { TaskTypeDefinition } from "./types.ts";

const definitions: readonly TaskTypeDefinition[] = [
  { type: "intake", kind: "dispatchable", description: "Intake" },
  {
    type: "review",
    kind: "dispatchable",
    description: "Review",
    dependsOn: [{ taskType: "intake", workflows: ["pr"] }]
  },
  {
    type: "publish",
    kind: "aggregate",
    description: "Publish",
    dependsOn: [
      { taskType: "review", workflows: ["pr"], conditions: ["review passed"] },
      // Transitively implied by intake -> review -> publish; must collapse.
      { taskType: "intake", workflows: ["pr"] }
    ]
  }
];

test("buildWorkflowTrees reduces transitive edges and roots the tree at intake", () => {
  const trees = buildWorkflowTrees(definitions);
  assert.equal(trees.length, 1);
  const tree = trees[0]!;
  assert.equal(tree.name, "pr");
  assert.equal(tree.typeCount, 3);
  assert.equal(tree.edgeCount, 3);
  assert.deepEqual(
    tree.roots.map((root) => root.type),
    ["intake"]
  );
  const review = tree.roots[0]!.children[0]!.node;
  assert.equal(review.type, "review");
  const publish = review.children[0]!.node;
  assert.equal(publish.type, "publish");
  assert.deepEqual(
    publish.collapsedDependencies.map((edge) => edge.from),
    ["intake"]
  );
});

test("buildWorkflowTrees stops on cycles instead of recursing forever", () => {
  const cyclic: readonly TaskTypeDefinition[] = [
    { type: "a", kind: "dispatchable", description: "A", dependsOn: [{ taskType: "b", workflows: ["loop"] }] },
    { type: "b", kind: "dispatchable", description: "B", dependsOn: [{ taskType: "a", workflows: ["loop"] }] }
  ];
  const trees = buildWorkflowTrees(cyclic);
  assert.equal(trees.length, 1);
  // Every node participates in the cycle, so there is no root; the tree still
  // reports its members without infinite recursion.
  assert.equal(trees[0]!.typeCount, 2);
});
