export const PRODUCT_DASHBOARD_ROUTES = [
  "/",
  "/billing",
  "/causal-graph",
  "/context",
  "/integrations",
  "/issues",
  "/issues/[id]",
  "/models",
  "/organization",
  "/organization/settings",
  "/reviews",
  "/reviews/[reviewRunId]",
  "/reviews/[reviewRunId]/scenarios/[scenarioId]",
  "/runs",
  "/signin",
  "/settings",
  "/usage"
] as const;

export const OPERATIONS_DASHBOARD_ROUTES = ["/board", "/history", "/tasks", "/operations/context"] as const;

const OPERATIONS_PREFIXES = ["/board", "/history", "/tasks", "/operations"] as const;

export function isOperationsPath(pathname: string): boolean {
  return OPERATIONS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
