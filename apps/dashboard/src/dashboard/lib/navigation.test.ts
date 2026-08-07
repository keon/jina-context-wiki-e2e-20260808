import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_NAV_ITEMS } from "./navigation.ts";

test("Workspace navigation exposes the Task Board as a first-class page", () => {
  assert.deepEqual(WORKSPACE_NAV_ITEMS, [
    { key: "reviews", label: "Reviews", href: "/reviews" },
    { key: "issues", label: "Issues", href: "/issues" },
    { key: "task-board", label: "Task Board", href: "/board" },
    { key: "context", label: "Context Wiki", href: "/context" },
    { key: "causal-graph", label: "Causal Graph", href: "/causal-graph" },
  ]);
});
