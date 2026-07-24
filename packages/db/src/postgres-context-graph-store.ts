import { randomUUID } from "node:crypto";
import {
  CONTEXT_GRAPH_PARSER_VERSION,
  ContextGraphProjectionDrainBusyError,
  CONTEXT_GRAPH_REGISTRY_VERSION,
  assertionObservationId,
  assertionIdentityQualifiers,
  canonicalJson,
  causalTraceItemsFromGraph,
  codeownersPatternMatches,
  computeCommitChanges,
  createContextGraphProjection,
  knowledgeCheckpoint,
  normalizeAssertionBatchLenient,
  normalizeSourceObservation,
  sourceObservationExternalId,
  sourceObservationProvider,
  sourceObservationId,
  stableId,
  predicateDefinition,
  validatePredicateEndpoints,
  validateQualifiers,
  type BlobAnalysis,
  type GitHubWorkItemObservation,
  type RepositorySourceObservation,
  type ContextGraphAssertionBatch,
  type ContextGraphAssertionResult,
  type ContextGraphAssertionSummary,
  type ContextGraphCommand,
  type ContextGraphCommandResult,
  type ContextGraphEdge,
  type ContextGraph,
  type ContextGraphStore,
  type ContextGraphIngestPlan,
  type ContextGraphNode,
  type ContextGraphProjectionRequest,
  type ContextGraphSourceEvidence,
  type ContextGraphSourceIngestResult,
  type ContextGraphWriteFence,
  type ContextGraphWorkerTopic,
  type ContextGraphOperationalMetrics,
  type ProjectionRebuildResult,
  type RepositorySnapshot,
  type IssueTraceProjection,
  type RetrievalItem,
  type RetrievalCitation,
  type RetrievalRequest,
  type RetrievalResult,
  type StoredAssertion,
  type ContextGraphSummaryFilter,
  type ContextGraphReadRevisionOptions
} from "@jina/context-graph";
import type { ContextGraphExecutionSettingsRecord } from "@jina/context-graph";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { pingPostgresPool } from "./postgres-health.js";
import { DomainError } from "@jina/shared-kernel";
import { applySchema } from "./apply-schema.js";
import { CONTEXT_GRAPH_SCHEMA_SQL } from "./context-graph-schema.js";

export { CONTEXT_GRAPH_SCHEMA_SQL } from "./context-graph-schema.js";

interface GraphRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref: string;
  commit_sha: string;
  generated_at: Date;
  executor: "daytona" | "fixture" | "projection";
  model: string;
  sandbox_id: string | null;
  summary: string;
}

interface ExecutionSettingsRow {
  tenant_id: string;
  provider: ContextGraphExecutionSettingsRecord["provider"];
  assertion_model: string;
  openrouter_api_key: string | null;
  openai_api_key: string | null;
  codex_harness_auth: string | null;
  revision: string | number;
  updated_at: Date;
}

function executionSettingsRecord(row: ExecutionSettingsRow): ContextGraphExecutionSettingsRecord {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error("invalid context graph execution settings revision");
  }
  return {
    tenantId: row.tenant_id,
    provider: row.provider,
    assertionModel: row.assertion_model,
    ...(row.openrouter_api_key ? { openrouterApiKey: row.openrouter_api_key } : {}),
    ...(row.openai_api_key ? { openaiApiKey: row.openai_api_key } : {}),
    ...(row.codex_harness_auth ? { codexHarnessAuth: row.codex_harness_auth } : {}),
    revision,
    updatedAt: row.updated_at.toISOString()
  };
}

interface NodeRow {
  graph_id: string;
  node_id: string;
  kind: ContextGraphNode["kind"];
  label: string;
  description: string;
  path: string | null;
  evidence: readonly string[];
}

interface EdgeRow {
  graph_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  predicate: string;
  plane: ContextGraphEdge["plane"];
  confidence: number | null;
  why: string | null;
  qualifiers: Readonly<Record<string, string | number | boolean>>;
  evidence: readonly string[];
}

const RESTORE_GITHUB_ENTITY_LABELS_SQL = `
  with latest as (
    select distinct on (payload->>'kind',payload->>'number') payload
    from jina_context_graph.observations
    where tenant_id=$1 and repository=$2 and source='github' and redacted_at is null
      and payload->>'kind' in ('issue','pull_request')
      and payload->>'number' is not null and payload->>'title' is not null
    order by payload->>'kind',payload->>'number',coalesce(occurred_at,recorded_at) desc,recorded_at desc,id desc
  ), labels as (
    select case payload->>'kind' when 'issue' then 'Issue' else 'PullRequest' end as kind,
           case payload->>'kind'
             when 'issue' then 'github:issue:' || $2 || '#' || (payload->>'number')
             else 'github:pr:' || $2 || '#' || (payload->>'number')
           end as natural_key,
           '#' || (payload->>'number') || ' ' || (payload->>'title') as display_name
    from latest
  )
  update jina_context_graph.entities e set display_name=labels.display_name
  from labels
  where e.tenant_id=$1 and e.kind=labels.kind and e.natural_key=labels.natural_key
    and e.display_name is distinct from labels.display_name`;

function assertionNaturalKey(
  assertion: Pick<StoredAssertion, "subject" | "predicate" | "object" | "qualifiers">
): string {
  return `${assertion.subject.kind}:${assertion.subject.naturalKey}:${assertion.predicate}:${assertion.object.kind}:${assertion.object.naturalKey}:${canonicalJson(assertionIdentityQualifiers(assertion.predicate, assertion.qualifiers ?? {}))}`;
}

async function lockAssertionNaturalKey(
  client: PoolClient,
  tenantId: string,
  repository: string,
  subjectId: string,
  predicate: string,
  objectId: string,
  qualifiersHash: string,
  cardinality: "one" | "many"
): Promise<void> {
  const naturalKey =
    cardinality === "one"
      ? `${tenantId}:${repository}:${subjectId}:${predicate}:${qualifiersHash}`
      : `${tenantId}:${repository}:${subjectId}:${predicate}:${objectId}:${qualifiersHash}`;
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [naturalKey]);
}

async function findLiveAssertionByNaturalKey(
  client: PoolClient,
  tenantId: string,
  repository: string,
  subjectId: string,
  predicate: string,
  objectId: string,
  qualifiersHash: string
): Promise<{ readonly id: string; readonly status: "proposed" | "active" } | undefined> {
  const result = await client.query<{ id: string; status: "proposed" | "active" }>(
    `select id,status from jina_context_graph.assertions
     where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and object_id=$5 and qualifiers_hash=$6
       and status in ('proposed','active')
     order by recorded_at,id limit 1`,
    [tenantId, repository, subjectId, predicate, objectId, qualifiersHash]
  );
  return result.rows[0];
}

/**
 * Batched equivalent of running findLiveAssertionByNaturalKey once per natural key.
 * `distinct on` with the same `order by recorded_at,id` picks exactly the row the
 * per-key `limit 1` query would have returned. Callers must already hold the advisory
 * locks for every requested natural key so the snapshot cannot go stale before the
 * per-key insert/confirm decision is applied.
 */
async function prefetchLiveAssertionsByNaturalKey(
  client: PoolClient,
  tenantId: string,
  repository: string,
  keys: readonly {
    readonly subjectId: string;
    readonly objectId: string;
    readonly qualifiersHash: string;
    readonly assertion: Pick<StoredAssertion, "predicate">;
  }[]
): Promise<ReadonlyMap<string, { readonly id: string; readonly status: "proposed" | "active" }>> {
  const live = new Map<string, { id: string; status: "proposed" | "active" }>();
  if (keys.length === 0) return live;
  const result = await client.query<{
    id: string;
    status: "proposed" | "active";
    subject_id: string;
    predicate: string;
    object_id: string;
    qualifiers_hash: string;
  }>(
    `select distinct on (assertion.subject_id,assertion.predicate,assertion.object_id,assertion.qualifiers_hash)
       assertion.id,assertion.status,assertion.subject_id,assertion.predicate,assertion.object_id,assertion.qualifiers_hash
     from jina_context_graph.assertions assertion
     join unnest($3::text[],$4::text[],$5::text[],$6::text[]) as source(subject_id,predicate,object_id,qualifiers_hash)
       on assertion.subject_id=source.subject_id and assertion.predicate=source.predicate
      and assertion.object_id=source.object_id and assertion.qualifiers_hash=source.qualifiers_hash
     where assertion.tenant_id=$1 and assertion.repository=$2 and assertion.status in ('proposed','active')
     order by assertion.subject_id,assertion.predicate,assertion.object_id,assertion.qualifiers_hash,
       assertion.recorded_at,assertion.id`,
    [
      tenantId,
      repository,
      keys.map((key) => key.subjectId),
      keys.map((key) => key.assertion.predicate),
      keys.map((key) => key.objectId),
      keys.map((key) => key.qualifiersHash)
    ]
  );
  for (const row of result.rows) {
    live.set(`${row.subject_id}:${row.predicate}:${row.object_id}:${row.qualifiers_hash}`, {
      id: row.id,
      status: row.status
    });
  }
  return live;
}

/**
 * Batched equivalent of calling ensureEntity(client, tenantId, endpoint, eventAt, false)
 * for every assertion endpoint in batch order. It reproduces the assert-path semantics
 * exactly: a new entity is created with the label of its first occurrence in the batch,
 * an existing entity keeps its display name untouched (updateExisting=false), ids are
 * resolved through the (tenant_id,kind,natural_key) unique key rather than assumed from
 * stableId, and entity_changed outbox events are emitted only for created entities.
 */
