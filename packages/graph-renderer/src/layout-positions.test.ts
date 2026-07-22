import assert from "node:assert/strict";
import test from "node:test";
import { initializeGraphPositions } from "./layout-positions.js";

test("restores cached positions for nodes that were hidden and re-enabled", () => {
  const cached = new Map([
    ["repository", [2048, 2048] as const],
    ["file", [1980, 2110] as const]
  ]);
  const { positions, reusedPositionCount } = initializeGraphPositions(
    [{ id: "repository" }, { id: "file" }],
    [{ source: "repository", target: "file" }],
    cached
  );

  assert.equal(reusedPositionCount, 2);
  assert.deepEqual([...positions], [2048, 2048, 1980, 2110]);
});

test("places a newly enabled node close to a visible neighbor", () => {
  const { positions } = initializeGraphPositions(
    [{ id: "repository" }, { id: "file" }],
    [{ source: "repository", target: "file" }],
    new Map([["repository", [2048, 2048] as const]])
  );

  assert.ok(Math.hypot((positions[2] ?? 0) - 2048, (positions[3] ?? 0) - 2048) <= 28.01);
});

test("keeps a disconnected new node near the existing graph instead of graph-space edges", () => {
  const { positions } = initializeGraphPositions(
    [{ id: "a" }, { id: "b" }, { id: "new-island" }],
    [],
    new Map([
      ["a", [2000, 2000] as const],
      ["b", [2100, 2100] as const]
    ])
  );

  assert.ok(Math.hypot((positions[4] ?? 0) - 2050, (positions[5] ?? 0) - 2050) <= 48.01);
});
