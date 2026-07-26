import { PostgresJsonStateStore } from "@jina/db";
import { isTerminalTaskStatus, type TaskStatus } from "@jina/board";

const LEGACY_TASK_MARKERS = ["context_graph", "context-graph"];

export interface LegacyContextTaskAudit {
  readonly tenantId: string;
  readonly legacyTaskCount: number;
  readonly terminalTaskCount: number;
}

export function auditLegacyContextSnapshot(snapshot: unknown, tenantIds: readonly string[]): LegacyContextTaskAudit[] {
  const inventory = [...new Set(tenantIds.map((value) => value.trim()).filter(Boolean))];
  if (inventory.length === 0) throw new Error("legacy cutover preflight requires the complete tenant inventory");
  const board = nestedBoard(snapshot);
  const tasks = board.tasks;
  const legacyTasks = tasks.filter((task) => {
    const type = optionalString(task.type);
    return type !== undefined && LEGACY_TASK_MARKERS.some((marker) => type.includes(marker));
  });
  const active = legacyTasks.filter((task) => !isTerminalStatus(task.status));
  if (active.length > 0) {
    const ids = active.map((task) => {
      const tenantId = optionalString(record(task.metadata).tenantId) ?? "unknown-tenant";
      return `${tenantId}/${optionalString(task.id) ?? "unknown-task"}`;
    });
    throw new Error(`legacy context work is still active after writer shutdown: ${ids.join(", ")}`);
  }
  const legacyTaskIds = new Set<string>();
  for (const task of legacyTasks) {
    const taskId = optionalString(task.id);
    if (taskId !== undefined) legacyTaskIds.add(taskId);
  }
  const activeOutbox = board.outbox.filter((message) => {
    const taskId = optionalString(message.taskId);
    const topic = optionalString(message.topic);
    const legacy =
      (taskId !== undefined && legacyTaskIds.has(taskId)) ||
      (topic !== undefined && LEGACY_TASK_MARKERS.some((marker) => topic.includes(marker)));
    return legacy && message.status !== "dispatched";
  });
  if (activeOutbox.length > 0) {
    const ids = activeOutbox.map(
      (message) =>
        `${optionalString(message.taskId) ?? "unknown-task"}/${optionalString(message.id) ?? "unknown-message"}`
    );
    throw new Error(`legacy context outbox is still active after writer shutdown: ${ids.join(", ")}`);
  }
  return inventory.map((tenantId) => {
    const scoped = legacyTasks.filter((task) => optionalString(record(task.metadata).tenantId) === tenantId);
    return {
      tenantId,
      legacyTaskCount: scoped.length,
      terminalTaskCount: scoped.length
    };
  });
}

async function main(): Promise<void> {
  const store = new PostgresJsonStateStore<unknown>({
    host: requiredEnvironment("INSTANCE_UNIX_SOCKET"),
    database: requiredEnvironment("DB_NAME"),
    user: requiredEnvironment("DB_USER"),
    password: requiredEnvironment("DB_PASS"),
    applicationName: "jina-context-cutover-preflight",
    manageSchema: false,
    max: 1
  });
  try {
    const snapshot = await store.load();
    const tenantIds = requiredEnvironment("JINA_LEGACY_CUTOVER_TENANT_IDS").split(/[|,]/);
    const audits = auditLegacyContextSnapshot(snapshot, tenantIds);
    console.log(JSON.stringify({ status: "quiesced", audits }));
  } finally {
    await store.close();
  }
}

function nestedBoard(snapshot: unknown): {
  tasks: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
} {
  if (snapshot === undefined) return { tasks: [], outbox: [] };
  const intakeState = record(record(snapshot).intakeState);
  const board = record(intakeState.board);
  if (!Array.isArray(board.tasks)) throw new Error("persisted board snapshot has malformed tasks");
  if (!Array.isArray(board.outbox)) throw new Error("persisted board snapshot has malformed outbox");
  return { tasks: board.tasks.map(record), outbox: board.outbox.map(record) };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isTerminalStatus(value: unknown): boolean {
  return typeof value === "string" && isTerminalTaskStatus(value as TaskStatus);
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted board snapshot is malformed");
  }
  return value as Record<string, unknown>;
}

if (process.argv[1]?.endsWith("cutover-preflight.js")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
