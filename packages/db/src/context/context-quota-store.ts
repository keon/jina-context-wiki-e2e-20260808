import {
  contextQuotaResources,
  type ContextQuotaMutation,
  type ContextQuotaStore,
  type ContextTenantQuotaLedger
} from "@jina/context-engine";
import type { QueryResultRow } from "pg";
import { ContextDatabase, contextTenantScope } from "./database.js";

interface QuotaLedgerRow extends QueryResultRow {
  readonly ledger: unknown;
}

/**
 * A durable, fail-closed quota store shared by every API and worker replica.
 *
 * The advisory lock is required even though existing rows are selected FOR
 * UPDATE: a row lock cannot serialize the first two transactions for a tenant
 * whose ledger does not exist yet. The tenant-derived advisory key closes that
 * creation race, while RLS independently confines SQL access to the tenant.
 */
export class PostgresContextQuotaStore implements ContextQuotaStore {
  constructor(private readonly database: ContextDatabase) {}

  async transact<T>(
    tenantId: string,
    operation: (current: ContextTenantQuotaLedger | undefined) => ContextQuotaMutation<T>
  ): Promise<T> {
    const validatedTenantId = quotaTenantId(tenantId);
    return this.database.transactionAs("jina_context_quota", contextTenantScope(validatedTenantId), async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `jina_context.context_quota_ledgers:${validatedTenantId}`
      ]);
      const existing = await client.query<QuotaLedgerRow>(
        `select ledger
           from jina_context.context_quota_ledgers
           where tenant_id=$1
           for update`,
        [validatedTenantId]
      );
      if (existing.rowCount !== 0 && existing.rowCount !== 1) {
        throw new ContextQuotaStoreError("quota ledger lookup returned an invalid row count");
      }
      const current =
        existing.rows[0] === undefined ? undefined : parseQuotaLedger(existing.rows[0].ledger, validatedTenantId);
      const mutation = operation(current === undefined ? undefined : structuredClone(current));
      if (!isRecord(mutation) || !("state" in mutation) || !("result" in mutation)) {
        throw new ContextQuotaStoreError("quota operation returned an invalid mutation");
      }
      const serialized = serializeQuotaLedger(mutation.state, validatedTenantId);
      await client.query(
        `insert into jina_context.context_quota_ledgers
             (tenant_id,version,ledger,created_at,updated_at)
           values ($1,1,$2::jsonb,clock_timestamp(),clock_timestamp())
           on conflict (tenant_id) do update
             set version=excluded.version,
                 ledger=excluded.ledger,
                 updated_at=clock_timestamp()`,
        [validatedTenantId, serialized]
      );
      return mutation.result;
    });
  }
}

export class ContextQuotaStoreError extends Error {
  readonly code = "context_quota_store";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextQuotaStoreError";
  }
}

function serializeQuotaLedger(value: unknown, tenantId: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new ContextQuotaStoreError("quota mutation state is not JSON-serializable", { cause });
  }
  if (serialized === undefined) {
    throw new ContextQuotaStoreError("quota mutation state is not JSON-serializable");
  }
  try {
    parseQuotaLedger(JSON.parse(serialized) as unknown, tenantId);
  } catch (cause) {
    if (cause instanceof ContextQuotaStoreError) throw cause;
    throw new ContextQuotaStoreError("quota mutation state is invalid", { cause });
  }
  return serialized;
}

