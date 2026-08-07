export const WORKSPACE_NAV_ITEMS = [
  { key: "reviews", label: "Reviews", href: "/reviews" },
  { key: "issues", label: "Issues", href: "/issues" },
  { key: "task-board", label: "Task Board", href: "/board" },
  { key: "context", label: "Wiki", href: "/wiki" },
  { key: "causal-graph", label: "Causal Graph", href: "/causal-graph" },
] as const;

export type WorkspaceNavKey = (typeof WORKSPACE_NAV_ITEMS)[number]["key"];
