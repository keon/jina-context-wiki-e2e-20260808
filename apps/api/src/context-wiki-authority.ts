import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendEvent, findTask, type BoardState, type TaskId } from "@jina/board";

const DISPATCH_EVENT = "context.wiki_trigger_dispatch_authorized";
const CLAIM_EVENT = "context.wiki_trigger_parent_claimed";
const GRANT_VERSION = 1;

export const contextWikiExecutionOperations = [
  "artifact:put",
  "release:read",
  "release:prepare",
  "release:activate",
  "board:complete",
  "board:fail",
  "stage:snapshot",
  "stage:plan",
  "stage:write-page",
  "stage:finalize",
  "stage:project",
  "stage:pageindex",
  "stage:audit",
  "audit:due",
  "audit:complete",
  "audit:fail",
  "audit:admit-fix"
] as const;

export type ContextWikiExecutionOperation = (typeof contextWikiExecutionOperations)[number];

export interface ContextWikiExecutionGrant {
  readonly version: 1;
  readonly kind: "build" | "audit";
  readonly subjectId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly triggerParentRunId: string;
  readonly authorityDigest: string;
  readonly locale: string;
  readonly operations: readonly ContextWikiExecutionOperation[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonceId: string;
  readonly auditRequest?: Readonly<Record<string, unknown>>;
}

export function authorizeContextWikiDispatch(
  state: BoardState,
  input: {
    readonly taskId: TaskId;
    readonly requestDigest: string;
    readonly attempt: number;
    readonly secret: string;
    readonly now: string;
  }
): { readonly state: BoardState; readonly dispatchNonce: string; readonly nonceDigest: string } {
  const task = findTask(state, input.taskId);
  if (!task || task.type !== "build-wiki" || task.kind !== "dispatchable") {
    throw new Error("wiki build task not found");
  }
  const requestDigest = requiredDigest(input.requestDigest, "requestDigest");
  if (task.metadata.requestDigest !== requestDigest)
    throw new Error("wiki request digest does not match Board authority");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error("wiki dispatch attempt is invalid");
  const dispatchNonce = createHmac("sha256", requiredSecret(input.secret))
    .update(`context-wiki-dispatch-v1\0${task.id}\0${input.attempt}\0${requestDigest}`, "utf8")
    .digest("base64url");
  const nonceDigest = sha256(dispatchNonce);
  const existing = state.events.find(
    (event) =>
      event.type === DISPATCH_EVENT &&
      event.taskId === task.id &&
      event.payload?.attempt === input.attempt &&
      event.payload?.requestDigest === requestDigest
  );
  if (existing) {
    if (existing.payload?.nonceDigest !== nonceDigest) throw new Error("wiki dispatch authority digest changed");
    return { state, dispatchNonce, nonceDigest };
  }
  const next = appendEvent(state, DISPATCH_EVENT, canonicalTimestamp(input.now), task.id, {
    version: 1,
    provider: "trigger.dev",
    effect: "generate-wiki",
    attempt: input.attempt,
    requestDigest,
    nonceDigest
  });
  return { state: next, dispatchNonce, nonceDigest };
}

export function claimContextWikiParent(
  state: BoardState,
  input: {
    readonly taskId: TaskId;
    readonly requestDigest: string;
    readonly attempt: number;
    readonly dispatchNonce: string;
    readonly triggerParentRunId: string;
    readonly now: string;
  }
): BoardState {
  const task = findTask(state, input.taskId);
  if (!task || task.type !== "build-wiki" || task.kind !== "dispatchable") throw new Error("wiki build task not found");
  if (task.status === "done" || task.status === "failed" || task.status === "canceled") {
    throw new Error("wiki build authority is terminal");
  }
  const requestDigest = requiredDigest(input.requestDigest, "requestDigest");
  const triggerParentRunId = requiredRunId(input.triggerParentRunId);
  const authorized = state.events.find(
    (event) =>
      event.type === DISPATCH_EVENT &&
      event.taskId === task.id &&
      event.payload?.attempt === input.attempt &&
      event.payload?.requestDigest === requestDigest
  );
  const expected = typeof authorized?.payload?.nonceDigest === "string" ? authorized.payload.nonceDigest : undefined;
  if (!expected || !safeDigestEqual(expected, sha256(input.dispatchNonce))) {
    throw new Error("wiki dispatch nonce is not authorized");
  }
  const existingClaims = state.events.filter(
    (event) =>
      event.type === CLAIM_EVENT &&
      event.taskId === task.id &&
      event.payload?.attempt === input.attempt &&
      event.payload?.requestDigest === requestDigest
  );
  const conflicting = existingClaims.find((event) => event.payload?.triggerParentRunId !== triggerParentRunId);
  if (conflicting) throw new Error("wiki dispatch attempt is already claimed by another Trigger run");
  if (existingClaims.length > 0) return state;
  return appendEvent(state, CLAIM_EVENT, canonicalTimestamp(input.now), task.id, {
    version: 1,
    attempt: input.attempt,
    requestDigest,
    triggerParentRunId,
    nonceDigest: expected
  });
}

export function contextWikiClaimedRun(
  state: BoardState,
  input: { readonly taskId: TaskId; readonly requestDigest: string; readonly attempt: number }
): string | undefined {
  const event = state.events.find(
    (candidate) =>
      candidate.type === CLAIM_EVENT &&
      candidate.taskId === input.taskId &&
      candidate.payload?.requestDigest === input.requestDigest &&
      candidate.payload?.attempt === input.attempt
  );
  return typeof event?.payload?.triggerParentRunId === "string" ? event.payload.triggerParentRunId : undefined;
}

export function contextWikiClaimedAt(
  state: BoardState,
  input: { readonly taskId: TaskId; readonly requestDigest: string; readonly attempt: number }
): string | undefined {
  return state.events.find(
    (candidate) =>
      candidate.type === CLAIM_EVENT &&
      candidate.taskId === input.taskId &&
      candidate.payload?.requestDigest === input.requestDigest &&
      candidate.payload?.attempt === input.attempt
  )?.at;
}

export interface ContextWikiClaimedExecution {
  readonly boardBuildId: string;
  readonly requestDigest: string;
  readonly triggerParentRunId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly locale: string;
}

/** Lists only active, run-bound parent claims in deterministic task-id order. */
export function contextWikiClaimedExecutions(
  state: BoardState,
  input: { readonly cursor?: string; readonly limit: number }
): { readonly executions: readonly ContextWikiClaimedExecution[]; readonly nextCursor?: string } {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("wiki reconciliation limit is invalid");
  }
  const tasks = state.tasks
    .filter(
      (task) =>
        task.type === "build-wiki" &&
        task.kind === "dispatchable" &&
        task.status === "in_progress" &&
        (input.cursor === undefined || task.id > input.cursor)
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const claimed = tasks.flatMap((task) => {
    const requestDigest = requiredDigest(task.metadata.requestDigest, "requestDigest");
    let claim: BoardState["events"][number] | undefined;
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const candidate = state.events[index];
      if (
        candidate?.type === CLAIM_EVENT &&
        candidate.taskId === task.id &&
        candidate.payload?.requestDigest === requestDigest
      ) {
        claim = candidate;
        break;
      }
    }
    // Dispatch can be leased before Trigger has claimed the parent. It is not
    // reconcilable yet and must not block already-claimed executions.
    if (!claim) return [];
    return [
      {
        boardBuildId: task.id,
        requestDigest,
        triggerParentRunId: requiredRunId(claim.payload?.triggerParentRunId),
        tenantId: requiredBounded(task.metadata.tenantId, "tenantId", 200),
        repository: requiredRepository(task.metadata.repository),
        locale: requiredLocale(task.metadata.locale)
      }
    ];
  });
  const executions = claimed.slice(0, input.limit);
  return {
    executions,
    ...(claimed.length > executions.length && executions.length > 0
      ? { nextCursor: executions[executions.length - 1]!.boardBuildId }
      : {})
  };
}