function parseQuotaLedger(value: unknown, tenantId: string): ContextTenantQuotaLedger {
  const ledger = record(value, "quota ledger");
  if (ledger.version !== 1) invalid("quota ledger version is unsupported");
  if (ledger.tenantId !== tenantId) invalid("quota ledger crossed its tenant partition");
  rateBucket(ledger.queryRate, "quota ledger queryRate");
  rateBucket(ledger.buildRate, "quota ledger buildRate");
  objectMap(ledger.activeBuilds, "quota ledger activeBuilds", timedReservation);
  objectMap(ledger.completedBuilds, "quota ledger completedBuilds", (entry, label) => {
    timestamp(record(entry, label).completedAt, `${label}.completedAt`);
  });
  objectMap(ledger.activeModelTasks, "quota ledger activeModelTasks", (entry, label) => {
    const task = timedReservation(entry, label);
    nonNegativeInteger(task.reservedTokens, `${label}.reservedTokens`);
    month(task.reservationMonth, `${label}.reservationMonth`);
  });
  objectMap(ledger.artifactReservations, "quota ledger artifactReservations", (entry, label) => {
    const reservation = timedReservation(entry, label);
    nonEmptyString(reservation.artifactId, `${label}.artifactId`);
    nonNegativeInteger(reservation.bytes, `${label}.bytes`);
  });
  objectMap(ledger.artifacts, "quota ledger artifacts", (entry, label) => {
    const artifact = record(entry, label);
    nonNegativeInteger(artifact.bytes, `${label}.bytes`);
    timestamp(artifact.committedAt, `${label}.committedAt`);
  });
  nonNegativeInteger(ledger.artifactBytes, "quota ledger artifactBytes");
  objectMap(ledger.artifactDeletionOperations, "quota ledger artifactDeletionOperations", (entry, label) =>
    nonEmptyString(record(entry, label).artifactId, `${label}.artifactId`)
  );
  const model = record(ledger.modelMonth, "quota ledger modelMonth");
  month(model.month, "quota ledger modelMonth.month");
  for (const field of ["requests", "inputTokens", "outputTokens", "cachedInputTokens", "reservedTokens"] as const) {
    nonNegativeInteger(model[field], `quota ledger modelMonth.${field}`);
  }
  objectMap(model.completedTasks, "quota ledger modelMonth.completedTasks", (entry, label) => {
    const digest = record(entry, label).usageDigest;
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      invalid(`${label}.usageDigest must be a sha256 digest`);
    }
  });
  const denials = record(ledger.denials, "quota ledger denials");
  for (const [resource, entry] of Object.entries(denials)) {
    if (!(contextQuotaResources as readonly string[]).includes(resource)) {
      invalid(`quota ledger has an unknown denial resource: ${resource}`);
    }
    const denial = record(entry, `quota ledger denials.${resource}`);
    nonNegativeInteger(denial.count, `quota ledger denials.${resource}.count`);
    timestamp(denial.lastDeniedAt, `quota ledger denials.${resource}.lastDeniedAt`);
  }
  timestamp(ledger.updatedAt, "quota ledger updatedAt");
  return ledger as unknown as ContextTenantQuotaLedger;
}

function rateBucket(value: unknown, label: string): void {
  const bucket = record(value, label);
  nonNegativeInteger(bucket.windowStartedAtMs, `${label}.windowStartedAtMs`);
  nonNegativeInteger(bucket.used, `${label}.used`);
  objectMap(bucket.operationIds, `${label}.operationIds`, (entry, entryLabel) => {
    if (entry !== true) invalid(`${entryLabel} must be true`);
  });
}

function timedReservation(value: unknown, label: string): Record<string, unknown> {
  const reservation = record(value, label);
  timestamp(reservation.createdAt, `${label}.createdAt`);
  timestamp(reservation.expiresAt, `${label}.expiresAt`);
  return reservation;
}

function objectMap(value: unknown, label: string, validate: (entry: unknown, label: string) => void): void {
  const entries = record(value, label);
  for (const [key, entry] of Object.entries(entries)) {
    if (!key || containsControlCharacter(key)) invalid(`${label} contains an invalid key`);
    validate(entry, `${label}.${key}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || containsControlCharacter(value)) {
    invalid(`${label} must be a non-empty string`);
  }
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
}

function month(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    invalid(`${label} must be a YYYY-MM month`);
  }
}

function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid(`${label} must be an ISO timestamp`);
  }
}

function quotaTenantId(value: string): string {
  if (value !== value.trim() || !value || value.length > 240 || containsControlCharacter(value)) {
    throw new ContextQuotaStoreError("tenantId is invalid");
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 || code === 127;
  });
}

function invalid(message: string): never {
  throw new ContextQuotaStoreError(message);
}
