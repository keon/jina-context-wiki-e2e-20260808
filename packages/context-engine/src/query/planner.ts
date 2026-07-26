import type { QueryContextRequest, QueryPlan, QueryRoute, QueryTaskKind } from "../domain/query.js";

export const QUERY_PLANNER_VERSION = "deterministic-router-v1";

function inferredTask(question: string): QueryTaskKind {
  if (/\b(?:who owns|owner|status|state|open|closed)\b/i.test(question)) return "status";
  if (/\b(?:what changed|change|diff|commit|pull request|pr\s*#?)\b/i.test(question)) return "change";
  if (/\b(?:why|rationale|decision|intent|reason)\b/i.test(question)) return "intent";
  if (/\b(?:calls?|imports?|depends?|inherits?|defined|structure|architecture)\b/i.test(question)) return "structure";
  if (/\b(?:overview|explain|how does|summarize)\b/i.test(question)) return "overview";
  return "lookup";
}

function add(routes: QueryPlan["routes"], route: QueryRoute, reason: string, limit = 12): void {
  if (!routes.some((value) => value.route === route)) routes.push({ route, reason, limit, timeoutMs: 1_000 });
}

export function planContextQuery(request: QueryContextRequest): QueryPlan {
  const question = request.question.trim().replace(/\s+/g, " ");
  if (question === "") throw new Error("question is required");
  const taskKind = request.taskKind ?? inferredTask(question);
  const routes: QueryPlan["routes"] = [];
  const hasExactSignal =
    /(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+|#[1-9][0-9]*|\b[0-9a-f]{7,40}\b|`[^`]+`|[A-Za-z_$][\w$]*\(/.test(question) ||
    (request.targets?.paths?.length ?? 0) > 0 ||
    (request.targets?.symbols?.length ?? 0) > 0;
  if (hasExactSignal || taskKind === "lookup") add(routes, "exact", "identifier, target, or lookup signal");
  if (
    taskKind === "status" ||
    taskKind === "change" ||
    (request.targets?.issues?.length ?? 0) > 0 ||
    (request.targets?.pullRequests?.length ?? 0) > 0
  ) {
    add(routes, "structured", "provider state, change, or explicit provider target");
  }
  if (taskKind === "structure") add(routes, "structural", "deterministic code relationship signal");
  add(routes, "lexical", "baseline token and prose retrieval", 20);
  if (taskKind === "overview") {
    add(routes, "hierarchy", "overview benefits from document hierarchy");
    add(routes, "knowledge", "overview benefits from current cited knowledge");
  }
  if (taskKind === "intent") {
    add(routes, "knowledge", "rationale benefits from cited interpretation");
    add(routes, "temporal", "rationale requires temporally relevant sources");
  }
  if (taskKind === "change") add(routes, "temporal", "change query requires temporally relevant sources");
  if (request.timeWindow) add(routes, "temporal", "explicit time window requires temporal filtering");
  return {
    normalizedQuestion: question,
    taskKind,
    routes,
    targets: {
      paths: request.targets?.paths ?? [],
      symbols: request.targets?.symbols ?? [],
      pullRequests: request.targets?.pullRequests ?? [],
      issues: request.targets?.issues ?? []
    },
    ...(request.timeWindow ? { timeWindow: { ...request.timeWindow } } : {}),
    plannerVersion: QUERY_PLANNER_VERSION
  };
}