/** Revalidates the durable Board authority before every build-side effect. */
export function assertContextWikiExecutionActive(
  state: BoardState,
  input: {
    readonly taskId: TaskId;
    readonly requestDigest: string;
    readonly triggerParentRunId: string;
  }
): void {
  const task = findTask(state, input.taskId);
  if (
    !task ||
    task.type !== "build-wiki" ||
    task.kind !== "dispatchable" ||
    task.status !== "in_progress" ||
    task.metadata.requestDigest !== input.requestDigest
  ) {
    throw new Error("wiki build authority is no longer active");
  }
  const claimed = state.events.some(
    (event) =>
      event.type === CLAIM_EVENT &&
      event.taskId === task.id &&
      event.payload?.requestDigest === input.requestDigest &&
      event.payload?.triggerParentRunId === input.triggerParentRunId
  );
  if (!claimed) throw new Error("wiki Trigger run does not own the active Board authority");
}

export function mintContextWikiExecutionGrant(
  input: Omit<ContextWikiExecutionGrant, "version" | "issuedAt" | "expiresAt" | "nonceId"> & {
    readonly secret: string;
    readonly now: string;
    readonly ttlSeconds: number;
  }
): { readonly token: string; readonly grant: ContextWikiExecutionGrant } {
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86_400) {
    throw new Error("wiki execution grant TTL must be between 60 and 86400 seconds");
  }
  const issuedAt = canonicalTimestamp(input.now);
  const expiresAt = new Date(Date.parse(issuedAt) + input.ttlSeconds * 1_000).toISOString();
  const operations = [...new Set(input.operations)].sort();
  if (operations.length === 0 || operations.some((operation) => !contextWikiExecutionOperations.includes(operation))) {
    throw new Error("wiki execution grant operations are invalid");
  }
  const grant: ContextWikiExecutionGrant = {
    version: GRANT_VERSION,
    kind: input.kind,
    subjectId: requiredBounded(input.subjectId, "subjectId", 240),
    tenantId: requiredBounded(input.tenantId, "tenantId", 200),
    repository: requiredRepository(input.repository),
    triggerParentRunId: requiredRunId(input.triggerParentRunId),
    authorityDigest: requiredDigest(input.authorityDigest, "authorityDigest"),
    locale: requiredLocale(input.locale),
    operations,
    issuedAt,
    expiresAt,
    nonceId: sha256(`${input.kind}\0${input.subjectId}\0${input.triggerParentRunId}\0${issuedAt}`).slice(0, 32),
    ...(input.auditRequest ? { auditRequest: input.auditRequest } : {})
  };
  const encoded = Buffer.from(JSON.stringify(grant), "utf8").toString("base64url");
  const signature = createHmac("sha256", requiredSecret(input.secret)).update(encoded, "ascii").digest("base64url");
  return { token: `jina_weg_${encoded}.${signature}`, grant };
}

