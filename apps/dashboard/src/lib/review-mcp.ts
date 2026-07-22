import type { BoardEvent, BoardState, BoardTask } from "./types.ts";

export interface ReviewMcpUsageEvent {
  readonly server: string;
  readonly tool: string;
  readonly at?: string;
  readonly status?: string;
  readonly detail?: string;
}

export interface ReviewMcpActivity {
  readonly enabledServers: readonly string[];
  readonly usageEvents: readonly ReviewMcpUsageEvent[];
}

const ENABLED_KEYS = ["mcpServersEnabled", "enabledMcpServers", "mcpServers", "mcpsEnabled"] as const;
const USAGE_KEYS = ["mcpUsageEvents", "mcpEvents", "mcpToolCalls"] as const;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function enabledServers(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const itemRecord = record(item);
      const name = stringValue(item) ?? stringValue(itemRecord?.name) ?? stringValue(itemRecord?.server);
      return name ? [name] : [];
    });
  }
  const valueRecord = record(value);
  return valueRecord ? Object.keys(valueRecord).filter((key) => Boolean(valueRecord[key])) : [];
}

function usageEvents(value: unknown, fallbackAt?: string): readonly ReviewMcpUsageEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const itemRecord = record(item);
    if (!itemRecord) return [];
    const server =
      stringValue(itemRecord.server) ?? stringValue(itemRecord.serverName) ?? stringValue(itemRecord.mcpServer);
    const tool = stringValue(itemRecord.tool) ?? stringValue(itemRecord.toolName) ?? stringValue(itemRecord.name);
    if (!server || !tool) return [];
    const at = stringValue(itemRecord.at) ?? stringValue(itemRecord.timestamp) ?? fallbackAt;
    const status = stringValue(itemRecord.status);
    const detail = stringValue(itemRecord.detail) ?? stringValue(itemRecord.summary);
    const event: ReviewMcpUsageEvent = {
      server,
      tool,
      ...(at ? { at } : {}),
      ...(status ? { status } : {}),
      ...(detail ? { detail } : {})
    };
    return [event];
  });
}

function reviewTaskIds(task: BoardTask, board: BoardState): ReadonlySet<string> {
  const ids = new Set([task.id]);
  if (task.type === "pr_review") {
    for (const candidate of board.tasks) {
      if (candidate.parentTaskId === task.id && candidate.type === "review_pass") ids.add(candidate.id);
    }
  }
  return ids;
}

export function isReviewTask(task: BoardTask): boolean {
  return task.type === "pr_review" || task.type === "review_pass";
}

export function reviewMcpActivity(
  task: BoardTask,
  board: BoardState,
  events: readonly BoardEvent[]
): ReviewMcpActivity {
  const ids = reviewTaskIds(task, board);
  const sources: { readonly value: Readonly<Record<string, unknown>>; readonly at?: string }[] = [];
  if (task.metadata) sources.push({ value: task.metadata });
  for (const candidate of board.tasks) {
    if (ids.has(candidate.id) && candidate.id !== task.id && candidate.metadata)
      sources.push({ value: candidate.metadata });
  }
  for (const event of events) {
    if (event.taskId && ids.has(event.taskId) && event.payload) sources.push({ value: event.payload, at: event.at });
  }

  const servers = new Set<string>();
  const uses: ReviewMcpUsageEvent[] = [];
  for (const source of sources) {
    const nestedResult = record(source.value.result);
    for (const candidate of [source.value, ...(nestedResult ? [nestedResult] : [])]) {
      for (const key of ENABLED_KEYS) for (const server of enabledServers(candidate[key])) servers.add(server);
      for (const key of USAGE_KEYS) uses.push(...usageEvents(candidate[key], source.at));
    }
  }
  for (const use of uses) servers.add(use.server);
  return {
    enabledServers: [...servers].sort((left, right) => left.localeCompare(right)),
    usageEvents: uses.sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""))
  };
}