async function ensureAssertionEntities(
  client: PoolClient,
  tenantId: string,
  endpoints: readonly StoredAssertion["subject"][],
  eventAt: string
): Promise<ReadonlyMap<string, string>> {
  const distinct = new Map<string, StoredAssertion["subject"]>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.kind}:${endpoint.naturalKey}`;
    if (!distinct.has(key)) distinct.set(key, endpoint);
  }
  const ordered = [...distinct.values()];
  const created = await client.query<{ id: string }>(
    `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name)
     select source.id,$1,source.kind,source.natural_key,source.display_name
     from unnest($2::text[],$3::text[],$4::text[],$5::text[]) as source(id,kind,natural_key,display_name)
     on conflict do nothing
     returning id`,
    [
      tenantId,
      ordered.map((endpoint) => stableId("entity", `${tenantId}:${endpoint.kind}:${endpoint.naturalKey}`)),
      ordered.map((endpoint) => endpoint.kind),
      ordered.map((endpoint) => endpoint.naturalKey),
      ordered.map((endpoint) => endpoint.label)
    ]
  );
  const resolved = await client.query<{ id: string; kind: string; natural_key: string }>(
    `select entity.id,entity.kind,entity.natural_key
     from jina_context_graph.entities entity
     join unnest($2::text[],$3::text[]) as source(kind,natural_key)
       on entity.kind=source.kind and entity.natural_key=source.natural_key
     where entity.tenant_id=$1`,
    [tenantId, ordered.map((endpoint) => endpoint.kind), ordered.map((endpoint) => endpoint.naturalKey)]
  );
  const ids = new Map<string, string>();
  for (const row of resolved.rows) ids.set(`${row.kind}:${row.natural_key}`, row.id);
  for (const key of distinct.keys()) {
    if (!ids.has(key)) throw new Error("entity id collision");
  }
  await insertOutboxEventBatch(
    client,
    tenantId,
    "entity_changed",
    created.rows.map((row) => ({ aggregateId: row.id, payload: { entityId: row.id } })),
    eventAt
  );
  return ids;
}

/**
 * Batched equivalent of calling backfillAssertionExplanation once per assertion:
 * one update fills every null explanation, and the per-row audit entries are only
 * written for rows the update actually touched (legacy rows recorded before the
 * explanation migration), mirroring the sequential rowCount check.
 */
async function backfillAssertionExplanations(
  client: PoolClient,
  tenantId: string,
  backfills: readonly { readonly id: string; readonly explanation: string }[],
  now: string
): Promise<void> {
  if (backfills.length === 0) return;
  const updated = await client.query<{ id: string }>(
    `update jina_context_graph.assertions assertion
     set explanation=source.explanation
     from unnest($2::text[],$3::text[]) as source(id,explanation)
     where assertion.tenant_id=$1 and assertion.id=source.id and assertion.explanation is null
     returning assertion.id`,
    [tenantId, backfills.map((backfill) => backfill.id), backfills.map((backfill) => backfill.explanation)]
  );
  for (const row of updated.rows) {
    await insertAudit(client, {
      id: stableId("audit", `${tenantId}:backfill_assertion_explanation:${row.id}`),
      tenantId,
      actorId: "svc:assertion-migration",
      action: "backfill_assertion_explanation",
      input: { assertionId: row.id },
      result: "accepted",
      reason: "Added an explanation from newly available source evidence.",
      now
    });
  }
}

interface GraphSummaryRow extends GraphRow {
  node_count: string;
  edge_count: string;
}

interface StoredAssertionRow {
  id: string;
  tenant_id: string;
  repository: string;
  commit_sha: string;
  subject_id: string;
  subject_kind: StoredAssertion["subject"]["kind"];
  subject_natural_key: string;
  subject_label: string;
  predicate: string;
  object_id: string;
  object_kind: StoredAssertion["object"]["kind"];
  object_natural_key: string;
  object_label: string;
  status: StoredAssertion["status"];
  confidence: number;
  explanation: string | null;
  evidence: string[];
  source_observation_id: string | null;
  asserted_by: string | null;
  qualifiers: Record<string, string | number | boolean>;
  valid_from: Date | null;
  valid_to: Date | null;
  last_confirmed_at: Date;
  superseded_by: string | null;
  generator_version: string;
  registry_version: string;
  recorded_at: Date;
}

interface BlobSymbolRow {
  blob_sha: string;
  parser_version: string;
  moniker: string;
  name: string;
  kind: string;
  signature_hash: string;
  start_line: number;
  end_line: number;
}

export interface PostgresContextGraphStoreConfig extends PoolConfig {
  readonly manageSchema?: boolean;
}

export class PostgresContextGraphStore implements ContextGraphStore {
  private readonly pool: Pool;
  private readonly projectionLockPool: Pool;
  private readonly manageSchema: boolean;
  private initialized?: Promise<void>;

  constructor(config: PostgresContextGraphStoreConfig) {
    const { manageSchema = true, ...poolConfig } = config;
    this.manageSchema = manageSchema;
    this.pool = new Pool({ ...poolConfig, application_name: "jina-context-graph", max: poolConfig.max ?? 5 });
    // Session advisory locks must not consume the query pool. Otherwise N
    // concurrent tenant drains can hold all N query clients while each drain
    // waits for one more client to rebuild its projections.
    this.projectionLockPool = new Pool({
      ...poolConfig,
      application_name: "jina-context-graph-projection-lock",
      max: 1
    });
    this.pool.on("error", (error) => {
      console.error("context graph postgres idle connection error", error);
    });
    this.projectionLockPool.on("error", (error) => {
      console.error("context graph projection-lock postgres idle connection error", error);
    });
  }

  async save(graph: ContextGraph, writeFence?: ContextGraphWriteFence): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertPipelineWriteFence(client, graph.tenantId, graph.repository, "run-context-graph-project", writeFence);
      await assertRepositoryWritable(client, graph.tenantId, graph.repository, ["projection"]);
      await insertContextGraph(client, graph);
      if (graph.generator.executor === "projection") {
        await client.query(
          `insert into jina_context_graph.graph_heads (tenant_id,repository,ref_name,graph_id,updated_at)
           select $1,$2,ref.ref_name,$3,$4
           from jina_context_graph.refs ref
           where ref.tenant_id=$1 and ref.repository=$2 and ref.commit_sha=$5
           on conflict (tenant_id,repository,ref_name) do update
             set graph_id=excluded.graph_id,updated_at=excluded.updated_at`,
          [graph.tenantId, graph.repository, graph.id, graph.generatedAt, graph.commitSha]
        );
      }
      await reassertPipelineWriteFence(client, writeFence);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceRepositoryAccess(tenantId: string, principalId: string, repositories: readonly string[]): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `with desired(repository) as materialized (
         select distinct repository from unnest($3::text[]) as repository
       ), removed as (
         delete from jina_context_graph.repository_acl acl
          where acl.tenant_id=$1 and acl.principal_id=$2
            and not exists (select 1 from desired where desired.repository=acl.repository)
         returning acl.repository
       )
       insert into jina_context_graph.repository_acl (tenant_id,repository,principal_id,role,created_at)
       select $1, desired.repository, $2, 'reader', now()
         from desired
       on conflict (tenant_id,repository,principal_id) do update
         set role=excluded.role
       where jina_context_graph.repository_acl.role is distinct from excluded.role`,
      [tenantId, principalId, repositories]
    );
  }

  async executionSettings(tenantId: string): Promise<ContextGraphExecutionSettingsRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<ExecutionSettingsRow>(
      `select tenant_id,provider,assertion_model,openrouter_api_key,openai_api_key,codex_harness_auth,
              revision,updated_at
         from jina_context_graph.execution_settings where tenant_id=$1`,
      [tenantId]
    );
    return result.rows[0] ? executionSettingsRecord(result.rows[0]) : undefined;
  }

  async saveExecutionSettings(
    record: Omit<ContextGraphExecutionSettingsRecord, "revision">,
    expectedRevision: number
  ): Promise<ContextGraphExecutionSettingsRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<ExecutionSettingsRow>(
      `insert into jina_context_graph.execution_settings
         (tenant_id,provider,assertion_model,openrouter_api_key,openai_api_key,codex_harness_auth,revision,updated_at)
       select $1,$2,$3,$4,$5,$6,1,$7
       where $8::bigint=0
          or exists (
               select 1
                 from jina_context_graph.execution_settings
                where tenant_id=$1 and revision=$8::bigint
             )
       on conflict (tenant_id) do update
         set provider=excluded.provider,
             assertion_model=excluded.assertion_model,
             openrouter_api_key=excluded.openrouter_api_key,
             openai_api_key=excluded.openai_api_key,
             codex_harness_auth=excluded.codex_harness_auth,
             revision=jina_context_graph.execution_settings.revision+1,
             updated_at=excluded.updated_at
       where jina_context_graph.execution_settings.revision=$8::bigint
       returning tenant_id,provider,assertion_model,openrouter_api_key,openai_api_key,codex_harness_auth,
                 revision,updated_at`,
      [
        record.tenantId,
        record.provider,
        record.assertionModel,
        record.openrouterApiKey ?? null,
        record.openaiApiKey ?? null,
        record.codexHarnessAuth ?? null,
        record.updatedAt,
        expectedRevision
      ]
    );
    return result.rows[0] ? executionSettingsRecord(result.rows[0]) : undefined;
  }

  /** The durable graph generation currently published for a ref, if any. */
  async currentGraphHead(
    tenantId: string,
    repository: string,
    ref: string
  ): Promise<{ readonly graphId: string; readonly commitSha: string } | undefined> {
    await this.initialize();
    const head = await this.pool.query<{ graph_id: string; commit_sha: string }>(
      `select head.graph_id,graph.commit_sha from jina_context_graph.graph_heads head
       join jina_context_graph.graphs graph on graph.id=head.graph_id
       where head.tenant_id=$1 and head.repository=$2 and head.ref_name=$3 limit 1`,
      [tenantId, repository, ref]
    );
    const row = head.rows[0];
    return row ? { graphId: row.graph_id, commitSha: row.commit_sha } : undefined;
  }

  async latest(
    tenantId: string,
    repositories?: readonly string[],
    filter: ContextGraphSummaryFilter = {}
  ): Promise<ContextGraph | undefined> {
    await this.initialize();
    if (repositories?.length === 0) return undefined;
    const result = await this.pool.query<GraphRow>(
      `select graph.* from jina_context_graph.graph_heads head
       join jina_context_graph.graphs graph on graph.id=head.graph_id and graph.tenant_id=head.tenant_id
       where head.tenant_id=$1 and ($2::text[] is null or head.repository=any($2))
         and ($3::text is null or head.repository=$3)
         and ($4::text is null or head.ref_name=$4)
       order by graph.generated_at desc,head.repository,head.ref_name limit 1`,
      [tenantId, repositories ?? null, filter.repository ?? null, filter.ref ?? null]
    );
    return result.rows[0] ? this.hydrate(result.rows[0]) : undefined;
  }

  async readRevision(tenantId: string, options: ContextGraphReadRevisionOptions = {}): Promise<string> {
    await this.initialize();
    if (options.repositories?.length === 0) return stableId("context-graph-read", `${tenantId}:empty`);
    const result = await this.pool.query<{ revision: string }>(
      `select md5(concat_ws('|',
         coalesce((select string_agg(concat_ws(':',head.repository,head.ref_name,head.graph_id,
                                                extract(epoch from head.updated_at)),',' order by head.repository,head.ref_name)
                   from jina_context_graph.graph_heads head
                  where head.tenant_id=$1
                    and ($2::text[] is null or head.repository=any($2))
                    and ($3::text is null or head.repository=$3)
                    and ($4::text is null or head.ref_name=$4)),''),
         coalesce((select concat(count(*),':',max(extract(epoch from assertion.recorded_at)))
                   from jina_context_graph.assertions assertion
                  where assertion.tenant_id=$1 and $7::boolean
                    and ($2::text[] is null or assertion.repository=any($2))
                    and ($5::text is null or assertion.repository=$5)
                    and ($6::text is null or assertion.status=$6)),''),
         coalesce((select concat(count(*),':',max(extract(epoch from audit.created_at)))
                   from jina_context_graph.audit_log audit
                  where audit.tenant_id=$1 and $7::boolean),''),
         coalesce((select concat(count(*),':',max(extract(epoch from redirect.created_at)))
                   from jina_context_graph.entity_redirects redirect
                  where redirect.tenant_id=$1 and $7::boolean),''))) as revision`,
      [
        tenantId,
        options.repositories ?? null,
        options.repository ?? null,
        options.ref ?? null,
        options.assertionRepository ?? null,
        options.assertionStatus ?? null,
        options.includeAssertions ?? false
      ]
    );
    return result.rows[0]?.revision ?? stableId("context-graph-read", `${tenantId}:missing`);
  }

  async get(graphId: string, tenantId: string): Promise<ContextGraph | undefined> {
    await this.initialize();
    const result = await this.pool.query<GraphRow>(
      `select graph.* from jina_context_graph.graphs graph
       where graph.id=$1 and graph.tenant_id=$2
         and exists (select 1 from jina_context_graph.graph_heads head
                     where head.tenant_id=$2 and head.graph_id=graph.id)`,
      [graphId, tenantId]
    );
    return result.rows[0] ? this.hydrate(result.rows[0]) : undefined;
  }

  async list(tenantId: string): Promise<readonly ContextGraph[]> {
    return this.loadGraphs(tenantId, 50);
  }

  async listAllSummaries() {
    await this.initialize();
    const result = await this.pool.query<GraphSummaryRow>(
      `select g.*,
         coalesce(g.node_count, (select count(*) from jina_context_graph.nodes n where n.graph_id = g.id)) as node_count,
         coalesce(g.edge_count, (select count(*) from jina_context_graph.edges e where e.graph_id = g.id)) as edge_count
       from jina_context_graph.graph_heads head
       join jina_context_graph.graphs g on g.id=head.graph_id and g.tenant_id=head.tenant_id
       order by g.generated_at desc,head.tenant_id,head.repository,head.ref_name`
    );
    return result.rows.map((row) => ({
      ...graphMetadata(row),
      nodeCount: Number(row.node_count),
      edgeCount: Number(row.edge_count)
    }));
  }

  async listSummaries(tenantId: string, filter?: ContextGraphSummaryFilter) {
    await this.initialize();
    // Scope in SQL before the row limit: an unscoped tenant-wide page can hold
    // more heads than the limit, which would silently omit a scoped caller's
    // repository from a post-hoc filter.
    const conditions = ["head.tenant_id=$1"];
    const parameters: string[] = [tenantId];
    if (filter?.repository !== undefined) {
      parameters.push(filter.repository);
      conditions.push(`head.repository=$${parameters.length}`);
    }
    if (filter?.ref !== undefined) {
      parameters.push(filter.ref);
      conditions.push(`head.ref_name=$${parameters.length}`);
    }
    // Counts come from the denormalized columns written at graph insert;
    // the correlated count(*) only covers rows saved before those columns
    // existed (schema application backfills them, so it is rarely taken).
    const result = await this.pool.query<GraphSummaryRow>(
      `select g.*,
         coalesce(g.node_count, (select count(*) from jina_context_graph.nodes n where n.graph_id = g.id)) as node_count,
         coalesce(g.edge_count, (select count(*) from jina_context_graph.edges e where e.graph_id = g.id)) as edge_count
       from jina_context_graph.graph_heads head
       join jina_context_graph.graphs g on g.id=head.graph_id and g.tenant_id=head.tenant_id
       where ${conditions.join(" and ")}
       order by g.generated_at desc,head.repository,head.ref_name
       limit 5000`,
      parameters
    );
    return result.rows.map((row) => ({
      ...graphMetadata(row),
      nodeCount: Number(row.node_count),
      edgeCount: Number(row.edge_count)
    }));
  }

  async knownCommits(tenantId: string, repository: string, commitShas: readonly string[]): Promise<readonly string[]> {
    await this.initialize();
    if (commitShas.length === 0) return [];
    const result = await this.pool.query<{ sha: string }>(
      `select sha from jina_context_graph.commits where tenant_id=$1 and repository=$2 and sha=any($3::text[])`,
      [tenantId, repository, commitShas]
    );
    return result.rows.map((row) => row.sha);
  }

  async planIngestion(
    snapshot: RepositorySnapshot,
    writeFence?: ContextGraphWriteFence
  ): Promise<ContextGraphIngestPlan> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertPipelineWriteFence(
        client,
        snapshot.tenantId,
        snapshot.repository,
        "run-context-graph-ingest",
        writeFence
      );
      // planIngestion writes git-shaped tables and also upserts entities/identities.
      await assertRepositoryWritable(client, snapshot.tenantId, snapshot.repository, ["code", "knowledge"]);
      const filtered = await client.query<{ kind: string; value: string }>(
        `select kind,value from jina_context_graph.erasure_filters
         where tenant_id=$1 and ((kind='identity' and value=$2) or (kind='commit' and value=$3))`,
        [snapshot.tenantId, snapshot.authorExternalId ?? "", snapshot.commitSha]
      );
      const authorExternalId = filtered.rows.some((row) => row.kind === "identity")
        ? undefined
        : snapshot.authorExternalId;
      const message = filtered.rows.some((row) => row.kind === "commit") ? undefined : snapshot.message;
      const { authorExternalId: _rawAuthor, message: _rawMessage, ...snapshotWithoutSensitiveFields } = snapshot;
      const filteredSnapshot: RepositorySnapshot = {
        ...snapshotWithoutSensitiveFields,
        ...(authorExternalId ? { authorExternalId } : {}),
        ...(message !== undefined ? { message } : {})
      };
      const parentSha = snapshot.parents[0];
      const parentManifest = parentSha
        ? await client.query<{ path: string; blob_sha: string }>(
            `select path,blob_sha from jina_context_graph.commit_manifest($1,$2,$3)`,
            [snapshot.tenantId, snapshot.repository, parentSha]
          )
        : { rows: [] as { path: string; blob_sha: string }[] };
      let files = snapshot.files;
      if (snapshot.mode === "delta") {
        if (!parentSha) throw new DomainError("delta snapshot requires a recorded first parent", "conflict");
        if (snapshot.files.length > 0) throw new DomainError("delta snapshot must not carry a full tree", "conflict");
        // Delta planning checks the parser backlog only for changed blobs, so
        // the live ref head must always arrive as a full tree: that pass is
        // what re-discovers retained blobs whose analyses are still missing.
        if (snapshot.updateRef !== false) {
          throw new DomainError(
            "delta snapshot cannot move the live ref; head commits require a full tree",
            "conflict"
          );
        }
        const parentRecorded = await client.query(
          `select 1 from jina_context_graph.commits where tenant_id=$1 and repository=$2 and sha=$3 and tree_recorded`,
          [snapshot.tenantId, snapshot.repository, parentSha]
        );
        if (parentRecorded.rowCount !== 1)
          throw new DomainError("delta snapshot parent tree is not recorded", "conflict");
        const tree = new Map<string, { path: string; blobSha: string; size: number }>(
          parentManifest.rows.map((row) => [row.path, { path: row.path, blobSha: row.blob_sha, size: 0 }])
        );
        for (const delta of snapshot.deltas ?? []) {
          if (delta.blobSha === null) tree.delete(delta.path);
          else tree.set(delta.path, { path: delta.path, blobSha: delta.blobSha, size: delta.size });
        }
        files = [...tree.values()];
      }
      const candidateObservationId = sourceObservationId(snapshot);
      const storedObservation = await client.query<{ id: string }>(
        `insert into jina_context_graph.observations
          (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
         values ($1,$2,'git','source_snapshot',$3,$4,$5,$6::jsonb,$7)
         on conflict (tenant_id,source,external_id) do update
           set external_id=excluded.external_id
         returning id`,
        [
          candidateObservationId,
          snapshot.tenantId,
          `${snapshot.repository}:${snapshot.commitSha}`,
          snapshot.repository,
          snapshot.recordedAt,
          JSON.stringify(filteredSnapshot),
          stableId("sha", JSON.stringify(filteredSnapshot))
        ]
      );
      const observationId = storedObservation.rows[0]?.id;
      if (!observationId) throw new Error("source observation insert did not resolve an id");
      if (files.length > 0) {
        await client.query(
          `insert into jina_context_graph.trees (tenant_id,tree_sha,paths,blob_shas)
           values ($1,$2,$3,$4) on conflict do nothing`,
          [snapshot.tenantId, snapshot.treeSha, files.map((file) => file.path), files.map((file) => file.blobSha)]
        );
      }
      await client.query(
        `insert into jina_context_graph.commits
          (tenant_id,repository,sha,tree_sha,parents,author_external_id,committed_at,message,source_observation_id,
           tree_paths,tree_blob_shas,tree_recorded)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}','{}',true)
        on conflict (tenant_id,repository,sha) do update set
           tree_sha=excluded.tree_sha,
           tree_recorded=true`,
        [
          snapshot.tenantId,
          snapshot.repository,
          snapshot.commitSha,
          snapshot.treeSha,
          snapshot.parents,
          authorExternalId ?? null,
          snapshot.committedAt ?? null,
          message ?? null,
          observationId
        ]
      );
      const steadyStateEventAt = snapshot.updateRef !== false ? snapshot.recordedAt : undefined;
      const repositoryEntityId = await ensureEntity(
        client,
        snapshot.tenantId,
        {
          kind: "Repository",
          naturalKey: `github:repo:${snapshot.repository}`,
          label: snapshot.repository
        },
        steadyStateEventAt
      );
      const commitEntityId = await ensureEntity(
        client,
        snapshot.tenantId,
        {
          kind: "Commit",
          naturalKey: `repo:${snapshot.repository}:sha:${snapshot.commitSha}`,
          label: snapshot.commitSha.slice(0, 12)
        },
        steadyStateEventAt
      );
      await ensureIdentity(
        client,
        snapshot.tenantId,
        "github-repository",
        snapshot.repository,
        repositoryEntityId,
        "accepted",
        observationId,
        snapshot.recordedAt,
        snapshot.updateRef !== false
      );
      await ensureIdentity(
        client,
        snapshot.tenantId,
        "git-sha",
        snapshot.commitSha,
        commitEntityId,
        "accepted",
        observationId,
        snapshot.recordedAt,
        snapshot.updateRef !== false
      );
      if (snapshot.authorGitHubLogin) {
        const engineerId = await ensureEntity(
          client,
          snapshot.tenantId,
          {
            kind: "Engineer",
            naturalKey: `github:user:${snapshot.authorGitHubLogin}`,
            label: snapshot.authorName ?? snapshot.authorGitHubLogin
          },
          steadyStateEventAt
        );
        await ensureIdentity(
          client,
          snapshot.tenantId,
          "github",
          snapshot.authorGitHubLogin,
          engineerId,
          "accepted",
          observationId,
          snapshot.recordedAt,
          snapshot.updateRef !== false
        );
        if (authorExternalId) {
          await ensureIdentity(
            client,
            snapshot.tenantId,
            "git-email",
            authorExternalId,
            engineerId,
            "proposed",
            observationId,
            snapshot.recordedAt,
            snapshot.updateRef !== false
          );
        }
      }
      let oldRefSha: string | undefined;
      if (snapshot.updateRef !== false) {
        const previousRef = await client.query<{ commit_sha: string }>(
          `select commit_sha from jina_context_graph.refs where tenant_id=$1 and repository=$2 and ref_name=$3 for update`,
          [snapshot.tenantId, snapshot.repository, snapshot.ref]
        );
        oldRefSha = previousRef.rows[0]?.commit_sha;
        await client.query(
          `insert into jina_context_graph.refs (tenant_id,repository,ref_name,commit_sha,is_default,updated_at)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id,repository,ref_name) do update
           set commit_sha=excluded.commit_sha, is_default=excluded.is_default, updated_at=excluded.updated_at`,
          [
            snapshot.tenantId,
            snapshot.repository,
            snapshot.ref,
            snapshot.commitSha,
            snapshot.isDefaultRef ?? snapshot.ref === "main",
            snapshot.recordedAt
          ]
        );
      }
      const blobSource =
        snapshot.mode === "delta"
          ? files.filter((file) =>
              (snapshot.deltas ?? []).some((delta) => delta.path === file.path && delta.blobSha !== null)
            )
          : files;
      if (blobSource.length > 0) {
        const uniqueBlobs = [...new Map(blobSource.map((file) => [file.blobSha, file.size])).entries()];
        await client.query(
          `insert into jina_context_graph.blobs (tenant_id,blob_sha,byte_size)
           select $1,source.blob_sha,source.byte_size
           from unnest($2::text[],$3::integer[]) as source(blob_sha,byte_size)
           on conflict do nothing`,
          [snapshot.tenantId, uniqueBlobs.map(([sha]) => sha), uniqueBlobs.map(([, size]) => size)]
        );
      }
      const missing = await client.query<{ blob_sha: string; path: string; byte_size: number }>(
        `select distinct on (source.blob_sha) source.blob_sha,source.path,b.byte_size
         from unnest($2::text[],$3::text[]) source(path,blob_sha)
         join jina_context_graph.blobs b on b.tenant_id=$1 and b.blob_sha=source.blob_sha
         left join jina_context_graph.blob_analyses a
           on a.tenant_id=$1 and a.blob_sha=source.blob_sha and a.parser_version=$4
         where a.blob_sha is null order by source.blob_sha,source.path`,
        [
          snapshot.tenantId,
          blobSource.map((file) => file.path),
          blobSource.map((file) => file.blobSha),
          CONTEXT_GRAPH_PARSER_VERSION
        ]
      );
      const parentTree = parentManifest.rows.map((file) => ({ path: file.path, blobSha: file.blob_sha, size: 0 }));
      const changes = computeCommitChanges(files, parentTree);
      if (changes.length > 0) {
        await client.query(
          `insert into jina_context_graph.commit_changes
            (tenant_id,repository,commit_sha,path,change,old_path,old_blob_sha,new_blob_sha)
           select $1,$2,$3,source.path,source.change,source.old_path,source.old_blob_sha,source.new_blob_sha
           from unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::text[])
             as source(path,change,old_path,old_blob_sha,new_blob_sha)
           on conflict do nothing`,
          [
            snapshot.tenantId,
            snapshot.repository,
            snapshot.commitSha,
            changes.map((change) => change.path),
            changes.map((change) => change.change),
            changes.map((change) => change.oldPath ?? null),
            changes.map((change) => change.oldBlobSha ?? null),
            changes.map((change) => change.newBlobSha ?? null)
          ]
        );
      }
      if (snapshot.updateRef !== false && oldRefSha !== snapshot.commitSha) {
        await insertOutbox(
          client,
          snapshot.tenantId,
          "observation_recorded",
          observationId,
          {
            observationId,
            repoId: snapshot.repository
          },
          snapshot.recordedAt
        );
        await insertOutbox(
          client,
          snapshot.tenantId,
          "commit_ingested",
          `${snapshot.repository}:${snapshot.commitSha}`,
          {
            repoId: snapshot.repository,
            commitSha: snapshot.commitSha
          },
          snapshot.recordedAt
        );
        await insertOutbox(
          client,
          snapshot.tenantId,
          "ref_moved",
          `${snapshot.repository}:${snapshot.ref}`,
          {
            repoId: snapshot.repository,
            refName: snapshot.ref,
            oldSha: oldRefSha ?? null,
            newSha: snapshot.commitSha
          },
          snapshot.recordedAt
        );
      }
      await reassertPipelineWriteFence(client, writeFence);
      await client.query("commit");
      const discoveredBlobCount = new Set(files.map((file) => file.blobSha)).size;
      return {
        observationId,
        commitSha: snapshot.commitSha,
        fileCount: files.length,
        discoveredBlobCount,
        reusedBlobCount: discoveredBlobCount - missing.rows.length,
        changedPaths: changes.filter((change) => change.change !== "delete").map((change) => change.path),
        changes,
        missingBlobs: missing.rows.map((row) => ({ blobSha: row.blob_sha, path: row.path, size: row.byte_size }))
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async applyBlobAnalyses(
    scope: Pick<RepositorySnapshot, "tenantId" | "repository" | "commitSha">,
    analyses: readonly BlobAnalysis[],
    writeFence?: ContextGraphWriteFence
  ): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertPipelineWriteFence(client, scope.tenantId, scope.repository, "run-context-graph-ingest", writeFence);
      await assertRepositoryWritable(client, scope.tenantId, scope.repository, ["code"]);
      if (analyses.length > 0) {
        const membership = await client.query<{ blob_sha: string }>(
          `select distinct blob_sha from jina_context_graph.commit_manifest($1,$2,$3)
           where blob_sha=any($4::text[])`,
          [
            scope.tenantId,
            scope.repository,
            scope.commitSha,
            [...new Set(analyses.map((analysis) => analysis.blobSha))]
          ]
        );
        const knownBlobShas = new Set(membership.rows.map((row) => row.blob_sha));
        for (const analysis of analyses) {
          if (!knownBlobShas.has(analysis.blobSha)) {
            throw new Error(`blob ${analysis.blobSha} is not in the recorded snapshot`);
          }
        }
        const inserted = await client.query<{ blob_sha: string; parser_version: string }>(
          `insert into jina_context_graph.blob_analyses (tenant_id,blob_sha,parser_version,language)
           select $1,source.blob_sha,source.parser_version,source.language
           from unnest($2::text[],$3::text[],$4::text[]) as source(blob_sha,parser_version,language)
           on conflict do nothing returning blob_sha,parser_version`,
          [
            scope.tenantId,
            analyses.map((analysis) => analysis.blobSha),
            analyses.map((analysis) => analysis.parserVersion),
            analyses.map((analysis) => analysis.language ?? null)
          ]
        );
        const analysisKey = (blobSha: string, parserVersion: string) => `${blobSha}\u0000${parserVersion}`;
        const insertedKeys = new Set(inserted.rows.map((row) => analysisKey(row.blob_sha, row.parser_version)));
        const seenKeys = new Set<string>();
        const active = analyses.filter((analysis) => {
          const key = analysisKey(analysis.blobSha, analysis.parserVersion);
          if (!insertedKeys.has(key) || seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
        const symbols = active.flatMap((analysis) => analysis.symbols.map((symbol) => ({ analysis, symbol })));
        if (symbols.length > 0) {
          await client.query(
            `insert into jina_context_graph.blob_symbols
              (tenant_id,blob_sha,parser_version,moniker,name,kind,signature_hash,start_line,end_line)
             select $1,source.blob_sha,source.parser_version,source.moniker,source.name,source.kind,
                    source.signature_hash,source.start_line,source.end_line
             from unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::integer[],$9::integer[])
               as source(blob_sha,parser_version,moniker,name,kind,signature_hash,start_line,end_line)
             on conflict do nothing`,
            [
              scope.tenantId,
              symbols.map(({ analysis }) => analysis.blobSha),
              symbols.map(({ analysis }) => analysis.parserVersion),
              symbols.map(({ symbol }) => symbol.moniker),
              symbols.map(({ symbol }) => symbol.name),
              symbols.map(({ symbol }) => symbol.kind),
              symbols.map(({ symbol }) => symbol.signatureHash),
              symbols.map(({ symbol }) => symbol.startLine),
              symbols.map(({ symbol }) => symbol.endLine)
            ]
          );
        }
        const imports = active.flatMap((analysis) => analysis.imports.map((item) => ({ analysis, item })));
        if (imports.length > 0) {
          await client.query(
            `insert into jina_context_graph.blob_imports
              (tenant_id,blob_sha,parser_version,specifier,line)
             select $1,source.blob_sha,source.parser_version,source.specifier,source.line
             from unnest($2::text[],$3::text[],$4::text[],$5::integer[])
               as source(blob_sha,parser_version,specifier,line)
             on conflict do nothing`,
            [
              scope.tenantId,
              imports.map(({ analysis }) => analysis.blobSha),
              imports.map(({ analysis }) => analysis.parserVersion),
              imports.map(({ item }) => item.specifier),
              imports.map(({ item }) => item.line)
            ]
          );
        }
        const edges = active.flatMap((analysis) => analysis.edges.map((edge) => ({ analysis, edge })));
        if (edges.length > 0) {
          await client.query(
            `insert into jina_context_graph.symbol_edges
              (tenant_id,blob_sha,parser_version,from_moniker,kind,to_moniker,start_line,end_line)
             select $1,source.blob_sha,source.parser_version,source.from_moniker,source.kind,
                    source.to_moniker,source.start_line,source.end_line
             from unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::integer[],$8::integer[])
               as source(blob_sha,parser_version,from_moniker,kind,to_moniker,start_line,end_line)
             on conflict do nothing`,
            [
              scope.tenantId,
              edges.map(({ analysis }) => analysis.blobSha),
              edges.map(({ analysis }) => analysis.parserVersion),
              edges.map(({ edge }) => edge.fromMoniker),
              edges.map(({ edge }) => edge.kind),
              edges.map(({ edge }) => edge.toMoniker),
              edges.map(({ edge }) => edge.startLine),
              edges.map(({ edge }) => edge.endLine)
            ]
          );
        }
      }
      await reassertPipelineWriteFence(client, writeFence);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async applyGitHubObservations(
    observations: readonly RepositorySourceObservation[],
    writeFence?: ContextGraphWriteFence
  ): Promise<ContextGraphSourceIngestResult> {
    await this.initialize();
    const client = await this.pool.connect();
    let assertionCount = 0;
    let newObservationCount = 0;
    let updatedObservationCount = 0;
    let confirmedObservationCount = 0;
    const observationIds: string[] = [];
    try {
      await client.query("begin");
      if (observations[0]) {
        await assertPipelineWriteFence(
          client,
          observations[0].tenantId,
          observations[0].repository,
          "run-context-graph-ingest",
          writeFence
        );
      }
      const scopes = [
        ...new Set(observations.map((observation) => `${observation.tenantId}\0${observation.repository}`))
      ].sort();
      for (const scope of scopes) {
        const [tenantId, repository] = scope.split("\0");
        await assertRepositoryWritable(client, tenantId!, repository!, ["knowledge"]);
      }
      // The mechanical per-observation layers below (prior-version probes, observation
      // inserts, latest-snapshot checks, entity/identity ensures, and their outbox rows)
      // are batched into a handful of statements. The per-assertion natural-key work and
      // the retraction sweep intentionally stay sequential per observation, in batch
      // order, because a later observation of the same work item must observe (and
      // supersede or retract) the assertion rows written by an earlier batch member.
      const prepared = observations.map((observation, index) => {
        const source = sourceObservationProvider(observation);
        const externalId = sourceObservationExternalId(observation);
        const payload = JSON.stringify(observation);
        return {
          index,
          observation,
          normalized: normalizeSourceObservation(observation),
          source,
          externalId,
          observationId: stableId("observation", `${observation.tenantId}:${source}:${externalId}`),
          scope: repositoryObservationScope(observation),
          payload,
          payloadSha: stableId("sha", payload),
          occurredAt: "occurredAt" in observation ? (observation.occurredAt ?? null) : null
        };
      });
      if (prepared.length > 0) {
        const existing = await client.query<{ ord: number; id: string }>(
          `select item.ord::int as ord,observation.id
           from unnest($1::text[],$2::text[],$3::text[]) with ordinality
             as item(tenant_id,source,external_id,ord)
           join jina_context_graph.observations observation
             on observation.tenant_id=item.tenant_id
            and observation.source=item.source
            and observation.external_id=item.external_id`,
          [
            prepared.map((item) => item.observation.tenantId),
            prepared.map((item) => item.source),
            prepared.map((item) => item.externalId)
          ]
        );
        for (const row of existing.rows) prepared[row.ord - 1]!.observationId = row.id;
      }
      for (const item of prepared) observationIds.push(item.observationId);
      // Prior-version probes, batched. This runs BEFORE the batch insert so it sees
      // exactly the pre-transaction rows; sequential execution additionally saw earlier
      // batch members that had just been inserted, which is reproduced in TypeScript
      // below when the counts are classified.
      const dbPriorVersion = new Set<number>();
      if (prepared.length > 0) {
        const priorRows = await client.query<{ ord: number }>(
          `select item.ord::int as ord
           from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[]) with ordinality
             as item(tenant_id,repository,source,kind,field,value,ord)
           where exists (
             select 1 from jina_context_graph.observations o
             where o.tenant_id=item.tenant_id and o.repository=item.repository and o.source=item.source
               and o.payload->>'kind'=item.kind
               and (item.field is null or o.payload->>item.field=item.value))`,
          [
            prepared.map((item) => item.observation.tenantId),
            prepared.map((item) => item.observation.repository),
            prepared.map((item) => item.source),
            prepared.map((item) => item.observation.kind),
            prepared.map((item) => item.scope.field),
            prepared.map((item) => item.scope.value)
          ]
        );
        for (const row of priorRows.rows) dbPriorVersion.add(Number(row.ord) - 1);
      }
      // Observation inserts, batched. The conflict key (tenant_id,source,external_id)
      // fully determines the observation id, so only the first batch occurrence of each
      // id is inserted; later occurrences would have conflicted sequentially and count
      // as confirmed below.
      const firstOccurrence = new Map<string, number>();
      for (const item of prepared) {
        if (!firstOccurrence.has(item.observationId)) firstOccurrence.set(item.observationId, item.index);
      }
      const insertRows = prepared.filter((item) => firstOccurrence.get(item.observationId) === item.index);
      const insertedIds = new Set<string>();
      if (insertRows.length > 0) {
        const inserted = await client.query<{ id: string }>(
          `insert into jina_context_graph.observations
            (id,tenant_id,source,type,external_id,repository,occurred_at,recorded_at,payload,payload_sha)
           select item.id,item.tenant_id,item.source,'source_snapshot',item.external_id,item.repository,
                  item.occurred_at,item.recorded_at,item.payload::jsonb,item.payload_sha
           from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::timestamptz[],$7::timestamptz[],$8::text[],$9::text[])
             as item(id,tenant_id,source,external_id,repository,occurred_at,recorded_at,payload,payload_sha)
           on conflict (tenant_id,source,external_id) do nothing returning id`,
          [
            insertRows.map((item) => item.observationId),
            insertRows.map((item) => item.observation.tenantId),
            insertRows.map((item) => item.source),
            insertRows.map((item) => item.externalId),
            insertRows.map((item) => item.observation.repository),
            insertRows.map((item) => item.occurredAt),
            insertRows.map((item) => item.observation.recordedAt),
            insertRows.map((item) => item.payload),
            insertRows.map((item) => item.payloadSha)
          ]
        );
        for (const row of inserted.rows) insertedIds.add(row.id);
      }
      const insertedFlags = prepared.map(
        (item) => firstOccurrence.get(item.observationId) === item.index && insertedIds.has(item.observationId)
      );
      // Classify new/updated/confirmed exactly as sequential execution did: the prior
      // probe for observation i also matched any EARLIER batch member with the same
      // tenant/repository/source/kind/scope-field-value that was itself inserted.
      const payloadFieldText = (observation: RepositorySourceObservation, field: string): string | undefined => {
        const raw: unknown = (observation as unknown as Record<string, unknown>)[field];
        if (raw === undefined || raw === null) return undefined;
        return typeof raw === "string" ? raw : JSON.stringify(raw);
      };
      const observationEvents: OutboxEventInput[] = [];
      for (const item of prepared) {
        if (!insertedFlags[item.index]) {
          confirmedObservationCount += 1;
          continue;
        }
        const priorVersion =
          dbPriorVersion.has(item.index) ||
          prepared.some(
            (earlier) =>
              earlier.index < item.index &&
              insertedFlags[earlier.index] &&
              earlier.observation.tenantId === item.observation.tenantId &&
              earlier.observation.repository === item.observation.repository &&
              earlier.source === item.source &&
              earlier.observation.kind === item.observation.kind &&
              (item.scope.field === null ||
                payloadFieldText(earlier.observation, item.scope.field) === item.scope.value)
          );
        if (priorVersion) updatedObservationCount += 1;
        else newObservationCount += 1;
        observationEvents.push({
          tenantId: item.observation.tenantId,
          eventType: "observation_recorded",
          aggregateId: item.observationId,
          payload: { observationId: item.observationId, repoId: item.observation.repository },
          createdAt: item.observation.recordedAt
        });
      }
      await insertOutboxBatch(client, observationEvents);
      // Latest-work-item checks, batched (previously isLatestGitHubWorkItemObservation
      // per row; the tuple comparison below is copied from it verbatim). Sequential
      // execution ran the check for observation i after inserting batch members 0..i
      // only, so rows this batch inserted at a LATER position are excluded per item;
      // pre-existing rows (including those that made a batch member "confirmed") always
      // participate.
      const latestByIndex = new Map<number, boolean>();
      const workItems = prepared.filter(
        (item) => item.observation.kind === "pull_request" || item.observation.kind === "issue"
      );
      if (workItems.length > 0) {
        const insertedBatch = prepared.filter((item) => insertedFlags[item.index]);
        const latestRows = await client.query<{ pos: number; is_latest: boolean }>(
          `with item as (
             select * from unnest($1::int[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::timestamptz[],$8::timestamptz[])
               as item(pos,tenant_id,repository,obs_id,kind,number,occurred_at,recorded_at)
           ), batch_inserted as (
             select * from unnest($9::int[],$10::text[]) as batch_inserted(pos,id)
           )
           select item.pos, not exists (
             select 1 from jina_context_graph.observations o
             where o.tenant_id=item.tenant_id and o.repository=item.repository and o.source='github' and o.id<>item.obs_id
               and o.payload->>'kind'=item.kind and o.payload->>'number'=item.number
               and (coalesce(o.occurred_at,o.recorded_at),o.recorded_at,o.id) >
                   (coalesce(item.occurred_at,item.recorded_at),item.recorded_at,item.obs_id)
               and not exists (select 1 from batch_inserted b where b.id=o.id and b.pos>item.pos)
           ) as is_latest
           from item`,
          [
            workItems.map((item) => item.index),
            workItems.map((item) => item.observation.tenantId),
            workItems.map((item) => item.observation.repository),
            workItems.map((item) => item.observationId),
            workItems.map((item) => item.observation.kind),
            workItems.map((item) => String((item.observation as GitHubWorkItemObservation).number)),
            workItems.map((item) => item.occurredAt),
            workItems.map((item) => item.observation.recordedAt),
            insertedBatch.map((item) => item.index),
            insertedBatch.map((item) => item.observationId)
          ]
        );
        for (const row of latestRows.rows) latestByIndex.set(Number(row.pos), row.is_latest === true);
      }
      const currentFlags = prepared.map((item) =>
        item.observation.kind === "pull_request" || item.observation.kind === "issue"
          ? latestByIndex.get(item.index) === true
          : insertedFlags[item.index]
      );
      // Entity ensures, batched: one existence probe, one insert, one label update, and
      // batched entity_changed rows. ensureEntity semantics reproduced per entity:
      // - created entities take the label of their FIRST batch occurrence and emit one
      //   entity_changed event at that occurrence's recordedAt;
      // - pre-existing entities (and created entities on later occurrences) take the
      //   label of the LAST occurrence whose observation is a current source snapshot,
      //   matching sequential last-writer-wins label updates.
      const entityStates = new Map<
        string,
        {
          readonly tenantId: string;
          readonly kind: string;
          readonly naturalKey: string;
          readonly firstIndex: number;
          readonly firstLabel: string;
          readonly occurrences: { readonly index: number; readonly label: string }[];
          id?: string;
          created?: boolean;
        }
      >();
      const entityMapKey = (tenantId: string, kind: string, key: string) => `${tenantId}\0${kind}\0${key}`;
      for (const item of prepared) {
        for (const entity of item.normalized.entities) {
          const mapKey = entityMapKey(item.observation.tenantId, entity.kind, entity.key);
          let state = entityStates.get(mapKey);
          if (!state) {
            state = {
              tenantId: item.observation.tenantId,
              kind: entity.kind,
              naturalKey: entity.key,
              firstIndex: item.index,
              firstLabel: entity.displayName,
              occurrences: []
            };
            entityStates.set(mapKey, state);
          }
          state.occurrences.push({ index: item.index, label: entity.displayName });
        }
      }
      const entityList = [...entityStates.values()];
      if (entityList.length > 0) {
        const existing = await client.query<{ ord: number; id: string }>(
          `select item.ord::int as ord,e.id
           from unnest($1::text[],$2::text[],$3::text[]) with ordinality as item(tenant_id,kind,natural_key,ord)
           join jina_context_graph.entities e
             on e.tenant_id=item.tenant_id and e.kind=item.kind and e.natural_key=item.natural_key`,
          [
            entityList.map((state) => state.tenantId),
            entityList.map((state) => state.kind),
            entityList.map((state) => state.naturalKey)
          ]
        );
        for (const row of existing.rows) entityList[Number(row.ord) - 1]!.id = row.id;
        const missing = entityList.filter((state) => state.id === undefined);
        if (missing.length > 0) {
          const created = await client.query<{ id: string }>(
            `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name)
             select item.id,item.tenant_id,item.kind,item.natural_key,item.display_name
             from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[])
               as item(id,tenant_id,kind,natural_key,display_name)
             on conflict do nothing returning id`,
            [
              missing.map((state) => stableId("entity", `${state.tenantId}:${state.kind}:${state.naturalKey}`)),
              missing.map((state) => state.tenantId),
              missing.map((state) => state.kind),
              missing.map((state) => state.naturalKey),
              missing.map((state) => state.firstLabel)
            ]
          );
          const createdIds = new Set(created.rows.map((row) => row.id));
          const unresolved: typeof missing = [];
          for (const state of missing) {
            const id = stableId("entity", `${state.tenantId}:${state.kind}:${state.naturalKey}`);
            if (createdIds.has(id)) {
              state.id = id;
              state.created = true;
            } else unresolved.push(state);
          }
          if (unresolved.length > 0) {
            // The insert conflicted without a natural-key match from the existence
            // probe: either a concurrent transaction created the entity (re-resolve it,
            // as sequential ensureEntity did) or the deterministic id collided with a
            // different natural key (surface the same error).
            const reresolved = await client.query<{ ord: number; id: string }>(
              `select item.ord::int as ord,e.id
               from unnest($1::text[],$2::text[],$3::text[]) with ordinality as item(tenant_id,kind,natural_key,ord)
               join jina_context_graph.entities e
                 on e.tenant_id=item.tenant_id and e.kind=item.kind and e.natural_key=item.natural_key`,
              [
                unresolved.map((state) => state.tenantId),
                unresolved.map((state) => state.kind),
                unresolved.map((state) => state.naturalKey)
              ]
            );
            for (const row of reresolved.rows) unresolved[Number(row.ord) - 1]!.id = row.id;
            if (unresolved.some((state) => state.id === undefined)) throw new Error("entity id collision");
          }
        }
        await insertOutboxBatch(
          client,
          entityList
            .filter((state) => state.created)
            .map((state) => ({
              tenantId: state.tenantId,
              eventType: "entity_changed",
              aggregateId: state.id!,
              payload: { entityId: state.id! },
              createdAt: prepared[state.firstIndex]!.observation.recordedAt
            }))
        );
        const labelUpdates: { readonly id: string; readonly label: string }[] = [];
        for (const state of entityList) {
          // The creating call set the label unconditionally; every LATER call whose
          // observation is a current source snapshot overwrote it, so the last such
          // occurrence wins. Pre-existing entities have no creating call in this batch.
          const updates = (state.created ? state.occurrences.slice(1) : state.occurrences).filter(
            (occurrence) => currentFlags[occurrence.index]
          );
          const last = updates.at(-1);
          if (last) labelUpdates.push({ id: state.id!, label: last.label });
        }
        if (labelUpdates.length > 0) {
          await client.query(
            `update jina_context_graph.entities e set display_name=item.display_name
             from unnest($1::text[],$2::text[]) as item(id,display_name)
             where e.id=item.id`,
            [labelUpdates.map((update) => update.id), labelUpdates.map((update) => update.label)]
          );
        }
      }
      const entityIdFor = (tenantId: string, kind: string, key: string): string =>
        entityStates.get(entityMapKey(tenantId, kind, key))!.id!;
      // Identity inserts, batched. The conflict key (tenant_id,source,external_id,
      // entity_id) fully determines the identity id, so only the first batch occurrence
      // is inserted; sequential later occurrences conflicted and emitted no event.
      const identityRows: {
        readonly identityId: string;
        readonly tenantId: string;
        readonly externalId: string;
        readonly entityId: string;
        readonly observationId: string;
        readonly recordedAt: string;
      }[] = [];
      const seenIdentityIds = new Set<string>();
      for (const item of prepared) {
        const githubIdentity = item.normalized.githubIdentity;
        if (!githubIdentity) continue;
        const entityId = entityIdFor(item.observation.tenantId, githubIdentity.entity.kind, githubIdentity.entity.key);
        const identityId = stableId(
          "identity",
          `${item.observation.tenantId}:github:${githubIdentity.externalId}:${entityId}`
        );
        if (seenIdentityIds.has(identityId)) continue;
        seenIdentityIds.add(identityId);
        identityRows.push({
          identityId,
          tenantId: item.observation.tenantId,
          externalId: githubIdentity.externalId,
          entityId,
          observationId: item.observationId,
          recordedAt: item.observation.recordedAt
        });
      }
      if (identityRows.length > 0) {
        const insertedIdentities = await client.query<{ id: string }>(
          `insert into jina_context_graph.identities
            (id,tenant_id,source,external_id,entity_id,status,confidence,source_observation_id,created_at)
           select item.id,item.tenant_id,'github',item.external_id,item.entity_id,'accepted',1,item.source_observation_id,item.created_at
           from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::timestamptz[])
             as item(id,tenant_id,external_id,entity_id,source_observation_id,created_at)
           on conflict (tenant_id,source,external_id,entity_id) do nothing returning id`,
          [
            identityRows.map((row) => row.identityId),
            identityRows.map((row) => row.tenantId),
            identityRows.map((row) => row.externalId),
            identityRows.map((row) => row.entityId),
            identityRows.map((row) => row.observationId),
            identityRows.map((row) => row.recordedAt)
          ]
        );
        const insertedIdentityIds = new Set(insertedIdentities.rows.map((row) => row.id));
        await insertOutboxBatch(
          client,
          identityRows
            .filter((row) => insertedIdentityIds.has(row.identityId))
            .map((row) => ({
              tenantId: row.tenantId,
              eventType: "identity_changed",
              aggregateId: row.identityId,
              payload: { identityId: row.identityId },
              createdAt: row.recordedAt
            }))
        );
      }
      // Per-assertion natural-key work and retractions stay sequential in batch order:
      // assertion visibility between batch members (a later observation confirming,
      // superseding, or retracting an earlier member's freshly written assertions)
      // depends on this ordering.
      for (const item of prepared) {
        const { observation, normalized, source, observationId, scope } = item;
        const shouldReconcile = insertedFlags[item.index] === true && currentFlags[item.index] === true;
        const desiredAssertionIds: string[] = [];
        for (const intent of normalized.assertions) {
          const subjectId = entityIdFor(observation.tenantId, intent.subject.kind, intent.subject.key);
          const objectId = entityIdFor(observation.tenantId, intent.object.kind, intent.object.key);
          const qualifiers = intent.qualifiers ?? {};
          const qualifiersHash = stableId(
            "q",
            canonicalJson(assertionIdentityQualifiers(intent.predicate, qualifiers))
          );
          const assertionId = stableId(
            "assertion",
            `${observation.tenantId}:${observation.repository}:${subjectId}:${intent.predicate}:${objectId}:${qualifiersHash}:${observationId}`
          );
          const definition = predicateDefinition(intent.predicate);
          await lockAssertionNaturalKey(
            client,
            observation.tenantId,
            observation.repository,
            subjectId,
            intent.predicate,
            objectId,
            qualifiersHash,
            definition.cardinality
          );
          const existingLive = await findLiveAssertionByNaturalKey(
            client,
            observation.tenantId,
            observation.repository,
            subjectId,
            intent.predicate,
            objectId,
            qualifiersHash
          );
          if (existingLive) {
            desiredAssertionIds.push(existingLive.id);
            if (shouldReconcile) {
              await backfillAssertionExplanation(
                client,
                observation.tenantId,
                existingLive.id,
                intent.explanation,
                observation.recordedAt
              );
              await client.query(
                `update jina_context_graph.assertions set
                   last_confirmed_at=greatest(last_confirmed_at,$3)
                 where tenant_id=$1 and id=$2`,
                [observation.tenantId, existingLive.id, observation.recordedAt]
              );
              await insertOutbox(
                client,
                observation.tenantId,
                "assertion_changed",
                existingLive.id,
                {
                  assertionId: existingLive.id,
                  repoId: observation.repository
                },
                observation.recordedAt
              );
              if (definition.cardinality === "one") {
                const superseded = await client.query<{ id: string }>(
                  `update jina_context_graph.assertions set status='superseded',valid_to=$6,superseded_by=$7
                   where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                     and status='active' and id<>$7 returning id`,
                  [
                    observation.tenantId,
                    observation.repository,
                    subjectId,
                    intent.predicate,
                    qualifiersHash,
                    observation.recordedAt,
                    existingLive.id
                  ]
                );
                for (const row of superseded.rows) {
                  await insertOutbox(
                    client,
                    observation.tenantId,
                    "assertion_changed",
                    row.id,
                    {
                      assertionId: row.id,
                      repoId: observation.repository,
                      status: "superseded"
                    },
                    observation.recordedAt
                  );
                }
              }
            }
            assertionCount += 1;
            continue;
          }
          desiredAssertionIds.push(assertionId);
          await client.query(
            `insert into jina_context_graph.assertions as current
             (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
               object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,source_observation_id,
               generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,generator,last_confirmed_at)
             values ($1,$2,$3,'source',$4,$5,$6,$7,$8,$9,$10,$11,$12,
               case when $19 and $20 then 'proposed' when $19 then 'active' else 'retracted' end,1,$22,'[]'::jsonb,$13,
               $21,$14,$15,$16::jsonb,$17,$18,$15)
             on conflict (id) do update set
               last_confirmed_at=greatest(current.last_confirmed_at,excluded.last_confirmed_at),
               source_observation_id=case when $19 then excluded.source_observation_id else current.source_observation_id end,
               subject_label=case when $19 then excluded.subject_label else current.subject_label end,
               object_label=case when $19 then excluded.object_label else current.object_label end,
               status=case when $19 and $20 then 'proposed' when $19 then 'active' else current.status end,
               valid_to=case when $19 then null else current.valid_to end`,
            [
              assertionId,
              observation.tenantId,
              observation.repository,
              subjectId,
              intent.subject.kind,
              intent.subject.key,
              intent.subject.displayName,
              intent.predicate,
              objectId,
              intent.object.kind,
              intent.object.key,
              intent.object.displayName,
              observationId,
              CONTEXT_GRAPH_REGISTRY_VERSION,
              observation.recordedAt,
              JSON.stringify(qualifiers),
              qualifiersHash,
              `source:${source}`,
              shouldReconcile,
              definition.cardinality === "one",
              `${source}-normalizer-v1`,
              intent.explanation
            ]
          );
          assertionCount += 1;
          if (shouldReconcile) {
            if (definition.cardinality === "one") {
              const superseded = await client.query<{ id: string }>(
                `update jina_context_graph.assertions set status='superseded',valid_to=$6,superseded_by=$7
                 where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                   and status='active' and id<>$7 returning id`,
                [
                  observation.tenantId,
                  observation.repository,
                  subjectId,
                  intent.predicate,
                  qualifiersHash,
                  observation.recordedAt,
                  assertionId
                ]
              );
              for (const row of superseded.rows) {
                await insertOutbox(
                  client,
                  observation.tenantId,
                  "assertion_changed",
                  row.id,
                  {
                    assertionId: row.id,
                    repoId: observation.repository,
                    status: "superseded"
                  },
                  observation.recordedAt
                );
              }
              await client.query(
                `update jina_context_graph.assertions set status='active' where tenant_id=$1 and id=$2`,
                [observation.tenantId, assertionId]
              );
            }
            await insertOutbox(
              client,
              observation.tenantId,
              "assertion_changed",
              assertionId,
              {
                assertionId,
                repoId: observation.repository,
                status: "active"
              },
              observation.recordedAt
            );
          }
        }
        if (shouldReconcile) {
          const retracted = await client.query<{ id: string }>(
            `update jina_context_graph.assertions a set status='retracted',valid_to=$9
             where a.tenant_id=$1 and a.repository=$2 and a.generator=any($3::text[])
               and a.status in ('active','proposed') and not (a.id=any($7::text[]))
               and a.source_observation_id in (
                 select o.id from jina_context_graph.observations o
                 where o.tenant_id=$1 and o.repository=$2 and o.source=$4
                   and o.payload->>'kind'=$5 and ($6::text is null or o.payload->>$6=$8)
               )
             returning a.id`,
            [
              observation.tenantId,
              observation.repository,
              observation.kind === "codeowners" ? ["source:codeowners", "source:github"] : [`source:${source}`],
              source,
              observation.kind,
              scope.field,
              desiredAssertionIds,
              scope.value,
              observation.recordedAt
            ]
          );
          for (const row of retracted.rows) {
            await insertOutbox(
              client,
              observation.tenantId,
              "assertion_changed",
              row.id,
              {
                assertionId: row.id,
                repoId: observation.repository,
                status: "retracted"
              },
              observation.recordedAt
            );
          }
        }
      }
      if (observations[0]) await reassertPipelineWriteFence(client, writeFence);
      await client.query("commit");
      return {
        observationCount: observations.length,
        observationIds: [...new Set(observationIds)],
        assertionCount,
        newObservationCount,
        updatedObservationCount,
        confirmedObservationCount
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadAssertionEvidence(
    tenantId: string,
    repository: string,
    observationIds: readonly string[]
  ): Promise<readonly ContextGraphSourceEvidence[]> {
    await this.initialize();
    const requested = [...new Set(observationIds)];
    if (requested.length === 0) return [];
    const result = await this.pool.query<{
      id: string;
      source: string;
      type: string;
      repository: string | null;
      payload_sha: string;
      payload: unknown;
    }>(
      `select id,source,type,repository,payload_sha,payload
       from jina_context_graph.observations
       where tenant_id=$1 and repository=$2 and id=any($3::text[]) and redacted_at is null and payload is not null`,
      [tenantId, repository, requested]
    );
    if (result.rows.length !== requested.length) throw new Error("assertion evidence observation was not found");
    return result.rows
      .map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        repository: row.repository ?? repository,
        payloadSha: row.payload_sha,
        payload: row.payload
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string,
    registryVersion: string,
    evidenceFingerprint: string
  ): Promise<ContextGraphAssertionResult | undefined> {
    await this.initialize();
    const generated = await this.pool.query<{ observation_id: string; evidence_fingerprint: string }>(
      `select id as observation_id,payload->>'evidenceFingerprint' as evidence_fingerprint
       from jina_context_graph.observations
       where tenant_id=$2 and repository=$3 and type='model_output'
         and (
           id=$1
           or (
             payload->>'commitSha'=$4
             and payload->>'generatorVersion'=$5
             and payload->>'registryVersion'=$6
             and payload->>'evidenceFingerprint'=$7
           )
         )
         and redacted_at is null and payload is not null`,
      [
        assertionObservationId({
          tenantId,
          repository,
          commitSha,
          generatorVersion,
          registryVersion,
          evidenceFingerprint
        }),
        tenantId,
        repository,
        commitSha,
        generatorVersion,
        registryVersion,
        evidenceFingerprint
      ]
    );
    const row = generated.rows[0];
    if (!row?.evidence_fingerprint) return undefined;
    return this.assertionResult(
      tenantId,
      repository,
      commitSha,
      generatorVersion,
      registryVersion,
      row.evidence_fingerprint,
      row.observation_id,
      true
    );
  }

  async saveAssertionBatch(
    batch: ContextGraphAssertionBatch,
    writeFence?: ContextGraphWriteFence
  ): Promise<ContextGraphAssertionResult> {
    await this.initialize();
    const normalized = normalizeAssertionBatchLenient(batch);
    const assertions = normalized.assertions;
    const candidateObservationId = assertionObservationId(batch);
    let observationId: string;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertPipelineWriteFence(client, batch.tenantId, batch.repository, "run-context-graph-assert", writeFence);
      await assertRepositoryWritable(client, batch.tenantId, batch.repository, ["knowledge"]);
      const observationSource = `model:${batch.model}`;
      const observationExternalId = `${batch.repository}:${batch.commitSha}:${batch.generatorVersion}:${batch.registryVersion}:${batch.evidenceFingerprint}`;
      const existingObservation = await client.query<{ id: string }>(
        `select id from jina_context_graph.observations
         where tenant_id=$1 and source=$2 and external_id=$3`,
        [batch.tenantId, observationSource, observationExternalId]
      );
      let insertedObservation = false;
      if (existingObservation.rows[0]) {
        observationId = existingObservation.rows[0].id;
      } else {
        const inserted = await client.query<{ id: string }>(
          `insert into jina_context_graph.observations
            (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
           values ($1,$2,$3,'model_output',$4,$5,$6,$7::jsonb,$8)
           on conflict (tenant_id,source,external_id) do nothing returning id`,
          [
            candidateObservationId,
            batch.tenantId,
            observationSource,
            observationExternalId,
            batch.repository,
            batch.generatedAt,
            JSON.stringify(batch),
            stableId("sha", JSON.stringify(batch))
          ]
        );
        if (inserted.rows[0]) {
          observationId = inserted.rows[0].id;
          insertedObservation = true;
        } else {
          const raced = await client.query<{ id: string }>(
            `select id from jina_context_graph.observations
             where tenant_id=$1 and source=$2 and external_id=$3`,
            [batch.tenantId, observationSource, observationExternalId]
          );
          observationId = raced.rows[0]?.id ?? candidateObservationId;
        }
      }
      if (insertedObservation) {
        await insertOutbox(
          client,
          batch.tenantId,
          "observation_recorded",
          observationId,
          {
            observationId,
            repoId: batch.repository
          },
          batch.generatedAt
        );
        // The per-assertion work below used to run sequentially: two ensureEntity calls,
        // one advisory lock, one live lookup, one insert-or-confirm, and one outbox
        // insert per assertion (~6-8 round trips each). Everything except the advisory
        // locks is now batched into a fixed number of statements while reproducing the
        // sequential loop's semantics row for row.
        if (assertions.length > 0) {
          // Model observations may introduce entities, but they must not rename
          // identities already established by deterministic source intake — the batched
          // helper reproduces ensureEntity's assert-path call (updateExisting=false).
          const entityIds = await ensureAssertionEntities(
            client,
            batch.tenantId,
            assertions.flatMap((assertion) => [assertion.subject, assertion.object]),
            batch.generatedAt
          );
          const resolved = assertions.map((assertion) => ({
            assertion,
            subjectId: entityIds.get(`${assertion.subject.kind}:${assertion.subject.naturalKey}`)!,
            objectId: entityIds.get(`${assertion.object.kind}:${assertion.object.naturalKey}`)!,
            qualifiersHash: stableId(
              "q",
              canonicalJson(assertionIdentityQualifiers(assertion.predicate, assertion.qualifiers ?? {}))
            )
          }));
          // Advisory locks stay one query per assertion and are taken in batch order —
          // exactly the order the sequential loop used — so concurrent writers acquire
          // them in the same relative order as before. They are deliberately NOT folded
          // into a single unnest() statement: PostgreSQL does not guarantee that a
          // volatile target-list function is evaluated in ORDER BY order, and lock
          // acquisition order is what keeps this path deadlock-free.
          for (const item of resolved) {
            await lockAssertionNaturalKey(
              client,
              batch.tenantId,
              batch.repository,
              item.subjectId,
              item.assertion.predicate,
              item.objectId,
              item.qualifiersHash,
              predicateDefinition(item.assertion.predicate).cardinality
            );
          }
          // One prefetch replaces the per-assertion findLiveAssertionByNaturalKey calls.
          // It cannot be stale within this transaction: findLiveAssertionByNaturalKey
          // filters on status in ('proposed','active'), and any concurrent writer that
          // could change which row is live for one of these natural keys must first hold
          // the same pg_advisory_xact_lock — it either committed before we acquired the
          // lock above (visible to this read-committed query) or is blocked until we
          // commit. Intra-batch inserts cannot invalidate it either, because
          // normalizeAssertionBatchLenient drops duplicate natural keys, so no key in
          // this batch can be inserted by an earlier iteration of the same batch.
          const liveByKey = await prefetchLiveAssertionsByNaturalKey(
            client,
            batch.tenantId,
            batch.repository,
            resolved
          );
          const confirmations: { readonly id: string; readonly explanation: string | undefined }[] = [];
          const freshInserts: (typeof resolved)[number][] = [];
          const assertionEvents: OutboxBatchEvent[] = [];
          for (const item of resolved) {
            const existingLive = liveByKey.get(
              `${item.subjectId}:${item.assertion.predicate}:${item.objectId}:${item.qualifiersHash}`
            );
            if (existingLive) {
              confirmations.push({ id: existingLive.id, explanation: item.assertion.explanation });
              assertionEvents.push({
                aggregateId: existingLive.id,
                payload: { assertionId: existingLive.id, repoId: batch.repository }
              });
              continue;
            }
            freshInserts.push(item);
            assertionEvents.push({
              aggregateId: item.assertion.id,
              payload: { assertionId: item.assertion.id, repoId: batch.repository, status: item.assertion.status }
            });
          }
          await backfillAssertionExplanations(
            client,
            batch.tenantId,
            confirmations.flatMap((confirmation) =>
              confirmation.explanation ? [{ id: confirmation.id, explanation: confirmation.explanation }] : []
            ),
            batch.generatedAt
          );
          if (confirmations.length > 0) {
            await client.query(
              `update jina_context_graph.assertions
               set last_confirmed_at=greatest(last_confirmed_at,$3)
               where tenant_id=$1 and id=any($2::text[])`,
              [batch.tenantId, confirmations.map((confirmation) => confirmation.id), batch.generatedAt]
            );
          }
          if (freshInserts.length > 0) {
            await client.query(
              `insert into jina_context_graph.assertions
                (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
                 predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,
                 source_observation_id,generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,generator,last_confirmed_at)
               select source.id,$1,$2,source.commit_sha,source.subject_id,source.subject_kind,source.subject_natural_key,
                 source.subject_label,source.predicate,source.object_id,source.object_kind,source.object_natural_key,
                 source.object_label,source.status,source.confidence,source.explanation,source.evidence::jsonb,
                 source.source_observation_id,source.generator_version,source.registry_version,
                 source.recorded_at::timestamptz,source.qualifiers::jsonb,source.qualifiers_hash,source.generator,
                 source.recorded_at::timestamptz
               from unnest(
                 $3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::text[],
                 $12::text[],$13::text[],$14::float8[],$15::text[],$16::text[],$17::text[],$18::text[],$19::text[],
                 $20::text[],$21::text[],$22::text[],$23::text[],$24::text[]
               ) as source(id,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,object_id,
                 object_kind,object_natural_key,object_label,confidence,explanation,evidence,source_observation_id,
                 generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,status,generator)
               on conflict (id) do update set
                 last_confirmed_at=greatest(jina_context_graph.assertions.last_confirmed_at,excluded.last_confirmed_at)`,
              [
                batch.tenantId,
                batch.repository,
                freshInserts.map((item) => item.assertion.id),
                freshInserts.map((item) => item.assertion.commitSha),
                freshInserts.map((item) => item.subjectId),
                freshInserts.map((item) => item.assertion.subject.kind),
                freshInserts.map((item) => item.assertion.subject.naturalKey),
                freshInserts.map((item) => item.assertion.subject.label),
                freshInserts.map((item) => item.assertion.predicate),
                freshInserts.map((item) => item.objectId),
                freshInserts.map((item) => item.assertion.object.kind),
                freshInserts.map((item) => item.assertion.object.naturalKey),
                freshInserts.map((item) => item.assertion.object.label),
                freshInserts.map((item) => item.assertion.confidence),
                freshInserts.map((item) => item.assertion.explanation ?? null),
                freshInserts.map((item) => JSON.stringify(item.assertion.evidence)),
                freshInserts.map((item) => item.assertion.sourceObservationId ?? null),
                freshInserts.map((item) => item.assertion.generatorVersion),
                freshInserts.map((item) => item.assertion.registryVersion),
                freshInserts.map((item) => item.assertion.recordedAt),
                freshInserts.map((item) => JSON.stringify(item.assertion.qualifiers ?? {})),
                freshInserts.map((item) => item.qualifiersHash),
                freshInserts.map((item) => item.assertion.status),
                freshInserts.map((item) => `model:${item.assertion.generatorVersion}`)
              ]
            );
          }
          await insertOutboxEventBatch(client, batch.tenantId, "assertion_changed", assertionEvents, batch.generatedAt);
        }
      }
      await reassertPipelineWriteFence(client, writeFence);
      await client.query("commit");
      const result = await this.assertionResult(
        batch.tenantId,
        batch.repository,
        batch.commitSha,
        batch.generatorVersion,
        batch.registryVersion,
        batch.evidenceFingerprint,
        observationId,
        !insertedObservation
      );
      return { ...result, warnings: normalized.warnings };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async project(request: ContextGraphProjectionRequest): Promise<ContextGraph> {
    await this.initialize();
    const guard = await this.pool.connect();
    try {
      await guard.query("begin");
      // The guard transaction only rewrites entity display labels (knowledge plane).
      await assertRepositoryWritable(guard, request.tenantId, request.repository, ["knowledge"]);
      await guard.query(RESTORE_GITHUB_ENTITY_LABELS_SQL, [request.tenantId, request.repository]);
      await guard.query("commit");
    } catch (error) {
      await guard.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      guard.release();
    }
    const commit = await this.pool.query<{ tree_sha: string; parents: string[]; source_observation_id: string }>(
      `select tree_sha,parents,source_observation_id from jina_context_graph.commits
       where tenant_id=$1 and repository=$2 and sha=$3`,
      [request.tenantId, request.repository, request.commitSha]
    );
    if (!commit.rows[0]) throw new Error("cannot project an contextGraph before repository ingestion");
    const filesResult = await this.pool.query<{ path: string; blob_sha: string; byte_size: number }>(
      `select manifest.path,manifest.blob_sha,blob.byte_size
       from jina_context_graph.commit_manifest($1,$2,$3) manifest
       join jina_context_graph.blobs blob on blob.tenant_id=$1 and blob.blob_sha=manifest.blob_sha
       order by manifest.path`,
      [request.tenantId, request.repository, request.commitSha]
    );
    const analyses = await this.loadAnalyses(request.tenantId, [
      ...new Set(filesResult.rows.map((row) => row.blob_sha))
    ]);
    const [assertionRows, assertionFiles, redirectRows, entityRows] = await Promise.all([
      this.pool.query<StoredAssertionRow>(
        `select * from jina_context_graph.assertions
       where tenant_id=$1 and repository=$2 and status='active' and object_id is not null
       order by recorded_at,id`,
        [request.tenantId, request.repository]
      ),
      this.pool.query<{ commit_sha: string; path: string; blob_sha: string }>(
        `select candidate.commit_sha,manifest.path,manifest.blob_sha
         from (select distinct commit_sha from jina_context_graph.assertions where tenant_id=$1 and repository=$2) candidate
         cross join lateral jina_context_graph.commit_manifest($1,$2,candidate.commit_sha) manifest`,
        [request.tenantId, request.repository]
      ),
      this.pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
        `select from_entity_id,to_entity_id,kind from jina_context_graph.entity_redirects
         where tenant_id=$1 order by created_at,id`,
        [request.tenantId]
      ),
      this.pool.query<{
        id: string;
        kind: StoredAssertion["subject"]["kind"];
        natural_key: string;
        display_name: string;
      }>(`select id,kind,natural_key,display_name from jina_context_graph.entities where tenant_id=$1`, [
        request.tenantId
      ])
    ]);
    const snapshot: RepositorySnapshot = {
      tenantId: request.tenantId,
      repository: request.repository,
      ref: request.ref,
      commitSha: request.commitSha,
      treeSha: commit.rows[0].tree_sha,
      parents: commit.rows[0].parents,
      recordedAt: request.generatedAt,
      taskId: request.taskId,
      files: filesResult.rows.map((row) => ({ path: row.path, blobSha: row.blob_sha, size: row.byte_size }))
    };
    const graph = createContextGraphProjection(
      snapshot,
      analyses,
      applicableAssertions(
        resolveStoredAssertionRows(assertionRows.rows, redirectRows.rows, entityRows.rows).map(storedAssertion),
        assertionFiles.rows,
        filesResult.rows
      ),
      request
    );
    await this.save(graph, request.writeFence);
    return graph;
  }

  async executeCommand(
    tenantId: string,
    actorId: string,
    command: ContextGraphCommand,
    now: string,
    actorIsTenantAdmin = false,
    mutationGuard?: (repository?: string) => Promise<void>
  ): Promise<ContextGraphCommandResult> {
    await this.initialize();
    const auditId = stableId("audit", `${tenantId}:${actorId}:${command.type}:${canonicalJson(command)}:${now}`);
    const client = await this.pool.connect();
    const affectedIds: string[] = [];
    const outboxEventIds: string[] = [];
    try {
      await client.query("begin");
      await authorizeContextGraphCommand(client, tenantId, actorId, command, actorIsTenantAdmin);
      await mutationGuard?.("repository" in command ? command.repository : undefined);
      if (
        command.type === "review_assertion" &&
        command.decision === "reject" &&
        (!command.reason || !command.rejectionCode)
      ) {
        throw new Error("assertion rejection requires a reason and rejection code");
      }
      if ("repository" in command && command.repository) {
        // Tombstoning deletes across every plane, so it needs full exclusion
        // (and skips the tombstone check because it is creating the tombstone).
        if (command.type === "tombstone_repository")
          await lockRepositoryAllPlanes(client, tenantId, command.repository);
        else await assertRepositoryWritable(client, tenantId, command.repository, ["knowledge"]);
      }
      await insertAudit(client, {
        id: auditId,
        tenantId,
        actorId,
        action: command.type,
        input: command,
        result: "accepted",
        now,
        ...("reason" in command && command.reason ? { reason: command.reason } : {})
      });
      if (command.type === "review_assertion") {
        const candidate = await client.query<{
          id: string;
          predicate: string;
          subject_id: string;
          object_id: string;
          qualifiers_hash: string;
          repository: string;
        }>(
          `select id,predicate,subject_id,object_id,qualifiers_hash,repository from jina_context_graph.assertions
           where tenant_id=$1 and id=$2`,
          [tenantId, command.assertionId]
        );
        const pending = candidate.rows[0];
        if (!pending) throw new Error("assertion not found");
        await mutationGuard?.(pending.repository);
        await lockAssertionNaturalKey(
          client,
          tenantId,
          pending.repository,
          pending.subject_id,
          pending.predicate,
          pending.object_id,
          pending.qualifiers_hash,
          predicateDefinition(pending.predicate).cardinality
        );
        const selected = await client.query<{
          id: string;
          status: string;
          predicate: string;
          subject_id: string;
          qualifiers_hash: string;
          repository: string;
        }>(
          `select id,status,predicate,subject_id,qualifiers_hash,repository from jina_context_graph.assertions
           where tenant_id=$1 and id=$2 for update`,
          [tenantId, command.assertionId]
        );
        const assertion = selected.rows[0];
        if (!assertion) throw new Error("assertion not found");
        const allowed =
          command.decision === "accept"
            ? assertion.status === "proposed"
            : command.decision === "reject"
              ? assertion.status === "proposed"
              : assertion.status === "active";
        if (!allowed) throw new Error(`cannot ${command.decision} assertion in ${assertion.status}`);
        const status =
          command.decision === "accept" ? "active" : command.decision === "reject" ? "rejected" : "retracted";
        if (status === "active" && predicateDefinition(assertion.predicate).cardinality === "one") {
          const superseded = await client.query<{ id: string }>(
            `update jina_context_graph.assertions set status='superseded',valid_to=$7,superseded_by=$6,audit_id=$8
             where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5 and status='active' and id<>$6
             returning id`,
            [
              tenantId,
              assertion.repository,
              assertion.subject_id,
              assertion.predicate,
              assertion.qualifiers_hash,
              assertion.id,
              now,
              auditId
            ]
          );
          affectedIds.push(...superseded.rows.map((row) => row.id));
        }
        await client.query(
          `update jina_context_graph.assertions set status=$3,valid_to=case when $3='retracted' then $4 else valid_to end,audit_id=$5
           where tenant_id=$1 and id=$2`,
          [tenantId, assertion.id, status, now, auditId]
        );
        affectedIds.push(assertion.id);
        for (const id of affectedIds) {
          outboxEventIds.push(
            await insertOutbox(
              client,
              tenantId,
              "assertion_changed",
              id,
              {
                assertionId: id,
                repoId: assertion.repository
              },
              now
            )
          );
        }
      } else if (command.type === "relate_assertions") {
        const assertions = await client.query<{ id: string; repository: string }>(
          `select id,repository from jina_context_graph.assertions where tenant_id=$1 and id=any($2::text[]) for update`,
          [tenantId, [command.sourceAssertionId, command.targetAssertionId]]
        );
        if (assertions.rowCount !== 2 || command.sourceAssertionId === command.targetAssertionId) {
          throw new Error("assertion relation endpoints are invalid");
        }
        const repositories = [...new Set(assertions.rows.map((assertion) => assertion.repository))];
        if (repositories.length !== 1) throw new Error("assertion relations must stay within one repository");
        await mutationGuard?.(repositories[0]);
        const evidence = await client.query(
          `select 1 from jina_context_graph.observations
           where tenant_id=$1 and id=$2 and repository=$3 and redacted_at is null`,
          [tenantId, command.evidenceObservationId, repositories[0]]
        );
        if (evidence.rowCount !== 1) throw new Error("assertion relation evidence observation was not found");
        const relationId = stableId(
          "assertion_relation",
          `${tenantId}:${command.sourceAssertionId}:${command.relation}:${command.targetAssertionId}:${command.evidenceObservationId}`
        );
        await client.query(
          `insert into jina_context_graph.assertion_relations
            (id,tenant_id,source_assertion_id,relation,target_assertion_id,evidence_observation_id,created_at)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [
            relationId,
            tenantId,
            command.sourceAssertionId,
            command.relation,
            command.targetAssertionId,
            command.evidenceObservationId,
            now
          ]
        );
        affectedIds.push(relationId, command.sourceAssertionId, command.targetAssertionId);
        for (const repository of repositories)
          outboxEventIds.push(
            await insertOutbox(
              client,
              tenantId,
              "assertion_relation_changed",
              relationId,
              {
                relationId,
                repoId: repository,
                sourceAssertionId: command.sourceAssertionId,
                targetAssertionId: command.targetAssertionId
              },
              now
            )
          );
      } else if (command.type === "merge_entities" || command.type === "unmerge_entities") {
        const entities = await client.query<{ id: string }>(
          `select id from jina_context_graph.entities where tenant_id=$1 and id=any($2::text[])`,
          [tenantId, [command.fromEntityId, command.toEntityId]]
        );
        if (entities.rowCount !== 2) throw new Error("redirect entities must exist in the authenticated tenant");
        if (command.fromEntityId === command.toEntityId) throw new Error("cannot redirect an entity to itself");
        const kind = command.type === "merge_entities" ? "merge" : "unmerge";
        if (kind === "merge") {
          const redirects = await client.query<{
            from_entity_id: string;
            to_entity_id: string;
            kind: "merge" | "unmerge";
          }>(
            `select from_entity_id,to_entity_id,kind from jina_context_graph.entity_redirects
             where tenant_id=$1 order by created_at,id`,
            [tenantId]
          );
          const mapping = redirectMap(redirects.rows);
          mapping.set(command.fromEntityId, command.toEntityId);
          resolveRedirect(mapping, command.fromEntityId);
        }
        const redirectId = stableId(
          "redirect",
          `${tenantId}:${command.fromEntityId}:${command.toEntityId}:${kind}:${now}`
        );
        await client.query(
          `insert into jina_context_graph.entity_redirects
            (id,tenant_id,from_entity_id,to_entity_id,kind,audit_id,created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
          [redirectId, tenantId, command.fromEntityId, command.toEntityId, kind, auditId, now]
        );
        affectedIds.push(redirectId, command.fromEntityId, command.toEntityId);
        outboxEventIds.push(
          await insertOutbox(
            client,
            tenantId,
            "redirect_added",
            redirectId,
            {
              fromEntityId: command.fromEntityId,
              toEntityId: command.toEntityId,
              kind,
              auditId
            },
            now
          )
        );
      } else if (command.type === "redact_observation") {
        const redacted = await client.query<{ repository: string | null }>(
          `update jina_context_graph.observations set payload=null,redacted_at=$3,redaction_reason=$4
           where tenant_id=$1 and id=$2 and redacted_at is null returning repository`,
          [tenantId, command.observationId, now, command.reason]
        );
        if (redacted.rowCount !== 1) throw new Error("observation not found or already redacted");
        await mutationGuard?.(redacted.rows[0]?.repository ?? undefined);
        await insertErasureFilter(client, tenantId, "observation", command.observationId, auditId, now);
        if (command.commitShas?.length) {
          await client.query(
            `update jina_context_graph.commits set message=null where tenant_id=$1 and sha=any($2::text[])`,
            [tenantId, command.commitShas]
          );
          for (const sha of command.commitShas)
            await insertErasureFilter(client, tenantId, "commit", sha, auditId, now);
        }
        const retracted = await client.query<{ id: string }>(
          `update jina_context_graph.assertions set status='retracted',valid_to=$3,audit_id=$4
           where tenant_id=$1 and source_observation_id=$2 and status in ('active','proposed') returning id`,
          [tenantId, command.observationId, now, auditId]
        );
        await client.query(`delete from jina_context_graph.search_documents where tenant_id=$1 and source_id=$2`, [
          tenantId,
          command.observationId
        ]);
        affectedIds.push(command.observationId, ...retracted.rows.map((row) => row.id));
        outboxEventIds.push(
          await insertOutbox(
            client,
            tenantId,
            "observation_redacted",
            command.observationId,
            {
              observationId: command.observationId,
              repoId: redacted.rows[0]?.repository ?? null
            },
            now
          )
        );
      } else if (command.type === "erase_person") {
        const entity = await client.query<{ id: string }>(
          `select id from jina_context_graph.entities where tenant_id=$1 and id=$2 and kind='Engineer' for update`,
          [tenantId, command.entityId]
        );
        if (entity.rowCount !== 1) throw new Error("engineer entity not found");
        const identities = await client.query<{ id: string; external_id: string }>(
          `update jina_context_graph.identities set status='erased'
           where tenant_id=$1 and entity_id=$2 and status<>'erased' returning id,external_id`,
          [tenantId, command.entityId]
        );
        await client.query(`update jina_context_graph.entities set retired_at=$3 where tenant_id=$1 and id=$2`, [
          tenantId,
          command.entityId,
          now
        ]);
        const externalIds = identities.rows.map((identity) => identity.external_id);
        const personalObservationIds: string[] = [];
        if (externalIds.length) {
          await client.query(
            `update jina_context_graph.commits set author_external_id=null where tenant_id=$1 and author_external_id=any($2::text[])`,
            [tenantId, externalIds]
          );
          for (const externalId of externalIds)
            await insertErasureFilter(client, tenantId, "identity", externalId, auditId, now);
          const personalObservations = await client.query<{ id: string; repository: string | null }>(
            `select id,repository from jina_context_graph.observations
             where tenant_id=$1 and redacted_at is null and payload is not null
               and exists (select 1 from unnest($2::text[]) value where payload::text ilike '%' || value || '%')`,
            [tenantId, externalIds]
          );
          if (personalObservations.rows.length) {
            personalObservationIds.push(...personalObservations.rows.map((row) => row.id));
            await client.query(
              `update jina_context_graph.observations set payload=null,redacted_at=$3,redaction_reason=$4
               where tenant_id=$1 and id=any($2::text[])`,
              [tenantId, personalObservations.rows.map((row) => row.id), now, command.reason]
            );
            for (const observation of personalObservations.rows) {
              await insertErasureFilter(client, tenantId, "observation", observation.id, auditId, now);
              outboxEventIds.push(
                await insertOutbox(
                  client,
                  tenantId,
                  "observation_redacted",
                  observation.id,
                  {
                    observationId: observation.id,
                    repoId: observation.repository
                  },
                  now
                )
              );
            }
          }
        }
        const retracted = await client.query<{ id: string; repository: string }>(
          `update jina_context_graph.assertions set status='retracted',valid_to=$4,audit_id=$5
           where tenant_id=$1
             and (subject_id=$2 or object_id=$2 or source_observation_id=any($3::text[]))
             and status in ('active','proposed') returning id,repository`,
          [tenantId, command.entityId, personalObservationIds, now, auditId]
        );
        await client.query(`delete from jina_context_graph.search_documents where tenant_id=$1 and source_id=$2`, [
          tenantId,
          command.entityId
        ]);
        affectedIds.push(
          command.entityId,
          ...identities.rows.map((identity) => identity.id),
          ...retracted.rows.map((row) => row.id)
        );
        for (const id of identities.rows.map((identity) => identity.id)) {
          outboxEventIds.push(await insertOutbox(client, tenantId, "identity_changed", id, { identityId: id }, now));
        }
        for (const assertion of retracted.rows) {
          outboxEventIds.push(
            await insertOutbox(
              client,
              tenantId,
              "assertion_changed",
              assertion.id,
              {
                assertionId: assertion.id,
                repoId: assertion.repository || null,
                status: "retracted"
              },
              now
            )
          );
        }
        outboxEventIds.push(
          await insertOutbox(client, tenantId, "entity_changed", command.entityId, { entityId: command.entityId }, now)
        );
      } else if (command.type === "tombstone_repository") {
        const tombstoneId = stableId("observation", `${tenantId}:tombstone:${command.repository}:${now}`);
        await client.query(
          `insert into jina_context_graph.observations
            (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
           values ($1,$2,'internal:command','tombstone',$3,$3,$4,$5::jsonb,$6)`,
          [
            tombstoneId,
            tenantId,
            command.repository,
            now,
            JSON.stringify({ repository: command.repository, reason: command.reason }),
            stableId("sha", command.reason)
          ]
        );
        await insertErasureFilter(client, tenantId, "repository", command.repository, auditId, now);
        const retracted = await client.query<{ id: string }>(
          `update jina_context_graph.assertions set status='retracted',valid_to=$3,audit_id=$4
           where tenant_id=$1 and repository=$2 and status in ('active','proposed') returning id`,
          [tenantId, command.repository, now, auditId]
        );
        await client.query(
          `update jina_context_graph.entities set retired_at=$3 where tenant_id=$1 and natural_key like $2`,
          [tenantId, `%${command.repository}%`, now]
        );
        await deleteCodePlaneRepository(client, tenantId, command.repository);
        await client.query(`delete from jina_context_graph.search_documents where tenant_id=$1 and repository=$2`, [
          tenantId,
          command.repository
        ]);
        affectedIds.push(tombstoneId, ...retracted.rows.map((row) => row.id));
        outboxEventIds.push(
          await insertOutbox(
            client,
            tenantId,
            "tombstone",
            tombstoneId,
            { scope: { repository: command.repository } },
            now
          )
        );
      } else if (command.type === "grant_repository_access") {
        await client.query(
          `insert into jina_context_graph.repository_acl (tenant_id,repository,principal_id,role,created_at)
           values ($1,$2,$3,$4,$5) on conflict (tenant_id,repository,principal_id) do update set role=excluded.role`,
          [tenantId, command.repository, command.principalId, command.role, now]
        );
        affectedIds.push(`${command.repository}:${command.principalId}`);
      } else if (command.type === "assign_relationship") {
        const definition = predicateDefinition(command.predicate);
        const repositoryScope = command.repository ?? "";
        validatePredicateEndpoints(definition, command.subject.kind, command.object.kind);
        validateQualifiers(definition, command.qualifiers);
        const subjectId = await ensureEntity(
          client,
          tenantId,
          {
            kind: command.subject.kind,
            naturalKey: command.subject.key,
            label: command.subject.displayName ?? command.subject.key
          },
          now
        );
        const objectId = await ensureEntity(
          client,
          tenantId,
          {
            kind: command.object.kind,
            naturalKey: command.object.key,
            label: command.object.displayName ?? command.object.key
          },
          now
        );
        const qualifiers = command.qualifiers ?? {};
        const qualifiersHash = stableId("q", canonicalJson(assertionIdentityQualifiers(definition.name, qualifiers)));
        const assertionId = stableId(
          "assertion",
          `${tenantId}:${repositoryScope}:${subjectId}:${definition.name}:${objectId}:${qualifiersHash}:${now}`
        );
        await lockAssertionNaturalKey(
          client,
          tenantId,
          repositoryScope,
          subjectId,
          definition.name,
          objectId,
          qualifiersHash,
          definition.cardinality
        );
        const existingLive = await findLiveAssertionByNaturalKey(
          client,
          tenantId,
          repositoryScope,
          subjectId,
          definition.name,
          objectId,
          qualifiersHash
        );
        if (existingLive) {
          if (definition.cardinality === "one") {
            const superseded = await client.query<{ id: string }>(
              `update jina_context_graph.assertions set status='superseded',valid_to=$6,superseded_by=$7,audit_id=$8
               where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                 and status='active' and id<>$7 returning id`,
              [tenantId, repositoryScope, subjectId, definition.name, qualifiersHash, now, existingLive.id, auditId]
            );
            affectedIds.push(...superseded.rows.map((row) => row.id));
            for (const row of superseded.rows) {
              outboxEventIds.push(
                await insertOutbox(
                  client,
                  tenantId,
                  "assertion_changed",
                  row.id,
                  {
                    assertionId: row.id,
                    repoId: command.repository ?? null,
                    status: "superseded"
                  },
                  now
                )
              );
            }
          }
          await client.query(
            `update jina_context_graph.assertions
             set status='active',last_confirmed_at=greatest(last_confirmed_at,$3),audit_id=$4,
                 explanation=coalesce(explanation,$5)
             where tenant_id=$1 and id=$2`,
            [tenantId, existingLive.id, now, auditId, command.reason]
          );
          affectedIds.push(existingLive.id);
          outboxEventIds.push(
            await insertOutbox(
              client,
              tenantId,
              "assertion_changed",
              existingLive.id,
              {
                assertionId: existingLive.id,
                repoId: command.repository ?? null,
                status: "active"
              },
              now
            )
          );
        } else {
          await client.query(
            `insert into jina_context_graph.assertions
              (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
               object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,asserted_by,generator_version,
               registry_version,recorded_at,qualifiers,qualifiers_hash,last_confirmed_at,audit_id)
             values ($1,$2,$3,'command',$4,$5,$6,$7,$8,$9,$10,$11,$12,$19,1,$20,'[]'::jsonb,$13,'command',$14,$15,$16::jsonb,$17,$15,$18)`,
            [
              assertionId,
              tenantId,
              repositoryScope,
              subjectId,
              command.subject.kind,
              command.subject.key,
              command.subject.displayName ?? command.subject.key,
              definition.name,
              objectId,
              command.object.kind,
              command.object.key,
              command.object.displayName ?? command.object.key,
              actorId,
              CONTEXT_GRAPH_REGISTRY_VERSION,
              now,
              JSON.stringify(qualifiers),
              qualifiersHash,
              auditId,
              definition.cardinality === "one" ? "proposed" : "active",
              command.reason
            ]
          );
          affectedIds.push(assertionId);
          if (definition.cardinality === "one") {
            const superseded = await client.query<{ id: string }>(
              `update jina_context_graph.assertions set status='superseded',valid_to=$6,superseded_by=$7,audit_id=$8
               where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                 and status='active' and id<>$7 returning id`,
              [tenantId, repositoryScope, subjectId, definition.name, qualifiersHash, now, assertionId, auditId]
            );
            affectedIds.push(...superseded.rows.map((row) => row.id));
            for (const row of superseded.rows) {
              outboxEventIds.push(
                await insertOutbox(
                  client,
                  tenantId,
                  "assertion_changed",
                  row.id,
                  {
                    assertionId: row.id,
                    repoId: command.repository ?? null,
                    status: "superseded"
                  },
                  now
                )
              );
            }
            await client.query(
              `update jina_context_graph.assertions set status='active' where tenant_id=$1 and id=$2`,
              [tenantId, assertionId]
            );
          }
          outboxEventIds.push(
            await insertOutbox(
              client,
              tenantId,
              "assertion_changed",
              assertionId,
              {
                assertionId,
                repoId: command.repository ?? null,
                status: "active"
              },
              now
            )
          );
        }
      }
      await client.query("commit");
      return { auditId, action: command.type, affectedIds, outboxEventIds };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      await this.pool
        .query(
          `insert into jina_context_graph.audit_log (id,tenant_id,actor_id,action,input,result,reason,created_at)
         values ($1,$2,$3,$4,$5::jsonb,'rejected',$6,$7) on conflict do nothing`,
          [
            auditId,
            tenantId,
            actorId,
            command.type,
            JSON.stringify(command),
            error instanceof Error ? error.message : String(error),
            now
          ]
        )
        .catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rebuildDerivedProjections(
    tenantId: string,
    repository: string,
    ref: string,
    now: string,
    force = false,
    consumers: readonly ("manifest" | "search" | "reconciliation")[] = ["manifest", "search", "reconciliation"]
  ): Promise<ProjectionRebuildResult> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // A full rebuild also rewrites entity labels, purges observations, and
      // garbage-collects the code plane, so it needs every plane; consumer-scoped
      // rebuilds only replace derived projection artifacts.
      await assertRepositoryWritable(
        client,
        tenantId,
        repository,
        consumers.length === 3 ? REPOSITORY_LOCK_PLANES : ["projection"]
      );
      if (consumers.length === 3) await client.query(RESTORE_GITHUB_ENTITY_LABELS_SQL, [tenantId, repository]);
      const claimToken = `projection:${repository}:${randomUUID()}`;
      const claimed = await client.query<{ id: string }>(
        `with candidates as (
           select id from jina_context_graph.outbox
         where tenant_id=$1 and processed_at is null and available_at<=now()
             and (claim_expires_at is null or claim_expires_at<now())
             and (consumer='legacy' or consumer=any($5::text[]))
             and coalesce(payload->>'repoId',payload#>>'{scope,repository}')=$3
             and payload->>'refName'=$4
           order by created_at,id for update skip locked limit 1000
         )
         update jina_context_graph.outbox o set claimed_by=$6,claimed_at=$2,claim_expires_at=$2::timestamptz+interval '15 minutes',attempts=o.attempts+1
         from candidates where o.id=candidates.id returning o.id`,
        [tenantId, now, repository, ref, consumers, claimToken]
      );
      const head = await client.query<{ commit_sha: string }>(
        `select commit_sha from jina_context_graph.refs where tenant_id=$1 and repository=$2 and ref_name=$3`,
        [tenantId, repository, ref]
      );
      const commitSha = head.rows[0]?.commit_sha;
      if (!commitSha) throw new Error("repository ref has not been ingested");
      if (claimed.rows.length === 0 && !force) {
        const existing = await client.query<{ manifest_count: string; search_count: string }>(
          `select
             (select count(*) from jina_context_graph.ref_manifest
              where tenant_id=$1 and repository=$2 and ref_name=$3 and commit_sha=$4) as manifest_count,
             (select count(*) from jina_context_graph.search_documents
              where tenant_id=$1 and repository=$2) as search_count`,
          [tenantId, repository, ref, commitSha]
        );
        const manifestFileCount = Number(existing.rows[0]?.manifest_count ?? 0);
        const searchDocumentCount = Number(existing.rows[0]?.search_count ?? 0);
        if (manifestFileCount > 0 && searchDocumentCount > 0) {
          await client.query("commit");
          return {
            manifestFileCount,
            searchDocumentCount,
            reconciledAssertionCount: 0,
            rebuilt: false,
            processedEventCount: 0,
            projectedAt: now
          };
        }
      }
      let manifestFileCount = 0;
      if (consumers.includes("manifest")) {
        await client.query(
          `delete from jina_context_graph.ref_manifest where tenant_id=$1 and repository=$2 and ref_name=$3`,
          [tenantId, repository, ref]
        );
        const manifest = await client.query(
          `insert into jina_context_graph.ref_manifest (tenant_id,repository,ref_name,commit_sha,path,blob_sha,projected_at)
           select $1,$2,$3,$4,path,blob_sha,$5
           from jina_context_graph.commit_manifest($1,$2,$4)`,
          [tenantId, repository, ref, commitSha, now]
        );
        manifestFileCount = manifest.rowCount ?? 0;
      }

      let searchDocumentCount = 0;
      if (consumers.includes("search")) {
        await client.query(`delete from jina_context_graph.search_documents where tenant_id=$1 and repository=$2`, [
          tenantId,
          repository
        ]);
        const documents = await client.query<{ id: string; title: string; body: string; source_kind: string }>(
          `select id,source || ':' || type as title,
                case when type='source_snapshot' then '' else coalesce(payload::text,'') end as body,
                'observation' as source_kind
         from jina_context_graph.observations where tenant_id=$1 and repository=$2 and redacted_at is null
         union all
         select distinct e.id,e.display_name as title,e.natural_key as body,'entity' as source_kind
         from jina_context_graph.entities e
         where e.tenant_id=$1 and e.retired_at is null and (
           e.natural_key='github:repo:' || $2 or
           starts_with(e.natural_key,'repo:' || $2 || ':') or
           starts_with(e.natural_key,'github:pr:' || $2 || '#') or
           starts_with(e.natural_key,'github:issue:' || $2 || '#') or
           exists (
             select 1 from jina_context_graph.assertions a
             where a.tenant_id=$1 and a.repository=$2 and (a.subject_id=e.id or a.object_id=e.id)
           )
         )`,
          [tenantId, repository]
        );
        const searchRedirects = await client.query<{
          from_entity_id: string;
          to_entity_id: string;
          kind: "merge" | "unmerge";
        }>(
          `select from_entity_id,to_entity_id,kind from jina_context_graph.entity_redirects
         where tenant_id=$1 order by created_at,id`,
          [tenantId]
        );
        const searchRedirectMap = redirectMap(searchRedirects.rows);
        const projected = documents.rows.filter(
          (document) =>
            document.source_kind !== "entity" || resolveRedirect(searchRedirectMap, document.id) === document.id
        );
        if (projected.length > 0) {
          await client.query(
            `insert into jina_context_graph.search_documents
            (id,tenant_id,repository,source_kind,source_id,title,body,embedding,projected_at)
           select source.id,$1,$2,source.source_kind,source.source_id,source.title,source.body,
                  (select array_agg(element.value::float8 order by element.ordinality)
                   from jsonb_array_elements_text(source.embedding) with ordinality as element(value,ordinality)),
                  $3
           from unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::jsonb[])
             as source(id,source_kind,source_id,title,body,embedding)`,
            [
              tenantId,
              repository,
              now,
              projected.map((document) =>
                stableId("search", `${tenantId}:${repository}:${document.source_kind}:${document.id}`)
              ),
              projected.map((document) => document.source_kind),
              projected.map((document) => document.id),
              projected.map((document) => document.title),
              projected.map((document) => document.body),
              projected.map((document) => JSON.stringify(embeddingForText(`${document.title} ${document.body}`)))
            ]
          );
        }
        searchDocumentCount = projected.length;
      }
      const reconciledAssertionCount = consumers.includes("reconciliation")
        ? await reconcileRedirectCollisions(client, tenantId, now)
        : 0;
      if (consumers.length === 3) {
        await garbageCollectCodePlane(client, tenantId, now, 90);
        await purgeRejectedModelPayloads(client, tenantId, now, 30);
        await client.query(
          `delete from jina_context_graph.retrieval_metrics where tenant_id=$1 and recorded_at<$2::timestamptz-interval '30 days'`,
          [tenantId, now]
        );
      }
      if (claimed.rows.length) {
        await client.query(
          `update jina_context_graph.outbox set processed_at=$2,claimed_by=null,claimed_at=null,claim_expires_at=null
           where id=any($1::text[]) and claimed_by=$3`,
          [claimed.rows.map((row) => row.id), now, claimToken]
        );
      }
      await client.query("commit");
      return {
        manifestFileCount,
        searchDocumentCount,
        reconciledAssertionCount,
        rebuilt: true,
        processedEventCount: claimed.rows.length,
        projectedAt: now
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Event-scoped search projection: replaces only the documents named by the
   * drained events instead of deleting and rebuilding the repository's whole
   * index. Redirect, redaction, and tombstone events still take the full
   * rebuild path.
   */
  private async upsertSearchDocuments(
    tenantId: string,
    repository: string,
    observationIds: readonly string[],
    entityIds: readonly string[],
    now: string
  ): Promise<void> {
    if (observationIds.length === 0 && entityIds.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertRepositoryWritable(client, tenantId, repository, ["projection"]);
      const documents = await client.query<{ id: string; title: string; body: string; source_kind: string }>(
        `select id,source || ':' || type as title,
                case when type='source_snapshot' then '' else coalesce(payload::text,'') end as body,
                'observation' as source_kind
         from jina_context_graph.observations
         where tenant_id=$1 and repository=$2 and redacted_at is null and id=any($3::text[])
         union all
         select distinct e.id,e.display_name as title,e.natural_key as body,'entity' as source_kind
         from jina_context_graph.entities e
         where e.tenant_id=$1 and e.retired_at is null and e.id=any($4::text[]) and (
           e.natural_key='github:repo:' || $2 or
           starts_with(e.natural_key,'repo:' || $2 || ':') or
           starts_with(e.natural_key,'github:pr:' || $2 || '#') or
           starts_with(e.natural_key,'github:issue:' || $2 || '#') or
           exists (
             select 1 from jina_context_graph.assertions a
             where a.tenant_id=$1 and a.repository=$2 and (a.subject_id=e.id or a.object_id=e.id)
           )
         )`,
        [tenantId, repository, observationIds, entityIds]
      );
      const redirects = await client.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
        `select from_entity_id,to_entity_id,kind from jina_context_graph.entity_redirects
         where tenant_id=$1 and from_entity_id=any($2::text[]) order by created_at,id`,
        [tenantId, entityIds]
      );
      const scopedRedirectMap = redirectMap(redirects.rows);
      const projected = documents.rows.filter(
        (document) =>
          document.source_kind !== "entity" || resolveRedirect(scopedRedirectMap, document.id) === document.id
      );
      await client.query(
        `delete from jina_context_graph.search_documents
         where tenant_id=$1 and repository=$2 and (
           (source_kind='observation' and source_id=any($3::text[])) or
           (source_kind='entity' and source_id=any($4::text[])))`,
        [tenantId, repository, observationIds, entityIds]
      );
      if (projected.length > 0) {
        await client.query(
          `insert into jina_context_graph.search_documents
            (id,tenant_id,repository,source_kind,source_id,title,body,embedding,projected_at)
           select source.id,$1,$2,source.source_kind,source.source_id,source.title,source.body,
                  (select array_agg(element.value::float8 order by element.ordinality)
                   from jsonb_array_elements_text(source.embedding) with ordinality as element(value,ordinality)),
                  $3
           from unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::jsonb[])
             as source(id,source_kind,source_id,title,body,embedding)
           on conflict (tenant_id,repository,source_kind,source_id) do update set
             title=excluded.title,body=excluded.body,
             embedding=excluded.embedding,projected_at=excluded.projected_at`,
          [
            tenantId,
            repository,
            now,
            projected.map((document) =>
              stableId("search", `${tenantId}:${repository}:${document.source_kind}:${document.id}`)
            ),
            projected.map((document) => document.source_kind),
            projected.map((document) => document.id),
            projected.map((document) => document.title),
            projected.map((document) => document.body),
            projected.map((document) => JSON.stringify(embeddingForText(`${document.title} ${document.body}`)))
          ]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async drainDerivedProjectionEvents(
    tenantId: string,
    now: string,
    options?: {
      readonly repositories?: readonly string[];
      readonly authorityGuard?: (repository: string) => Promise<void>;
    }
  ): Promise<{ readonly processedEventCount: number; readonly rebuiltRepositories: readonly string[] }> {
    await this.initialize();
    if (options?.repositories && options.repositories.length === 0) {
      return { processedEventCount: 0, rebuiltRepositories: [] };
    }
    const lockName = `jina:context-graph:projection-drain:${tenantId}`;
    const lockClient = await this.projectionLockPool.connect();
    let acquired = false;
    try {
      const result = await lockClient.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1,0)) as acquired",
        [lockName]
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) throw new ContextGraphProjectionDrainBusyError();
      return await this.drainDerivedProjectionEventsLocked(tenantId, now, options);
    } finally {
      if (acquired) {
        await lockClient.query("select pg_advisory_unlock(hashtextextended($1,0))", [lockName]).catch(() => undefined);
      }
      lockClient.release();
    }
  }

  private async drainDerivedProjectionEventsLocked(
    tenantId: string,
    now: string,
    options?: {
      readonly repositories?: readonly string[];
      readonly authorityGuard?: (repository: string) => Promise<void>;
    }
  ): Promise<{ readonly processedEventCount: number; readonly rebuiltRepositories: readonly string[] }> {
    const rebuiltRepositories = new Set<string>();
    let processedEventCount = 0;
    // A repository whose ingest stage is mid-flight would have its projections
    // rebuilt once per drain while blob batches stream in; its events stay
    // pending and retry shortly after the ingest completes.
    const activeIngests = await this.pool
      .query<{ repository: string }>(
        `select distinct repository from jina_board.tasks
       where tenant_id=$1 and stage='ingest' and status='in_progress'`,
        [tenantId]
      )
      .catch(() => ({ rows: [] as { repository: string }[] }));
    const suppressedRepositories = new Set(activeIngests.rows.map((row) => row.repository));
    const repositoryKeys = options?.repositories?.map((repository) => repository.toLowerCase()) ?? null;
    const consumers = ["legacy", "manifest", "search", "reconciliation", "graph"] as const;
    for (const consumer of consumers) {
      const claimOwner = `projection:${consumer}:${randomUUID()}`;
      const allClaimed = await this.pool.query<{
        id: string;
        repository: string | null;
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `with candidates as (
           select id,coalesce(payload->>'repoId',payload#>>'{scope,repository}') as repository
           from jina_context_graph.outbox
           where tenant_id=$1 and consumer=$3 and processed_at is null and available_at<=now()
             and (claim_expires_at is null or claim_expires_at<now())
             and (
               $5::text[] is null
               or coalesce(payload->>'repoId',payload#>>'{scope,repository}') is null
               or lower(coalesce(payload->>'repoId',payload#>>'{scope,repository}'))=any($5::text[])
             )
           order by created_at,id for update skip locked limit 10000
         )
         update jina_context_graph.outbox o
         set claimed_by=$4,claimed_at=$2,claim_expires_at=$2::timestamptz+interval '15 minutes',attempts=o.attempts+1
         from candidates where o.id=candidates.id returning o.id,candidates.repository,o.event_type,o.payload`,
        [tenantId, now, consumer, claimOwner, repositoryKeys]
      );
      if (allClaimed.rows.length === 0) continue;
      const suppressed = allClaimed.rows.filter(
        (row) =>
          suppressedRepositories.size > 0 && (row.repository === null || suppressedRepositories.has(row.repository))
      );
      const suppressedIds = new Set(suppressed.map((row) => row.id));
      if (suppressedIds.size > 0) {
        await this.pool.query(
          `update jina_context_graph.outbox
           set claimed_by=null,claimed_at=null,claim_expires_at=null,available_at=now()+interval '30 seconds'
           where id=any($1::text[]) and claimed_by=$2`,
          [[...suppressedIds], claimOwner]
        );
      }
      const claimed = { rows: allClaimed.rows.filter((row) => !suppressedIds.has(row.id)) };
      if (claimed.rows.length === 0) continue;
      const ids = claimed.rows.map((row) => row.id);
      const affectedRepositories = new Set(claimed.rows.flatMap((row) => (row.repository ? [row.repository] : [])));
      if (claimed.rows.some((row) => row.repository === null)) {
        const all = await this.pool.query<{ repository: string }>(
          `select distinct repository from jina_context_graph.refs
           where tenant_id=$1 and ($2::text[] is null or lower(repository)=any($2::text[]))`,
          [tenantId, repositoryKeys]
        );
        for (const row of all.rows) affectedRepositories.add(row.repository);
      }
      try {
        if (consumer === "reconciliation") {
          const client = await this.pool.connect();
          try {
            await client.query("begin");
            await reconcileRedirectCollisions(client, tenantId, now);
            await client.query("commit");
          } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        }
        for (const repository of [...affectedRepositories].sort()) {
          if (repositoryKeys && !repositoryKeys.includes(repository.toLowerCase())) continue;
          await options?.authorityGuard?.(repository);
          const refs = await this.pool.query<{ ref_name: string; commit_sha: string }>(
            `select ref_name,commit_sha from jina_context_graph.refs
             where tenant_id=$1 and repository=$2 order by is_default desc,ref_name`,
            [tenantId, repository]
          );
          if (refs.rows.length === 0) continue;
          if (consumer === "search") {
            const scopedTypes = new Set(["observation_recorded", "entity_changed", "identity_changed"]);
            const relevant = claimed.rows.filter((row) => row.repository === null || row.repository === repository);
            if (relevant.length > 0 && relevant.every((row) => scopedTypes.has(row.event_type))) {
              await this.upsertSearchDocuments(
                tenantId,
                repository,
                relevant.flatMap((row) =>
                  row.event_type === "observation_recorded" && typeof row.payload.observationId === "string"
                    ? [row.payload.observationId]
                    : []
                ),
                relevant.flatMap((row) =>
                  row.event_type === "entity_changed" && typeof row.payload.entityId === "string"
                    ? [row.payload.entityId]
                    : []
                ),
                now
              );
            } else {
              await this.rebuildDerivedProjections(tenantId, repository, refs.rows[0]!.ref_name, now, true, ["search"]);
            }
          } else if (consumer === "manifest") {
            for (const row of refs.rows) {
              await this.rebuildDerivedProjections(tenantId, repository, row.ref_name, now, true, ["manifest"]);
            }
          } else if (consumer === "legacy") {
            for (const row of refs.rows) {
              await this.rebuildDerivedProjections(tenantId, repository, row.ref_name, now, true);
              await this.project({
                tenantId,
                repository,
                ref: row.ref_name,
                commitSha: row.commit_sha,
                taskId: `projection-drain:${stableId("scope", `${tenantId}:${repository}:${row.ref_name}:${now}:legacy`)}`,
                generatedAt: now
              });
            }
          } else if (consumer === "graph") {
            for (const row of refs.rows) {
              await this.project({
                tenantId,
                repository,
                ref: row.ref_name,
                commitSha: row.commit_sha,
                taskId: `projection-drain:${stableId("scope", `${tenantId}:${repository}:${row.ref_name}:${now}:graph`)}`,
                generatedAt: now
              });
            }
          }
          await options?.authorityGuard?.(repository);
          rebuiltRepositories.add(repository);
        }
        const acknowledged = await this.pool.query(
          `update jina_context_graph.outbox
           set processed_at=$2,claimed_by=null,claimed_at=null,claim_expires_at=null,last_error=null
           where id=any($1::text[]) and claimed_by=$3`,
          [ids, now, claimOwner]
        );
        processedEventCount += acknowledged.rowCount ?? 0;
      } catch (error) {
        await this.pool
          .query(
            `update jina_context_graph.outbox
           set claimed_by=null,claimed_at=null,claim_expires_at=null,last_error=$2,available_at=now()+interval '30 seconds'
           where id=any($1::text[]) and claimed_by=$3`,
            [ids, error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000), claimOwner]
          )
          .catch(() => undefined);
        throw error;
      }
    }
    return { processedEventCount, rebuiltRepositories: [...rebuiltRepositories].sort() };
  }

  async parserBacklogRefs(
    tenantId: string,
    options: { readonly repositories?: readonly string[]; readonly limit?: number } = {}
  ): Promise<
    readonly {
      readonly tenantId: string;
      readonly repository: string;
      readonly ref: string;
      readonly unparsedBlobCount: number;
    }[]
  > {
    await this.initialize();
    if (options.repositories && options.repositories.length === 0) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const result = await this.pool.query<{ repository: string; ref_name: string; count: string }>(
      `select ref.repository,ref.ref_name,count(distinct manifest.blob_sha) as count
       from jina_context_graph.refs ref
       cross join lateral jina_context_graph.commit_manifest(
         ref.tenant_id,ref.repository,ref.commit_sha
       ) manifest
       left join jina_context_graph.blob_analyses analysis
         on analysis.tenant_id=ref.tenant_id and analysis.blob_sha=manifest.blob_sha
        and analysis.parser_version=$2
       where ref.tenant_id=$1
         and ($3::text[] is null or ref.repository=any($3::text[]))
         and analysis.blob_sha is null
       group by ref.repository,ref.ref_name
       order by count(distinct manifest.blob_sha) desc,ref.repository,ref.ref_name
       limit $4`,
      [tenantId, CONTEXT_GRAPH_PARSER_VERSION, options.repositories ?? null, limit]
    );
    return result.rows.map((row) => ({
      tenantId,
      repository: row.repository,
      ref: row.ref_name,
      unparsedBlobCount: Number(row.count)
    }));
  }

  async operationalMetrics(
    tenantId: string,
    now: string,
    scope?: {
      readonly repository?: string;
      readonly repositories?: readonly string[];
      readonly ref?: string;
    }
  ): Promise<ContextGraphOperationalMetrics> {
    await this.initialize();
    const repositories = scope?.repositories ?? (scope?.repository ? [scope.repository] : null);
    const ref = scope?.ref ?? null;
    const backlogQuery = this.pool.query<{ count: string }>(
      `select count(distinct manifest.blob_sha)
       from jina_context_graph.refs ref
       cross join lateral jina_context_graph.commit_manifest(
         ref.tenant_id,ref.repository,ref.commit_sha
       ) manifest
       left join jina_context_graph.blob_analyses analysis
         on analysis.tenant_id=ref.tenant_id and analysis.blob_sha=manifest.blob_sha
        and analysis.parser_version=$2
       where ref.tenant_id=$1
         and ($3::text[] is null or ref.repository=any($3::text[]))
         and ($4::text is null or ref.ref_name=$4)
         and analysis.blob_sha is null`,
      [tenantId, CONTEXT_GRAPH_PARSER_VERSION, repositories, ref]
    );
    const [
      outbox,
      backlog,
      parsed,
      proposed,
      unexplained,
      erasure,
      freshness,
      labels,
      retrieval,
      retrievalAccess,
      retrievalChannels
    ] = await Promise.all([
      this.pool.query<{ event_type: string; consumer: string; count: string; oldest: Date | null }>(
        `select event_type,consumer,count(*),min(created_at) as oldest from jina_context_graph.outbox
         where tenant_id=$1 and processed_at is null
           and ($2::text[] is null or coalesce(payload->>'repoId',payload#>>'{scope,repository}')=any($2))
           and ($3::text is null or payload->>'refName' is null or payload->>'refName'=$3)
         group by event_type,consumer`,
        [tenantId, repositories, ref]
      ),
      backlogQuery,
      repositories
        ? this.pool.query<{ count: string }>(
            `select count(distinct analysis.blob_sha)
             from jina_context_graph.refs ref
             cross join lateral jina_context_graph.commit_manifest(
               ref.tenant_id,ref.repository,ref.commit_sha
             ) manifest
             join jina_context_graph.blob_analyses analysis
               on analysis.tenant_id=ref.tenant_id and analysis.blob_sha=manifest.blob_sha
              and analysis.parsed_at>=now()-interval '1 hour'
             where ref.tenant_id=$1 and ref.repository=any($2::text[])
               and ($3::text is null or ref.ref_name=$3)`,
            [tenantId, repositories, ref]
          )
        : this.pool.query<{ count: string }>(
            `select count(*) from jina_context_graph.blob_analyses
             where tenant_id=$1 and parsed_at>=now()-interval '1 hour'`,
            [tenantId]
          ),
      this.pool.query<{ count: string }>(
        `select count(*) from jina_context_graph.assertions assertion
         where assertion.tenant_id=$1 and assertion.status='proposed'
           and ($2::text[] is null or assertion.repository=any($2))
           and ($3::text is null or exists (
             select 1 from jina_context_graph.refs ref
             where ref.tenant_id=assertion.tenant_id and ref.repository=assertion.repository
               and ref.commit_sha=assertion.commit_sha and ref.ref_name=$3
           ))`,
        [tenantId, repositories, ref]
      ),
      this.pool.query<{ count: string }>(
        `select count(*) from jina_context_graph.assertions assertion
         where assertion.tenant_id=$1 and assertion.explanation is null
           and ($2::text[] is null or assertion.repository=any($2))
           and ($3::text is null or exists (
             select 1 from jina_context_graph.refs ref
             where ref.tenant_id=assertion.tenant_id and ref.repository=assertion.repository
               and ref.commit_sha=assertion.commit_sha and ref.ref_name=$3
           ))`,
        [tenantId, repositories, ref]
      ),
      this.pool.query<{ count: string }>(
        `select count(distinct (event_type,aggregate_id)) from jina_context_graph.outbox
         where tenant_id=$1 and processed_at is null and event_type in ('observation_redacted','tombstone')
           and ($2::text[] is null or coalesce(payload->>'repoId',payload#>>'{scope,repository}')=any($2))
           and ($3::text is null or payload->>'refName' is null or payload->>'refName'=$3)`,
        [tenantId, repositories, ref]
      ),
      this.pool.query<{ manifest: Date | null; search: Date | null }>(
        `select (
           select max(projected_at) from jina_context_graph.ref_manifest
           where tenant_id=$1 and ($2::text[] is null or repository=any($2))
             and ($3::text is null or ref_name=$3)
         ) as manifest,
         (
           select case
             when $3::text is null then max(search.projected_at)
             else least(
               max(search.projected_at),
               (
                 select max(manifest.projected_at)
                 from jina_context_graph.ref_manifest manifest
                 where manifest.tenant_id=$1
                   and ($2::text[] is null or manifest.repository=any($2))
                   and manifest.ref_name=$3
               )
             )
           end
           from jina_context_graph.search_documents search
           where search.tenant_id=$1 and ($2::text[] is null or search.repository=any($2))
         ) as search`,
        [tenantId, repositories, ref]
      ),
      this.pool.query<{ generator: string; predicate: string; accepted: string; rejected: string }>(
        `select a.generator,a.predicate,
          count(*) filter (where l.action='review_assertion' and l.input->>'decision'='accept') as accepted,
          count(*) filter (where l.action='review_assertion' and l.input->>'decision' in ('reject','retract')) as rejected
         from jina_context_graph.audit_log l
         join jina_context_graph.assertions a on a.id=l.input->>'assertionId'
         where l.tenant_id=$1 and a.generator is not null
           and ($2::text[] is null or a.repository=any($2))
           and ($3::text is null or exists (
             select 1 from jina_context_graph.refs ref
             where ref.tenant_id=a.tenant_id and ref.repository=a.repository
               and ref.commit_sha=a.commit_sha and ref.ref_name=$3
           ))
         group by a.generator,a.predicate`,
        [tenantId, repositories, ref]
      ),
      this.pool.query<{ template: string; requests: string; average: string; p95: string; truncated: string }>(
        `select template,count(*) as requests,avg(duration_ms) as average,
                percentile_cont(0.95) within group (order by duration_ms) as p95,
                avg(case when truncated then 1.0 else 0.0 end) as truncated
         from jina_context_graph.retrieval_metrics
         where tenant_id=$1 and recorded_at>=now()-interval '24 hours'
           and ($2::text[] is null or repository=any($2))
         group by template order by template`,
        [tenantId, repositories]
      ),
      this.pool.query<{
        principal_id: string;
        access_channel: "mcp" | "api" | "admin" | "direct";
        template: string;
        requests: string;
        average: string;
        p95: string;
        truncated: string;
        last_accessed_at: Date;
      }>(
        `select principal_id,access_channel,template,count(*) as requests,avg(duration_ms) as average,
                percentile_cont(0.95) within group (order by duration_ms) as p95,
                avg(case when truncated then 1.0 else 0.0 end) as truncated,
                max(recorded_at) as last_accessed_at
         from jina_context_graph.retrieval_metrics
         where tenant_id=$1 and recorded_at>=now()-interval '24 hours'
           and ($2::text[] is null or repository=any($2))
         group by principal_id,access_channel,template
         order by count(*) desc,max(recorded_at) desc
         limit 501`,
        [tenantId, repositories]
      ),
      this.pool.query<{
        access_channel: "mcp" | "api" | "admin" | "direct";
        retrievals: string;
        requests: string;
        actors: string;
        average: string;
        p95: string;
        truncated: string;
      }>(
        `select access_channel,count(*) as retrievals,count(distinct request_id) as requests,
                count(distinct principal_id) as actors,avg(duration_ms) as average,
                percentile_cont(0.95) within group (order by duration_ms) as p95,
                avg(case when truncated then 1.0 else 0.0 end) as truncated
         from jina_context_graph.retrieval_metrics
         where tenant_id=$1 and recorded_at>=now()-interval '24 hours'
           and ($2::text[] is null or repository=any($2))
         group by access_channel order by access_channel`,
        [tenantId, repositories]
      )
    ]);
    const nowMs = new Date(now).getTime();
    const oldest = outbox.rows.flatMap((row) => (row.oldest ? [row.oldest.getTime()] : [])).sort((a, b) => a - b)[0];
    const manifest = freshness.rows[0]?.manifest?.getTime();
    const search = freshness.rows[0]?.search?.getTime();
    return {
      outboxDepth: Object.fromEntries(
        [...new Set(outbox.rows.map((row) => row.event_type))].map((eventType) => [
          eventType,
          outbox.rows.filter((row) => row.event_type === eventType).reduce((sum, row) => sum + Number(row.count), 0)
        ])
      ),
      outboxDepthByConsumer: Object.fromEntries(
        [...new Set(outbox.rows.map((row) => row.consumer))].map((consumer) => [
          consumer,
          outbox.rows.filter((row) => row.consumer === consumer).reduce((sum, row) => sum + Number(row.count), 0)
        ])
      ),
      oldestOutboxAgeSeconds: oldest ? Math.max(0, (nowMs - oldest) / 1000) : 0,
      reconciliationLagSeconds: (() => {
        const timestamp = outbox.rows
          .filter((row) => row.consumer === "reconciliation" && row.oldest)
          .map((row) => row.oldest!.getTime())
          .sort((a, b) => a - b)[0];
        return timestamp ? Math.max(0, (nowMs - timestamp) / 1000) : 0;
      })(),
      unparsedBlobCount: Number(backlog.rows[0]?.count ?? 0),
      parsedBlobCountLastHour: Number(parsed.rows[0]?.count ?? 0),
      manifestStalenessSeconds: manifest ? Math.max(0, (nowMs - manifest) / 1000) : 0,
      searchStalenessSeconds: search ? Math.max(0, (nowMs - search) / 1000) : 0,
      proposedAssertionCount: Number(proposed.rows[0]?.count ?? 0),
      unexplainedAssertionCount: Number(unexplained.rows[0]?.count ?? 0),
      pendingErasureEventCount: Number(erasure.rows[0]?.count ?? 0),
      retrievalTemplates: retrieval.rows.map((row) => ({
        template: row.template,
        requests: Number(row.requests),
        averageLatencyMs: Number(row.average),
        p95LatencyMs: Number(row.p95),
        truncationRate: Number(row.truncated)
      })),
      retrievalAccess: retrievalAccess.rows.slice(0, 500).map((row) => ({
        principalId: row.principal_id,
        accessChannel: row.access_channel,
        template: row.template,
        requests: Number(row.requests),
        averageLatencyMs: Number(row.average),
        p95LatencyMs: Number(row.p95),
        truncationRate: Number(row.truncated),
        lastAccessedAt: row.last_accessed_at.toISOString()
      })),
      retrievalAccessTruncated: retrievalAccess.rows.length > 500,
      retrievalChannels: retrievalChannels.rows.map((row) => ({
        accessChannel: row.access_channel,
        retrievals: Number(row.retrievals),
        requests: Number(row.requests),
        actors: Number(row.actors),
        averageLatencyMs: Number(row.average),
        p95LatencyMs: Number(row.p95),
        truncationRate: Number(row.truncated)
      })),
      acceptanceRates: labels.rows.map((row) => {
        const accepted = Number(row.accepted);
        const rejected = Number(row.rejected);
        return {
          generator: row.generator,
          predicate: row.predicate,
          accepted,
          rejected,
          rate: accepted / Math.max(1, accepted + rejected)
        };
      })
    };
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<readonly string[]> {
    await this.initialize();
    const result = principalId.startsWith("svc:")
      ? await this.pool.query<{ repository: string }>(
          `select distinct repository from jina_context_graph.refs where tenant_id=$1 order by repository`,
          [tenantId]
        )
      : await this.pool.query<{ repository: string }>(
          `select repository from jina_context_graph.repository_acl where tenant_id=$1 and principal_id=$2 order by repository`,
          [tenantId, principalId]
        );
    return result.rows.map((row) => row.repository);
  }

  async listAssertions(
    tenantId: string,
    repository: string,
    filter: {
      readonly status?: StoredAssertion["status"];
      readonly predicate?: string;
      readonly entityKind?: ContextGraphNode["kind"];
      readonly limit?: number;
    } = {}
  ): Promise<readonly ContextGraphAssertionSummary[]> {
    await this.initialize();
    const result = await this.pool.query<{
      id: string;
      repository: string;
      commit_sha: string;
      subject_id: string;
      subject_kind: ContextGraphAssertionSummary["subjectKind"];
      subject_natural_key: string;
      subject_label: string;
      predicate: string;
      object_id: string;
      object_kind: ContextGraphAssertionSummary["objectKind"];
      object_natural_key: string;
      object_label: string;
      status: ContextGraphAssertionSummary["status"];
      confidence: number | null;
      explanation: string | null;
      evidence: string[];
      source_observation_id: string | null;
      qualifiers: Record<string, string | number | boolean>;
      generator: string;
      registry_version: string;
    }>(
      `select id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
              object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,source_observation_id,
              qualifiers,coalesce(generator,'unknown') as generator,registry_version
       from jina_context_graph.assertions
       where tenant_id=$1 and repository=$2
         and ($3::text is null or status=$3)
         and ($4::text is null or predicate=$4)
         and ($5::text is null or subject_kind=$5 or object_kind=$5)
       order by recorded_at desc,id limit $6`,
      [
        tenantId,
        repository,
        filter.status ?? null,
        filter.predicate ?? null,
        filter.entityKind ?? null,
        Math.max(1, Math.min(filter.limit ?? 500, 500))
      ]
    );
    if (result.rows.length === 0) return [];
    const assertionEntityIds = [
      ...new Set(result.rows.flatMap((row) => [row.subject_id, row.object_id]).filter(Boolean))
    ];
    const [redirects, relations] = await Promise.all([
      this.pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
        `with recursive relevant as (
           select redirect.* from jina_context_graph.entity_redirects redirect
            where redirect.tenant_id=$1 and redirect.from_entity_id=any($2::text[])
           union
           select redirect.* from jina_context_graph.entity_redirects redirect
           join relevant prior on redirect.from_entity_id=prior.to_entity_id
            where redirect.tenant_id=$1
         )
         select from_entity_id,to_entity_id,kind from relevant order by created_at,id`,
        [tenantId, assertionEntityIds]
      ),
      this.pool.query<{
        source_assertion_id: string;
        relation: "supports" | "contradicts";
        target_assertion_id: string;
      }>(
        `select source_assertion_id,relation,target_assertion_id from jina_context_graph.assertion_relations
             where tenant_id=$1 and target_assertion_id=any($2::text[])`,
        [tenantId, result.rows.map((row) => row.id)]
      )
    ]);
    const mapping = redirectMap(redirects.rows);
    const resolvedEntityIds = [...new Set(assertionEntityIds.flatMap((id) => [id, resolveRedirect(mapping, id)]))];
    const entities = await this.pool.query<{
      id: string;
      kind: ContextGraphAssertionSummary["subjectKind"];
      natural_key: string;
      display_name: string;
    }>(
      `select id,kind,natural_key,display_name from jina_context_graph.entities where tenant_id=$1 and id=any($2::text[])`,
      [tenantId, resolvedEntityIds]
    );
    const byId = new Map(entities.rows.map((entity) => [entity.id, entity]));
    return result.rows.map((row) => {
      const subject = byId.get(resolveRedirect(mapping, row.subject_id));
      const object = byId.get(resolveRedirect(mapping, row.object_id));
      return {
        id: row.id,
        repository: row.repository,
        commitSha: row.commit_sha,
        subjectKind: subject?.kind ?? row.subject_kind,
        subjectNaturalKey: subject?.natural_key ?? row.subject_natural_key,
        subjectLabel: subject?.display_name ?? row.subject_label,
        predicate: row.predicate,
        objectKind: object?.kind ?? row.object_kind,
        objectNaturalKey: object?.natural_key ?? row.object_natural_key,
        objectLabel: object?.display_name ?? row.object_label,
        status: row.status,
        ...(row.confidence === null ? {} : { confidence: row.confidence }),
        ...(row.explanation ? { explanation: row.explanation } : {}),
        evidence:
          row.evidence.length > 0
            ? row.evidence
            : row.source_observation_id
              ? [`observation:${row.source_observation_id}`]
              : [],
        qualifiers: row.qualifiers,
        generator: row.generator,
        registryVersion: row.registry_version,
        supportingAssertionIds: relations.rows
          .filter((relation) => relation.target_assertion_id === row.id && relation.relation === "supports")
          .map((relation) => relation.source_assertion_id),
        contradictingAssertionIds: relations.rows
          .filter((relation) => relation.target_assertion_id === row.id && relation.relation === "contradicts")
          .map((relation) => relation.source_assertion_id)
      };
    });
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    await this.initialize();
    const startedAt = performance.now();
    if (!request.allowedRepositories.includes(request.repository)) {
      throw new DomainError("repository access denied", "forbidden");
    }
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const refResult = await this.pool.query<{ ref_name: string; commit_sha: string }>(
      `select ref_name,commit_sha from jina_context_graph.refs
       where tenant_id=$1 and repository=$2 and ($3::text is null or ref_name=$3)
       order by case when ref_name=$3 then 0 when is_default then 1 else 2 end,updated_at desc limit 1`,
      [request.tenantId, request.repository, request.ref ?? null]
    );
    const ref = refResult.rows[0];
    if (!ref) throw new Error("repository ref not found");
    const items =
      request.template === "causal_trace" || request.template === "counterfactual"
        ? await this.retrieveCausalTrace(request, ref.ref_name, ref.commit_sha)
        : request.template === "issue_trace"
          ? await retrieveIssueTrace(this.pool, request, ref.ref_name, limit + 1)
          : request.template === "feature_trace"
            ? await retrieveFeatureTrace(this.pool, request, ref.ref_name, limit + 1)
            : request.template === "structure"
              ? await retrieveStructure(this.pool, request, ref.ref_name, limit + 1)
              : request.template === "change"
                ? await retrieveChange(this.pool, request, ref.commit_sha, limit + 1)
                : request.template === "intent"
                  ? await retrieveIntent(this.pool, request, limit + 1)
                  : await retrieveOwnership(this.pool, request, limit + 1);
    // Exit filter repeats the entry permission check so a future template cannot widen scope accidentally.
    const permitted = items.filter((item) =>
      item.citations.every((citation) => request.allowedRepositories.includes(citation.repository))
    );
    const result = {
      template: request.template,
      repository: request.repository,
      ref: ref.ref_name,
      items: permitted.slice(0, limit),
      truncated: permitted.length > limit,
      totalBeforeLimit: permitted.length,
      limit
    };
    const access = request.access ?? {
      principalId: "svc:direct",
      channel: "direct" as const,
      requestId: randomUUID()
    };
    await this.pool.query(
      `insert into jina_context_graph.retrieval_metrics
       (tenant_id,repository,template,request_id,principal_id,access_channel,duration_ms,truncated,recorded_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [
        request.tenantId,
        request.repository,
        request.template,
        access.requestId,
        access.principalId,
        access.channel,
        Math.max(0, performance.now() - startedAt),
        result.truncated
      ]
    );
    return result;
  }

  async migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void> {
    const distinct = [...new Set(aliases.filter((alias) => alias && alias !== tenantId))];
    if (distinct.length === 0) return;
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Lifecycle migration: fully exclude every plane writer for each affected
      // repository. Scopes are sorted so concurrent migrations acquire locks in
      // the same global order (tenant, repository, then plane order).
      const scopes = await client.query<{ tenant_id: string; repository: string }>(
        `select distinct tenant_id,repository from jina_context_graph.graphs
         where tenant_id=any($1::text[]) order by tenant_id,repository`,
        [distinct]
      );
      for (const scope of scopes.rows) await lockRepositoryAllPlanes(client, scope.tenant_id, scope.repository);
      await client.query("update jina_context_graph.graphs set tenant_id = $1 where tenant_id = any($2::text[])", [
        tenantId,
        distinct
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    // The projection pool has one client by design and may legitimately hold
    // it for a multi-minute drain. Only probe it when doing so cannot queue
    // health behind active projection work.
    const projectionPoolIsAvailable = this.projectionLockPool.totalCount === 0 || this.projectionLockPool.idleCount > 0;
    await Promise.all([
      pingPostgresPool(this.pool),
      projectionPoolIsAvailable ? pingPostgresPool(this.projectionLockPool) : undefined
    ]);
  }

  async close(): Promise<void> {
    await Promise.all([this.pool.end(), this.projectionLockPool.end()]);
  }

  private async retrieveCausalTrace(
    request: RetrievalRequest,
    ref: string,
    commitSha: string
  ): Promise<readonly RetrievalItem[]> {
    const graph = await this.pool.query<GraphRow>(
      `select graph.* from jina_context_graph.graph_heads head
       join jina_context_graph.graphs graph on graph.id=head.graph_id
       where head.tenant_id=$1 and head.repository=$2 and head.ref_name=$3
         and graph.commit_sha=$4 and graph.executor='projection'
       limit 1`,
      [request.tenantId, request.repository, ref, commitSha]
    );
    return graph.rows[0] ? causalTraceItemsFromGraph(await this.hydrate(graph.rows[0]), request) : [];
  }

  private async assertionResult(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string,
    registryVersion: string,
    evidenceFingerprint: string,
    observationId: string,
    cached: boolean
  ): Promise<ContextGraphAssertionResult> {
    const modelOutput = await this.pool.query<{ payload: ContextGraphAssertionBatch }>(
      `select payload from jina_context_graph.observations
       where id=$1 and tenant_id=$2 and repository=$3 and type='model_output'
         and redacted_at is null and payload is not null`,
      [observationId, tenantId, repository]
    );
    const generatedAssertions = modelOutput.rows[0]
      ? normalizeAssertionBatchLenient(modelOutput.rows[0].payload).assertions
      : [];
    const generatedKeys = new Set(generatedAssertions.map(assertionNaturalKey));
    const candidates = await this.pool.query<{
      status: StoredAssertion["status"];
      subject_kind: ContextGraphNode["kind"];
      subject_natural_key: string;
      predicate: string;
      object_kind: ContextGraphNode["kind"];
      object_natural_key: string;
      qualifiers: Readonly<Record<string, string | number | boolean>>;
    }>(
      `select status,subject_kind,subject_natural_key,predicate,object_kind,object_natural_key,qualifiers
       from jina_context_graph.assertions where tenant_id=$1 and repository=$2
       order by case status when 'active' then 0 when 'proposed' then 1 else 2 end,recorded_at desc,id`,
      [tenantId, repository]
    );
    const selected = new Map<string, StoredAssertion["status"]>();
    for (const candidate of candidates.rows) {
      const key = assertionNaturalKey({
        subject: { kind: candidate.subject_kind, naturalKey: candidate.subject_natural_key, label: "" },
        predicate: candidate.predicate,
        object: { kind: candidate.object_kind, naturalKey: candidate.object_natural_key, label: "" },
        qualifiers: candidate.qualifiers
      });
      if (generatedKeys.has(key) && !selected.has(key)) selected.set(key, candidate.status);
    }
    const count = (status: string) => [...selected.values()].filter((candidate) => candidate === status).length;
    return {
      observationId,
      assertionCount: selected.size,
      activeCount: count("active"),
      proposedCount: count("proposed"),
      knowledgeCheckpoint: knowledgeCheckpoint(
        tenantId,
        repository,
        commitSha,
        generatorVersion,
        registryVersion,
        evidenceFingerprint
      ),
      cached,
      warnings: []
    };
  }

  private async loadAnalyses(
    tenantId: string,
    blobShas: readonly string[]
  ): Promise<ReadonlyMap<string, BlobAnalysis>> {
    const analyses = new Map<string, BlobAnalysis>();
    if (blobShas.length === 0) return analyses;
    const [rows, symbols, imports, edges] = await Promise.all([
      this.pool.query<{ blob_sha: string; parser_version: string; language: string | null }>(
        `select blob_sha,parser_version,language from jina_context_graph.blob_analyses
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, CONTEXT_GRAPH_PARSER_VERSION]
      ),
      this.pool.query<BlobSymbolRow>(
        `select blob_sha,parser_version,moniker,name,kind,signature_hash,start_line,end_line from jina_context_graph.blob_symbols
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, CONTEXT_GRAPH_PARSER_VERSION]
      ),
      this.pool.query<{ blob_sha: string; parser_version: string; specifier: string; line: number }>(
        `select blob_sha,parser_version,specifier,line from jina_context_graph.blob_imports
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, CONTEXT_GRAPH_PARSER_VERSION]
      ),
      this.pool.query<{
        blob_sha: string;
        from_moniker: string;
        kind: "calls" | "imports" | "references" | "extends";
        to_moniker: string;
        start_line: number;
        end_line: number;
      }>(
        `select blob_sha,from_moniker,kind,to_moniker,start_line,end_line from jina_context_graph.symbol_edges
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, CONTEXT_GRAPH_PARSER_VERSION]
      )
    ]);
    for (const row of rows.rows) {
      analyses.set(`${tenantId}:${row.blob_sha}:${row.parser_version}`, {
        blobSha: row.blob_sha,
        parserVersion: row.parser_version,
        ...(row.language ? { language: row.language } : {}),
        symbols: symbols.rows
          .filter((symbol) => symbol.blob_sha === row.blob_sha)
          .map((symbol) => ({
            moniker: symbol.moniker,
            name: symbol.name,
            kind: symbol.kind,
            signatureHash: symbol.signature_hash,
            startLine: symbol.start_line,
            endLine: symbol.end_line
          })),
        imports: imports.rows
          .filter((item) => item.blob_sha === row.blob_sha)
          .map((item) => ({ specifier: item.specifier, line: item.line })),
        edges: edges.rows
          .filter((edge) => edge.blob_sha === row.blob_sha)
          .map((edge) => ({
            fromMoniker: edge.from_moniker,
            kind: edge.kind,
            toMoniker: edge.to_moniker,
            startLine: edge.start_line,
            endLine: edge.end_line
          }))
      });
    }
    return analyses;
  }

  private async loadGraphs(tenantId: string, limit: number): Promise<readonly ContextGraph[]> {
    await this.initialize();
    const result = await this.pool.query<GraphRow>(
      "select * from jina_context_graph.graphs where tenant_id = $1 order by generated_at desc limit $2",
      [tenantId, limit]
    );
    return Promise.all(result.rows.map((row) => this.hydrate(row)));
  }

  private async hydrate(row: GraphRow): Promise<ContextGraph> {
    const [nodes, edges] = await Promise.all([
      this.pool.query<NodeRow>("select * from jina_context_graph.nodes where graph_id = $1 order by node_id", [row.id]),
      this.pool.query<EdgeRow>("select * from jina_context_graph.edges where graph_id = $1 order by edge_id", [row.id])
    ]);
    return {
      ...graphMetadata(row),
      nodes: nodes.rows.map((node) => ({
        id: node.node_id,
        kind: node.kind,
        label: node.label,
        description: node.description,
        ...(node.path ? { path: node.path } : {}),
        evidence: node.evidence
      })),
      edges: edges.rows.map((edge) => ({
        id: edge.edge_id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        predicate: edge.predicate,
        plane: edge.plane,
        ...(edge.confidence !== null ? { confidence: edge.confidence } : {}),
        ...(edge.why ? { why: edge.why } : {}),
        ...(Object.keys(edge.qualifiers ?? {}).length > 0 ? { qualifiers: edge.qualifiers } : {}),
        evidence: edge.evidence
      }))
    };
  }

  private initialize(): Promise<void> {
    this.initialized ??= this.manageSchema ? this.createSchema() : Promise.resolve();
    return this.initialized;
  }

  private async createSchema(): Promise<void> {
    await applySchema(this.pool, "jina_context_graph.schema", CONTEXT_GRAPH_SCHEMA_SQL);
  }
}

async function insertContextGraph(client: PoolClient, graph: ContextGraph): Promise<void> {
  const inserted = await client.query(
    `insert into jina_context_graph.graphs
      (id, tenant_id, repository, ref, commit_sha, generated_at, executor, model, sandbox_id, summary, node_count, edge_count)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (id) do nothing
     returning id`,
    [
      graph.id,
      graph.tenantId,
      graph.repository,
      graph.ref,
      graph.commitSha,
      graph.generatedAt,
      graph.generator.executor,
      graph.generator.model,
      graph.generator.sandboxId ?? null,
      graph.summary,
      graph.nodes.length,
      graph.edges.length
    ]
  );
  if (inserted.rowCount !== 1) return;
  if (graph.nodes.length > 0) {
    await client.query(
      `insert into jina_context_graph.nodes (graph_id,node_id,kind,label,description,path,evidence)
       select $1, node_id, kind, label, description, path, evidence
       from unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::jsonb[])
         as node(node_id,kind,label,description,path,evidence)`,
      [
        graph.id,
        graph.nodes.map((node) => node.id),
        graph.nodes.map((node) => node.kind),
        graph.nodes.map((node) => node.label),
        graph.nodes.map((node) => node.description),
        graph.nodes.map((node) => node.path ?? null),
        graph.nodes.map((node) => JSON.stringify(node.evidence))
      ]
    );
  }
  if (graph.edges.length > 0) {
    await client.query(
      `insert into jina_context_graph.edges
        (graph_id,edge_id,source_node_id,target_node_id,predicate,plane,confidence,why,qualifiers,evidence)
       select $1, edge_id, source_node_id, target_node_id, predicate, plane, confidence, why, qualifiers, evidence
       from unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::float8[],$8::text[],$9::jsonb[],$10::jsonb[])
         as edge(edge_id,source_node_id,target_node_id,predicate,plane,confidence,why,qualifiers,evidence)`,
      [
        graph.id,
        graph.edges.map((edge) => edge.id),
        graph.edges.map((edge) => edge.source),
        graph.edges.map((edge) => edge.target),
        graph.edges.map((edge) => edge.predicate),
        graph.edges.map((edge) => edge.plane),
        graph.edges.map((edge) => edge.confidence ?? null),
        graph.edges.map((edge) => edge.why ?? null),
        graph.edges.map((edge) => JSON.stringify(edge.qualifiers ?? {})),
        graph.edges.map((edge) => JSON.stringify(edge.evidence))
      ]
    );
  }
}

function repositoryObservationScope(observation: RepositorySourceObservation): {
  readonly field: string | null;
  readonly value: string;
} {
  if (observation.kind === "pull_request" || observation.kind === "issue")
    return { field: "number", value: String(observation.number) };
  if (observation.kind === "package_manifest") return { field: "path", value: observation.path };
  if (observation.kind === "move_candidate") return { field: "commitSha", value: observation.commitSha };
  if (
    observation.kind === "service_definition" ||
    observation.kind === "deployment" ||
    observation.kind === "incident"
  ) {
    return { field: "externalId", value: observation.externalId };
  }
  return { field: null, value: "" };
}

async function ensureEntity(
  client: PoolClient,
  tenantId: string,
  entity: StoredAssertion["subject"],
  eventAt?: string,
  updateExisting = true
): Promise<string> {
  const id = stableId("entity", `${tenantId}:${entity.kind}:${entity.naturalKey}`);
  const inserted = await client.query<{ id: string }>(
    `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name)
     values ($1,$2,$3,$4,$5)
     on conflict do nothing returning id`,
    [id, tenantId, entity.kind, entity.naturalKey, entity.label]
  );
  const created = inserted.rows[0]?.id !== undefined;
  const existing = created
    ? inserted
    : await client.query<{ id: string }>(
        `select id from jina_context_graph.entities
         where tenant_id=$1 and kind=$2 and natural_key=$3`,
        [tenantId, entity.kind, entity.naturalKey]
      );
  const resolvedId = existing.rows[0]?.id;
  if (!resolvedId) throw new Error("entity id collision");
  if (!created && updateExisting) {
    await client.query(`update jina_context_graph.entities set display_name=$2 where id=$1`, [
      resolvedId,
      entity.label
    ]);
  }
  if (eventAt && created) {
    await insertOutbox(client, tenantId, "entity_changed", resolvedId, { entityId: resolvedId }, eventAt);
  }
  return resolvedId;
}

async function ensureIdentity(
  client: PoolClient,
  tenantId: string,
  source: string,
  externalId: string,
  entityId: string,
  status: "proposed" | "accepted",
  observationId: string,
  now: string,
  emitEvent = true
): Promise<string> {
  const id = stableId("identity", `${tenantId}:${source}:${externalId}:${entityId}`);
  const inserted = await client.query(
    `insert into jina_context_graph.identities
      (id,tenant_id,source,external_id,entity_id,status,confidence,source_observation_id,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id,source,external_id,entity_id) do nothing returning id`,
    [id, tenantId, source, externalId, entityId, status, status === "accepted" ? 1 : null, observationId, now]
  );
  if (emitEvent && inserted.rowCount === 1)
    await insertOutbox(client, tenantId, "identity_changed", id, { identityId: id }, now);
  return id;
}

async function authorizeContextGraphCommand(
  client: PoolClient,
  tenantId: string,
  actorId: string,
  command: ContextGraphCommand,
  actorIsTenantAdmin: boolean
): Promise<void> {
  if (actorId.startsWith("svc:") || actorIsTenantAdmin) return;
  if (command.type === "merge_entities" || command.type === "unmerge_entities" || command.type === "erase_person") {
    throw new DomainError("tenant administrator access required", "forbidden");
  }

  let repository: string | undefined;
  let requiresAdmin = false;
  if (command.type === "review_assertion") {
    const result = await client.query<{ repository: string }>(
      `select repository from jina_context_graph.assertions where tenant_id=$1 and id=$2`,
      [tenantId, command.assertionId]
    );
    repository = result.rows[0]?.repository;
  } else if (command.type === "relate_assertions") {
    const result = await client.query<{ repository: string }>(
      `select distinct repository from jina_context_graph.assertions where tenant_id=$1 and id=any($2::text[])`,
      [tenantId, [command.sourceAssertionId, command.targetAssertionId]]
    );
    if (result.rowCount !== 1) throw new Error("assertion relations must stay within one authorized repository");
    repository = result.rows[0]?.repository;
  } else if (command.type === "redact_observation") {
    const result = await client.query<{ repository: string | null }>(
      `select repository from jina_context_graph.observations where tenant_id=$1 and id=$2`,
      [tenantId, command.observationId]
    );
    repository = result.rows[0]?.repository ?? undefined;
  } else {
    repository = "repository" in command ? command.repository : undefined;
    requiresAdmin = command.type === "grant_repository_access" || command.type === "tombstone_repository";
  }
  if (!repository) throw new DomainError("contextGraph command access denied", "forbidden");
  const access = await client.query<{ role: "reader" | "writer" | "admin" }>(
    `select role from jina_context_graph.repository_acl
     where tenant_id=$1 and repository=$2 and principal_id=$3`,
    [tenantId, repository, actorId]
  );
  const role = access.rows[0]?.role;
  if (!role || role === "reader" || (requiresAdmin && role !== "admin")) {
    throw new DomainError("contextGraph command access denied", "forbidden");
  }
}

function storedAssertion(row: StoredAssertionRow): StoredAssertion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    commitSha: row.commit_sha,
    subject: { kind: row.subject_kind, naturalKey: row.subject_natural_key, label: row.subject_label },
    predicate: row.predicate,
    object: { kind: row.object_kind, naturalKey: row.object_natural_key, label: row.object_label },
    status: row.status,
    confidence: row.confidence,
    ...(row.explanation ? { explanation: row.explanation } : {}),
    evidence: row.evidence,
    ...(row.source_observation_id ? { sourceObservationId: row.source_observation_id } : {}),
    ...(row.asserted_by ? { assertedBy: row.asserted_by } : {}),
    qualifiers: row.qualifiers,
    ...(row.valid_from ? { validFrom: row.valid_from.toISOString() } : {}),
    ...(row.valid_to ? { validTo: row.valid_to.toISOString() } : {}),
    lastConfirmedAt: row.last_confirmed_at.toISOString(),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    generatorVersion: row.generator_version,
    registryVersion: row.registry_version,
    recordedAt: row.recorded_at.toISOString()
  };
}

function resolveStoredAssertionRows(
  rows: readonly StoredAssertionRow[],
  redirects: readonly { from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }[],
  entities: readonly {
    id: string;
    kind: StoredAssertion["subject"]["kind"];
    natural_key: string;
    display_name: string;
  }[]
): readonly StoredAssertionRow[] {
  const mapping = redirectMap(redirects);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return rows.map((row) => {
    const subject = byId.get(resolveRedirect(mapping, row.subject_id));
    const object = byId.get(resolveRedirect(mapping, row.object_id));
    return {
      ...row,
      ...(subject
        ? {
            subject_id: subject.id,
            subject_kind: subject.kind,
            subject_natural_key: subject.natural_key,
            subject_label: subject.display_name
          }
        : {}),
      ...(object
        ? {
            object_id: object.id,
            object_kind: object.kind,
            object_natural_key: object.natural_key,
            object_label: object.display_name
          }
        : {})
    };
  });
}

function applicableAssertions(
  assertions: readonly StoredAssertion[],
  sourceFiles: readonly { readonly commit_sha: string; readonly path: string; readonly blob_sha: string }[],
  currentFiles: readonly { readonly path: string; readonly blob_sha: string }[]
): readonly StoredAssertion[] {
  const sourceMap = new Map(sourceFiles.map((file) => [`${file.commit_sha}:${file.path}`, file.blob_sha]));
  const currentMap = new Map(currentFiles.map((file) => [file.path, file.blob_sha]));
  const selected = new Map<string, StoredAssertion>();
  for (const assertion of assertions) {
    const current =
      assertion.evidence.length === 0
        ? (assertion.commitSha === "source" && Boolean(assertion.sourceObservationId)) ||
          (assertion.commitSha === "command" && Boolean(assertion.assertedBy))
        : assertion.evidence.every((citation) => {
            const path = citation.replace(/:\d+(?:-\d+)?$/, "");
            const sourceBlob = sourceMap.get(`${assertion.commitSha}:${path}`);
            return sourceBlob !== undefined && sourceBlob === currentMap.get(path);
          });
    if (!current) continue;
    const key = `${assertion.subject.kind}:${assertion.subject.naturalKey}:${assertion.predicate}:${assertion.object.kind}:${assertion.object.naturalKey}:${canonicalJson(assertionIdentityQualifiers(assertion.predicate, assertion.qualifiers ?? {}))}`;
    const prior = selected.get(key);
    if (!prior || prior.recordedAt < assertion.recordedAt) selected.set(key, assertion);
  }
  return [...selected.values()];
}

function graphMetadata(row: GraphRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref,
    commitSha: row.commit_sha,
    generatedAt: row.generated_at.toISOString(),
    generator: {
      executor: row.executor,
      model: row.model,
      ...(row.sandbox_id ? { sandboxId: row.sandbox_id } : {})
    },
    summary: row.summary
  };
}

interface OutboxEventInput {
  readonly tenantId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** Batch variant of insertOutbox: identical ids, consumer fan-out, and conflict handling. */
async function insertOutboxBatch(client: PoolClient, events: readonly OutboxEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const rows = events.flatMap((event) => {
    const serializedPayload = JSON.stringify(event.payload);
    return outboxConsumers(event.eventType).map((consumer) => ({
      id: stableId(
        "outbox",
        `${event.tenantId}:${event.eventType}:${event.aggregateId}:${event.createdAt}:${serializedPayload}:${consumer}`
      ),
      tenantId: event.tenantId,
      eventType: event.eventType,
      consumer,
      aggregateId: event.aggregateId,
      payload: serializedPayload,
      createdAt: event.createdAt
    }));
  });
  await client.query(
    `insert into jina_context_graph.outbox (id,tenant_id,event_type,consumer,aggregate_id,payload,created_at,available_at)
     select item.id,item.tenant_id,item.event_type,item.consumer,item.aggregate_id,item.payload::jsonb,item.created_at,item.created_at
     from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::timestamptz[])
       as item(id,tenant_id,event_type,consumer,aggregate_id,payload,created_at)
     on conflict do nothing`,
    [
      rows.map((row) => row.id),
      rows.map((row) => row.tenantId),
      rows.map((row) => row.eventType),
      rows.map((row) => row.consumer),
      rows.map((row) => row.aggregateId),
      rows.map((row) => row.payload),
      rows.map((row) => row.createdAt)
    ]
  );
}

async function insertOutbox(
  client: PoolClient,
  tenantId: string,
  eventType: string,
  aggregateId: string,
  payload: Readonly<Record<string, unknown>>,
  createdAt: string
): Promise<string> {
  const consumers = outboxConsumers(eventType);
  const serializedPayload = JSON.stringify(payload);
  const ids = consumers.map((consumer) =>
    stableId("outbox", `${tenantId}:${eventType}:${aggregateId}:${createdAt}:${serializedPayload}:${consumer}`)
  );
  await client.query(
    `insert into jina_context_graph.outbox (id,tenant_id,event_type,consumer,aggregate_id,payload,created_at,available_at)
     select source.id,$1,$2,source.consumer,$3,$4::jsonb,$5,$5
     from unnest($6::text[],$7::text[]) as source(id,consumer)
     on conflict do nothing`,
    [tenantId, eventType, aggregateId, serializedPayload, createdAt, ids, [...consumers]]
  );
  return ids[0]!;
}

interface OutboxBatchEvent {
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Batched equivalent of calling insertOutbox once per event with a shared event type
 * and creation time: identical stable ids, per-consumer fan-out, and conflict handling,
 * but one round trip for the whole batch.
 */
async function insertOutboxEventBatch(
  client: PoolClient,
  tenantId: string,
  eventType: string,
  events: readonly OutboxBatchEvent[],
  createdAt: string
): Promise<void> {
  if (events.length === 0) return;
  const consumers = outboxConsumers(eventType);
  const ids: string[] = [];
  const consumerRows: string[] = [];
  const aggregateIds: string[] = [];
  const payloads: string[] = [];
  for (const event of events) {
    const serializedPayload = JSON.stringify(event.payload);
    for (const consumer of consumers) {
      ids.push(
        stableId(
          "outbox",
          `${tenantId}:${eventType}:${event.aggregateId}:${createdAt}:${serializedPayload}:${consumer}`
        )
      );
      consumerRows.push(consumer);
      aggregateIds.push(event.aggregateId);
      payloads.push(serializedPayload);
    }
  }
  await client.query(
    `insert into jina_context_graph.outbox (id,tenant_id,event_type,consumer,aggregate_id,payload,created_at,available_at)
     select source.id,$1,$2,source.consumer,source.aggregate_id,source.payload::jsonb,$3,$3
     from unnest($4::text[],$5::text[],$6::text[],$7::text[]) as source(id,consumer,aggregate_id,payload)
     on conflict do nothing`,
    [tenantId, eventType, createdAt, ids, consumerRows, aggregateIds, payloads]
  );
}

function outboxConsumers(eventType: string): readonly ("manifest" | "search" | "reconciliation" | "graph")[] {
  switch (eventType) {
    case "ref_moved":
      return ["manifest", "graph"];
    case "observation_recorded":
    case "entity_changed":
    case "identity_changed":
      return ["search", "graph"];
    case "assertion_changed":
      return ["reconciliation", "graph"];
    case "redirect_added":
      return ["reconciliation", "search", "graph"];
    case "observation_redacted":
      return ["search", "graph"];
    case "tombstone":
      return ["manifest", "search", "reconciliation", "graph"];
    default:
      return ["graph"];
  }
}

/**
 * Canonical writes are serialized per repository, but on independent planes so
 * that ingest, knowledge, and projection traffic no longer queue behind each
 * other:
 *   - "code": git-shaped tables (commits, trees, blobs, blob_* / symbol_* rows,
 *     commit_changes, refs).
 *   - "knowledge": observations, entities, identities, assertions and their
 *     relations.
 *   - "projection": derived artifacts (graphs, graph_heads, ref_manifest,
 *     search_documents).
 * A writer that touches tables from several planes must hold every affected
 * plane lock; locks are always acquired in REPOSITORY_LOCK_PLANES order so
 * multi-plane writers cannot deadlock each other.
 */
type RepositoryLockPlane = "code" | "knowledge" | "projection";
const REPOSITORY_LOCK_PLANES: readonly RepositoryLockPlane[] = ["code", "knowledge", "projection"];

async function lockRepositoryWrite(
  client: PoolClient,
  tenantId: string,
  repository: string,
  planes: readonly RepositoryLockPlane[]
): Promise<void> {
  // Iterate the canonical plane list (not the caller's array) so every
  // transaction acquires plane locks in the same fixed order.
  for (const plane of REPOSITORY_LOCK_PLANES) {
    if (!planes.includes(plane)) continue;
    await client.query("select pg_advisory_xact_lock(hashtext($1),hashtext($2))", [`${tenantId}:${plane}`, repository]);
  }
}

/** Full cross-plane exclusion for lifecycle operations (tombstone, tenant migration). */
async function lockRepositoryAllPlanes(client: PoolClient, tenantId: string, repository: string): Promise<void> {
  await lockRepositoryWrite(client, tenantId, repository, REPOSITORY_LOCK_PLANES);
}

async function assertRepositoryWritable(
  client: PoolClient,
  tenantId: string,
  repository: string,
  planes: readonly RepositoryLockPlane[]
): Promise<void> {
  await lockRepositoryWrite(client, tenantId, repository, planes);
  const tombstone = await client.query(
    `select 1 from jina_context_graph.erasure_filters
     where tenant_id=$1 and kind='repository' and value=$2`,
    [tenantId, repository]
  );
  if (tombstone.rowCount) throw new DomainError("repository is tombstoned", "conflict");
}

async function assertPipelineWriteFence(
  client: PoolClient,
  tenantId: string,
  repository: string,
  topic: ContextGraphWorkerTopic,
  writeFence?: ContextGraphWriteFence
): Promise<void> {
  if (!writeFence) return;
  await writeFence.authorityGuard?.();
  const result = await client.query(
    `select 1 from jina_board.tasks
     where id=$1 and tenant_id=$2 and repository=$3 and topic=$4
       and lease_id=$5 and status='in_progress' and lease_expires_at>now()`,
    [writeFence.stageId, tenantId, repository, topic, writeFence.leaseId]
  );
  if (result.rowCount !== 1) throw new DomainError("stale contextGraph worker lease", "conflict");
}

async function reassertPipelineWriteFence(client: PoolClient, writeFence?: ContextGraphWriteFence): Promise<void> {
  if (!writeFence) return;
  await writeFence.authorityGuard?.();
  const result = await client.query(
    `select 1 from jina_board.tasks
     where id=$1 and lease_id=$2 and status='in_progress' and lease_expires_at>now()`,
    [writeFence.stageId, writeFence.leaseId]
  );
  if (result.rowCount !== 1) throw new DomainError("stale contextGraph worker lease", "conflict");
}

async function insertAudit(
  client: PoolClient,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly actorId: string;
    readonly action: string;
    readonly input: unknown;
    readonly result: "accepted" | "rejected";
    readonly now: string;
    readonly reason?: string;
    readonly parentAuditId?: string;
  }
): Promise<void> {
  await client.query(
    `insert into jina_context_graph.audit_log (id,tenant_id,actor_id,action,input,result,reason,parent_audit_id,created_at)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
    [
      input.id,
      input.tenantId,
      input.actorId,
      input.action,
      JSON.stringify(input.input),
      input.result,
      input.reason ?? null,
      input.parentAuditId ?? null,
      input.now
    ]
  );
}

async function backfillAssertionExplanation(
  client: PoolClient,
  tenantId: string,
  assertionId: string,
  explanation: string,
  now: string
): Promise<void> {
  const updated = await client.query(
    `update jina_context_graph.assertions set explanation=$3
     where tenant_id=$1 and id=$2 and explanation is null`,
    [tenantId, assertionId, explanation]
  );
  if (updated.rowCount !== 1) return;
  await insertAudit(client, {
    id: stableId("audit", `${tenantId}:backfill_assertion_explanation:${assertionId}`),
    tenantId,
    actorId: "svc:assertion-migration",
    action: "backfill_assertion_explanation",
    input: { assertionId },
    result: "accepted",
    reason: "Added an explanation from newly available source evidence.",
    now
  });
}

async function insertErasureFilter(
  client: PoolClient,
  tenantId: string,
  kind: "identity" | "observation" | "commit" | "repository",
  value: string,
  auditId: string,
  now: string
): Promise<void> {
  await client.query(
    `insert into jina_context_graph.erasure_filters (id,tenant_id,kind,value,audit_id,created_at)
     values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id,kind,value) do nothing`,
    [stableId("filter", `${tenantId}:${kind}:${value}`), tenantId, kind, value, auditId, now]
  );
}

function redirectMap(
  rows: readonly { from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }[]
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "merge") mapping.set(row.from_entity_id, row.to_entity_id);
    else if (mapping.get(row.from_entity_id) === row.to_entity_id) mapping.delete(row.from_entity_id);
  }
  return mapping;
}

function resolveRedirect(mapping: ReadonlyMap<string, string>, entityId: string): string {
  const seen = new Set<string>();
  let current = entityId;
  while (mapping.has(current)) {
    if (seen.has(current)) throw new Error("entity redirect cycle detected");
    seen.add(current);
    current = mapping.get(current)!;
  }
  return current;
}

async function reconcileRedirectCollisions(client: PoolClient, tenantId: string, now: string): Promise<number> {
  const [redirectRows, assertionRows] = await Promise.all([
    client.query<{
      from_entity_id: string;
      to_entity_id: string;
      kind: "merge" | "unmerge";
      audit_id: string;
      created_at: Date;
      id: string;
    }>(
      `select from_entity_id,to_entity_id,kind,audit_id,created_at,id from jina_context_graph.entity_redirects
       where tenant_id=$1 order by created_at,id`,
      [tenantId]
    ),
    client.query<{
      id: string;
      subject_id: string;
      object_id: string;
      repository: string;
      predicate: string;
      qualifiers_hash: string;
      valid_from: Date | null;
      recorded_at: Date;
    }>(
      `select id,repository,subject_id,object_id,predicate,qualifiers_hash,valid_from,recorded_at
       from jina_context_graph.assertions
       where tenant_id=$1 and status='active' and object_id is not null for update`,
      [tenantId]
    )
  ]);
  const mapping = redirectMap(redirectRows.rows);
  const groups = new Map<string, typeof assertionRows.rows>();
  for (const assertion of assertionRows.rows) {
    const subject = resolveRedirect(mapping, assertion.subject_id);
    const object = resolveRedirect(mapping, assertion.object_id);
    const definition = predicateDefinition(assertion.predicate);
    const key =
      definition.cardinality === "one"
        ? `${assertion.repository}:${subject}:${assertion.predicate}:${assertion.qualifiers_hash}`
        : `${assertion.repository}:${subject}:${assertion.predicate}:${object}:${assertion.qualifiers_hash}`;
    groups.set(key, [...(groups.get(key) ?? []), assertion]);
  }
  const supersede = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const definition = predicateDefinition(group[0]!.predicate);
    const ordered = [...group].sort((a, b) => {
      if (definition.cardinality === "one") {
        const aTime = (a.valid_from ?? a.recorded_at).getTime();
        const bTime = (b.valid_from ?? b.recorded_at).getTime();
        return bTime - aTime || b.recorded_at.getTime() - a.recorded_at.getTime() || b.id.localeCompare(a.id);
      }
      return a.recorded_at.getTime() - b.recorded_at.getTime() || a.id.localeCompare(b.id);
    });
    for (const loser of ordered.slice(1)) supersede.set(loser.id, ordered[0]!.id);
  }
  if (supersede.size === 0) return 0;
  const parentAuditId = [...redirectRows.rows].reverse().find((row) => row.kind === "merge")?.audit_id;
  const auditId = stableId("audit", `${tenantId}:reconciliation:${[...supersede].flat().join(":")}:${now}`);
  await insertAudit(client, {
    id: auditId,
    tenantId,
    actorId: "svc:reconciliation",
    action: "reconcile_redirect_collisions",
    input: { superseded: Object.fromEntries(supersede) },
    result: "accepted",
    now,
    ...(parentAuditId ? { parentAuditId } : {})
  });
  for (const [loser, winner] of supersede) {
    await client.query(
      `update jina_context_graph.assertions set status='superseded',valid_to=$3,superseded_by=$4,audit_id=$5
       where tenant_id=$1 and id=$2`,
      [tenantId, loser, now, winner, auditId]
    );
    await insertOutbox(client, tenantId, "assertion_changed", loser, { assertionId: loser, supersededBy: winner }, now);
  }
  return supersede.size;
}

async function deleteCodePlaneRepository(client: PoolClient, tenantId: string, repository: string): Promise<void> {
  const removed = await client.query<{ blob_sha: string }>(
    `select distinct blob_sha from (
       select old_blob_sha as blob_sha from jina_context_graph.commit_changes where tenant_id=$1 and repository=$2
       union all
       select new_blob_sha as blob_sha from jina_context_graph.commit_changes where tenant_id=$1 and repository=$2
     ) referenced where blob_sha is not null`,
    [tenantId, repository]
  );
  await client.query(`delete from jina_context_graph.ref_manifest where tenant_id=$1 and repository=$2`, [
    tenantId,
    repository
  ]);
  await client.query(`delete from jina_context_graph.commit_changes where tenant_id=$1 and repository=$2`, [
    tenantId,
    repository
  ]);
  await client.query(`delete from jina_context_graph.refs where tenant_id=$1 and repository=$2`, [
    tenantId,
    repository
  ]);
  await client.query(`delete from jina_context_graph.commits where tenant_id=$1 and repository=$2`, [
    tenantId,
    repository
  ]);
  await deleteOrphanBlobs(client, tenantId, [...new Set(removed.rows.map((row) => row.blob_sha))]);
  await client.query(`delete from jina_context_graph.graphs where tenant_id=$1 and repository=$2`, [
    tenantId,
    repository
  ]);
  await client.query(`delete from jina_context_graph.repository_acl where tenant_id=$1 and repository=$2`, [
    tenantId,
    repository
  ]);
}

async function garbageCollectCodePlane(
  client: PoolClient,
  tenantId: string,
  now: string,
  recentDays: number
): Promise<void> {
  const garbage = await client.query<{ repository: string; sha: string }>(
    `with recursive pr_linked as (
       select repository,substring(object_natural_key from ':sha:([a-f0-9]{40})$') as sha
       from jina_context_graph.assertions
       where tenant_id=$1 and predicate='INCLUDES' and status='active'
     ), reachable(repository,sha) as (
       select repository,commit_sha from jina_context_graph.refs where tenant_id=$1
       union
       select repository,sha from pr_linked where sha is not null
       union
       select c.repository,parent.sha
       from reachable r
       join jina_context_graph.commits c on c.tenant_id=$1 and c.repository=r.repository and c.sha=r.sha
       cross join lateral unnest(c.parents) parent(sha)
     )
     select c.repository,c.sha from jina_context_graph.commits c
     where c.tenant_id=$1 and c.committed_at < $2::timestamptz - make_interval(days=>$3)
       and not exists (select 1 from reachable r where r.repository=c.repository and r.sha=c.sha)`,
    [tenantId, now, recentDays]
  );
  if (garbage.rows.length === 0) return;
  const removed = await client.query<{ blob_sha: string }>(
    `select distinct blob_sha from (
       select change.old_blob_sha as blob_sha
       from jina_context_graph.commit_changes change
       join unnest($2::text[],$3::text[]) doomed(repository,sha)
         on change.repository=doomed.repository and change.commit_sha=doomed.sha
       where change.tenant_id=$1
       union all
       select change.new_blob_sha as blob_sha
       from jina_context_graph.commit_changes change
       join unnest($2::text[],$3::text[]) doomed(repository,sha)
         on change.repository=doomed.repository and change.commit_sha=doomed.sha
       where change.tenant_id=$1
     ) referenced where blob_sha is not null`,
    [tenantId, garbage.rows.map((row) => row.repository), garbage.rows.map((row) => row.sha)]
  );
  await client.query(
    `delete from jina_context_graph.commit_changes c using (
       select source.repository,source.sha from unnest($2::text[],$3::text[]) source(repository,sha)
     ) doomed where c.tenant_id=$1 and c.repository=doomed.repository and c.commit_sha=doomed.sha`,
    [tenantId, garbage.rows.map((row) => row.repository), garbage.rows.map((row) => row.sha)]
  );
  await client.query(
    `delete from jina_context_graph.commits c using (
       select source.repository,source.sha from unnest($2::text[],$3::text[]) source(repository,sha)
     ) doomed where c.tenant_id=$1 and c.repository=doomed.repository and c.sha=doomed.sha`,
    [tenantId, garbage.rows.map((row) => row.repository), garbage.rows.map((row) => row.sha)]
  );
  await deleteOrphanBlobs(client, tenantId, [...new Set(removed.rows.map((row) => row.blob_sha))]);
}

async function deleteOrphanBlobs(client: PoolClient, tenantId: string, candidates: readonly string[]): Promise<void> {
  if (candidates.length === 0) return;
  const orphaned = await client.query<{ blob_sha: string }>(
    `select source.sha as blob_sha from unnest($2::text[]) source(sha)
     where not exists (
       select 1 from jina_context_graph.commit_changes change
       where change.tenant_id=$1 and (change.old_blob_sha=source.sha or change.new_blob_sha=source.sha)
     )`,
    [tenantId, candidates]
  );
  const shas = orphaned.rows.map((row) => row.blob_sha);
  if (shas.length === 0) return;
  await client.query(`delete from jina_context_graph.symbol_edges where tenant_id=$1 and blob_sha=any($2::text[])`, [
    tenantId,
    shas
  ]);
  await client.query(`delete from jina_context_graph.blob_symbols where tenant_id=$1 and blob_sha=any($2::text[])`, [
    tenantId,
    shas
  ]);
  await client.query(`delete from jina_context_graph.blob_imports where tenant_id=$1 and blob_sha=any($2::text[])`, [
    tenantId,
    shas
  ]);
  await client.query(`delete from jina_context_graph.blob_analyses where tenant_id=$1 and blob_sha=any($2::text[])`, [
    tenantId,
    shas
  ]);
  await client.query(`delete from jina_context_graph.blobs where tenant_id=$1 and blob_sha=any($2::text[])`, [
    tenantId,
    shas
  ]);
}

async function purgeRejectedModelPayloads(
  client: PoolClient,
  tenantId: string,
  now: string,
  retentionDays: number
): Promise<void> {
  const expired = await client.query<{ observation_id: string }>(
    `select o.id as observation_id from jina_context_graph.observations o
     where o.tenant_id=$1 and o.type='model_output' and o.redacted_at is null and o.payload is not null
       and o.recorded_at < $2::timestamptz - make_interval(days=>$3)
       and not exists (
         select 1 from jina_context_graph.assertions a
         where a.source_observation_id=o.id and a.status in ('active','proposed')
       )`,
    [tenantId, now, retentionDays]
  );
  const ids = expired.rows.map((row) => row.observation_id);
  if (ids.length === 0) return;
  await client.query(
    `update jina_context_graph.observations set payload=null,redacted_at=$2,redaction_reason='rejected model output retention'
     where id=any($1::text[]) and redacted_at is null`,
    [ids, now]
  );
}

interface IssueTraceAssertionRow {
  readonly id: string;
  readonly predicate: string;
  readonly subject_id: string;
  readonly subject_kind: string;
  readonly subject_natural_key: string;
  readonly subject_label: string;
  readonly object_id: string;
  readonly object_kind: string;
  readonly object_natural_key: string;
  readonly object_label: string;
  readonly source_observation_id: string | null;
  readonly commit_sha: string;
  readonly confidence: number | null;
  readonly evidence: string[];
  readonly qualifiers: Record<string, unknown>;
}

const ISSUE_TRACE_PREDICATES = ["RESOLVES", "MERGED_AS", "INCLUDES", "INTRODUCED_BY"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberFromNaturalKey(naturalKey: string): number | undefined {
  const value = /#(\d+)$/.exec(naturalKey)?.[1];
  return value ? Number.parseInt(value, 10) : undefined;
}

function shaFromNaturalKey(naturalKey: string): string | undefined {
  return /:sha:([a-f0-9]{40})$/i.exec(naturalKey)?.[1]?.toLowerCase();
}

function derivedIssueDescription(
  issueNaturalKey: string,
  modelPayloadByObservationId: ReadonlyMap<string, Record<string, unknown>>
): string | undefined {
  for (const payload of modelPayloadByObservationId.values()) {
    if (!Array.isArray(payload.assertions)) continue;
    const resolution = payload.assertions.find((candidate): candidate is Record<string, unknown> => {
      if (!isRecord(candidate) || candidate.predicate !== "RESOLVES") return false;
      const object = isRecord(candidate.object) ? candidate.object : undefined;
      return object?.naturalKey === issueNaturalKey;
    });
    const subject =
      resolution && typeof resolution.subject === "object" && resolution.subject !== null
        ? (resolution.subject as Record<string, unknown>)
        : undefined;
    const pullRequestNumber =
      typeof subject?.naturalKey === "string" ? numberFromNaturalKey(subject.naturalKey) : undefined;
    const rawOutput =
      typeof payload.rawOutput === "object" && payload.rawOutput !== null
        ? (payload.rawOutput as Record<string, unknown>)
        : undefined;
    if (!pullRequestNumber || !Array.isArray(rawOutput?.nodes)) continue;
    const node = rawOutput.nodes.find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && candidate.kind === "Issue" && candidate.id === `derived:pr:${pullRequestNumber}`
    );
    if (typeof node?.description === "string" && node.description.trim()) return node.description;
  }
  return undefined;
}

function retrievalCitationFromEvidence(
  repository: string,
  commitSha: string,
  value: string
): RetrievalCitation | undefined {
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const startLine = Number.parseInt(match[2], 10);
  const endLine = match[3] ? Number.parseInt(match[3], 10) : startLine;
  return {
    kind: "code",
    id: `${commitSha}:${match[1]}:${startLine}:${endLine}`,
    repository,
    commitSha,
    path: match[1],
    startLine,
    endLine
  };
}

function dedupeRetrievalCitations(citations: readonly RetrievalCitation[]): RetrievalCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = JSON.stringify(citation);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

interface IssueTraceGraphNodeRow {
  readonly node_id: string;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly evidence: string[];
}

interface IssueTraceGraphEdgeRow {
  readonly edge_id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly predicate: string;
  readonly why: string | null;
  readonly evidence: string[];
}

async function retrieveIssueTrace(
  pool: Pool,
  request: RetrievalRequest,
  ref: string,
  limit: number
): Promise<RetrievalItem[]> {
  const issueText = request.issueText?.trim().toLowerCase() ?? "";
  if (!request.issueEntityId && !request.issueNumber && !issueText && !request.pullRequestNumber && !request.commitSha)
    return [];
  const graphResult = await pool.query<{ id: string; commit_sha: string }>(
    `select graph.id,graph.commit_sha from jina_context_graph.graph_heads head
     join jina_context_graph.graphs graph on graph.id=head.graph_id
     where head.tenant_id=$1 and head.repository=$2 and head.ref_name=$3
     limit 1`,
    [request.tenantId, request.repository, ref]
  );
  const graph = graphResult.rows[0];
  if (!graph) return [];
  let modelObservationRows: { id: string; payload: Record<string, unknown> }[] = [];
  if (issueText) {
    modelObservationRows = (
      await pool.query<{ id: string; payload: Record<string, unknown> }>(
        `select id,payload from jina_context_graph.observations
       where tenant_id=$1 and repository=$2 and type='model_output' and redacted_at is null and payload is not null
         and position($3 in lower(payload::text)) > 0`,
        [request.tenantId, request.repository, issueText]
      )
    ).rows;
  }
  const earlyModelPayloads = new Map(modelObservationRows.map((observation) => [observation.id, observation.payload]));
  const derivedIssueNaturalKeys = new Set<string>();
  if (issueText) {
    for (const payload of earlyModelPayloads.values()) {
      if (!Array.isArray(payload.assertions)) continue;
      for (const candidate of payload.assertions) {
        if (!isRecord(candidate) || candidate.predicate !== "RESOLVES") continue;
        const object = isRecord(candidate.object) ? candidate.object : undefined;
        if (typeof object?.naturalKey !== "string") continue;
        if (derivedIssueDescription(object.naturalKey, earlyModelPayloads)?.toLowerCase().includes(issueText)) {
          derivedIssueNaturalKeys.add(object.naturalKey);
        }
      }
    }
  }
  let candidateQuery: string;
  let candidateValues: unknown[];
  if (request.issueEntityId) {
    candidateQuery = `select node.node_id,node.kind,node.label,node.description,node.evidence
      from jina_context_graph.nodes node
      join jina_context_graph.entities entity on entity.tenant_id=$2 and entity.id=$3 and entity.kind='Issue'
        and entity.natural_key=node.description
      where node.graph_id=$1 and node.kind='Issue'
      order by node.label,node.node_id limit $4`;
    candidateValues = [graph.id, request.tenantId, request.issueEntityId, limit];
  } else if (request.issueNumber) {
    candidateQuery = `select node_id,kind,label,description,evidence from jina_context_graph.nodes
      where graph_id=$1 and kind='Issue' and description=$2 order by label,node_id limit $3`;
    candidateValues = [graph.id, `github:issue:${request.repository}#${request.issueNumber}`, limit];
  } else if (issueText) {
    candidateQuery = `with matching_issue_numbers as materialized (
        select distinct observation.payload->>'number' as issue_number
        from jina_context_graph.observations observation
        where observation.tenant_id=$3 and observation.repository=$4 and observation.source='github'
          and observation.redacted_at is null and observation.payload->>'kind'='issue'
          and (position($2 in lower(coalesce(observation.payload->>'title',''))) > 0
            or position($2 in lower(coalesce(observation.payload->>'body',''))) > 0)
      )
      select node.node_id,node.kind,node.label,node.description,node.evidence
      from jina_context_graph.nodes node
      where node.graph_id=$1 and node.kind='Issue' and (
        position($2 in lower(node.label)) > 0 or node.description=any($5::text[]) or
        substring(node.description from '#([0-9]+)$') in (select issue_number from matching_issue_numbers)
      )
      order by case when lower(node.label)=$2 then 0 when position($2 in lower(node.label)) > 0 then 1 else 2 end,
               node.label,node.node_id limit $6`;
    candidateValues = [graph.id, issueText, request.tenantId, request.repository, [...derivedIssueNaturalKeys], limit];
  } else if (request.pullRequestNumber) {
    candidateQuery = `select distinct issue.node_id,issue.kind,issue.label,issue.description,issue.evidence
      from jina_context_graph.nodes issue
      where issue.graph_id=$1 and issue.kind='Issue' and (
        exists (select 1 from jina_context_graph.edges resolution
          join jina_context_graph.nodes pull_request on pull_request.graph_id=resolution.graph_id
            and pull_request.node_id=resolution.source_node_id and pull_request.description=$2
          where resolution.graph_id=$1 and resolution.predicate='RESOLVES' and resolution.target_node_id=issue.node_id)
        or exists (select 1 from jina_context_graph.edges cause
          join jina_context_graph.edges inclusion on inclusion.graph_id=cause.graph_id
            and inclusion.target_node_id=cause.target_node_id and inclusion.predicate in ('INCLUDES','MERGED_AS')
          join jina_context_graph.nodes pull_request on pull_request.graph_id=inclusion.graph_id
            and pull_request.node_id=inclusion.source_node_id and pull_request.description=$2
          where cause.graph_id=$1 and cause.predicate='INTRODUCED_BY' and cause.source_node_id=issue.node_id)
      ) order by issue.label,issue.node_id limit $3`;
    candidateValues = [graph.id, `github:pr:${request.repository}#${request.pullRequestNumber}`, limit];
  } else {
    candidateQuery = `select distinct issue.node_id,issue.kind,issue.label,issue.description,issue.evidence
      from jina_context_graph.nodes issue
      where issue.graph_id=$1 and issue.kind='Issue' and (
        exists (select 1 from jina_context_graph.edges cause
          join jina_context_graph.nodes commit on commit.graph_id=cause.graph_id and commit.node_id=cause.target_node_id
          where cause.graph_id=$1 and cause.predicate='INTRODUCED_BY' and cause.source_node_id=issue.node_id
            and lower(commit.description) like '%:sha:'||$2||'%')
        or exists (select 1 from jina_context_graph.edges resolution
          join jina_context_graph.edges inclusion on inclusion.graph_id=resolution.graph_id
            and inclusion.source_node_id=resolution.source_node_id and inclusion.predicate in ('INCLUDES','MERGED_AS')
          join jina_context_graph.nodes commit on commit.graph_id=inclusion.graph_id and commit.node_id=inclusion.target_node_id
          where resolution.graph_id=$1 and resolution.predicate='RESOLVES' and resolution.target_node_id=issue.node_id
            and lower(commit.description) like '%:sha:'||$2||'%')
      ) order by issue.label,issue.node_id limit $3`;
    candidateValues = [graph.id, request.commitSha!.toLowerCase(), limit];
  }
  const candidateIssueResult = await pool.query<IssueTraceGraphNodeRow>(candidateQuery, candidateValues);
  if (candidateIssueResult.rows.length === 0) return [];
  const candidateIssueIds = candidateIssueResult.rows.map((issue) => issue.node_id);
  const edgeResult = await pool.query<IssueTraceGraphEdgeRow>(
    `with resolution_pull_requests as (
       select source_node_id from jina_context_graph.edges
       where graph_id=$1 and predicate='RESOLVES' and target_node_id=any($2::text[])
     ), causal_commits as (
       select target_node_id from jina_context_graph.edges
       where graph_id=$1 and predicate='INTRODUCED_BY' and source_node_id=any($2::text[])
     )
     select edge_id,source_node_id,target_node_id,predicate,why,evidence from jina_context_graph.edges
     where graph_id=$1 and predicate=any($3::text[]) and (
       source_node_id=any($2::text[]) or target_node_id=any($2::text[]) or
       (predicate in ('INCLUDES','MERGED_AS') and (
         source_node_id in (select source_node_id from resolution_pull_requests) or
         target_node_id in (select target_node_id from causal_commits)
       ))
     )`,
    [graph.id, candidateIssueIds, [...ISSUE_TRACE_PREDICATES]]
  );
  const relevantNodeIds = new Set(candidateIssueIds);
  for (const edge of edgeResult.rows) {
    relevantNodeIds.add(edge.source_node_id);
    relevantNodeIds.add(edge.target_node_id);
  }
  const nodeResult = await pool.query<IssueTraceGraphNodeRow>(
    `select node_id,kind,label,description,evidence from jina_context_graph.nodes
     where graph_id=$1 and node_id=any($2::text[])`,
    [graph.id, [...relevantNodeIds]]
  );
  const relevantEntityIds = nodeResult.rows.map((node) =>
    stableId("entity", `${request.tenantId}:${node.kind}:${node.description}`)
  );
  const relevantNumbers = nodeResult.rows.flatMap((node) => {
    const number = numberFromNaturalKey(node.description);
    return number ? [number] : [];
  });
  const [assertionResult, observationResult] = await Promise.all([
    pool.query<IssueTraceAssertionRow & { recorded_at: Date }>(
      `select id,predicate,subject_id,subject_kind,subject_natural_key,subject_label,
              object_id,object_kind,object_natural_key,object_label,source_observation_id,
              commit_sha,confidence,evidence,qualifiers,recorded_at
       from jina_context_graph.assertions
       where tenant_id=$1 and repository=$2 and status='active' and predicate=any($3::text[])
         and (subject_id=any($4::text[]) or object_id=any($4::text[]))
       order by recorded_at desc,id desc`,
      [request.tenantId, request.repository, [...ISSUE_TRACE_PREDICATES], relevantEntityIds]
    ),
    relevantNumbers.length > 0
      ? pool.query<{ id: string; payload: Record<string, unknown>; recorded_at: Date }>(
          `select id,payload,recorded_at from jina_context_graph.observations
           where tenant_id=$1 and repository=$2 and source='github' and redacted_at is null
             and payload is not null and payload->>'kind' in ('issue','pull_request')
             and (payload->>'number')::int=any($3::int[])
           order by coalesce(occurred_at,recorded_at),recorded_at,id`,
          [request.tenantId, request.repository, relevantNumbers]
        )
      : Promise.resolve({ rows: [] as { id: string; payload: Record<string, unknown>; recorded_at: Date }[] })
  ]);
  if (candidateIssueResult.rows.some((issue) => !numberFromNaturalKey(issue.description))) {
    const loadedIds = new Set(modelObservationRows.map((observation) => observation.id));
    const missingIds = [
      ...new Set(
        assertionResult.rows.flatMap((assertion) =>
          assertion.source_observation_id && !loadedIds.has(assertion.source_observation_id)
            ? [assertion.source_observation_id]
            : []
        )
      )
    ];
    if (missingIds.length > 0) {
      const missing = await pool.query<{ id: string; payload: Record<string, unknown> }>(
        `select id,payload from jina_context_graph.observations
         where tenant_id=$1 and repository=$2 and id=any($3::text[])
           and type='model_output' and redacted_at is null and payload is not null`,
        [request.tenantId, request.repository, missingIds]
      );
      modelObservationRows.push(...missing.rows);
    }
  }
  const nodesById = new Map(nodeResult.rows.map((node) => [node.node_id, node]));
  const issueNodes = nodeResult.rows.filter((node) => node.kind === "Issue");
  const relationKey = (subjectNaturalKey: string, predicate: string, objectNaturalKey: string): string =>
    JSON.stringify([subjectNaturalKey, predicate, objectNaturalKey]);
  const assertionsByRelation = new Map<string, (IssueTraceAssertionRow & { recorded_at: Date })[]>();
  for (const assertion of assertionResult.rows) {
    const key = relationKey(assertion.subject_natural_key, assertion.predicate, assertion.object_natural_key);
    assertionsByRelation.set(key, [...(assertionsByRelation.get(key) ?? []), assertion]);
  }
  const assertionForEdge = (
    edge: IssueTraceGraphEdgeRow
  ): (IssueTraceAssertionRow & { recorded_at: Date }) | undefined => {
    const subject = nodesById.get(edge.source_node_id)?.description;
    const object = nodesById.get(edge.target_node_id)?.description;
    if (!subject || !object) return undefined;
    const candidates = assertionsByRelation.get(relationKey(subject, edge.predicate, object)) ?? [];
    return (
      candidates.find(
        (candidate) =>
          edge.predicate !== "INTRODUCED_BY" ||
          typeof candidate.qualifiers.reason !== "string" ||
          candidate.qualifiers.reason === edge.why
      ) ?? candidates[0]
    );
  };
  const latestObservationByKey = new Map<string, { readonly id: string; readonly payload: Record<string, unknown> }>();
  for (const observation of observationResult.rows) {
    const kind = observation.payload.kind;
    const number = observation.payload.number;
    if ((kind === "issue" || kind === "pull_request") && typeof number === "number") {
      latestObservationByKey.set(`${kind}:${number}`, observation);
    }
  }
  const modelPayloadByObservationId = new Map(
    modelObservationRows.map((observation) => [observation.id, observation.payload])
  );
  const resolves = edgeResult.rows.filter((edge) => edge.predicate === "RESOLVES");
  const causes = edgeResult.rows.filter((edge) => edge.predicate === "INTRODUCED_BY");
  const inclusions = edgeResult.rows.filter((edge) => edge.predicate === "INCLUDES" || edge.predicate === "MERGED_AS");
  const commitPrefix = request.commitSha?.toLowerCase() ?? "";
  const candidates = issueNodes
    .filter((issue) => {
      const naturalKey = issue.description;
      const issueNumber = numberFromNaturalKey(naturalKey);
      const issueObservation = issueNumber ? latestObservationByKey.get(`issue:${issueNumber}`) : undefined;
      if (request.issueEntityId) {
        return stableId("entity", `${request.tenantId}:Issue:${naturalKey}`) === request.issueEntityId;
      }
      if (request.issueNumber) return issueNumber === request.issueNumber;
      if (issueText) {
        return (
          issue.label.toLowerCase().includes(issueText) ||
          stringValue(issueObservation?.payload.title).toLowerCase().includes(issueText) ||
          stringValue(issueObservation?.payload.body).toLowerCase().includes(issueText) ||
          (derivedIssueDescription(naturalKey, modelPayloadByObservationId)?.toLowerCase().includes(issueText) ?? false)
        );
      }
      if (request.pullRequestNumber) {
        const pullRequestNumber = request.pullRequestNumber;
        const directlyResolved = resolves.some(
          (edge) =>
            edge.target_node_id === issue.node_id &&
            numberFromNaturalKey(nodesById.get(edge.source_node_id)?.description ?? "") === pullRequestNumber
        );
        const causedByPullRequest = causes.some(
          (cause) =>
            cause.source_node_id === issue.node_id &&
            inclusions.some(
              (inclusion) =>
                inclusion.target_node_id === cause.target_node_id &&
                numberFromNaturalKey(nodesById.get(inclusion.source_node_id)?.description ?? "") === pullRequestNumber
            )
        );
        return directlyResolved || causedByPullRequest;
      }
      if (commitPrefix) {
        const causedByCommit = causes.some(
          (edge) =>
            edge.source_node_id === issue.node_id &&
            shaFromNaturalKey(nodesById.get(edge.target_node_id)?.description ?? "")?.startsWith(commitPrefix)
        );
        const resolvedByCommit = resolves.some(
          (resolution) =>
            resolution.target_node_id === issue.node_id &&
            inclusions.some(
              (inclusion) =>
                inclusion.source_node_id === resolution.source_node_id &&
                shaFromNaturalKey(nodesById.get(inclusion.target_node_id)?.description ?? "")?.startsWith(commitPrefix)
            )
        );
        return causedByCommit || resolvedByCommit;
      }
      return false;
    })
    .sort((left, right) => {
      if (!issueText)
        return (
          (numberFromNaturalKey(left.description) ?? Number.MAX_SAFE_INTEGER) -
            (numberFromNaturalKey(right.description) ?? Number.MAX_SAFE_INTEGER) ||
          left.label.localeCompare(right.label)
        );
      const leftTitle = stringValue(
        latestObservationByKey.get(`issue:${numberFromNaturalKey(left.description)}`)?.payload.title,
        left.label
      ).toLowerCase();
      const rightTitle = stringValue(
        latestObservationByKey.get(`issue:${numberFromNaturalKey(right.description)}`)?.payload.title,
        right.label
      ).toLowerCase();
      return (
        (leftTitle === issueText ? 0 : leftTitle.includes(issueText) ? 1 : 2) -
          (rightTitle === issueText ? 0 : rightTitle.includes(issueText) ? 1 : 2) || leftTitle.localeCompare(rightTitle)
      );
    })
    .slice(0, limit);
  if (candidates.length === 0) return [];

  const relevantCommitShas = new Set<string>();
  for (const issue of candidates) {
    for (const cause of causes.filter((edge) => edge.source_node_id === issue.node_id)) {
      const sha = shaFromNaturalKey(nodesById.get(cause.target_node_id)?.description ?? "");
      if (sha) relevantCommitShas.add(sha);
    }
    for (const resolution of resolves.filter((edge) => edge.target_node_id === issue.node_id)) {
      for (const inclusion of inclusions.filter((edge) => edge.source_node_id === resolution.source_node_id)) {
        const sha = shaFromNaturalKey(nodesById.get(inclusion.target_node_id)?.description ?? "");
        if (sha) relevantCommitShas.add(sha);
      }
    }
  }
  const changeResult =
    relevantCommitShas.size > 0
      ? await pool.query<{ commit_sha: string; path: string; change: string; old_path: string | null }>(
          `select commit_sha,path,change,old_path from jina_context_graph.commit_changes
         where tenant_id=$1 and repository=$2 and commit_sha=any($3::text[]) order by commit_sha,path`,
          [request.tenantId, request.repository, [...relevantCommitShas]]
        )
      : { rows: [] as { commit_sha: string; path: string; change: string; old_path: string | null }[] };
  const changesByCommit = new Map<string, typeof changeResult.rows>();
  for (const change of changeResult.rows) {
    changesByCommit.set(change.commit_sha, [...(changesByCommit.get(change.commit_sha) ?? []), change]);
  }
  const edgeCitations = (edge: IssueTraceGraphEdgeRow): RetrievalCitation[] => {
    const assertion = assertionForEdge(edge);
    const citations: RetrievalCitation[] = [];
    if (assertion) {
      citations.push({ kind: "assertion", id: assertion.id, repository: request.repository });
      if (assertion.source_observation_id)
        citations.push({ kind: "observation", id: assertion.source_observation_id, repository: request.repository });
    }
    for (const evidence of edge.evidence) {
      if (evidence.startsWith("observation:")) {
        citations.push({
          kind: "observation",
          id: evidence.slice("observation:".length),
          repository: request.repository
        });
      } else {
        const evidenceCommitSha =
          assertion && /^[a-f0-9]{40}$/i.test(assertion.commit_sha) ? assertion.commit_sha : graph.commit_sha;
        const citation = retrievalCitationFromEvidence(request.repository, evidenceCommitSha, evidence);
        if (citation) citations.push(citation);
      }
    }
    return citations;
  };

  return candidates.map((issue): RetrievalItem => {
    const issueNumber = numberFromNaturalKey(issue.description);
    const issueObservation = issueNumber ? latestObservationByKey.get(`issue:${issueNumber}`) : undefined;
    const citations: RetrievalCitation[] = [
      {
        kind: "entity",
        id: stableId("entity", `${request.tenantId}:Issue:${issue.description}`),
        repository: request.repository
      }
    ];
    if (issueObservation)
      citations.push({ kind: "observation", id: issueObservation.id, repository: request.repository });
    const issueResolutions = resolves
      .filter((edge) => edge.target_node_id === issue.node_id)
      .flatMap((resolution) => {
        const pullRequest = nodesById.get(resolution.source_node_id);
        const pullRequestNumber = pullRequest ? numberFromNaturalKey(pullRequest.description) : undefined;
        if (!pullRequest || !pullRequestNumber) return [];
        const pullRequestObservation = latestObservationByKey.get(`pull_request:${pullRequestNumber}`);
        const relatedInclusions = inclusions.filter((edge) => edge.source_node_id === pullRequest.node_id);
        const assertionIds = new Set<string>();
        const observationIds = new Set<string>();
        for (const edge of [resolution, ...relatedInclusions]) {
          const assertion = assertionForEdge(edge);
          if (assertion) {
            assertionIds.add(assertion.id);
            if (assertion.source_observation_id) observationIds.add(assertion.source_observation_id);
          }
          citations.push(...edgeCitations(edge));
        }
        if (pullRequestObservation) {
          observationIds.add(pullRequestObservation.id);
          citations.push({ kind: "observation", id: pullRequestObservation.id, repository: request.repository });
        }
        const bySha = new Map<string, "merge" | "included">();
        for (const inclusion of relatedInclusions) {
          const sha = shaFromNaturalKey(nodesById.get(inclusion.target_node_id)?.description ?? "");
          if (sha) bySha.set(sha, inclusion.predicate === "MERGED_AS" ? "merge" : (bySha.get(sha) ?? "included"));
        }
        const commits = [...bySha]
          .sort(
            (left, right) =>
              (left[1] === "merge" ? 0 : 1) - (right[1] === "merge" ? 0 : 1) || left[0].localeCompare(right[0])
          )
          .map(([sha, role]) => {
            const changes = (changesByCommit.get(sha) ?? []).map((change) => ({
              commitSha: sha,
              path: change.path,
              change: change.change,
              ...(change.old_path ? { oldPath: change.old_path } : {})
            }));
            for (const change of changes)
              citations.push({
                kind: "commit_change",
                id: `${sha}:${change.path}`,
                repository: request.repository,
                commitSha: sha,
                path: change.path
              });
            return { sha, url: `https://github.com/${request.repository}/commit/${sha}`, role, changes };
          });
        return [
          {
            pullRequestNumber,
            title: stringValue(pullRequestObservation?.payload.title, pullRequest.label),
            url: stringValue(
              pullRequestObservation?.payload.url,
              `https://github.com/${request.repository}/pull/${pullRequestNumber}`
            ),
            commits,
            assertionIds: [...assertionIds],
            observationIds: [...observationIds]
          }
        ];
      })
      .sort((left, right) => left.pullRequestNumber - right.pullRequestNumber);
    const introducedBy = causes
      .filter((edge) => edge.source_node_id === issue.node_id)
      .flatMap((cause) => {
        const commit = nodesById.get(cause.target_node_id);
        const sha = commit ? shaFromNaturalKey(commit.description) : undefined;
        if (!commit || !sha) return [];
        const assertion = assertionForEdge(cause);
        citations.push(...edgeCitations(cause));
        const causalPullRequests = [
          ...new Map(
            inclusions
              .filter((edge) => edge.target_node_id === commit.node_id)
              .flatMap((inclusion) => {
                const pullRequest = nodesById.get(inclusion.source_node_id);
                const number = pullRequest ? numberFromNaturalKey(pullRequest.description) : undefined;
                if (!pullRequest || !number) return [];
                const observation = latestObservationByKey.get(`pull_request:${number}`);
                citations.push(...edgeCitations(inclusion));
                if (observation)
                  citations.push({ kind: "observation", id: observation.id, repository: request.repository });
                return [
                  [
                    number,
                    {
                      number,
                      title: stringValue(observation?.payload.title, pullRequest.label),
                      url: stringValue(
                        observation?.payload.url,
                        `https://github.com/${request.repository}/pull/${number}`
                      )
                    }
                  ] as const
                ];
              })
          ).values()
        ].sort((left, right) => left.number - right.number);
        const changes = (changesByCommit.get(sha) ?? []).map((change) => ({
          commitSha: sha,
          path: change.path,
          change: change.change,
          ...(change.old_path ? { oldPath: change.old_path } : {})
        }));
        for (const change of changes)
          citations.push({
            kind: "commit_change",
            id: `${sha}:${change.path}`,
            repository: request.repository,
            commitSha: sha,
            path: change.path
          });
        return [
          {
            sha,
            url: `https://github.com/${request.repository}/commit/${sha}`,
            role: "introduced" as const,
            changes,
            ...(cause.why ? { why: cause.why } : {}),
            evidence: cause.evidence,
            evidenceCommitSha: assertion?.commit_sha ?? graph.commit_sha,
            assertionIds: assertion ? [assertion.id] : [],
            pullRequests: causalPullRequests
          }
        ];
      });
    const payload: IssueTraceProjection = {
      issue: {
        entityId: stableId("entity", `${request.tenantId}:Issue:${issue.description}`),
        origin: issueNumber ? "github" : "derived",
        title: stringValue(issueObservation?.payload.title, issue.label.replace(/^#\d+\s+/, "")),
        ...(issueNumber ? { number: issueNumber, displayId: `#${issueNumber}` } : { displayId: "derived" }),
        ...(!issueNumber
          ? { description: derivedIssueDescription(issue.description, modelPayloadByObservationId) ?? issue.label }
          : {}),
        ...(typeof issueObservation?.payload.url === "string"
          ? { url: issueObservation.payload.url }
          : issueNumber
            ? { url: `https://github.com/${request.repository}/issues/${issueNumber}` }
            : {}),
        ...(typeof issueObservation?.payload.state === "string" ? { state: issueObservation.payload.state } : {})
      },
      resolutions: issueResolutions,
      introducedBy,
      citations: dedupeRetrievalCitations(citations)
    };
    return issueTraceRetrievalItem(payload, request, commitPrefix);
  });
}

function issueTraceRetrievalItem(
  payload: IssueTraceProjection,
  request: RetrievalRequest,
  commitPrefix: string
): RetrievalItem {
  const firstResolution = payload.resolutions[0];
  const firstCommit = firstResolution?.commits[0];
  const wantsCausality = Boolean(request.commitSha) || /caus|introduc|root cause/i.test(request.query ?? "");
  const causalCommit = !wantsCausality
    ? undefined
    : request.commitSha
      ? payload.introducedBy.find((commit) => commit.sha.startsWith(commitPrefix))
      : request.pullRequestNumber
        ? payload.introducedBy.find((commit) =>
            commit.pullRequests?.some((pullRequest) => pullRequest.number === request.pullRequestNumber)
          )
        : payload.introducedBy[0];
  const issueLabel = payload.issue.displayId ? `Issue ${payload.issue.displayId}` : payload.issue.title;
  const title = causalCommit
    ? `${causalCommit.sha.slice(0, 12)} caused ${issueLabel}`
    : firstResolution
      ? `${issueLabel} → PR #${firstResolution.pullRequestNumber}${firstCommit ? ` → ${firstCommit.sha.slice(0, 12)}` : ""}`
      : payload.introducedBy[0]
        ? `${issueLabel} introduced by ${payload.introducedBy[0].sha.slice(0, 12)}`
        : `${issueLabel} has no verified commit relationship`;
  return {
    kind: "issue_trace",
    title,
    data: payload as unknown as Readonly<Record<string, unknown>>,
    citations: payload.citations,
    score: firstResolution ? 3 : payload.introducedBy.length > 0 ? 2 : 1
  };
}

async function retrieveFeatureTrace(
  pool: Pool,
  request: RetrievalRequest,
  ref: string,
  limit: number
): Promise<RetrievalItem[]> {
  const featureText = request.featureText?.trim() ?? "";
  if (!featureText) return [];
  const result = await pool.query<{
    id: string;
    commit_sha: string;
    subject_id: string;
    subject_kind: string;
    subject_natural_key: string;
    subject_label: string;
    predicate: string;
    object_id: string;
    object_kind: string;
    object_natural_key: string;
    object_label: string;
    confidence: number;
    evidence: string[];
    source_observation_id: string | null;
  }>(
    `with current_ref as (
       select commit_sha from jina_context_graph.refs
       where tenant_id=$1 and repository=$2 and ref_name=$3
     ), projected_ref as (
       select current_ref.commit_sha from current_ref
       where exists (
         select 1 from jina_context_graph.graph_heads head
         join jina_context_graph.graphs graph on graph.id=head.graph_id
         where head.tenant_id=$1 and head.repository=$2 and head.ref_name=$3
           and graph.commit_sha=current_ref.commit_sha
       )
     )
     select assertion.id,assertion.commit_sha,assertion.subject_id,assertion.subject_kind,assertion.subject_natural_key,assertion.subject_label,assertion.predicate,
            assertion.object_id,assertion.object_kind,assertion.object_natural_key,assertion.object_label,assertion.confidence,
            assertion.evidence,assertion.source_observation_id
     from jina_context_graph.assertions assertion
     cross join projected_ref
     where assertion.tenant_id=$1 and assertion.repository=$2 and assertion.status='active'
       and assertion.predicate in ('IMPLEMENTS','DOCUMENTED_BY','LIKELY_AFFECTS','REFERENCES')
       and (assertion.subject_kind='Feature' or assertion.object_kind='Feature')
       and (
         (assertion.commit_sha='source' and jsonb_array_length(assertion.evidence)=0 and assertion.source_observation_id is not null)
         or (
           assertion.commit_sha<>'source' and jsonb_array_length(assertion.evidence)>0 and not exists (
             select 1
             from jsonb_array_elements_text(assertion.evidence) cited(value)
             left join lateral (
               select regexp_replace(cited.value, ':[0-9]+(-[0-9]+)?$', '') as path
             ) citation on true
             left join lateral (
               select blob_sha from jina_context_graph.commit_manifest($1,$2,assertion.commit_sha)
               where path=citation.path
             ) source_file on true
             left join jina_context_graph.ref_manifest current_file
               on current_file.tenant_id=$1 and current_file.repository=$2 and current_file.ref_name=$3
              and current_file.commit_sha=projected_ref.commit_sha and current_file.path=citation.path
             where source_file.blob_sha is null or current_file.blob_sha is null or source_file.blob_sha<>current_file.blob_sha
           )
         )
       )
     order by case assertion.predicate when 'IMPLEMENTS' then 0 when 'DOCUMENTED_BY' then 1 when 'LIKELY_AFFECTS' then 2 else 3 end,
              assertion.confidence desc,assertion.id`,
    [request.tenantId, request.repository, ref]
  );
  const [redirects, entities] = await Promise.all([
    pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
      `select from_entity_id,to_entity_id,kind from jina_context_graph.entity_redirects where tenant_id=$1 order by created_at,id`,
      [request.tenantId]
    ),
    pool.query<{ id: string; kind: string; natural_key: string; display_name: string }>(
      `select id,kind,natural_key,display_name from jina_context_graph.entities where tenant_id=$1`,
      [request.tenantId]
    )
  ]);
  const mapping = redirectMap(redirects.rows);
  const entitiesById = new Map(entities.rows.map((entity) => [entity.id, entity]));
  const rows = result.rows
    .map((row) => {
      const subject = entitiesById.get(resolveRedirect(mapping, row.subject_id));
      const object = entitiesById.get(resolveRedirect(mapping, row.object_id));
      return {
        ...row,
        ...(subject
          ? {
              subject_kind: subject.kind,
              subject_natural_key: subject.natural_key,
              subject_label: subject.display_name
            }
          : {}),
        ...(object
          ? { object_kind: object.kind, object_natural_key: object.natural_key, object_label: object.display_name }
          : {})
      };
    })
    .filter((row) => {
      const feature =
        row.subject_kind === "Feature"
          ? row.subject_label + " " + row.subject_natural_key
          : row.object_kind === "Feature"
            ? row.object_label + " " + row.object_natural_key
            : "";
      return feature.toLocaleLowerCase().includes(featureText.toLocaleLowerCase());
    })
    .slice(0, limit);
  return rows.map((row) => {
    const featureIsSubject = row.subject_kind === "Feature";
    const feature = featureIsSubject
      ? { kind: row.subject_kind, naturalKey: row.subject_natural_key, label: row.subject_label }
      : { kind: row.object_kind, naturalKey: row.object_natural_key, label: row.object_label };
    const related = featureIsSubject
      ? { kind: row.object_kind, naturalKey: row.object_natural_key, label: row.object_label }
      : { kind: row.subject_kind, naturalKey: row.subject_natural_key, label: row.subject_label };
    const title =
      row.predicate === "IMPLEMENTS"
        ? `${related.label} implements ${feature.label}`
        : row.predicate === "DOCUMENTED_BY"
          ? `${feature.label} is documented by ${related.label}`
          : row.predicate === "LIKELY_AFFECTS"
            ? `${related.label} may affect ${feature.label}`
            : `${related.label} references ${feature.label}`;
    const citations: RetrievalCitation[] = [
      {
        kind: "assertion",
        id: row.id,
        repository: request.repository,
        ...(/^[a-f0-9]{40}$/i.test(row.commit_sha) ? { commitSha: row.commit_sha } : {})
      }
    ];
    if (row.source_observation_id)
      citations.push({
        kind: "observation",
        id: row.source_observation_id,
        repository: request.repository
      });
    if (/^[a-f0-9]{40}$/i.test(row.commit_sha)) {
      for (const value of row.evidence) {
        const citation = retrievalCitationFromEvidence(request.repository, row.commit_sha, value);
        if (citation) citations.push(citation);
      }
    }
    return {
      kind: "feature_relationship",
      title,
      data: { feature, related, predicate: row.predicate },
      citations: dedupeRetrievalCitations(citations),
      score: row.confidence
    };
  });
}

async function retrieveStructure(
  pool: Pool,
  request: RetrievalRequest,
  ref: string,
  limit: number
): Promise<RetrievalItem[]> {
  const symbol = request.symbol ?? "";
  const path = request.path ?? "";
  const definitions = await pool.query<{
    path: string;
    commit_sha: string;
    blob_sha: string;
    moniker: string;
    name: string;
    symbol_kind: string;
    start_line: number;
    end_line: number;
  }>(
    `select m.path,m.commit_sha,m.blob_sha,s.moniker,s.name,s.kind as symbol_kind,s.start_line,s.end_line
     from jina_context_graph.ref_manifest m
     join jina_context_graph.blob_symbols s on s.tenant_id=m.tenant_id and s.blob_sha=m.blob_sha and s.parser_version=$6
     where m.tenant_id=$1 and m.repository=$2 and m.ref_name=$3
       and ($4='' or s.name ilike $4 or s.moniker ilike '%' || $4 || '%')
       and ($5='' or m.path=$5)
     order by case when s.name ilike $4 then 0 else 1 end,m.path,s.start_line limit $7`,
    [request.tenantId, request.repository, ref, symbol, path, CONTEXT_GRAPH_PARSER_VERSION, limit]
  );
  const items: RetrievalItem[] = definitions.rows.map((row) => ({
    kind: "symbol_definition",
    title: `${row.name} is ${row.symbol_kind} in ${row.path}`,
    data: { moniker: row.moniker, name: row.name, symbolKind: row.symbol_kind, path: row.path },
    score: 2,
    citations: [
      {
        kind: "code",
        id: `${row.blob_sha}:${row.start_line}:${row.moniker}`,
        repository: request.repository,
        commitSha: row.commit_sha,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line
      }
    ]
  }));
  if (items.length >= limit) return items.slice(0, limit);
  const relationships = await pool.query<{
    path: string;
    commit_sha: string;
    blob_sha: string;
    from_moniker: string;
    kind: string;
    to_moniker: string;
    start_line: number;
    end_line: number;
  }>(
    `select m.path,m.commit_sha,m.blob_sha,e.from_moniker,e.kind,e.to_moniker,e.start_line,e.end_line
     from jina_context_graph.ref_manifest m
     join jina_context_graph.symbol_edges e on e.tenant_id=m.tenant_id and e.blob_sha=m.blob_sha and e.parser_version=$6
     where m.tenant_id=$1 and m.repository=$2 and m.ref_name=$3
       and ($4='' or e.from_moniker ilike '%' || $4 || '%' or e.to_moniker ilike '%' || $4 || '%')
       and ($5='' or m.path=$5)
     order by case when e.from_moniker ilike $4 || '%' then 0 else 1 end,m.path,e.start_line limit $7`,
    [request.tenantId, request.repository, ref, symbol, path, CONTEXT_GRAPH_PARSER_VERSION, limit - items.length]
  );
  items.push(
    ...relationships.rows.map((row): RetrievalItem => ({
      kind: row.kind,
      title: `${row.from_moniker} ${row.kind} ${row.to_moniker}`,
      data: { fromMoniker: row.from_moniker, toMoniker: row.to_moniker, path: row.path },
      score: 1,
      citations: [
        {
          kind: "code",
          id: `${row.blob_sha}:${row.start_line}:${row.from_moniker}`,
          repository: request.repository,
          commitSha: row.commit_sha,
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line
        }
      ]
    }))
  );
  return items;
}

async function retrieveChange(
  pool: Pool,
  request: RetrievalRequest,
  headSha: string,
  limit: number
): Promise<RetrievalItem[]> {
  let commitShas = [headSha];
  if (request.pullRequestNumber) {
    const key = `github:pr:${request.repository}#${request.pullRequestNumber}`;
    const [included, redirects, entities] = await Promise.all([
      pool.query<{ subject_id: string; subject_natural_key: string; object_id: string; object_natural_key: string }>(
        `select subject_id,subject_natural_key,object_id,object_natural_key from jina_context_graph.assertions
         where tenant_id=$1 and repository=$2 and predicate='INCLUDES' and status='active'`,
        [request.tenantId, request.repository]
      ),
      pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
        `select from_entity_id,to_entity_id,kind from jina_context_graph.entity_redirects where tenant_id=$1 order by created_at,id`,
        [request.tenantId]
      ),
      pool.query<{ id: string; natural_key: string }>(
        `select id,natural_key from jina_context_graph.entities where tenant_id=$1`,
        [request.tenantId]
      )
    ]);
    const mapping = redirectMap(redirects.rows);
    const naturalKeys = new Map(entities.rows.map((entity) => [entity.id, entity.natural_key]));
    const parsed = included.rows
      .filter((row) => (naturalKeys.get(resolveRedirect(mapping, row.subject_id)) ?? row.subject_natural_key) === key)
      .map((row) => {
        const naturalKey = naturalKeys.get(resolveRedirect(mapping, row.object_id)) ?? row.object_natural_key;
        return /:sha:([a-f0-9]{40})$/i.exec(naturalKey)?.[1];
      })
      .filter((sha): sha is string => Boolean(sha));
    if (parsed.length) commitShas = parsed;
  }
  const changes = await pool.query<{
    commit_sha: string;
    path: string;
    change: string;
    old_path: string | null;
    old_blob_sha: string | null;
    new_blob_sha: string | null;
  }>(
    `select commit_sha,path,change,old_path,old_blob_sha,new_blob_sha from jina_context_graph.commit_changes
     where tenant_id=$1 and repository=$2 and commit_sha=any($3::text[])
       and ($4::text is null or path=$4 or old_path=$4)
     order by commit_sha,path limit $5`,
    [request.tenantId, request.repository, commitShas, request.path ?? null, limit]
  );
  const items: RetrievalItem[] = changes.rows.map((row) => ({
    kind: "commit_change",
    title: `${row.change} ${row.path}`,
    data: { change: row.change, oldPath: row.old_path, oldBlobSha: row.old_blob_sha, newBlobSha: row.new_blob_sha },
    score: 1,
    citations: [
      {
        kind: "commit_change",
        id: `${row.commit_sha}:${row.path}`,
        repository: request.repository,
        commitSha: row.commit_sha,
        path: row.path
      }
    ]
  }));
  const newBlobs = changes.rows.flatMap((row) => (row.new_blob_sha ? [row.new_blob_sha] : []));
  if (newBlobs.length && items.length < limit) {
    const inbound = await pool.query<{
      changed_path: string;
      changed_moniker: string;
      caller_path: string;
      caller_blob: string;
      commit_sha: string;
      from_moniker: string;
      kind: string;
      start_line: number;
      end_line: number;
    }>(
      `with changed as (
         select distinct ch.path,s.moniker,s.name
         from jina_context_graph.commit_changes ch
         join jina_context_graph.blob_symbols s on s.tenant_id=ch.tenant_id and s.blob_sha=ch.new_blob_sha and s.parser_version=$4
         where ch.tenant_id=$1 and ch.repository=$2 and ch.commit_sha=any($3::text[])
       )
       select changed.path as changed_path,changed.moniker as changed_moniker,m.path as caller_path,m.blob_sha as caller_blob,
              m.commit_sha,e.from_moniker,e.kind,e.start_line,e.end_line
       from changed
       join jina_context_graph.ref_manifest m on m.tenant_id=$1 and m.repository=$2
       join jina_context_graph.symbol_edges e on e.tenant_id=m.tenant_id and e.blob_sha=m.blob_sha and e.parser_version=$4
         and (e.to_moniker=changed.name or e.to_moniker=changed.moniker or e.to_moniker like '%.' || changed.name)
       where m.path<>changed.path
       order by changed.path,m.path,e.start_line limit $5`,
      [request.tenantId, request.repository, commitShas, CONTEXT_GRAPH_PARSER_VERSION, limit - items.length]
    );
    items.push(
      ...inbound.rows.map((row): RetrievalItem => ({
        kind: "affected_surface",
        title: `${row.caller_path} may be affected by ${row.changed_path}`,
        data: { changedMoniker: row.changed_moniker, fromMoniker: row.from_moniker, relationship: row.kind },
        score: 0.8,
        citations: [
          {
            kind: "code",
            id: `${row.caller_blob}:${row.start_line}:${row.from_moniker}`,
            repository: request.repository,
            commitSha: row.commit_sha,
            path: row.caller_path,
            startLine: row.start_line,
            endLine: row.end_line
          }
        ]
      }))
    );
  }
  return items.slice(0, limit);
}

async function retrieveIntent(pool: Pool, request: RetrievalRequest, limit: number): Promise<RetrievalItem[]> {
  const items: RetrievalItem[] = [];
  const historyCommitShas: string[] = [];
  if (request.path) {
    const history = await pool.query<{
      commit_sha: string;
      path: string;
      change: string;
      message: string | null;
      committed_at: Date | null;
    }>(
      `select c.commit_sha,c.path,c.change,m.message,m.committed_at from jina_context_graph.commit_changes c
       join jina_context_graph.commits m on m.tenant_id=c.tenant_id and m.repository=c.repository and m.sha=c.commit_sha
       where c.tenant_id=$1 and c.repository=$2 and (c.path=$3 or c.old_path=$3)
       order by m.committed_at desc nulls last limit $4`,
      [request.tenantId, request.repository, request.path, limit]
    );
    historyCommitShas.push(...history.rows.map((row) => row.commit_sha));
    items.push(
      ...history.rows.map((row): RetrievalItem => ({
        kind: "history",
        title: row.message ?? `${row.change} ${row.path}`,
        data: { change: row.change, ...(row.committed_at ? { committedAt: row.committed_at.toISOString() } : {}) },
        score: 1,
        citations: [
          {
            kind: "commit_change",
            id: `${row.commit_sha}:${row.path}`,
            repository: request.repository,
            commitSha: row.commit_sha,
            path: row.path
          }
        ]
      }))
    );
  }
  if (historyCommitShas.length && items.length < limit) {
    const workLinks = await pool.query<{
      includes_id: string;
      relation_id: string;
      relation: string;
      pr_label: string;
      issue_label: string;
      source_observation_id: string | null;
    }>(
      `select includes.id as includes_id,relation.id as relation_id,relation.predicate as relation,
              includes.subject_label as pr_label,relation.object_label as issue_label,relation.source_observation_id
       from jina_context_graph.assertions includes
       join jina_context_graph.assertions relation
         on relation.tenant_id=includes.tenant_id and relation.repository=includes.repository
        and relation.subject_id=includes.subject_id and relation.predicate in ('RESOLVES','REFERENCES') and relation.status='active'
       where includes.tenant_id=$1 and includes.repository=$2 and includes.predicate='INCLUDES' and includes.status='active'
         and exists (select 1 from unnest($3::text[]) sha where includes.object_natural_key like '%:sha:' || sha)
       order by case relation.predicate when 'RESOLVES' then 0 else 1 end,relation.recorded_at desc limit $4`,
      [request.tenantId, request.repository, historyCommitShas, limit - items.length]
    );
    items.push(
      ...workLinks.rows.map((row): RetrievalItem => ({
        kind: "work_intent",
        title: `${row.pr_label} ${row.relation.toLowerCase()} ${row.issue_label}`,
        data: { pullRequest: row.pr_label, issue: row.issue_label, relation: row.relation },
        score: row.relation === "RESOLVES" ? 2 : 1,
        citations: [
          { kind: "assertion", id: row.includes_id, repository: request.repository },
          { kind: "assertion", id: row.relation_id, repository: request.repository },
          ...(row.source_observation_id
            ? [{ kind: "observation" as const, id: row.source_observation_id, repository: request.repository }]
            : [])
        ]
      }))
    );
  }
  const query = request.query?.trim();
  if (query && items.length < limit) {
    const search = await pool.query<{
      source_id: string;
      source_kind: string;
      title: string;
      body: string;
      score: number;
    }>(
      `select source_id,source_kind,title,body,ts_rank(search_vector,plainto_tsquery('english',$3)) as score
       from jina_context_graph.search_documents
       where tenant_id=$1 and repository=$2
         and search_vector @@ plainto_tsquery('english',$3)
       order by score desc,projected_at desc limit $4`,
      [request.tenantId, request.repository, query, Math.min(200, limit * 4)]
    );
    const ranked = search.rows
      .map((row) => ({ row, score: Number(row.score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit - items.length);
    items.push(
      ...ranked.map(({ row, score }): RetrievalItem => ({
        kind: row.source_kind,
        title: row.title,
        data: { excerpt: row.body.slice(0, 500) },
        score,
        citations: [
          {
            kind: row.source_kind === "entity" ? "entity" : "observation",
            id: row.source_id,
            repository: request.repository
          }
        ]
      }))
    );
  }
  return items.slice(0, limit);
}

async function retrieveOwnership(pool: Pool, request: RetrievalRequest, limit: number): Promise<RetrievalItem[]> {
  const assertions = await pool.query<{
    id: string;
    subject_id: string;
    subject_label: string;
    subject_natural_key: string;
    object_id: string;
    object_label: string;
    object_natural_key: string;
    qualifiers: Record<string, unknown>;
    recorded_at: Date;
    generator: string | null;
    asserted_by: string | null;
  }>(
    `select id,subject_id,subject_label,subject_natural_key,object_id,object_label,object_natural_key,
            qualifiers,recorded_at,generator,asserted_by
     from jina_context_graph.assertions where tenant_id=$1 and repository=$2 and predicate='OWNED_BY' and status='active'
     order by recorded_at desc limit $3`,
    [request.tenantId, request.repository, Math.min(800, limit * 4)]
  );
  const redirects = await pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
    `select from_entity_id,to_entity_id,kind from jina_context_graph.entity_redirects where tenant_id=$1 order by created_at,id`,
    [request.tenantId]
  );
  const mapping = redirectMap(redirects.rows);
  const resolved = await pool.query<{ id: string; display_name: string; natural_key: string }>(
    `select id,display_name,natural_key from jina_context_graph.entities where tenant_id=$1`,
    [request.tenantId]
  );
  const names = new Map(resolved.rows.map((row) => [row.id, row]));
  const target = request.path ?? request.symbol;
  const applicable = assertions.rows
    .filter((row) => {
      const subject = names.get(resolveRedirect(mapping, row.subject_id));
      return (
        !target ||
        (subject?.natural_key ?? row.subject_natural_key).includes(target) ||
        (typeof row.qualifiers.pattern === "string" && codeownersPatternMatches(row.qualifiers.pattern, target))
      );
    })
    .sort(
      (left, right) =>
        ownershipAuthority(left) - ownershipAuthority(right) || right.recorded_at.getTime() - left.recorded_at.getTime()
    );
  const items: RetrievalItem[] = applicable.map((row) => {
    const subject = names.get(resolveRedirect(mapping, row.subject_id));
    const owner = names.get(resolveRedirect(mapping, row.object_id));
    return {
      kind: "ownership",
      title: `${subject?.display_name ?? row.subject_label} owned by ${owner?.display_name ?? row.object_label}`,
      data: {
        subjectKey: subject?.natural_key ?? row.subject_natural_key,
        ownerKey: owner?.natural_key ?? row.object_natural_key,
        qualifiers: row.qualifiers,
        authority: row.asserted_by ? "human" : row.generator === "source:codeowners" ? "codeowners" : "model"
      },
      score: 3 - ownershipAuthority(row),
      citations: [{ kind: "assertion", id: row.id, repository: request.repository }]
    };
  });
  if (request.path && items.length < limit) {
    const authors = await pool.query<{
      sha: string;
      author_external_id: string;
      committed_at: Date | null;
      entity_id: string | null;
      display_name: string | null;
    }>(
      `select c.sha,c.author_external_id,c.committed_at,i.entity_id,e.display_name
       from jina_context_graph.commit_changes ch
       join jina_context_graph.commits c on c.tenant_id=ch.tenant_id and c.repository=ch.repository and c.sha=ch.commit_sha
       left join jina_context_graph.identities i on i.tenant_id=c.tenant_id and i.source='git-email' and i.external_id=c.author_external_id and i.status='accepted'
       left join jina_context_graph.entities e on e.id=i.entity_id
       where ch.tenant_id=$1 and ch.repository=$2 and (ch.path=$3 or ch.old_path=$3) and c.author_external_id is not null
       order by c.committed_at desc nulls last limit $4`,
      [request.tenantId, request.repository, request.path, limit - items.length]
    );
    const seenAuthors = new Set<string>();
    const uniqueAuthors = authors.rows.filter((row) => {
      const key = row.entity_id ? resolveRedirect(mapping, row.entity_id) : row.author_external_id;
      return seenAuthors.has(key) ? false : (seenAuthors.add(key), true);
    });
    items.push(
      ...uniqueAuthors.map((row, index): RetrievalItem => ({
        kind: "recent_author",
        title:
          (row.entity_id ? names.get(resolveRedirect(mapping, row.entity_id))?.display_name : undefined) ??
          row.display_name ??
          row.author_external_id,
        data: {
          authorExternalId: row.author_external_id,
          ...(row.committed_at ? { committedAt: row.committed_at.toISOString() } : {})
        },
        score: 1 / (index + 1),
        citations: [
          {
            kind: "commit_change",
            id: `${row.sha}:${request.path}`,
            repository: request.repository,
            commitSha: row.sha,
            path: request.path!
          }
        ]
      }))
    );
  }
  return items.slice(0, limit);
}

function ownershipAuthority(row: { readonly generator: string | null; readonly asserted_by: string | null }): number {
  if (row.asserted_by) return 0;
  if (row.generator === "source:codeowners") return 1;
  return 2;
}

function embeddingForText(text: string, dimensions = 64): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) {
    const digest = stableId("e", token).slice(2);
    const index = Number.parseInt(digest.slice(0, 8), 16) % dimensions;
    vector[index] = (vector[index] ?? 0) + (Number.parseInt(digest.slice(8, 10), 16) % 2 === 0 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}