export function verifyContextWikiExecutionGrant(
  token: string,
  input: { readonly secret: string; readonly now: string; readonly operation?: ContextWikiExecutionOperation }
): ContextWikiExecutionGrant {
  const match = /^jina_weg_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) throw new Error("wiki execution grant is malformed");
  const encoded = match[1]!;
  const signature = match[2]!;
  const expected = createHmac("sha256", requiredSecret(input.secret)).update(encoded, "ascii").digest("base64url");
  if (!safeStringEqual(signature, expected)) throw new Error("wiki execution grant signature is invalid");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("wiki execution grant payload is invalid");
  }
  const grant = parseGrant(raw);
  const now = Date.parse(canonicalTimestamp(input.now));
  if (Date.parse(grant.issuedAt) > now + 30_000) throw new Error("wiki execution grant is not active");
  if (Date.parse(grant.expiresAt) <= now) throw new Error("wiki execution grant has expired");
  if (input.operation && !grant.operations.includes(input.operation)) {
    throw new Error("wiki execution grant does not permit this operation");
  }
  return grant;
}

function parseGrant(value: unknown): ContextWikiExecutionGrant {
  const candidate = requiredRecord(value, "wiki execution grant");
  const allowed = [
    "version",
    "kind",
    "subjectId",
    "tenantId",
    "repository",
    "triggerParentRunId",
    "authorityDigest",
    "locale",
    "operations",
    "issuedAt",
    "expiresAt",
    "nonceId",
    "auditRequest"
  ];
  if (Object.keys(candidate).some((key) => !allowed.includes(key)))
    throw new Error("wiki execution grant has unknown fields");
  if (candidate.version !== 1) throw new Error("wiki execution grant version is invalid");
  if (candidate.kind !== "build" && candidate.kind !== "audit") throw new Error("wiki execution grant kind is invalid");
  if (!Array.isArray(candidate.operations)) throw new Error("wiki execution grant operations are invalid");
  const operations = candidate.operations.map((operation) => {
    if (!contextWikiExecutionOperations.includes(operation as ContextWikiExecutionOperation)) {
      throw new Error("wiki execution grant operation is invalid");
    }
    return operation as ContextWikiExecutionOperation;
  });
  const auditRequest =
    candidate.auditRequest === undefined ? undefined : requiredRecord(candidate.auditRequest, "auditRequest");
  if ((candidate.kind === "audit") !== Boolean(auditRequest)) {
    throw new Error("wiki audit execution grant request binding is invalid");
  }
  if (auditRequest && Buffer.byteLength(JSON.stringify(auditRequest), "utf8") > 8_192) {
    throw new Error("wiki audit execution grant request is too large");
  }
  return {
    version: 1,
    kind: candidate.kind,
    subjectId: requiredBounded(candidate.subjectId, "subjectId", 240),
    tenantId: requiredBounded(candidate.tenantId, "tenantId", 200),
    repository: requiredRepository(candidate.repository),
    triggerParentRunId: requiredRunId(candidate.triggerParentRunId),
    authorityDigest: requiredDigest(candidate.authorityDigest, "authorityDigest"),
    locale: requiredLocale(candidate.locale),
    operations,
    issuedAt: canonicalTimestamp(candidate.issuedAt),
    expiresAt: canonicalTimestamp(candidate.expiresAt),
    nonceId: requiredBounded(candidate.nonceId, "nonceId", 64),
    ...(auditRequest ? { auditRequest } : {})
  };
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredBounded(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} is invalid`);
  return value;
}

function requiredRepository(value: unknown): string {
  const repository = requiredBounded(value, "repository", 300).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error("repository is invalid");
  return repository;
}

function requiredLocale(value: unknown): string {
  const locale = requiredBounded(value, "locale", 35).toLowerCase();
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale)) throw new Error("locale is invalid");
  return locale;
}

function requiredDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredRunId(value: unknown): string {
  if (typeof value !== "string" || !/^run_[A-Za-z0-9]+$/.test(value) || value.length > 200) {
    throw new Error("Trigger parent run ID is invalid");
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("timestamp is invalid");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) throw new Error("timestamp is invalid");
  return timestamp.toISOString();
}

function requiredSecret(value: string): string {
  if (value.length < 32) throw new Error("wiki execution secret must contain at least 32 characters");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(left) &&
    /^[0-9a-f]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
