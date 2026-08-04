import assert from "node:assert/strict";
import test from "node:test";
import { isOperationsPath, OPERATIONS_DASHBOARD_ROUTES, PRODUCT_DASHBOARD_ROUTES } from "./dashboard-routes.ts";

test("the dashboard retains the complete customer route inventory", () => {
  assert.deepEqual(PRODUCT_DASHBOARD_ROUTES, [
    "/",
    "/billing",
    "/causal-graph",
    "/context",
    "/integrations",
    "/issues",
    "/issues/[id]",
    "/jina",
    "/models",
    "/organization",
    "/reviews",
    "/reviews/[reviewRunId]",
    "/reviews/[reviewRunId]/scenarios/[scenarioId]",
    "/runs",
    "/signin",
    "/settings",
    "/usage"
  ]);
});

test("the operations routes remain available without colliding with customer Context", () => {
  assert.deepEqual(OPERATIONS_DASHBOARD_ROUTES, ["/board", "/history", "/tasks", "/operations/context"]);
  for (const pathname of OPERATIONS_DASHBOARD_ROUTES) assert.equal(isOperationsPath(pathname), true);
  for (const pathname of ["/", "/reviews", "/context", "/issues/issue-1"]) {
    assert.equal(isOperationsPath(pathname), false);
  }
});
