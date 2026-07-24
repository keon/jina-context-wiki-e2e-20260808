import { CONTEXT_GRAPH_DEFAULT_HISTORY_LIMIT, CONTEXT_GRAPH_MAX_HISTORY_LIMIT } from "@jina/context-graph";

export interface ContextGraphHistoryPolicy {
  readonly limit: number;
  readonly traversalLimit: number;
}

export function contextGraphHistoryPolicy(
  requestedLimit: unknown,
  serviceLimit = CONTEXT_GRAPH_MAX_HISTORY_LIMIT,
  defaultLimit = CONTEXT_GRAPH_DEFAULT_HISTORY_LIMIT
): ContextGraphHistoryPolicy {
  if (!Number.isSafeInteger(serviceLimit) || serviceLimit <= 0) {
    throw new Error("context graph service history limit must be a positive integer");
  }
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit <= 0) {
    throw new Error("context graph default history limit must be a positive integer");
  }
  if (requestedLimit === undefined) {
    return { limit: Math.min(defaultLimit, serviceLimit), traversalLimit: serviceLimit };
  }
  if (typeof requestedLimit !== "number" || !Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error("requested context graph history limit must be a positive integer");
  }
  if (requestedLimit > serviceLimit) {
    throw new Error(`requested context graph history limit ${requestedLimit} exceeds service maximum ${serviceLimit}`);
  }
  return { limit: requestedLimit, traversalLimit: serviceLimit };
}
