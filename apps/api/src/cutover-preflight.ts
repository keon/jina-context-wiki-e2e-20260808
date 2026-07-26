import { PostgresJsonStateStore, PostgresLegacyContextCutoverAuditor, PostgresSharedIdentityStore } from "@jina/db";
import { isTerminalTaskStatus, type TaskStatus } from "@jina/board";

const LEGACY_TASK_MARKERS = ["context_graph", "context-graph"];

export interface LegacyContextTaskAudit {
  readonly tenantId: string;
  readonly legacyTaskCount: number;
  readonly terminalTaskCount: number;
}

export function assertExactTenantInventory(
  declaredTenantIds: readonly string[],
  authoritativeTenantIds: readonly string[]
): void {
  const declared = [...new Set(declaredTenantIds)].sort();
  const authoritative = [...new Set(authoritativeTenantIds)].sort();
  if (
    declared.length === authoritative.length &&
    declared.every((tenantId, index) => tenantId === authoritative[index])
  )
    return;
  const authoritativeSet = new Set(authoritative);
  const declaredSet = new Set(declared);
  const missing = authoritative.filter((tenantId) => !declaredSet.has(tenantId));
  const unexpected = declared.filter((tenantId) => !authoritativeSet.has(tenantId));
  throw new Error(
    `legacy cutover tenant inventory does not match active shared tenants; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`
  );
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
  const inventorySet = new Set(inventory);
  const uninventoried = [
    ...new Set(
      legacyTasks
        .map((task) => optionalString(record(task.metadata).tenantId))
        .filter((tenantId): tenantId is string => tenantId !== undefined && !inventorySet.has(tenantId))
    )
  ].sort();
  if (uninventoried.length > 0) {
    throw new Error(`legacy cutover tenant inventory is incomplete: ${uninventoried.join(", ")}`);
  }
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
  const tenantIds = parseTenantInventory(requiredEnvironment("JINA_LEGACY_CUTOVER_TENANT_IDS"));
  const stateStore = new PostgresJsonStateStore<unknown>({
    host: requiredEnvironment("INSTANCE_UNIX_SOCKET"),
    database: requiredEnvironment("DB_NAME"),
    user: requiredEnvironment("DB_USER"),
    password: requiredEnvironment("DB_PASS"),
    applicationName: "jina-context-cutover-preflight",
    manageSchema: false,
    max: 1,
    ...optionalPort("DB_PORT")
  });
  const identityStore = new PostgresSharedIdentityStore({
    host: requiredEnvironment("INSTANCE_UNIX_SOCKET"),
    database: requiredEnvironment("DB_NAME"),
    user: requiredEnvironment("DB_USER"),
    password: requiredEnvironment("DB_PASS"),
    applicationName: "jina-context-cutover-identity",
    max: 1,
    ...optionalPort("DB_PORT")
  });
  const graphAuditor = new PostgresLegacyContextCutoverAuditor({
    host: requiredEnvironment("LEGACY_GRAPH_INSTANCE_UNIX_SOCKET"),
    database: requiredEnvironment("LEGACY_GRAPH_DB_NAME"),
    user: requiredEnvironment("LEGACY_GRAPH_DB_USER"),
    password: requiredEnvironment("LEGACY_GRAPH_DB_PASS"),
    max: 1,
    ...optionalPort("LEGACY_GRAPH_DB_PORT")
  });
  try {
    assertExactTenantInventory(tenantIds, await identityStore.listTenantIds());
    const snapshot = await stateStore.load();
    const stateAudits = auditLegacyContextSnapshot(snapshot, tenantIds);
    const graphAudits = await graphAuditor.audit(tenantIds);
    console.log(JSON.stringify({ status: "quiesced", stateAudits, graphAudits }));
  } finally {
    await Promise.all([stateStore.close(), identityStore.close(), graphAuditor.close()]);
  }
}

function nestedBoard(snapshot: unknown): {
  tasks: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
} {
  if (snapshot === undefined) throw new Error("persisted API snapshot is missing");
  const intakeState = record(record(snapshot).intakeState);
  const board = record(intakeState.board);
  if (!Array.isArray(board.tasks)) throw new Error("persisted board snapshot has malformed tasks");
  if (!Array.isArray(board.outbox)) throw new Error("persisted board snapshot has malformed outbox");
  return { tasks: board.tasks.map(record), outbox: board.outbox.map(record) };
}

function parseTenantInventory(value: string): string[] {
  const tenantIds = [
    ...new Set(
      value
        .split("|")
        .map((tenantId) => tenantId.trim())
        .filter(Boolean)
    )
  ].sort();
  if (
    tenantIds.length === 0 ||
    tenantIds.some(
      (tenantId) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tenantId)
    )
  ) {
    throw new Error("JINA_LEGACY_CUTOVER_TENANT_IDS must be a pipe-delimited list of canonical UUIDs");
  }
  return tenantIds;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPort(name: string): { readonly port?: number } {
  const value = process.env[name]?.trim();
  if (!value) return {};
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return { port };
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
