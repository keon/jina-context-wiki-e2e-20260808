import { randomUUID } from "node:crypto";
import {
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  assertionObservationId,
  canonicalJson,
  causalTraceItemsFromGraph,
  computeCommitChanges,
  createOntologyProjection,
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
  type OntologyAssertionBatch,
  type OntologyAssertionResult,
  type OntologyAssertionSummary,
  type OntologyCommand,
  type OntologyCommandResult,
  type OntologyEdge,
  type OntologyGraph,
  type OntologyGraphStore,
  type OntologyIngestPlan,
  type OntologyNode,
  type OntologyProjectionRequest,
  type OntologySourceEvidence,
  type OntologySourceIngestResult,
  type OntologyOperationalMetrics,
  type ProjectionRebuildResult,
  type RepositorySnapshot,
  type IssueTraceProjection,
  type RetrievalItem,
  type RetrievalCitation,
  type RetrievalRequest,
  type RetrievalResult,
  type StoredAssertion
} from "@jina/ontology";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { DomainError } from "@jina/shared-kernel";

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

interface NodeRow {
  graph_id: string;
  node_id: string;
  kind: OntologyNode["kind"];
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
  plane: OntologyEdge["plane"];
  confidence: number | null;
  why: string | null;
  qualifiers: Readonly<Record<string, string | number | boolean>>;
  evidence: readonly string[];
}

const RESTORE_GITHUB_ENTITY_LABELS_SQL = `
  with latest as (
    select distinct on (payload->>'kind',payload->>'number') payload
    from jina_ontology.observations
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
  update jina_ontology.entities e set display_name=labels.display_name
  from labels
  where e.tenant_id=$1 and e.kind=labels.kind and e.natural_key=labels.natural_key
    and e.display_name is distinct from labels.display_name`;

function assertionNaturalKey(
  assertion: Pick<StoredAssertion, "subject" | "predicate" | "object" | "qualifiers">
): string {
  return `${assertion.subject.kind}:${assertion.subject.naturalKey}:${assertion.predicate}:${assertion.object.kind}:${assertion.object.naturalKey}:${canonicalJson(assertion.qualifiers ?? {})}`;
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
  const naturalKey = cardinality === "one"
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
    `select id,status from jina_ontology.assertions
     where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and object_id=$5 and qualifiers_hash=$6
       and status in ('proposed','active')
     order by recorded_at,id limit 1`,
    [tenantId, repository, subjectId, predicate, objectId, qualifiersHash]
  );
  return result.rows[0];
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

export interface PostgresOntologyGraphStoreConfig extends PoolConfig {
  readonly manageSchema?: boolean;
}

export class PostgresOntologyGraphStore implements OntologyGraphStore {
  private readonly pool: Pool;
  private readonly manageSchema: boolean;
  private initialized?: Promise<void>;

  constructor(config: PostgresOntologyGraphStoreConfig) {
    const { manageSchema = true, ...poolConfig } = config;
    this.manageSchema = manageSchema;
    this.pool = new Pool({ ...poolConfig, application_name: "jina-ontology", max: poolConfig.max ?? 5 });
  }

  async save(graph: OntologyGraph): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertRepositoryWritable(client, graph.tenantId, graph.repository);
      await insertOntologyGraph(client, graph);
      if (graph.generator.executor === "projection") {
        await client.query(
          `insert into jina_ontology.graph_heads (tenant_id,repository,ref_name,graph_id,updated_at)
           select $1,$2,ref.ref_name,$3,$4
           from jina_ontology.refs ref
           where ref.tenant_id=$1 and ref.repository=$2 and ref.commit_sha=$5
           on conflict (tenant_id,repository,ref_name) do update
             set graph_id=excluded.graph_id,updated_at=excluded.updated_at`,
          [graph.tenantId, graph.repository, graph.id, graph.generatedAt, graph.commitSha]
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

  async latest(tenantId: string): Promise<OntologyGraph | undefined> {
    const graphs = await this.loadGraphs(tenantId, 1);
    return graphs[0];
  }

  async get(graphId: string, tenantId: string): Promise<OntologyGraph | undefined> {
    await this.initialize();
    const result = await this.pool.query<GraphRow>(
      "select * from jina_ontology.graphs where id = $1 and tenant_id = $2",
      [graphId, tenantId]
    );
    return result.rows[0] ? this.hydrate(result.rows[0]) : undefined;
  }

  async list(tenantId: string): Promise<readonly OntologyGraph[]> {
    return this.loadGraphs(tenantId, 50);
  }

  async listSummaries(tenantId: string) {
    await this.initialize();
    const result = await this.pool.query<GraphSummaryRow>(
      `select g.*,
         (select count(*) from jina_ontology.nodes n where n.graph_id = g.id) as node_count,
         (select count(*) from jina_ontology.edges e where e.graph_id = g.id) as edge_count
       from jina_ontology.graphs g
       where g.tenant_id = $1
       order by g.generated_at desc
       limit 50`,
      [tenantId]
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
      `select sha from jina_ontology.commits where tenant_id=$1 and repository=$2 and sha=any($3::text[])`,
      [tenantId, repository, commitShas]
    );
    return result.rows.map((row) => row.sha);
  }

  async planIngestion(snapshot: RepositorySnapshot): Promise<OntologyIngestPlan> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertRepositoryWritable(client, snapshot.tenantId, snapshot.repository);
      const filtered = await client.query<{ kind: string; value: string }>(
        `select kind,value from jina_ontology.erasure_filters
         where tenant_id=$1 and ((kind='identity' and value=$2) or (kind='commit' and value=$3))`,
        [snapshot.tenantId, snapshot.authorExternalId ?? "", snapshot.commitSha]
      );
      const authorExternalId = filtered.rows.some((row) => row.kind === "identity") ? undefined : snapshot.authorExternalId;
      const message = filtered.rows.some((row) => row.kind === "commit") ? undefined : snapshot.message;
      const { authorExternalId: _rawAuthor, message: _rawMessage, ...snapshotWithoutSensitiveFields } = snapshot;
      const filteredSnapshot: RepositorySnapshot = {
        ...snapshotWithoutSensitiveFields,
        ...(authorExternalId ? { authorExternalId } : {}),
        ...(message !== undefined ? { message } : {})
      };
      const observationId = sourceObservationId(snapshot);
      await client.query(
        `insert into jina_ontology.observations
          (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
         values ($1,$2,'git','source_snapshot',$3,$4,$5,$6::jsonb,$7)
         on conflict (id) do nothing`,
        [observationId, snapshot.tenantId, `${snapshot.repository}:${snapshot.commitSha}`, snapshot.repository,
          snapshot.recordedAt, JSON.stringify(filteredSnapshot), stableId("sha", JSON.stringify(filteredSnapshot))]
      );
      await client.query(
        `insert into jina_ontology.commits
          (tenant_id,repository,sha,tree_sha,parents,author_external_id,committed_at,message,source_observation_id,
           tree_paths,tree_blob_shas,tree_recorded)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
        on conflict (tenant_id,repository,sha) do update set
           tree_paths=case when jina_ontology.commits.tree_recorded then jina_ontology.commits.tree_paths else excluded.tree_paths end,
           tree_blob_shas=case when jina_ontology.commits.tree_recorded then jina_ontology.commits.tree_blob_shas else excluded.tree_blob_shas end,
           tree_recorded=true`,
        [snapshot.tenantId, snapshot.repository, snapshot.commitSha, snapshot.treeSha, snapshot.parents,
          authorExternalId ?? null, snapshot.committedAt ?? null, message ?? null, observationId,
          snapshot.files.map((file) => file.path), snapshot.files.map((file) => file.blobSha)]
      );
      const steadyStateEventAt = snapshot.updateRef !== false ? snapshot.recordedAt : undefined;
      const repositoryEntityId = await ensureEntity(client, snapshot.tenantId, {
        kind: "Repository", naturalKey: `github:repo:${snapshot.repository}`, label: snapshot.repository
      }, steadyStateEventAt);
      const commitEntityId = await ensureEntity(client, snapshot.tenantId, {
        kind: "Commit", naturalKey: `repo:${snapshot.repository}:sha:${snapshot.commitSha}`, label: snapshot.commitSha.slice(0, 12)
      }, steadyStateEventAt);
      await ensureIdentity(client, snapshot.tenantId, "github-repository", snapshot.repository, repositoryEntityId, "accepted", observationId, snapshot.recordedAt, snapshot.updateRef !== false);
      await ensureIdentity(client, snapshot.tenantId, "git-sha", snapshot.commitSha, commitEntityId, "accepted", observationId, snapshot.recordedAt, snapshot.updateRef !== false);
      if (snapshot.authorGitHubLogin) {
        const engineerId = await ensureEntity(client, snapshot.tenantId, {
          kind: "Engineer", naturalKey: `github:user:${snapshot.authorGitHubLogin}`,
          label: snapshot.authorName ?? snapshot.authorGitHubLogin
        }, steadyStateEventAt);
        await ensureIdentity(client, snapshot.tenantId, "github", snapshot.authorGitHubLogin, engineerId, "accepted", observationId, snapshot.recordedAt, snapshot.updateRef !== false);
        if (authorExternalId) {
          await ensureIdentity(client, snapshot.tenantId, "git-email", authorExternalId, engineerId, "proposed", observationId, snapshot.recordedAt, snapshot.updateRef !== false);
        }
      }
      let oldRefSha: string | undefined;
      if (snapshot.updateRef !== false) {
        const previousRef = await client.query<{ commit_sha: string }>(
          `select commit_sha from jina_ontology.refs where tenant_id=$1 and repository=$2 and ref_name=$3 for update`,
          [snapshot.tenantId, snapshot.repository, snapshot.ref]
        );
        oldRefSha = previousRef.rows[0]?.commit_sha;
        await client.query(
          `insert into jina_ontology.refs (tenant_id,repository,ref_name,commit_sha,is_default,updated_at)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id,repository,ref_name) do update
           set commit_sha=excluded.commit_sha, is_default=excluded.is_default, updated_at=excluded.updated_at`,
          [snapshot.tenantId, snapshot.repository, snapshot.ref, snapshot.commitSha, snapshot.isDefaultRef ?? snapshot.ref === "main", snapshot.recordedAt]
        );
      }
      if (snapshot.files.length > 0) {
        const uniqueBlobs = [...new Map(snapshot.files.map((file) => [file.blobSha, file.size])).entries()];
        await client.query(
          `insert into jina_ontology.blobs (tenant_id,blob_sha,byte_size)
           select $1,source.blob_sha,source.byte_size
           from unnest($2::text[],$3::integer[]) as source(blob_sha,byte_size)
           on conflict do nothing`,
          [snapshot.tenantId, uniqueBlobs.map(([sha]) => sha), uniqueBlobs.map(([, size]) => size)]
        );
      }
      const missing = await client.query<{ blob_sha: string; path: string; byte_size: number }>(
        `select distinct on (source.blob_sha) source.blob_sha,source.path,b.byte_size
         from unnest($2::text[],$3::text[]) source(path,blob_sha)
         join jina_ontology.blobs b on b.tenant_id=$1 and b.blob_sha=source.blob_sha
         left join jina_ontology.blob_analyses a
           on a.tenant_id=$1 and a.blob_sha=source.blob_sha and a.parser_version=$4
         where a.blob_sha is null order by source.blob_sha,source.path`,
        [snapshot.tenantId, snapshot.files.map((file) => file.path),
          snapshot.files.map((file) => file.blobSha), ONTOLOGY_PARSER_VERSION]
      );
      const parentFiles = snapshot.parents[0]
        ? await client.query<{ path: string; blob_sha: string }>(
            `select path,blob_sha from jina_ontology.commit_manifest($1,$2,$3)`,
            [snapshot.tenantId, snapshot.repository, snapshot.parents[0]]
          )
        : { rows: [] as { path: string; blob_sha: string }[] };
      const parentTree = parentFiles.rows.map((file) => ({ path: file.path, blobSha: file.blob_sha, size: 0 }));
      const changes = computeCommitChanges(snapshot.files, parentTree);
      for (const change of changes) {
        await client.query(
          `insert into jina_ontology.commit_changes
            (tenant_id,repository,commit_sha,path,change,old_path,old_blob_sha,new_blob_sha)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
          [snapshot.tenantId, snapshot.repository, snapshot.commitSha, change.path, change.change,
            change.oldPath ?? null, change.oldBlobSha ?? null, change.newBlobSha ?? null]
        );
      }
      if (snapshot.updateRef !== false && oldRefSha !== snapshot.commitSha) {
        await insertOutbox(client, snapshot.tenantId, "observation_recorded", observationId, {
          observationId, repoId: snapshot.repository
        }, snapshot.recordedAt);
        await insertOutbox(client, snapshot.tenantId, "commit_ingested", `${snapshot.repository}:${snapshot.commitSha}`, {
          repoId: snapshot.repository, commitSha: snapshot.commitSha
        }, snapshot.recordedAt);
        await insertOutbox(client, snapshot.tenantId, "ref_moved", `${snapshot.repository}:${snapshot.ref}`, {
          repoId: snapshot.repository, refName: snapshot.ref, oldSha: oldRefSha ?? null, newSha: snapshot.commitSha
        }, snapshot.recordedAt);
      }
      await client.query("commit");
      const discoveredBlobCount = new Set(snapshot.files.map((file) => file.blobSha)).size;
      return {
        observationId,
        commitSha: snapshot.commitSha,
        fileCount: snapshot.files.length,
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
    analyses: readonly BlobAnalysis[]
  ): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertRepositoryWritable(client, scope.tenantId, scope.repository);
      for (const analysis of analyses) {
        const known = await client.query(
          `select 1 from jina_ontology.commit_manifest($1,$2,$3)
           where blob_sha=$4 limit 1`,
          [scope.tenantId, scope.repository, scope.commitSha, analysis.blobSha]
        );
        if (known.rowCount !== 1) throw new Error(`blob ${analysis.blobSha} is not in the recorded snapshot`);
        const inserted = await client.query(
          `insert into jina_ontology.blob_analyses (tenant_id,blob_sha,parser_version,language)
           values ($1,$2,$3,$4) on conflict do nothing returning blob_sha`,
          [scope.tenantId, analysis.blobSha, analysis.parserVersion, analysis.language ?? null]
        );
        if (inserted.rowCount !== 1) continue;
        for (const symbol of analysis.symbols) {
          await client.query(
            `insert into jina_ontology.blob_symbols
              (tenant_id,blob_sha,parser_version,moniker,name,kind,signature_hash,start_line,end_line)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
            [scope.tenantId, analysis.blobSha, analysis.parserVersion, symbol.moniker, symbol.name,
              symbol.kind, symbol.signatureHash, symbol.startLine, symbol.endLine]
          );
        }
        for (const item of analysis.imports) {
          await client.query(
            `insert into jina_ontology.blob_imports
              (tenant_id,blob_sha,parser_version,specifier,line)
             values ($1,$2,$3,$4,$5) on conflict do nothing`,
            [scope.tenantId, analysis.blobSha, analysis.parserVersion, item.specifier, item.line]
          );
        }
        for (const edge of analysis.edges) {
          await client.query(
            `insert into jina_ontology.symbol_edges
              (tenant_id,blob_sha,parser_version,from_moniker,kind,to_moniker,start_line,end_line)
             values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
            [scope.tenantId, analysis.blobSha, analysis.parserVersion, edge.fromMoniker, edge.kind,
              edge.toMoniker, edge.startLine, edge.endLine]
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async applyGitHubObservations(observations: readonly RepositorySourceObservation[]): Promise<OntologySourceIngestResult> {
    await this.initialize();
    const client = await this.pool.connect();
    let assertionCount = 0;
    let newObservationCount = 0;
    let updatedObservationCount = 0;
    let confirmedObservationCount = 0;
    const observationIds: string[] = [];
    try {
      await client.query("begin");
      const scopes = [...new Set(observations.map((observation) => `${observation.tenantId}\0${observation.repository}`))].sort();
      for (const scope of scopes) {
        const [tenantId, repository] = scope.split("\0");
        await assertRepositoryWritable(client, tenantId!, repository!);
      }
      for (const observation of observations) {
        const normalized = normalizeSourceObservation(observation);
        const source = sourceObservationProvider(observation);
        const externalId = sourceObservationExternalId(observation);
        const observationId = stableId("observation", `${observation.tenantId}:${source}:${externalId}`);
        const scope = repositoryObservationScope(observation);
        observationIds.push(observationId);
        const payload = JSON.stringify(observation);
        const priorVersion = await client.query(
          `select 1 from jina_ontology.observations
           where tenant_id=$1 and repository=$2 and source=$3 and payload->>'kind'=$4
             and ($5::text is null or payload->>$5=$6) limit 1`,
          [observation.tenantId, observation.repository, source, observation.kind, scope.field, scope.value]
        );
        const insertedObservation = await client.query(
          `insert into jina_ontology.observations
            (id,tenant_id,source,type,external_id,repository,occurred_at,recorded_at,payload,payload_sha)
           values ($1,$2,$9,'source_snapshot',$3,$4,$5,$6,$7::jsonb,$8)
           on conflict (tenant_id,source,external_id) do nothing returning id`,
          [observationId, observation.tenantId, externalId, observation.repository,
            "occurredAt" in observation ? observation.occurredAt ?? null : null,
            observation.recordedAt, payload, stableId("sha", payload), source]
        );
        if (insertedObservation.rowCount === 1) {
          if (priorVersion.rowCount) updatedObservationCount += 1;
          else newObservationCount += 1;
          await insertOutbox(client, observation.tenantId, "observation_recorded", observationId, {
            observationId, repoId: observation.repository
          }, observation.recordedAt);
        } else confirmedObservationCount += 1;
        const currentSourceSnapshot = observation.kind === "pull_request" || observation.kind === "issue"
          ? await isLatestGitHubWorkItemObservation(client, observation, observationId)
          : insertedObservation.rowCount === 1;
        const shouldReconcile = insertedObservation.rowCount === 1 && currentSourceSnapshot;
        const entityIds = new Map<string, string>();
        for (const entity of normalized.entities) {
          const id = await ensureEntity(client, observation.tenantId, {
            kind: entity.kind, naturalKey: entity.key, label: entity.displayName
          }, observation.recordedAt, currentSourceSnapshot);
          entityIds.set(`${entity.kind}:${entity.key}`, id);
        }
        if (normalized.githubIdentity) {
          const entityId = entityIds.get(`${normalized.githubIdentity.entity.kind}:${normalized.githubIdentity.entity.key}`)!;
          const identityId = stableId("identity", `${observation.tenantId}:github:${normalized.githubIdentity.externalId}:${entityId}`);
          const inserted = await client.query(
            `insert into jina_ontology.identities
              (id,tenant_id,source,external_id,entity_id,status,confidence,source_observation_id,created_at)
             values ($1,$2,'github',$3,$4,'accepted',1,$5,$6)
             on conflict (tenant_id,source,external_id,entity_id) do nothing returning id`,
            [identityId, observation.tenantId, normalized.githubIdentity.externalId, entityId, observationId, observation.recordedAt]
          );
          if (inserted.rowCount === 1) await insertOutbox(client, observation.tenantId, "identity_changed", identityId, { identityId }, observation.recordedAt);
        }
        const desiredAssertionIds: string[] = [];
        for (const intent of normalized.assertions) {
          const subjectId = entityIds.get(`${intent.subject.kind}:${intent.subject.key}`)!;
          const objectId = entityIds.get(`${intent.object.kind}:${intent.object.key}`)!;
          const qualifiers = intent.qualifiers ?? {};
          const qualifiersHash = stableId("q", canonicalJson(qualifiers));
          const assertionId = stableId(
            "assertion",
            `${observation.tenantId}:${observation.repository}:${subjectId}:${intent.predicate}:${objectId}:${qualifiersHash}:${observationId}`
          );
          const definition = predicateDefinition(intent.predicate);
          await lockAssertionNaturalKey(
            client, observation.tenantId, observation.repository, subjectId, intent.predicate, objectId, qualifiersHash, definition.cardinality
          );
          const existingLive = await findLiveAssertionByNaturalKey(
            client, observation.tenantId, observation.repository, subjectId, intent.predicate, objectId, qualifiersHash
          );
          if (existingLive) {
            desiredAssertionIds.push(existingLive.id);
            if (shouldReconcile) {
              await backfillAssertionExplanation(client, observation.tenantId, existingLive.id, intent.explanation, observation.recordedAt);
              await client.query(
                `update jina_ontology.assertions set
                   last_confirmed_at=greatest(last_confirmed_at,$3)
                 where tenant_id=$1 and id=$2`,
                [observation.tenantId, existingLive.id, observation.recordedAt]
              );
              await insertOutbox(client, observation.tenantId, "assertion_changed", existingLive.id, {
                assertionId: existingLive.id, repoId: observation.repository
              }, observation.recordedAt);
              if (definition.cardinality === "one") {
                const superseded = await client.query<{ id: string }>(
                  `update jina_ontology.assertions set status='superseded',valid_to=$6,superseded_by=$7
                   where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                     and status='active' and id<>$7 returning id`,
                  [observation.tenantId, observation.repository, subjectId, intent.predicate, qualifiersHash, observation.recordedAt, existingLive.id]
                );
                for (const row of superseded.rows) {
                  await insertOutbox(client, observation.tenantId, "assertion_changed", row.id, {
                    assertionId: row.id, repoId: observation.repository, status: "superseded"
                  }, observation.recordedAt);
                }
              }
            }
            assertionCount += 1;
            continue;
          }
          desiredAssertionIds.push(assertionId);
          await client.query(
            `insert into jina_ontology.assertions as current
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
            [assertionId, observation.tenantId, observation.repository, subjectId, intent.subject.kind, intent.subject.key,
              intent.subject.displayName, intent.predicate, objectId, intent.object.kind, intent.object.key,
              intent.object.displayName, observationId, ONTOLOGY_REGISTRY_VERSION, observation.recordedAt,
              JSON.stringify(qualifiers), qualifiersHash, `source:${source}`,
              shouldReconcile, definition.cardinality === "one", `${source}-normalizer-v1`, intent.explanation]
          );
          assertionCount += 1;
          if (shouldReconcile) {
            if (definition.cardinality === "one") {
              const superseded = await client.query<{ id: string }>(
                `update jina_ontology.assertions set status='superseded',valid_to=$6,superseded_by=$7
                 where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                   and status='active' and id<>$7 returning id`,
                [observation.tenantId, observation.repository, subjectId, intent.predicate, qualifiersHash, observation.recordedAt, assertionId]
              );
              for (const row of superseded.rows) {
                await insertOutbox(client, observation.tenantId, "assertion_changed", row.id, {
                  assertionId: row.id, repoId: observation.repository, status: "superseded"
                }, observation.recordedAt);
              }
              await client.query(
                `update jina_ontology.assertions set status='active' where tenant_id=$1 and id=$2`,
                [observation.tenantId, assertionId]
              );
            }
            await insertOutbox(client, observation.tenantId, "assertion_changed", assertionId, {
              assertionId, repoId: observation.repository, status: "active"
            }, observation.recordedAt);
          }
        }
        if (shouldReconcile) {
          const retracted = await client.query<{ id: string }>(
            `update jina_ontology.assertions a set status='retracted',valid_to=$9
             where a.tenant_id=$1 and a.repository=$2 and a.generator=any($3::text[])
               and a.status in ('active','proposed') and not (a.id=any($7::text[]))
               and a.source_observation_id in (
                 select o.id from jina_ontology.observations o
                 where o.tenant_id=$1 and o.repository=$2 and o.source=$4
                   and o.payload->>'kind'=$5 and ($6::text is null or o.payload->>$6=$8)
               )
             returning a.id`,
            [observation.tenantId, observation.repository,
              observation.kind === "codeowners" ? ["source:codeowners", "source:github"] : [`source:${source}`], source, observation.kind,
              scope.field, desiredAssertionIds, scope.value, observation.recordedAt]
          );
          for (const row of retracted.rows) {
            await insertOutbox(client, observation.tenantId, "assertion_changed", row.id, {
              assertionId: row.id, repoId: observation.repository, status: "retracted"
            }, observation.recordedAt);
          }
        }
      }
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
  ): Promise<readonly OntologySourceEvidence[]> {
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
       from jina_ontology.observations
       where tenant_id=$1 and repository=$2 and id=any($3::text[]) and redacted_at is null and payload is not null`,
      [tenantId, repository, requested]
    );
    if (result.rows.length !== requested.length) throw new Error("assertion evidence observation was not found");
    return result.rows.map((row) => ({
      id: row.id,
      source: row.source,
      type: row.type,
      repository: row.repository ?? repository,
      payloadSha: row.payload_sha,
      payload: row.payload
    })).sort((left, right) => left.id.localeCompare(right.id));
  }

  async hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string,
    registryVersion: string,
    evidenceFingerprint: string
  ): Promise<OntologyAssertionResult | undefined> {
    await this.initialize();
    const generated = await this.pool.query<{ observation_id: string; evidence_fingerprint: string }>(
      `select id as observation_id,payload->>'evidenceFingerprint' as evidence_fingerprint
       from jina_ontology.observations
       where id=$1 and tenant_id=$2 and repository=$3 and type='model_output'
         and redacted_at is null and payload is not null`,
      [
        assertionObservationId({ tenantId, repository, commitSha, generatorVersion, registryVersion, evidenceFingerprint }),
        tenantId,
        repository
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

  async saveAssertionBatch(batch: OntologyAssertionBatch): Promise<OntologyAssertionResult> {
    await this.initialize();
    const normalized = normalizeAssertionBatchLenient(batch);
    const assertions = normalized.assertions;
    const observationId = assertionObservationId(batch);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await assertRepositoryWritable(client, batch.tenantId, batch.repository);
      const inserted = await client.query(
        `insert into jina_ontology.observations
          (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
         values ($1,$2,$3,'model_output',$4,$5,$6,$7::jsonb,$8)
         on conflict do nothing returning id`,
        [observationId, batch.tenantId, `model:${batch.model}`,
          `${batch.repository}:${batch.commitSha}:${batch.generatorVersion}:${batch.registryVersion}:${batch.evidenceFingerprint}`,
          batch.repository, batch.generatedAt, JSON.stringify(batch), stableId("sha", JSON.stringify(batch))]
      );
      if (inserted.rowCount === 1) {
        await insertOutbox(client, batch.tenantId, "observation_recorded", observationId, {
          observationId, repoId: batch.repository
        }, batch.generatedAt);
        for (const assertion of assertions) {
          // Model observations may introduce entities, but they must not rename
          // identities already established by deterministic source intake.
          const subjectId = await ensureEntity(client, batch.tenantId, assertion.subject, batch.generatedAt, false);
          const objectId = await ensureEntity(client, batch.tenantId, assertion.object, batch.generatedAt, false);
          const qualifiersHash = stableId("q", canonicalJson(assertion.qualifiers ?? {}));
          await lockAssertionNaturalKey(
            client,
            batch.tenantId,
            batch.repository,
            subjectId,
            assertion.predicate,
            objectId,
            qualifiersHash,
            predicateDefinition(assertion.predicate).cardinality
          );
          const existingLive = await findLiveAssertionByNaturalKey(
            client, batch.tenantId, batch.repository, subjectId, assertion.predicate, objectId, qualifiersHash
          );
          if (existingLive) {
            if (assertion.explanation) {
              await backfillAssertionExplanation(client, batch.tenantId, existingLive.id, assertion.explanation, batch.generatedAt);
            }
            await client.query(
              `update jina_ontology.assertions
               set last_confirmed_at=greatest(last_confirmed_at,$3)
               where tenant_id=$1 and id=$2`,
              [batch.tenantId, existingLive.id, batch.generatedAt]
            );
            await insertOutbox(client, batch.tenantId, "assertion_changed", existingLive.id, {
              assertionId: existingLive.id, repoId: batch.repository
            }, batch.generatedAt);
            continue;
          }
          await client.query(
            `insert into jina_ontology.assertions
              (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
               predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,
               source_observation_id,generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,generator,last_confirmed_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22::jsonb,$23,$24,$21)
             on conflict (id) do update set
               last_confirmed_at=greatest(jina_ontology.assertions.last_confirmed_at,excluded.last_confirmed_at)`,
            [assertion.id, assertion.tenantId, assertion.repository, assertion.commitSha,
              subjectId, assertion.subject.kind, assertion.subject.naturalKey, assertion.subject.label,
              assertion.predicate, objectId, assertion.object.kind, assertion.object.naturalKey, assertion.object.label,
              assertion.status, assertion.confidence, assertion.explanation, JSON.stringify(assertion.evidence), assertion.sourceObservationId,
              assertion.generatorVersion, assertion.registryVersion, assertion.recordedAt, JSON.stringify(assertion.qualifiers ?? {}),
              qualifiersHash, `model:${assertion.generatorVersion}`]
          );
          await insertOutbox(client, batch.tenantId, "assertion_changed", assertion.id, {
            assertionId: assertion.id, repoId: batch.repository, status: assertion.status
          }, batch.generatedAt);
        }
      }
      await client.query("commit");
      const result = await this.assertionResult(
        batch.tenantId,
        batch.repository,
        batch.commitSha,
        batch.generatorVersion,
        batch.registryVersion,
        batch.evidenceFingerprint,
        observationId,
        inserted.rowCount !== 1
      );
      return { ...result, warnings: normalized.warnings };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async project(request: OntologyProjectionRequest): Promise<OntologyGraph> {
    await this.initialize();
    const guard = await this.pool.connect();
    try {
      await guard.query("begin");
      await assertRepositoryWritable(guard, request.tenantId, request.repository);
      await guard.query(RESTORE_GITHUB_ENTITY_LABELS_SQL, [request.tenantId, request.repository]);
      await guard.query("commit");
    } catch (error) {
      await guard.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      guard.release();
    }
    const commit = await this.pool.query<{ tree_sha: string; parents: string[]; source_observation_id: string }>(
      `select tree_sha,parents,source_observation_id from jina_ontology.commits
       where tenant_id=$1 and repository=$2 and sha=$3`,
      [request.tenantId, request.repository, request.commitSha]
    );
    if (!commit.rows[0]) throw new Error("cannot project an ontology before repository ingestion");
    const filesResult = await this.pool.query<{ path: string; blob_sha: string; byte_size: number }>(
      `select manifest.path,manifest.blob_sha,blob.byte_size
       from jina_ontology.commit_manifest($1,$2,$3) manifest
       join jina_ontology.blobs blob on blob.tenant_id=$1 and blob.blob_sha=manifest.blob_sha
       order by manifest.path`,
      [request.tenantId, request.repository, request.commitSha]
    );
    const analyses = await this.loadAnalyses(request.tenantId, [...new Set(filesResult.rows.map((row) => row.blob_sha))]);
    const [assertionRows, assertionFiles, redirectRows, entityRows] = await Promise.all([
      this.pool.query<StoredAssertionRow>(
      `select * from jina_ontology.assertions
       where tenant_id=$1 and repository=$2 and status='active'
       order by recorded_at,id`,
      [request.tenantId, request.repository]
      ),
      this.pool.query<{ commit_sha: string; path: string; blob_sha: string }>(
        `select candidate.commit_sha,manifest.path,manifest.blob_sha
         from (select distinct commit_sha from jina_ontology.assertions where tenant_id=$1 and repository=$2) candidate
         cross join lateral jina_ontology.commit_manifest($1,$2,candidate.commit_sha) manifest`,
        [request.tenantId, request.repository]
      ),
      this.pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge"; created_at: Date; id: string }>(
        `select from_entity_id,to_entity_id,kind,created_at,id from jina_ontology.entity_redirects
         where tenant_id=$1 order by created_at,id`, [request.tenantId]
      ),
      this.pool.query<{ id: string; kind: StoredAssertion["subject"]["kind"]; natural_key: string; display_name: string }>(
        `select id,kind,natural_key,display_name from jina_ontology.entities where tenant_id=$1`, [request.tenantId]
      )
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
    const graph = createOntologyProjection(
      snapshot,
      analyses,
      applicableAssertions(
        resolveStoredAssertionRows(assertionRows.rows, redirectRows.rows, entityRows.rows).map(storedAssertion),
        assertionFiles.rows,
        filesResult.rows
      ),
      request
    );
    await this.save(graph);
    return graph;
  }

  async executeCommand(
    tenantId: string,
    actorId: string,
    command: OntologyCommand,
    now: string,
    actorIsTenantAdmin = false
  ): Promise<OntologyCommandResult> {
    await this.initialize();
    const auditId = stableId("audit", `${tenantId}:${actorId}:${command.type}:${canonicalJson(command)}:${now}`);
    const client = await this.pool.connect();
    const affectedIds: string[] = [];
    const outboxEventIds: string[] = [];
    try {
      await client.query("begin");
      await authorizeOntologyCommand(client, tenantId, actorId, command, actorIsTenantAdmin);
      if (command.type === "review_assertion" && command.decision === "reject" && (!command.reason || !command.rejectionCode)) {
        throw new Error("assertion rejection requires a reason and rejection code");
      }
      if ("repository" in command && command.repository) {
        if (command.type === "tombstone_repository") await lockRepositoryWrite(client, tenantId, command.repository);
        else await assertRepositoryWritable(client, tenantId, command.repository);
      }
      await insertAudit(client, {
        id: auditId, tenantId, actorId, action: command.type, input: command, result: "accepted", now,
        ...("reason" in command && command.reason ? { reason: command.reason } : {})
      });
      if (command.type === "review_assertion") {
        const candidate = await client.query<{
          id: string; predicate: string; subject_id: string; object_id: string; qualifiers_hash: string; repository: string;
        }>(
          `select id,predicate,subject_id,object_id,qualifiers_hash,repository from jina_ontology.assertions
           where tenant_id=$1 and id=$2`,
          [tenantId, command.assertionId]
        );
        const pending = candidate.rows[0];
        if (!pending) throw new Error("assertion not found");
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
          id: string; status: string; predicate: string; subject_id: string; qualifiers_hash: string; repository: string;
        }>(
          `select id,status,predicate,subject_id,qualifiers_hash,repository from jina_ontology.assertions
           where tenant_id=$1 and id=$2 for update`,
          [tenantId, command.assertionId]
        );
        const assertion = selected.rows[0];
        if (!assertion) throw new Error("assertion not found");
        const allowed = command.decision === "accept" ? assertion.status === "proposed"
          : command.decision === "reject" ? assertion.status === "proposed"
            : assertion.status === "active";
        if (!allowed) throw new Error(`cannot ${command.decision} assertion in ${assertion.status}`);
        const status = command.decision === "accept" ? "active" : command.decision === "reject" ? "rejected" : "retracted";
        if (status === "active" && predicateDefinition(assertion.predicate).cardinality === "one") {
          const superseded = await client.query<{ id: string }>(
            `update jina_ontology.assertions set status='superseded',valid_to=$7,superseded_by=$6,audit_id=$8
             where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5 and status='active' and id<>$6
             returning id`,
            [tenantId, assertion.repository, assertion.subject_id, assertion.predicate, assertion.qualifiers_hash, assertion.id, now, auditId]
          );
          affectedIds.push(...superseded.rows.map((row) => row.id));
        }
        await client.query(
          `update jina_ontology.assertions set status=$3,valid_to=case when $3='retracted' then $4 else valid_to end,audit_id=$5
           where tenant_id=$1 and id=$2`,
          [tenantId, assertion.id, status, now, auditId]
        );
        affectedIds.push(assertion.id);
        for (const id of affectedIds) {
          outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", id, {
            assertionId: id, repoId: assertion.repository
          }, now));
        }
      } else if (command.type === "relate_assertions") {
        const assertions = await client.query<{ id: string; repository: string }>(
          `select id,repository from jina_ontology.assertions where tenant_id=$1 and id=any($2::text[]) for update`,
          [tenantId, [command.sourceAssertionId, command.targetAssertionId]]
        );
        if (assertions.rowCount !== 2 || command.sourceAssertionId === command.targetAssertionId) {
          throw new Error("assertion relation endpoints are invalid");
        }
        const repositories = [...new Set(assertions.rows.map((assertion) => assertion.repository))];
        if (repositories.length !== 1) throw new Error("assertion relations must stay within one repository");
        const evidence = await client.query(
          `select 1 from jina_ontology.observations
           where tenant_id=$1 and id=$2 and repository=$3 and redacted_at is null`,
          [tenantId, command.evidenceObservationId, repositories[0]]
        );
        if (evidence.rowCount !== 1) throw new Error("assertion relation evidence observation was not found");
        const relationId = stableId("assertion_relation", `${tenantId}:${command.sourceAssertionId}:${command.relation}:${command.targetAssertionId}:${command.evidenceObservationId}`);
        await client.query(
          `insert into jina_ontology.assertion_relations
            (id,tenant_id,source_assertion_id,relation,target_assertion_id,evidence_observation_id,created_at)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [relationId, tenantId, command.sourceAssertionId, command.relation, command.targetAssertionId, command.evidenceObservationId, now]
        );
        affectedIds.push(relationId, command.sourceAssertionId, command.targetAssertionId);
        for (const repository of repositories) outboxEventIds.push(await insertOutbox(
          client, tenantId, "assertion_relation_changed", relationId,
          { relationId, repoId: repository, sourceAssertionId: command.sourceAssertionId, targetAssertionId: command.targetAssertionId }, now
        ));
      } else if (command.type === "merge_entities" || command.type === "unmerge_entities") {
        const entities = await client.query<{ id: string }>(
          `select id from jina_ontology.entities where tenant_id=$1 and id=any($2::text[])`,
          [tenantId, [command.fromEntityId, command.toEntityId]]
        );
        if (entities.rowCount !== 2) throw new Error("redirect entities must exist in the authenticated tenant");
        if (command.fromEntityId === command.toEntityId) throw new Error("cannot redirect an entity to itself");
        const kind = command.type === "merge_entities" ? "merge" : "unmerge";
        if (kind === "merge") {
          const redirects = await client.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge"; created_at: Date; id: string }>(
            `select from_entity_id,to_entity_id,kind,created_at,id from jina_ontology.entity_redirects
             where tenant_id=$1 order by created_at,id`, [tenantId]
          );
          const mapping = redirectMap(redirects.rows);
          mapping.set(command.fromEntityId, command.toEntityId);
          resolveRedirect(mapping, command.fromEntityId);
        }
        const redirectId = stableId("redirect", `${tenantId}:${command.fromEntityId}:${command.toEntityId}:${kind}:${now}`);
        await client.query(
          `insert into jina_ontology.entity_redirects
            (id,tenant_id,from_entity_id,to_entity_id,kind,audit_id,created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
          [redirectId, tenantId, command.fromEntityId, command.toEntityId, kind, auditId, now]
        );
        affectedIds.push(redirectId, command.fromEntityId, command.toEntityId);
        outboxEventIds.push(await insertOutbox(client, tenantId, "redirect_added", redirectId, {
          fromEntityId: command.fromEntityId, toEntityId: command.toEntityId, kind, auditId
        }, now));
      } else if (command.type === "redact_observation") {
        const redacted = await client.query<{ repository: string | null }>(
          `update jina_ontology.observations set payload=null,redacted_at=$3,redaction_reason=$4
           where tenant_id=$1 and id=$2 and redacted_at is null returning repository`,
          [tenantId, command.observationId, now, command.reason]
        );
        if (redacted.rowCount !== 1) throw new Error("observation not found or already redacted");
        await insertErasureFilter(client, tenantId, "observation", command.observationId, auditId, now);
        if (command.commitShas?.length) {
          await client.query(
            `update jina_ontology.commits set message=null where tenant_id=$1 and sha=any($2::text[])`,
            [tenantId, command.commitShas]
          );
          for (const sha of command.commitShas) await insertErasureFilter(client, tenantId, "commit", sha, auditId, now);
        }
        const retracted = await client.query<{ id: string }>(
          `update jina_ontology.assertions set status='retracted',valid_to=$3,audit_id=$4
           where tenant_id=$1 and source_observation_id=$2 and status in ('active','proposed') returning id`,
          [tenantId, command.observationId, now, auditId]
        );
        await client.query(`delete from jina_ontology.search_documents where tenant_id=$1 and source_id=$2`, [tenantId, command.observationId]);
        affectedIds.push(command.observationId, ...retracted.rows.map((row) => row.id));
        outboxEventIds.push(await insertOutbox(client, tenantId, "observation_redacted", command.observationId, {
          observationId: command.observationId, repoId: redacted.rows[0]?.repository ?? null
        }, now));
      } else if (command.type === "erase_person") {
        const entity = await client.query<{ id: string }>(
          `select id from jina_ontology.entities where tenant_id=$1 and id=$2 and kind='Engineer' for update`,
          [tenantId, command.entityId]
        );
        if (entity.rowCount !== 1) throw new Error("engineer entity not found");
        const identities = await client.query<{ id: string; external_id: string }>(
          `update jina_ontology.identities set status='erased'
           where tenant_id=$1 and entity_id=$2 and status<>'erased' returning id,external_id`,
          [tenantId, command.entityId]
        );
        await client.query(`update jina_ontology.entities set retired_at=$3 where tenant_id=$1 and id=$2`, [tenantId, command.entityId, now]);
        const externalIds = identities.rows.map((identity) => identity.external_id);
        const personalObservationIds: string[] = [];
        if (externalIds.length) {
          await client.query(`update jina_ontology.commits set author_external_id=null where tenant_id=$1 and author_external_id=any($2::text[])`, [tenantId, externalIds]);
          for (const externalId of externalIds) await insertErasureFilter(client, tenantId, "identity", externalId, auditId, now);
          const personalObservations = await client.query<{ id: string; repository: string | null }>(
            `select id,repository from jina_ontology.observations
             where tenant_id=$1 and redacted_at is null and payload is not null
               and exists (select 1 from unnest($2::text[]) value where payload::text ilike '%' || value || '%')`,
            [tenantId, externalIds]
          );
          if (personalObservations.rows.length) {
            personalObservationIds.push(...personalObservations.rows.map((row) => row.id));
            await client.query(
              `update jina_ontology.observations set payload=null,redacted_at=$3,redaction_reason=$4
               where tenant_id=$1 and id=any($2::text[])`,
              [tenantId, personalObservations.rows.map((row) => row.id), now, command.reason]
            );
            for (const observation of personalObservations.rows) {
              await insertErasureFilter(client, tenantId, "observation", observation.id, auditId, now);
              outboxEventIds.push(await insertOutbox(client, tenantId, "observation_redacted", observation.id, {
                observationId: observation.id, repoId: observation.repository
              }, now));
            }
          }
        }
        const retracted = await client.query<{ id: string; repository: string }>(
          `update jina_ontology.assertions set status='retracted',valid_to=$4,audit_id=$5
           where tenant_id=$1
             and (subject_id=$2 or object_id=$2 or source_observation_id=any($3::text[]))
             and status in ('active','proposed') returning id,repository`,
          [tenantId, command.entityId, personalObservationIds, now, auditId]
        );
        await client.query(`delete from jina_ontology.search_documents where tenant_id=$1 and source_id=$2`, [tenantId, command.entityId]);
        affectedIds.push(command.entityId, ...identities.rows.map((identity) => identity.id), ...retracted.rows.map((row) => row.id));
        for (const id of identities.rows.map((identity) => identity.id)) {
          outboxEventIds.push(await insertOutbox(client, tenantId, "identity_changed", id, { identityId: id }, now));
        }
        for (const assertion of retracted.rows) {
          outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", assertion.id, {
            assertionId: assertion.id, repoId: assertion.repository || null, status: "retracted"
          }, now));
        }
        outboxEventIds.push(await insertOutbox(client, tenantId, "entity_changed", command.entityId, { entityId: command.entityId }, now));
      } else if (command.type === "tombstone_repository") {
        const tombstoneId = stableId("observation", `${tenantId}:tombstone:${command.repository}:${now}`);
        await client.query(
          `insert into jina_ontology.observations
            (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
           values ($1,$2,'internal:command','tombstone',$3,$3,$4,$5::jsonb,$6)`,
          [tombstoneId, tenantId, command.repository, now, JSON.stringify({ repository: command.repository, reason: command.reason }), stableId("sha", command.reason)]
        );
        await insertErasureFilter(client, tenantId, "repository", command.repository, auditId, now);
        const retracted = await client.query<{ id: string }>(
          `update jina_ontology.assertions set status='retracted',valid_to=$3,audit_id=$4
           where tenant_id=$1 and repository=$2 and status in ('active','proposed') returning id`,
          [tenantId, command.repository, now, auditId]
        );
        await client.query(`update jina_ontology.entities set retired_at=$3 where tenant_id=$1 and natural_key like $2`, [tenantId, `%${command.repository}%`, now]);
        await deleteCodePlaneRepository(client, tenantId, command.repository);
        await client.query(`delete from jina_ontology.search_documents where tenant_id=$1 and repository=$2`, [tenantId, command.repository]);
        affectedIds.push(tombstoneId, ...retracted.rows.map((row) => row.id));
        outboxEventIds.push(await insertOutbox(client, tenantId, "tombstone", tombstoneId, { scope: { repository: command.repository } }, now));
      } else if (command.type === "grant_repository_access") {
        await client.query(
          `insert into jina_ontology.repository_acl (tenant_id,repository,principal_id,role,created_at)
           values ($1,$2,$3,$4,$5) on conflict (tenant_id,repository,principal_id) do update set role=excluded.role`,
          [tenantId, command.repository, command.principalId, command.role, now]
        );
        affectedIds.push(`${command.repository}:${command.principalId}`);
      } else if (command.type === "assign_relationship") {
        const definition = predicateDefinition(command.predicate);
        const repositoryScope = command.repository ?? "";
        validatePredicateEndpoints(definition, command.subject.kind, command.object.kind);
        validateQualifiers(definition, command.qualifiers);
        const subjectId = await ensureEntity(client, tenantId, {
          kind: command.subject.kind, naturalKey: command.subject.key, label: command.subject.displayName ?? command.subject.key
        }, now);
        const objectId = await ensureEntity(client, tenantId, {
          kind: command.object.kind, naturalKey: command.object.key, label: command.object.displayName ?? command.object.key
        }, now);
        const qualifiers = command.qualifiers ?? {};
        const qualifiersHash = stableId("q", canonicalJson(qualifiers));
        const assertionId = stableId("assertion", `${tenantId}:${repositoryScope}:${subjectId}:${definition.name}:${objectId}:${qualifiersHash}:${now}`);
        await lockAssertionNaturalKey(
          client, tenantId, repositoryScope, subjectId, definition.name, objectId, qualifiersHash, definition.cardinality
        );
        const existingLive = await findLiveAssertionByNaturalKey(
          client, tenantId, repositoryScope, subjectId, definition.name, objectId, qualifiersHash
        );
        if (existingLive) {
          if (definition.cardinality === "one") {
            const superseded = await client.query<{ id: string }>(
              `update jina_ontology.assertions set status='superseded',valid_to=$6,superseded_by=$7,audit_id=$8
               where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                 and status='active' and id<>$7 returning id`,
              [tenantId, repositoryScope, subjectId, definition.name, qualifiersHash, now, existingLive.id, auditId]
            );
            affectedIds.push(...superseded.rows.map((row) => row.id));
            for (const row of superseded.rows) {
              outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", row.id, {
                assertionId: row.id, repoId: command.repository ?? null, status: "superseded"
              }, now));
            }
          }
          await client.query(
            `update jina_ontology.assertions
             set status='active',last_confirmed_at=greatest(last_confirmed_at,$3),audit_id=$4,
                 explanation=coalesce(explanation,$5)
             where tenant_id=$1 and id=$2`,
            [tenantId, existingLive.id, now, auditId, command.reason]
          );
          affectedIds.push(existingLive.id);
          outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", existingLive.id, {
            assertionId: existingLive.id, repoId: command.repository ?? null, status: "active"
          }, now));
        } else {
          await client.query(
            `insert into jina_ontology.assertions
              (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
               object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,asserted_by,generator_version,
               registry_version,recorded_at,qualifiers,qualifiers_hash,last_confirmed_at,audit_id)
             values ($1,$2,$3,'command',$4,$5,$6,$7,$8,$9,$10,$11,$12,$19,1,$20,'[]'::jsonb,$13,'command',$14,$15,$16::jsonb,$17,$15,$18)`,
            [assertionId, tenantId, repositoryScope, subjectId, command.subject.kind, command.subject.key,
              command.subject.displayName ?? command.subject.key, definition.name, objectId, command.object.kind, command.object.key,
              command.object.displayName ?? command.object.key, actorId, ONTOLOGY_REGISTRY_VERSION, now,
              JSON.stringify(qualifiers), qualifiersHash, auditId, definition.cardinality === "one" ? "proposed" : "active", command.reason]
          );
          affectedIds.push(assertionId);
          if (definition.cardinality === "one") {
            const superseded = await client.query<{ id: string }>(
              `update jina_ontology.assertions set status='superseded',valid_to=$6,superseded_by=$7,audit_id=$8
               where tenant_id=$1 and repository=$2 and subject_id=$3 and predicate=$4 and qualifiers_hash=$5
                 and status='active' and id<>$7 returning id`,
              [tenantId, repositoryScope, subjectId, definition.name, qualifiersHash, now, assertionId, auditId]
            );
            affectedIds.push(...superseded.rows.map((row) => row.id));
            for (const row of superseded.rows) {
              outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", row.id, {
                assertionId: row.id, repoId: command.repository ?? null, status: "superseded"
              }, now));
            }
            await client.query(
              `update jina_ontology.assertions set status='active' where tenant_id=$1 and id=$2`,
              [tenantId, assertionId]
            );
          }
          outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", assertionId, {
            assertionId, repoId: command.repository ?? null, status: "active"
          }, now));
        }
      }
      await client.query("commit");
      return { auditId, action: command.type, affectedIds, outboxEventIds };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      await this.pool.query(
        `insert into jina_ontology.audit_log (id,tenant_id,actor_id,action,input,result,reason,created_at)
         values ($1,$2,$3,$4,$5::jsonb,'rejected',$6,$7) on conflict do nothing`,
        [auditId, tenantId, actorId, command.type, JSON.stringify(command), error instanceof Error ? error.message : String(error), now]
      ).catch(() => undefined);
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
      await assertRepositoryWritable(client, tenantId, repository);
      if (consumers.length === 3) await client.query(RESTORE_GITHUB_ENTITY_LABELS_SQL, [tenantId, repository]);
      const claimToken = `projection:${repository}:${randomUUID()}`;
      const claimed = await client.query<{ id: string; event_type: string; consumer: string; payload: Record<string, unknown> }>(
        `with candidates as (
           select id from jina_ontology.outbox
         where tenant_id=$1 and processed_at is null and available_at<=now()
             and (claim_expires_at is null or claim_expires_at<now())
             and (consumer='legacy' or consumer=any($5::text[]))
             and coalesce(payload->>'repoId',payload#>>'{scope,repository}')=$3
             and payload->>'refName'=$4
           order by created_at,id for update skip locked limit 1000
         )
         update jina_ontology.outbox o set claimed_by=$6,claimed_at=$2,claim_expires_at=$2::timestamptz+interval '15 minutes',attempts=o.attempts+1
         from candidates where o.id=candidates.id returning o.id,o.event_type,o.consumer,o.payload`,
        [tenantId, now, repository, ref, consumers, claimToken]
      );
      const head = await client.query<{ commit_sha: string }>(
        `select commit_sha from jina_ontology.refs where tenant_id=$1 and repository=$2 and ref_name=$3`,
        [tenantId, repository, ref]
      );
      const commitSha = head.rows[0]?.commit_sha;
      if (!commitSha) throw new Error("repository ref has not been ingested");
      if (claimed.rows.length === 0 && !force) {
        const existing = await client.query<{ manifest_count: string; search_count: string }>(
          `select
             (select count(*) from jina_ontology.ref_manifest
              where tenant_id=$1 and repository=$2 and ref_name=$3 and commit_sha=$4) as manifest_count,
             (select count(*) from jina_ontology.search_documents
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
        await client.query(`delete from jina_ontology.ref_manifest where tenant_id=$1 and repository=$2 and ref_name=$3`, [tenantId, repository, ref]);
        const manifest = await client.query(
          `insert into jina_ontology.ref_manifest (tenant_id,repository,ref_name,commit_sha,path,blob_sha,projected_at)
           select $1,$2,$3,$4,path,blob_sha,$5
           from jina_ontology.commit_manifest($1,$2,$4)`,
          [tenantId, repository, ref, commitSha, now]
        );
        manifestFileCount = manifest.rowCount ?? 0;
      } else {
        manifestFileCount = 0;
      }

      let searchDocumentCount = 0;
      if (consumers.includes("search")) {
        await client.query(`delete from jina_ontology.search_documents where tenant_id=$1 and repository=$2`, [tenantId, repository]);
        const documents = await client.query<{ id: string; title: string; body: string; source_kind: string }>(
        `select id,source || ':' || type as title,coalesce(payload::text,'') as body,'observation' as source_kind
         from jina_ontology.observations where tenant_id=$1 and repository=$2 and redacted_at is null
         union all
         select distinct e.id,e.display_name as title,e.natural_key as body,'entity' as source_kind
         from jina_ontology.entities e
         where e.tenant_id=$1 and e.retired_at is null and (
           e.natural_key='github:repo:' || $2 or
           starts_with(e.natural_key,'repo:' || $2 || ':') or
           starts_with(e.natural_key,'github:pr:' || $2 || '#') or
           starts_with(e.natural_key,'github:issue:' || $2 || '#') or
           exists (
             select 1 from jina_ontology.assertions a
             where a.tenant_id=$1 and a.repository=$2 and (a.subject_id=e.id or a.object_id=e.id)
           )
         )`,
        [tenantId, repository]
        );
        const searchRedirects = await client.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
        `select from_entity_id,to_entity_id,kind from jina_ontology.entity_redirects
         where tenant_id=$1 order by created_at,id`, [tenantId]
      );
        const searchRedirectMap = redirectMap(searchRedirects.rows);
        for (const document of documents.rows) {
          if (document.source_kind === "entity" && resolveRedirect(searchRedirectMap, document.id) !== document.id) continue;
          await client.query(
          `insert into jina_ontology.search_documents
            (id,tenant_id,repository,source_kind,source_id,title,body,embedding,projected_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [stableId("search", `${tenantId}:${repository}:${document.source_kind}:${document.id}`), tenantId, repository,
            document.source_kind, document.id, document.title, document.body, embeddingForText(`${document.title} ${document.body}`), now]
          );
          searchDocumentCount += 1;
        }
      } else {
        searchDocumentCount = 0;
      }
      const reconciledAssertionCount = consumers.includes("reconciliation")
        ? await reconcileRedirectCollisions(client, tenantId, now)
        : 0;
      if (consumers.length === 3) {
        await garbageCollectCodePlane(client, tenantId, now, 90);
        await purgeRejectedModelPayloads(client, tenantId, now, 30);
        await client.query(
          `delete from jina_ontology.retrieval_metrics where tenant_id=$1 and recorded_at<$2::timestamptz-interval '30 days'`,
          [tenantId, now]
        );
      }
      if (claimed.rows.length) {
        await client.query(
          `update jina_ontology.outbox set processed_at=$2,claimed_by=null,claimed_at=null,claim_expires_at=null
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

  async drainDerivedProjectionEvents(
    tenantId: string,
    now: string
  ): Promise<{ readonly processedEventCount: number; readonly rebuiltRepositories: readonly string[] }> {
    await this.initialize();
    const rebuiltRepositories = new Set<string>();
    let processedEventCount = 0;
    const consumers = ["legacy", "manifest", "search", "reconciliation", "graph"] as const;
    for (const consumer of consumers) {
      const claimOwner = `projection:${consumer}:${randomUUID()}`;
      const claimed = await this.pool.query<{ id: string; repository: string | null }>(
        `with candidates as (
           select id,coalesce(payload->>'repoId',payload#>>'{scope,repository}') as repository
           from jina_ontology.outbox
           where tenant_id=$1 and consumer=$3 and processed_at is null and available_at<=now()
             and (claim_expires_at is null or claim_expires_at<now())
           order by created_at,id for update skip locked limit 10000
         )
         update jina_ontology.outbox o
         set claimed_by=$4,claimed_at=$2,claim_expires_at=$2::timestamptz+interval '15 minutes',attempts=o.attempts+1
         from candidates where o.id=candidates.id returning o.id,candidates.repository`,
        [tenantId, now, consumer, claimOwner]
      );
      if (claimed.rows.length === 0) continue;
      const ids = claimed.rows.map((row) => row.id);
      const affectedRepositories = new Set(claimed.rows.flatMap((row) => row.repository ? [row.repository] : []));
      if (claimed.rows.some((row) => row.repository === null)) {
        const all = await this.pool.query<{ repository: string }>(
          `select distinct repository from jina_ontology.refs where tenant_id=$1`, [tenantId]
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
          const refs = await this.pool.query<{ ref_name: string; commit_sha: string }>(
            `select ref_name,commit_sha from jina_ontology.refs
             where tenant_id=$1 and repository=$2 order by is_default desc,ref_name`,
            [tenantId, repository]
          );
          if (refs.rows.length === 0) continue;
          if (consumer === "search") {
            await this.rebuildDerivedProjections(tenantId, repository, refs.rows[0]!.ref_name, now, true, ["search"]);
          } else if (consumer === "manifest") {
            for (const row of refs.rows) {
              await this.rebuildDerivedProjections(tenantId, repository, row.ref_name, now, true, ["manifest"]);
            }
          } else if (consumer === "legacy") {
            for (const row of refs.rows) {
              await this.rebuildDerivedProjections(tenantId, repository, row.ref_name, now, true);
              await this.project({
                tenantId, repository, ref: row.ref_name, commitSha: row.commit_sha,
                taskId: `projection-drain:${stableId("scope", `${tenantId}:${repository}:${row.ref_name}:${now}:legacy`)}`,
                generatedAt: now
              });
            }
          } else if (consumer === "graph") {
            for (const row of refs.rows) {
              await this.project({
                tenantId, repository, ref: row.ref_name, commitSha: row.commit_sha,
                taskId: `projection-drain:${stableId("scope", `${tenantId}:${repository}:${row.ref_name}:${now}:graph`)}`,
                generatedAt: now
              });
            }
          }
          rebuiltRepositories.add(repository);
        }
        const acknowledged = await this.pool.query(
          `update jina_ontology.outbox
           set processed_at=$2,claimed_by=null,claimed_at=null,claim_expires_at=null,last_error=null
           where id=any($1::text[]) and claimed_by=$3`,
          [ids, now, claimOwner]
        );
        processedEventCount += acknowledged.rowCount ?? 0;
      } catch (error) {
        await this.pool.query(
          `update jina_ontology.outbox
           set claimed_by=null,claimed_at=null,claim_expires_at=null,last_error=$2,available_at=now()+interval '30 seconds'
           where id=any($1::text[]) and claimed_by=$3`,
          [ids, error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000), claimOwner]
        ).catch(() => undefined);
        throw error;
      }
    }
    return { processedEventCount, rebuiltRepositories: [...rebuiltRepositories].sort() };
  }

  async operationalMetrics(tenantId: string, now: string): Promise<OntologyOperationalMetrics> {
    await this.initialize();
    const [outbox, backlog, parsed, proposed, unexplained, erasure, freshness, labels, retrieval] = await Promise.all([
      this.pool.query<{ event_type: string; consumer: string; count: string; oldest: Date | null }>(
        `select event_type,consumer,count(*),min(created_at) as oldest from jina_ontology.outbox
         where tenant_id=$1 and processed_at is null group by event_type,consumer`, [tenantId]
      ),
      this.pool.query<{ count: string }>(
        `select count(distinct (b.blob_sha,b.tenant_id)) from jina_ontology.blobs b
         left join jina_ontology.blob_analyses a on a.tenant_id=b.tenant_id and a.blob_sha=b.blob_sha and a.parser_version=$2
         where b.tenant_id=$1 and a.blob_sha is null`, [tenantId, ONTOLOGY_PARSER_VERSION]
      ),
      this.pool.query<{ count: string }>(
        `select count(*) from jina_ontology.blob_analyses where tenant_id=$1 and parsed_at>=now()-interval '1 hour'`, [tenantId]
      ),
      this.pool.query<{ count: string }>(`select count(*) from jina_ontology.assertions where tenant_id=$1 and status='proposed'`, [tenantId]),
      this.pool.query<{ count: string }>(`select count(*) from jina_ontology.assertions where tenant_id=$1 and explanation is null`, [tenantId]),
      this.pool.query<{ count: string }>(
        `select count(distinct (event_type,aggregate_id)) from jina_ontology.outbox
         where tenant_id=$1 and processed_at is null and event_type in ('observation_redacted','tombstone')`, [tenantId]
      ),
      this.pool.query<{ manifest: Date | null; search: Date | null }>(
        `select (select max(projected_at) from jina_ontology.ref_manifest where tenant_id=$1) as manifest,
                (select max(projected_at) from jina_ontology.search_documents where tenant_id=$1) as search`, [tenantId]
      ),
      this.pool.query<{ generator: string; predicate: string; accepted: string; rejected: string }>(
        `select a.generator,a.predicate,
          count(*) filter (where l.action='review_assertion' and l.input->>'decision'='accept') as accepted,
          count(*) filter (where l.action='review_assertion' and l.input->>'decision' in ('reject','retract')) as rejected
         from jina_ontology.audit_log l
         join jina_ontology.assertions a on a.id=l.input->>'assertionId'
         where l.tenant_id=$1 and a.generator is not null group by a.generator,a.predicate`, [tenantId]
      ),
      this.pool.query<{ template: string; requests: string; average: string; p95: string; truncated: string }>(
        `select template,count(*) as requests,avg(duration_ms) as average,
                percentile_cont(0.95) within group (order by duration_ms) as p95,
                avg(case when truncated then 1.0 else 0.0 end) as truncated
         from jina_ontology.retrieval_metrics
         where tenant_id=$1 and recorded_at>=now()-interval '24 hours'
         group by template order by template`, [tenantId]
      )
    ]);
    const nowMs = new Date(now).getTime();
    const oldest = outbox.rows.flatMap((row) => row.oldest ? [row.oldest.getTime()] : []).sort((a, b) => a - b)[0];
    const manifest = freshness.rows[0]?.manifest?.getTime();
    const search = freshness.rows[0]?.search?.getTime();
    return {
      outboxDepth: Object.fromEntries([...new Set(outbox.rows.map((row) => row.event_type))].map((eventType) => [
        eventType, outbox.rows.filter((row) => row.event_type === eventType).reduce((sum, row) => sum + Number(row.count), 0)
      ])),
      outboxDepthByConsumer: Object.fromEntries([...new Set(outbox.rows.map((row) => row.consumer))].map((consumer) => [
        consumer, outbox.rows.filter((row) => row.consumer === consumer).reduce((sum, row) => sum + Number(row.count), 0)
      ])),
      oldestOutboxAgeSeconds: oldest ? Math.max(0, (nowMs - oldest) / 1000) : 0,
      reconciliationLagSeconds: (() => {
        const timestamp = outbox.rows.filter((row) => row.consumer === "reconciliation" && row.oldest)
          .map((row) => row.oldest!.getTime()).sort((a, b) => a - b)[0];
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
        template: row.template, requests: Number(row.requests), averageLatencyMs: Number(row.average),
        p95LatencyMs: Number(row.p95), truncationRate: Number(row.truncated)
      })),
      acceptanceRates: labels.rows.map((row) => {
        const accepted = Number(row.accepted);
        const rejected = Number(row.rejected);
        return { generator: row.generator, predicate: row.predicate, accepted, rejected, rate: accepted / Math.max(1, accepted + rejected) };
      })
    };
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<readonly string[]> {
    await this.initialize();
    const result = principalId.startsWith("svc:")
      ? await this.pool.query<{ repository: string }>(
          `select distinct repository from jina_ontology.refs where tenant_id=$1 order by repository`, [tenantId]
        )
      : await this.pool.query<{ repository: string }>(
          `select repository from jina_ontology.repository_acl where tenant_id=$1 and principal_id=$2 order by repository`,
          [tenantId, principalId]
        );
    return result.rows.map((row) => row.repository);
  }

  async listAssertions(
    tenantId: string,
    repository: string,
    filter: { readonly status?: StoredAssertion["status"]; readonly predicate?: string; readonly entityKind?: OntologyNode["kind"] } = {}
  ): Promise<readonly OntologyAssertionSummary[]> {
    await this.initialize();
    const result = await this.pool.query<{
      id: string; repository: string; commit_sha: string; subject_id: string; subject_kind: OntologyAssertionSummary["subjectKind"];
      subject_natural_key: string; subject_label: string; predicate: string;
      object_id: string; object_kind: OntologyAssertionSummary["objectKind"]; object_natural_key: string; object_label: string;
      status: OntologyAssertionSummary["status"]; confidence: number | null; explanation: string | null; evidence: string[];
      source_observation_id: string | null;
      qualifiers: Record<string, string | number | boolean>; generator: string; registry_version: string;
    }>(
      `select id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
              object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,source_observation_id,
              qualifiers,coalesce(generator,'unknown') as generator,registry_version
       from jina_ontology.assertions
       where tenant_id=$1 and repository=$2
         and ($3::text is null or status=$3)
         and ($4::text is null or predicate=$4)
         and ($5::text is null or subject_kind=$5 or object_kind=$5)
       order by recorded_at desc,id limit 500`,
      [tenantId, repository, filter.status ?? null, filter.predicate ?? null, filter.entityKind ?? null]
    );
    const [redirects, entities, relations] = await Promise.all([
      this.pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
        `select from_entity_id,to_entity_id,kind from jina_ontology.entity_redirects where tenant_id=$1 order by created_at,id`, [tenantId]
      ),
      this.pool.query<{ id: string; kind: OntologyAssertionSummary["subjectKind"]; natural_key: string; display_name: string }>(
        `select id,kind,natural_key,display_name from jina_ontology.entities where tenant_id=$1`, [tenantId]
      ),
      result.rows.length === 0
        ? Promise.resolve({ rows: [] as { source_assertion_id: string; relation: "supports" | "contradicts"; target_assertion_id: string }[] })
        : this.pool.query<{ source_assertion_id: string; relation: "supports" | "contradicts"; target_assertion_id: string }>(
            `select source_assertion_id,relation,target_assertion_id from jina_ontology.assertion_relations
             where tenant_id=$1 and target_assertion_id=any($2::text[])`, [tenantId, result.rows.map((row) => row.id)]
          )
    ]);
    const mapping = redirectMap(redirects.rows);
    const byId = new Map(entities.rows.map((entity) => [entity.id, entity]));
    return result.rows.map((row) => {
      const subject = byId.get(resolveRedirect(mapping, row.subject_id));
      const object = byId.get(resolveRedirect(mapping, row.object_id));
      return ({
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
      evidence: row.evidence.length > 0
        ? row.evidence
        : row.source_observation_id ? [`observation:${row.source_observation_id}`] : [],
      qualifiers: row.qualifiers,
      generator: row.generator,
      registryVersion: row.registry_version,
      supportingAssertionIds: relations.rows.filter((relation) => relation.target_assertion_id === row.id && relation.relation === "supports")
        .map((relation) => relation.source_assertion_id),
      contradictingAssertionIds: relations.rows.filter((relation) => relation.target_assertion_id === row.id && relation.relation === "contradicts")
        .map((relation) => relation.source_assertion_id)
      });
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
      `select ref_name,commit_sha from jina_ontology.refs
       where tenant_id=$1 and repository=$2 and ($3::text is null or ref_name=$3)
       order by case when ref_name=$3 then 0 when is_default then 1 else 2 end,updated_at desc limit 1`,
      [request.tenantId, request.repository, request.ref ?? null]
    );
    const ref = refResult.rows[0];
    if (!ref) throw new Error("repository ref not found");
    const items = request.template === "causal_trace" || request.template === "counterfactual"
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
    const permitted = items.filter((item) => item.citations.every((citation) => request.allowedRepositories.includes(citation.repository)));
    const result = {
      template: request.template, repository: request.repository, ref: ref.ref_name,
      items: permitted.slice(0, limit), truncated: permitted.length > limit,
      totalBeforeLimit: permitted.length, limit
    };
    await this.pool.query(
      `insert into jina_ontology.retrieval_metrics (tenant_id,repository,template,duration_ms,truncated,recorded_at)
       values ($1,$2,$3,$4,$5,now())`,
      [request.tenantId, request.repository, request.template, Math.max(0, performance.now() - startedAt), result.truncated]
    );
    return result;
  }

  async migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void> {
    const distinct = [...new Set(aliases.filter((alias) => alias && alias !== tenantId))];
    if (distinct.length === 0) return;
    await this.initialize();
    await this.pool.query(
      "update jina_ontology.graphs set tenant_id = $1 where tenant_id = any($2::text[])",
      [tenantId, distinct]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async retrieveCausalTrace(request: RetrievalRequest, ref: string, commitSha: string): Promise<readonly RetrievalItem[]> {
    const graph = await this.pool.query<GraphRow>(
      `select graph.* from jina_ontology.graph_heads head
       join jina_ontology.graphs graph on graph.id=head.graph_id
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
  ): Promise<OntologyAssertionResult> {
    const modelOutput = await this.pool.query<{ payload: OntologyAssertionBatch }>(
      `select payload from jina_ontology.observations
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
      subject_kind: OntologyNode["kind"];
      subject_natural_key: string;
      predicate: string;
      object_kind: OntologyNode["kind"];
      object_natural_key: string;
      qualifiers: Readonly<Record<string, string | number | boolean>>;
    }>(
      `select status,subject_kind,subject_natural_key,predicate,object_kind,object_natural_key,qualifiers
       from jina_ontology.assertions where tenant_id=$1 and repository=$2
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

  private async loadAnalyses(tenantId: string, blobShas: readonly string[]): Promise<ReadonlyMap<string, BlobAnalysis>> {
    const analyses = new Map<string, BlobAnalysis>();
    if (blobShas.length === 0) return analyses;
    const [rows, symbols, imports, edges] = await Promise.all([
      this.pool.query<{ blob_sha: string; parser_version: string; language: string | null }>(
        `select blob_sha,parser_version,language from jina_ontology.blob_analyses
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, ONTOLOGY_PARSER_VERSION]
      ),
      this.pool.query<BlobSymbolRow>(
        `select blob_sha,parser_version,moniker,name,kind,signature_hash,start_line,end_line from jina_ontology.blob_symbols
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, ONTOLOGY_PARSER_VERSION]
      ),
      this.pool.query<{ blob_sha: string; parser_version: string; specifier: string; line: number }>(
        `select blob_sha,parser_version,specifier,line from jina_ontology.blob_imports
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, ONTOLOGY_PARSER_VERSION]
      ),
      this.pool.query<{ blob_sha: string; from_moniker: string; kind: "calls" | "imports" | "references" | "extends"; to_moniker: string; start_line: number; end_line: number }>(
        `select blob_sha,from_moniker,kind,to_moniker,start_line,end_line from jina_ontology.symbol_edges
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, ONTOLOGY_PARSER_VERSION]
      )
    ]);
    for (const row of rows.rows) {
      analyses.set(`${tenantId}:${row.blob_sha}:${row.parser_version}`, {
        blobSha: row.blob_sha,
        parserVersion: row.parser_version,
        ...(row.language ? { language: row.language } : {}),
        symbols: symbols.rows.filter((symbol) => symbol.blob_sha === row.blob_sha).map((symbol) => ({
          moniker: symbol.moniker,
          name: symbol.name,
          kind: symbol.kind,
          signatureHash: symbol.signature_hash,
          startLine: symbol.start_line,
          endLine: symbol.end_line
        })),
        imports: imports.rows.filter((item) => item.blob_sha === row.blob_sha).map((item) => ({ specifier: item.specifier, line: item.line })),
        edges: edges.rows.filter((edge) => edge.blob_sha === row.blob_sha).map((edge) => ({
          fromMoniker: edge.from_moniker, kind: edge.kind, toMoniker: edge.to_moniker,
          startLine: edge.start_line, endLine: edge.end_line
        }))
      });
    }
    return analyses;
  }

  private async loadGraphs(tenantId: string, limit: number): Promise<readonly OntologyGraph[]> {
    await this.initialize();
    const result = await this.pool.query<GraphRow>(
      "select * from jina_ontology.graphs where tenant_id = $1 order by generated_at desc limit $2",
      [tenantId, limit]
    );
    return Promise.all(result.rows.map((row) => this.hydrate(row)));
  }

  private async hydrate(row: GraphRow): Promise<OntologyGraph> {
    const [nodes, edges] = await Promise.all([
      this.pool.query<NodeRow>("select * from jina_ontology.nodes where graph_id = $1 order by node_id", [row.id]),
      this.pool.query<EdgeRow>("select * from jina_ontology.edges where graph_id = $1 order by edge_id", [row.id])
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
    await this.pool.query(ONTOLOGY_SCHEMA_SQL);
  }
}

export async function insertOntologyGraph(client: PoolClient, graph: OntologyGraph): Promise<void> {
  const inserted = await client.query(
    `insert into jina_ontology.graphs
      (id, tenant_id, repository, ref, commit_sha, generated_at, executor, model, sandbox_id, summary)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do nothing
     returning id`,
    [graph.id, graph.tenantId, graph.repository, graph.ref, graph.commitSha, graph.generatedAt,
      graph.generator.executor, graph.generator.model, graph.generator.sandboxId ?? null, graph.summary]
  );
  if (inserted.rowCount !== 1) return;
  for (const node of graph.nodes) {
    await client.query(
      `insert into jina_ontology.nodes
        (graph_id,node_id,kind,label,description,path,evidence) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [graph.id, node.id, node.kind, node.label, node.description, node.path ?? null, JSON.stringify(node.evidence)]
    );
  }
  for (const edge of graph.edges) {
    await client.query(
      `insert into jina_ontology.edges
        (graph_id,edge_id,source_node_id,target_node_id,predicate,plane,confidence,why,qualifiers,evidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
      [graph.id, edge.id, edge.source, edge.target, edge.predicate, edge.plane,
        edge.confidence ?? null, edge.why ?? null, JSON.stringify(edge.qualifiers ?? {}), JSON.stringify(edge.evidence)]
    );
  }
}

function repositoryObservationScope(observation: RepositorySourceObservation): { readonly field: string | null; readonly value: string } {
  if (observation.kind === "pull_request" || observation.kind === "issue") return { field: "number", value: String(observation.number) };
  if (observation.kind === "package_manifest") return { field: "path", value: observation.path };
  if (observation.kind === "move_candidate") return { field: "commitSha", value: observation.commitSha };
  if (observation.kind === "service_definition" || observation.kind === "deployment" || observation.kind === "incident") {
    return { field: "externalId", value: observation.externalId };
  }
  return { field: null, value: "" };
}

async function isLatestGitHubWorkItemObservation(
  client: PoolClient,
  observation: GitHubWorkItemObservation,
  observationId: string
): Promise<boolean> {
  const result = await client.query<{ is_latest: boolean }>(
    `select not exists (
       select 1 from jina_ontology.observations o
       where o.tenant_id=$1 and o.repository=$2 and o.source='github' and o.id<>$3
         and o.payload->>'kind'=$4 and o.payload->>'number'=$5
         and (coalesce(o.occurred_at,o.recorded_at),o.recorded_at,o.id) >
             (coalesce($6::timestamptz,$7::timestamptz),$7::timestamptz,$3)
     ) as is_latest`,
    [observation.tenantId, observation.repository, observationId, observation.kind, String(observation.number),
      observation.occurredAt ?? null, observation.recordedAt]
  );
  return result.rows[0]?.is_latest === true;
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
    `insert into jina_ontology.entities (id,tenant_id,kind,natural_key,display_name)
     values ($1,$2,$3,$4,$5)
     on conflict do nothing returning id`,
    [id, tenantId, entity.kind, entity.naturalKey, entity.label]
  );
  const created = inserted.rows[0]?.id !== undefined;
  const existing = created
    ? inserted
    : await client.query<{ id: string }>(
        `select id from jina_ontology.entities
         where tenant_id=$1 and kind=$2 and natural_key=$3`,
        [tenantId, entity.kind, entity.naturalKey]
      );
  const resolvedId = existing.rows[0]?.id;
  if (!resolvedId) throw new Error("entity id collision");
  if (!created && updateExisting) {
    await client.query(`update jina_ontology.entities set display_name=$2 where id=$1`, [resolvedId, entity.label]);
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
    `insert into jina_ontology.identities
      (id,tenant_id,source,external_id,entity_id,status,confidence,source_observation_id,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id,source,external_id,entity_id) do nothing returning id`,
    [id, tenantId, source, externalId, entityId, status, status === "accepted" ? 1 : null, observationId, now]
  );
  if (emitEvent && inserted.rowCount === 1) await insertOutbox(client, tenantId, "identity_changed", id, { identityId: id }, now);
  return id;
}

async function authorizeOntologyCommand(
  client: PoolClient,
  tenantId: string,
  actorId: string,
  command: OntologyCommand,
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
      `select repository from jina_ontology.assertions where tenant_id=$1 and id=$2`,
      [tenantId, command.assertionId]
    );
    repository = result.rows[0]?.repository;
  } else if (command.type === "relate_assertions") {
    const result = await client.query<{ repository: string }>(
      `select distinct repository from jina_ontology.assertions where tenant_id=$1 and id=any($2::text[])`,
      [tenantId, [command.sourceAssertionId, command.targetAssertionId]]
    );
    if (result.rowCount !== 1) throw new Error("assertion relations must stay within one authorized repository");
    repository = result.rows[0]?.repository;
  } else if (command.type === "redact_observation") {
    const result = await client.query<{ repository: string | null }>(
      `select repository from jina_ontology.observations where tenant_id=$1 and id=$2`,
      [tenantId, command.observationId]
    );
    repository = result.rows[0]?.repository ?? undefined;
  } else {
    repository = "repository" in command ? command.repository : undefined;
    requiresAdmin = command.type === "grant_repository_access" || command.type === "tombstone_repository";
  }
  if (!repository) throw new DomainError("ontology command access denied", "forbidden");
  const access = await client.query<{ role: "reader" | "writer" | "admin" }>(
    `select role from jina_ontology.repository_acl
     where tenant_id=$1 and repository=$2 and principal_id=$3`,
    [tenantId, repository, actorId]
  );
  const role = access.rows[0]?.role;
  if (!role || role === "reader" || (requiresAdmin && role !== "admin")) {
    throw new DomainError("ontology command access denied", "forbidden");
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
  entities: readonly { id: string; kind: StoredAssertion["subject"]["kind"]; natural_key: string; display_name: string }[]
): readonly StoredAssertionRow[] {
  const mapping = redirectMap(redirects);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return rows.map((row) => {
    const subject = byId.get(resolveRedirect(mapping, row.subject_id));
    const object = byId.get(resolveRedirect(mapping, row.object_id));
    return {
      ...row,
      ...(subject ? {
        subject_id: subject.id, subject_kind: subject.kind,
        subject_natural_key: subject.natural_key, subject_label: subject.display_name
      } : {}),
      ...(object ? {
        object_id: object.id, object_kind: object.kind,
        object_natural_key: object.natural_key, object_label: object.display_name
      } : {})
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
    const current = assertion.evidence.length === 0
      ? (assertion.commitSha === "source" && Boolean(assertion.sourceObservationId)) ||
        (assertion.commitSha === "command" && Boolean(assertion.assertedBy))
      : assertion.evidence.every((citation) => {
          const path = citation.replace(/:\d+(?:-\d+)?$/, "");
          const sourceBlob = sourceMap.get(`${assertion.commitSha}:${path}`);
          return sourceBlob !== undefined && sourceBlob === currentMap.get(path);
        });
    if (!current) continue;
    const key = `${assertion.subject.kind}:${assertion.subject.naturalKey}:${assertion.predicate}:${assertion.object.kind}:${assertion.object.naturalKey}:${canonicalJson(assertion.qualifiers ?? {})}`;
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

async function insertOutbox(
  client: PoolClient,
  tenantId: string,
  eventType: string,
  aggregateId: string,
  payload: Readonly<Record<string, unknown>>,
  createdAt: string
): Promise<string> {
  const consumers = outboxConsumers(eventType);
  const ids: string[] = [];
  for (const consumer of consumers) {
    const id = stableId("outbox", `${tenantId}:${eventType}:${aggregateId}:${createdAt}:${JSON.stringify(payload)}:${consumer}`);
    ids.push(id);
    await client.query(
      `insert into jina_ontology.outbox (id,tenant_id,event_type,consumer,aggregate_id,payload,created_at,available_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7) on conflict do nothing`,
      [id, tenantId, eventType, consumer, aggregateId, JSON.stringify(payload), createdAt]
    );
  }
  return ids[0]!;
}

function outboxConsumers(eventType: string): readonly ("manifest" | "search" | "reconciliation" | "graph")[] {
  switch (eventType) {
    case "ref_moved": return ["manifest", "graph"];
    case "observation_recorded":
    case "entity_changed":
    case "identity_changed": return ["search", "graph"];
    case "assertion_changed": return ["reconciliation", "graph"];
    case "redirect_added": return ["reconciliation", "search", "graph"];
    case "observation_redacted": return ["search", "graph"];
    case "tombstone": return ["manifest", "search", "reconciliation", "graph"];
    default: return ["graph"];
  }
}

async function lockRepositoryWrite(client: PoolClient, tenantId: string, repository: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1),hashtext($2))", [tenantId, repository]);
}

async function assertRepositoryWritable(client: PoolClient, tenantId: string, repository: string): Promise<void> {
  await lockRepositoryWrite(client, tenantId, repository);
  const tombstone = await client.query(
    `select 1 from jina_ontology.erasure_filters
     where tenant_id=$1 and kind='repository' and value=$2`,
    [tenantId, repository]
  );
  if (tombstone.rowCount) throw new DomainError("repository is tombstoned", "conflict");
}

async function insertAudit(client: PoolClient, input: {
  readonly id: string; readonly tenantId: string; readonly actorId: string; readonly action: string;
  readonly input: unknown; readonly result: "accepted" | "rejected"; readonly now: string; readonly reason?: string; readonly parentAuditId?: string;
}): Promise<void> {
  await client.query(
    `insert into jina_ontology.audit_log (id,tenant_id,actor_id,action,input,result,reason,parent_audit_id,created_at)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
    [input.id, input.tenantId, input.actorId, input.action, JSON.stringify(input.input), input.result,
      input.reason ?? null, input.parentAuditId ?? null, input.now]
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
    `update jina_ontology.assertions set explanation=$3
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
  client: PoolClient, tenantId: string, kind: "identity" | "observation" | "commit" | "repository",
  value: string, auditId: string, now: string
): Promise<void> {
  await client.query(
    `insert into jina_ontology.erasure_filters (id,tenant_id,kind,value,audit_id,created_at)
     values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id,kind,value) do nothing`,
    [stableId("filter", `${tenantId}:${kind}:${value}`), tenantId, kind, value, auditId, now]
  );
}

function redirectMap(rows: readonly { from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }[]): Map<string, string> {
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
    client.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge"; audit_id: string; created_at: Date; id: string }>(
      `select from_entity_id,to_entity_id,kind,audit_id,created_at,id from jina_ontology.entity_redirects
       where tenant_id=$1 order by created_at,id`, [tenantId]
    ),
    client.query<{
      id: string; subject_id: string; object_id: string | null; literal_type: string | null; literal_value: unknown;
      repository: string; predicate: string; qualifiers_hash: string; valid_from: Date | null; recorded_at: Date;
    }>(
      `select id,repository,subject_id,object_id,literal_type,literal_value,predicate,qualifiers_hash,valid_from,recorded_at
       from jina_ontology.assertions
       where tenant_id=$1 and status='active' for update`, [tenantId]
    )
  ]);
  const mapping = redirectMap(redirectRows.rows);
  const groups = new Map<string, typeof assertionRows.rows>();
  for (const assertion of assertionRows.rows) {
    const subject = resolveRedirect(mapping, assertion.subject_id);
    const object = assertion.object_id ? resolveRedirect(mapping, assertion.object_id) : `${assertion.literal_type}:${canonicalJson(assertion.literal_value)}`;
    const definition = predicateDefinition(assertion.predicate);
    const key = definition.cardinality === "one"
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
    id: auditId, tenantId, actorId: "svc:reconciliation", action: "reconcile_redirect_collisions",
    input: { superseded: Object.fromEntries(supersede) }, result: "accepted", now,
    ...(parentAuditId ? { parentAuditId } : {})
  });
  for (const [loser, winner] of supersede) {
    await client.query(
      `update jina_ontology.assertions set status='superseded',valid_to=$3,superseded_by=$4,audit_id=$5
       where tenant_id=$1 and id=$2`, [tenantId, loser, now, winner, auditId]
    );
    await insertOutbox(client, tenantId, "assertion_changed", loser, { assertionId: loser, supersededBy: winner }, now);
  }
  return supersede.size;
}

async function deleteCodePlaneRepository(client: PoolClient, tenantId: string, repository: string): Promise<void> {
  const removed = await client.query<{ blob_sha: string }>(
    `select distinct blob_sha from (
       select old_blob_sha as blob_sha from jina_ontology.commit_changes where tenant_id=$1 and repository=$2
       union all
       select new_blob_sha as blob_sha from jina_ontology.commit_changes where tenant_id=$1 and repository=$2
     ) referenced where blob_sha is not null`, [tenantId, repository]
  );
  await client.query(`delete from jina_ontology.ref_manifest where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  await client.query(`delete from jina_ontology.commit_changes where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  await client.query(`delete from jina_ontology.refs where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  await client.query(`delete from jina_ontology.commits where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  const candidates = [...new Set(removed.rows.map((row) => row.blob_sha))];
  if (candidates.length) {
    const orphaned = await client.query<{ blob_sha: string }>(
      `select source.sha as blob_sha from unnest($2::text[]) source(sha)
       where not exists (
         select 1 from jina_ontology.commit_changes change
         where change.tenant_id=$1 and (change.old_blob_sha=source.sha or change.new_blob_sha=source.sha)
       )`,
      [tenantId, candidates]
    );
    const shas = orphaned.rows.map((row) => row.blob_sha);
    if (shas.length) {
      await client.query(`delete from jina_ontology.symbol_edges where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
      await client.query(`delete from jina_ontology.blob_symbols where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
      await client.query(`delete from jina_ontology.blob_imports where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
      await client.query(`delete from jina_ontology.blob_analyses where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
      await client.query(`delete from jina_ontology.blobs where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
    }
  }
  await client.query(`delete from jina_ontology.graphs where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  await client.query(`delete from jina_ontology.repository_acl where tenant_id=$1 and repository=$2`, [tenantId, repository]);
}

async function garbageCollectCodePlane(client: PoolClient, tenantId: string, now: string, recentDays: number): Promise<void> {
  const garbage = await client.query<{ repository: string; sha: string }>(
    `with recursive pr_linked as (
       select repository,substring(object_natural_key from ':sha:([a-f0-9]{40})$') as sha
       from jina_ontology.assertions
       where tenant_id=$1 and predicate='INCLUDES' and status='active'
     ), reachable(repository,sha) as (
       select repository,commit_sha from jina_ontology.refs where tenant_id=$1
       union
       select repository,sha from pr_linked where sha is not null
       union
       select c.repository,parent.sha
       from reachable r
       join jina_ontology.commits c on c.tenant_id=$1 and c.repository=r.repository and c.sha=r.sha
       cross join lateral unnest(c.parents) parent(sha)
     )
     select c.repository,c.sha from jina_ontology.commits c
     where c.tenant_id=$1 and c.committed_at < $2::timestamptz - make_interval(days=>$3)
       and not exists (select 1 from reachable r where r.repository=c.repository and r.sha=c.sha)`,
    [tenantId, now, recentDays]
  );
  if (garbage.rows.length === 0) return;
  const removed = await client.query<{ blob_sha: string }>(
    `select distinct blob_sha from (
       select change.old_blob_sha as blob_sha
       from jina_ontology.commit_changes change
       join unnest($2::text[],$3::text[]) doomed(repository,sha)
         on change.repository=doomed.repository and change.commit_sha=doomed.sha
       where change.tenant_id=$1
       union all
       select change.new_blob_sha as blob_sha
       from jina_ontology.commit_changes change
       join unnest($2::text[],$3::text[]) doomed(repository,sha)
         on change.repository=doomed.repository and change.commit_sha=doomed.sha
       where change.tenant_id=$1
     ) referenced where blob_sha is not null`,
    [tenantId, garbage.rows.map((row) => row.repository), garbage.rows.map((row) => row.sha)]
  );
  await client.query(
    `delete from jina_ontology.commit_changes c using (
       select source.repository,source.sha from unnest($2::text[],$3::text[]) source(repository,sha)
     ) doomed where c.tenant_id=$1 and c.repository=doomed.repository and c.commit_sha=doomed.sha`,
    [tenantId, garbage.rows.map((row) => row.repository), garbage.rows.map((row) => row.sha)]
  );
  await client.query(
    `delete from jina_ontology.commits c using (
       select source.repository,source.sha from unnest($2::text[],$3::text[]) source(repository,sha)
     ) doomed where c.tenant_id=$1 and c.repository=doomed.repository and c.sha=doomed.sha`,
    [tenantId, garbage.rows.map((row) => row.repository), garbage.rows.map((row) => row.sha)]
  );
  const candidates = [...new Set(removed.rows.map((row) => row.blob_sha))];
  if (candidates.length === 0) return;
  const orphans = await client.query<{ blob_sha: string }>(
    `select source.sha as blob_sha from unnest($2::text[]) source(sha)
     where not exists (
       select 1 from jina_ontology.commit_changes change
       where change.tenant_id=$1 and (change.old_blob_sha=source.sha or change.new_blob_sha=source.sha)
     )`,
    [tenantId, candidates]
  );
  const shas = orphans.rows.map((row) => row.blob_sha);
  if (shas.length === 0) return;
  await client.query(`delete from jina_ontology.symbol_edges where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
  await client.query(`delete from jina_ontology.blob_symbols where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
  await client.query(`delete from jina_ontology.blob_imports where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
  await client.query(`delete from jina_ontology.blob_analyses where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
  await client.query(`delete from jina_ontology.blobs where tenant_id=$1 and blob_sha=any($2::text[])`, [tenantId, shas]);
}

async function purgeRejectedModelPayloads(client: PoolClient, tenantId: string, now: string, retentionDays: number): Promise<void> {
  const expired = await client.query<{ observation_id: string }>(
    `select o.id as observation_id from jina_ontology.observations o
     where o.tenant_id=$1 and o.type='model_output' and o.redacted_at is null and o.payload is not null
       and o.recorded_at < $2::timestamptz - make_interval(days=>$3)
       and not exists (
         select 1 from jina_ontology.assertions a
         where a.source_observation_id=o.id and a.status in ('active','proposed')
       )`, [tenantId, now, retentionDays]
  );
  const ids = expired.rows.map((row) => row.observation_id);
  if (ids.length === 0) return;
  await client.query(
    `update jina_ontology.observations set payload=null,redacted_at=$2,redaction_reason='rejected model output retention'
     where id=any($1::text[]) and redacted_at is null`, [ids, now]
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
      if (typeof candidate !== "object" || candidate === null || candidate.predicate !== "RESOLVES") return false;
      const object = typeof candidate.object === "object" && candidate.object !== null
        ? candidate.object as Record<string, unknown>
        : undefined;
      return object?.naturalKey === issueNaturalKey;
    });
    const subject = resolution && typeof resolution.subject === "object" && resolution.subject !== null
      ? resolution.subject as Record<string, unknown>
      : undefined;
    const pullRequestNumber = typeof subject?.naturalKey === "string" ? numberFromNaturalKey(subject.naturalKey) : undefined;
    const rawOutput = typeof payload.rawOutput === "object" && payload.rawOutput !== null
      ? payload.rawOutput as Record<string, unknown>
      : undefined;
    if (!pullRequestNumber || !Array.isArray(rawOutput?.nodes)) continue;
    const node = rawOutput.nodes.find((candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null && candidate.kind === "Issue" &&
        candidate.id === `virtual:pr:${pullRequestNumber}`
    );
    if (typeof node?.description === "string" && node.description.trim()) return node.description;
  }
  return undefined;
}

function retrievalCitationFromEvidence(repository: string, commitSha: string, value: string): RetrievalCitation | undefined {
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
  if (!request.issueEntityId && !request.issueNumber && !issueText && !request.pullRequestNumber && !request.commitSha) return [];
  const graphResult = await pool.query<{ id: string; commit_sha: string }>(
    `select graph.id,graph.commit_sha from jina_ontology.graph_heads head
     join jina_ontology.graphs graph on graph.id=head.graph_id
     where head.tenant_id=$1 and head.repository=$2 and head.ref_name=$3
     limit 1`,
    [request.tenantId, request.repository, ref]
  );
  const graph = graphResult.rows[0];
  if (!graph) return [];
  let modelObservationRows: { id: string; payload: Record<string, unknown> }[] = [];
  if (issueText) {
    modelObservationRows = (await pool.query<{ id: string; payload: Record<string, unknown> }>(
      `select id,payload from jina_ontology.observations
       where tenant_id=$1 and repository=$2 and type='model_output' and redacted_at is null and payload is not null
         and position($3 in lower(payload::text)) > 0`,
      [request.tenantId, request.repository, issueText]
    )).rows;
  }
  const earlyModelPayloads = new Map(modelObservationRows.map((observation) => [observation.id, observation.payload]));
  const derivedIssueNaturalKeys = new Set<string>();
  if (issueText) {
    for (const payload of earlyModelPayloads.values()) {
      if (!Array.isArray(payload.assertions)) continue;
      for (const candidate of payload.assertions) {
        if (typeof candidate !== "object" || candidate === null || candidate.predicate !== "RESOLVES") continue;
        const object = typeof candidate.object === "object" && candidate.object !== null
          ? candidate.object as Record<string, unknown>
          : undefined;
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
      from jina_ontology.nodes node
      join jina_ontology.entities entity on entity.tenant_id=$2 and entity.id=$3 and entity.kind='Issue'
        and entity.natural_key=node.description
      where node.graph_id=$1 and node.kind='Issue'
      order by node.label,node.node_id limit $4`;
    candidateValues = [graph.id, request.tenantId, request.issueEntityId, limit];
  } else if (request.issueNumber) {
    candidateQuery = `select node_id,kind,label,description,evidence from jina_ontology.nodes
      where graph_id=$1 and kind='Issue' and description=$2 order by label,node_id limit $3`;
    candidateValues = [graph.id, `github:issue:${request.repository}#${request.issueNumber}`, limit];
  } else if (issueText) {
    candidateQuery = `with matching_issue_numbers as materialized (
        select distinct observation.payload->>'number' as issue_number
        from jina_ontology.observations observation
        where observation.tenant_id=$3 and observation.repository=$4 and observation.source='github'
          and observation.redacted_at is null and observation.payload->>'kind'='issue'
          and (position($2 in lower(coalesce(observation.payload->>'title',''))) > 0
            or position($2 in lower(coalesce(observation.payload->>'body',''))) > 0)
      )
      select node.node_id,node.kind,node.label,node.description,node.evidence
      from jina_ontology.nodes node
      where node.graph_id=$1 and node.kind='Issue' and (
        position($2 in lower(node.label)) > 0 or node.description=any($5::text[]) or
        substring(node.description from '#([0-9]+)$') in (select issue_number from matching_issue_numbers)
      )
      order by case when lower(node.label)=$2 then 0 when position($2 in lower(node.label)) > 0 then 1 else 2 end,
               node.label,node.node_id limit $6`;
    candidateValues = [graph.id, issueText, request.tenantId, request.repository, [...derivedIssueNaturalKeys], limit];
  } else if (request.pullRequestNumber) {
    candidateQuery = `select distinct issue.node_id,issue.kind,issue.label,issue.description,issue.evidence
      from jina_ontology.nodes issue
      where issue.graph_id=$1 and issue.kind='Issue' and (
        exists (select 1 from jina_ontology.edges resolution
          join jina_ontology.nodes pull_request on pull_request.graph_id=resolution.graph_id
            and pull_request.node_id=resolution.source_node_id and pull_request.description=$2
          where resolution.graph_id=$1 and resolution.predicate='RESOLVES' and resolution.target_node_id=issue.node_id)
        or exists (select 1 from jina_ontology.edges cause
          join jina_ontology.edges inclusion on inclusion.graph_id=cause.graph_id
            and inclusion.target_node_id=cause.target_node_id and inclusion.predicate in ('INCLUDES','MERGED_AS')
          join jina_ontology.nodes pull_request on pull_request.graph_id=inclusion.graph_id
            and pull_request.node_id=inclusion.source_node_id and pull_request.description=$2
          where cause.graph_id=$1 and cause.predicate='INTRODUCED_BY' and cause.source_node_id=issue.node_id)
      ) order by issue.label,issue.node_id limit $3`;
    candidateValues = [graph.id, `github:pr:${request.repository}#${request.pullRequestNumber}`, limit];
  } else {
    candidateQuery = `select distinct issue.node_id,issue.kind,issue.label,issue.description,issue.evidence
      from jina_ontology.nodes issue
      where issue.graph_id=$1 and issue.kind='Issue' and (
        exists (select 1 from jina_ontology.edges cause
          join jina_ontology.nodes commit on commit.graph_id=cause.graph_id and commit.node_id=cause.target_node_id
          where cause.graph_id=$1 and cause.predicate='INTRODUCED_BY' and cause.source_node_id=issue.node_id
            and lower(commit.description) like '%:sha:'||$2||'%')
        or exists (select 1 from jina_ontology.edges resolution
          join jina_ontology.edges inclusion on inclusion.graph_id=resolution.graph_id
            and inclusion.source_node_id=resolution.source_node_id and inclusion.predicate in ('INCLUDES','MERGED_AS')
          join jina_ontology.nodes commit on commit.graph_id=inclusion.graph_id and commit.node_id=inclusion.target_node_id
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
       select source_node_id from jina_ontology.edges
       where graph_id=$1 and predicate='RESOLVES' and target_node_id=any($2::text[])
     ), causal_commits as (
       select target_node_id from jina_ontology.edges
       where graph_id=$1 and predicate='INTRODUCED_BY' and source_node_id=any($2::text[])
     )
     select edge_id,source_node_id,target_node_id,predicate,why,evidence from jina_ontology.edges
     where graph_id=$1 and predicate=any($3::text[]) and (
       source_node_id=any($2::text[]) or target_node_id=any($2::text[]) or
       (predicate in ('INCLUDES','MERGED_AS') and (
         source_node_id in (select source_node_id from resolution_pull_requests) or
         target_node_id in (select target_node_id from causal_commits)
       ))
     )`, [graph.id, candidateIssueIds, [...ISSUE_TRACE_PREDICATES]]
  );
  const relevantNodeIds = new Set(candidateIssueIds);
  for (const edge of edgeResult.rows) {
    relevantNodeIds.add(edge.source_node_id);
    relevantNodeIds.add(edge.target_node_id);
  }
  const nodeResult = await pool.query<IssueTraceGraphNodeRow>(
    `select node_id,kind,label,description,evidence from jina_ontology.nodes
     where graph_id=$1 and node_id=any($2::text[])`, [graph.id, [...relevantNodeIds]]
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
       from jina_ontology.assertions
       where tenant_id=$1 and repository=$2 and status='active' and predicate=any($3::text[])
         and (subject_id=any($4::text[]) or object_id=any($4::text[]))
       order by recorded_at desc,id desc`,
      [request.tenantId, request.repository, [...ISSUE_TRACE_PREDICATES], relevantEntityIds]
    ),
    relevantNumbers.length > 0
      ? pool.query<{ id: string; payload: Record<string, unknown>; recorded_at: Date }>(
          `select id,payload,recorded_at from jina_ontology.observations
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
    const missingIds = [...new Set(assertionResult.rows.flatMap((assertion) =>
      assertion.source_observation_id && !loadedIds.has(assertion.source_observation_id)
        ? [assertion.source_observation_id]
        : []
    ))];
    if (missingIds.length > 0) {
      const missing = await pool.query<{ id: string; payload: Record<string, unknown> }>(
        `select id,payload from jina_ontology.observations
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
  const assertionForEdge = (edge: IssueTraceGraphEdgeRow): (IssueTraceAssertionRow & { recorded_at: Date }) | undefined => {
    const subject = nodesById.get(edge.source_node_id)?.description;
    const object = nodesById.get(edge.target_node_id)?.description;
    if (!subject || !object) return undefined;
    const candidates = assertionsByRelation.get(relationKey(subject, edge.predicate, object)) ?? [];
    return candidates.find((candidate) =>
      edge.predicate !== "INTRODUCED_BY" || typeof candidate.qualifiers.reason !== "string" || candidate.qualifiers.reason === edge.why
    ) ?? candidates[0];
  };
  const latestObservationByKey = new Map<string, { readonly id: string; readonly payload: Record<string, unknown> }>();
  for (const observation of observationResult.rows) {
    const kind = observation.payload.kind;
    const number = observation.payload.number;
    if ((kind === "issue" || kind === "pull_request") && typeof number === "number") {
      latestObservationByKey.set(`${kind}:${number}`, observation);
    }
  }
  const modelPayloadByObservationId = new Map(modelObservationRows.map((observation) => [observation.id, observation.payload]));
  const resolves = edgeResult.rows.filter((edge) => edge.predicate === "RESOLVES");
  const causes = edgeResult.rows.filter((edge) => edge.predicate === "INTRODUCED_BY");
  const inclusions = edgeResult.rows.filter((edge) => edge.predicate === "INCLUDES" || edge.predicate === "MERGED_AS");
  const commitPrefix = request.commitSha?.toLowerCase() ?? "";
  const candidates = issueNodes.filter((issue) => {
    const naturalKey = issue.description;
    const issueNumber = numberFromNaturalKey(naturalKey);
    const issueObservation = issueNumber ? latestObservationByKey.get(`issue:${issueNumber}`) : undefined;
    if (request.issueEntityId) {
      return stableId("entity", `${request.tenantId}:Issue:${naturalKey}`) === request.issueEntityId;
    }
    if (request.issueNumber) return issueNumber === request.issueNumber;
    if (issueText) {
      return issue.label.toLowerCase().includes(issueText) ||
        String(issueObservation?.payload.title ?? "").toLowerCase().includes(issueText) ||
        String(issueObservation?.payload.body ?? "").toLowerCase().includes(issueText) ||
        (derivedIssueDescription(naturalKey, modelPayloadByObservationId)?.toLowerCase().includes(issueText) ?? false);
    }
    if (request.pullRequestNumber) {
      const pullRequestNumber = request.pullRequestNumber;
      const directlyResolved = resolves.some((edge) => edge.target_node_id === issue.node_id &&
        numberFromNaturalKey(nodesById.get(edge.source_node_id)?.description ?? "") === pullRequestNumber);
      const causedByPullRequest = causes.some((cause) => cause.source_node_id === issue.node_id &&
        inclusions.some((inclusion) => inclusion.target_node_id === cause.target_node_id &&
          numberFromNaturalKey(nodesById.get(inclusion.source_node_id)?.description ?? "") === pullRequestNumber));
      return directlyResolved || causedByPullRequest;
    }
    if (commitPrefix) {
      const causedByCommit = causes.some((edge) => edge.source_node_id === issue.node_id &&
        shaFromNaturalKey(nodesById.get(edge.target_node_id)?.description ?? "")?.startsWith(commitPrefix));
      const resolvedByCommit = resolves.some((resolution) => resolution.target_node_id === issue.node_id &&
        inclusions.some((inclusion) => inclusion.source_node_id === resolution.source_node_id &&
          shaFromNaturalKey(nodesById.get(inclusion.target_node_id)?.description ?? "")?.startsWith(commitPrefix)));
      return causedByCommit || resolvedByCommit;
    }
    return false;
  }).sort((left, right) => {
    if (!issueText) return (numberFromNaturalKey(left.description) ?? Number.MAX_SAFE_INTEGER) -
      (numberFromNaturalKey(right.description) ?? Number.MAX_SAFE_INTEGER) || left.label.localeCompare(right.label);
    const leftTitle = String(latestObservationByKey.get(`issue:${numberFromNaturalKey(left.description)}`)?.payload.title ?? left.label).toLowerCase();
    const rightTitle = String(latestObservationByKey.get(`issue:${numberFromNaturalKey(right.description)}`)?.payload.title ?? right.label).toLowerCase();
    return (leftTitle === issueText ? 0 : leftTitle.includes(issueText) ? 1 : 2) -
      (rightTitle === issueText ? 0 : rightTitle.includes(issueText) ? 1 : 2) || leftTitle.localeCompare(rightTitle);
  }).slice(0, limit);
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
  const changeResult = relevantCommitShas.size > 0
    ? await pool.query<{ commit_sha: string; path: string; change: string; old_path: string | null }>(
        `select commit_sha,path,change,old_path from jina_ontology.commit_changes
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
      if (assertion.source_observation_id) citations.push({ kind: "observation", id: assertion.source_observation_id, repository: request.repository });
    }
    for (const evidence of edge.evidence) {
      if (evidence.startsWith("observation:")) {
        citations.push({ kind: "observation", id: evidence.slice("observation:".length), repository: request.repository });
      } else {
        const evidenceCommitSha = assertion && /^[a-f0-9]{40}$/i.test(assertion.commit_sha) ? assertion.commit_sha : graph.commit_sha;
        const citation = retrievalCitationFromEvidence(request.repository, evidenceCommitSha, evidence);
        if (citation) citations.push(citation);
      }
    }
    return citations;
  };

  return candidates.map((issue): RetrievalItem => {
    const issueNumber = numberFromNaturalKey(issue.description);
    const issueObservation = issueNumber ? latestObservationByKey.get(`issue:${issueNumber}`) : undefined;
    const citations: RetrievalCitation[] = [{
      kind: "entity", id: stableId("entity", `${request.tenantId}:Issue:${issue.description}`), repository: request.repository
    }];
    if (issueObservation) citations.push({ kind: "observation", id: issueObservation.id, repository: request.repository });
    const issueResolutions = resolves.filter((edge) => edge.target_node_id === issue.node_id).flatMap((resolution) => {
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
        if (sha) bySha.set(sha, inclusion.predicate === "MERGED_AS" ? "merge" : bySha.get(sha) ?? "included");
      }
      const commits = [...bySha].sort((left, right) =>
        (left[1] === "merge" ? 0 : 1) - (right[1] === "merge" ? 0 : 1) || left[0].localeCompare(right[0])
      ).map(([sha, role]) => {
        const changes = (changesByCommit.get(sha) ?? []).map((change) => ({
          commitSha: sha, path: change.path, change: change.change, ...(change.old_path ? { oldPath: change.old_path } : {})
        }));
        for (const change of changes) citations.push({
          kind: "commit_change", id: `${sha}:${change.path}`, repository: request.repository, commitSha: sha, path: change.path
        });
        return { sha, url: `https://github.com/${request.repository}/commit/${sha}`, role, changes };
      });
      return [{
        pullRequestNumber,
        title: String(pullRequestObservation?.payload.title ?? pullRequest.label),
        url: String(pullRequestObservation?.payload.url ?? `https://github.com/${request.repository}/pull/${pullRequestNumber}`),
        commits,
        assertionIds: [...assertionIds],
        observationIds: [...observationIds]
      }];
    }).sort((left, right) => left.pullRequestNumber - right.pullRequestNumber);
    const introducedBy = causes.filter((edge) => edge.source_node_id === issue.node_id).flatMap((cause) => {
      const commit = nodesById.get(cause.target_node_id);
      const sha = commit ? shaFromNaturalKey(commit.description) : undefined;
      if (!commit || !sha) return [];
      const assertion = assertionForEdge(cause);
      citations.push(...edgeCitations(cause));
      const causalPullRequests = [...new Map(inclusions.filter((edge) => edge.target_node_id === commit.node_id).flatMap((inclusion) => {
        const pullRequest = nodesById.get(inclusion.source_node_id);
        const number = pullRequest ? numberFromNaturalKey(pullRequest.description) : undefined;
        if (!pullRequest || !number) return [];
        const observation = latestObservationByKey.get(`pull_request:${number}`);
        citations.push(...edgeCitations(inclusion));
        if (observation) citations.push({ kind: "observation", id: observation.id, repository: request.repository });
        return [[number, {
          number,
          title: String(observation?.payload.title ?? pullRequest.label),
          url: String(observation?.payload.url ?? `https://github.com/${request.repository}/pull/${number}`)
        }] as const];
      })).values()].sort((left, right) => left.number - right.number);
      const changes = (changesByCommit.get(sha) ?? []).map((change) => ({
        commitSha: sha, path: change.path, change: change.change, ...(change.old_path ? { oldPath: change.old_path } : {})
      }));
      for (const change of changes) citations.push({
        kind: "commit_change", id: `${sha}:${change.path}`, repository: request.repository, commitSha: sha, path: change.path
      });
      return [{
        sha,
        url: `https://github.com/${request.repository}/commit/${sha}`,
        role: "introduced" as const,
        changes,
        ...(cause.why ? { why: cause.why } : {}),
        evidence: cause.evidence,
        evidenceCommitSha: assertion?.commit_sha ?? graph.commit_sha,
        assertionIds: assertion ? [assertion.id] : [],
        pullRequests: causalPullRequests
      }];
    });
    const payload: IssueTraceProjection = {
      issue: {
        entityId: stableId("entity", `${request.tenantId}:Issue:${issue.description}`),
        origin: issueNumber ? "github" : "derived",
        title: String(issueObservation?.payload.title ?? issue.label.replace(/^#\d+\s+/, "")),
        ...(issueNumber ? { number: issueNumber, displayId: `#${issueNumber}` } : { displayId: "virtual" }),
        ...(!issueNumber ? { description: derivedIssueDescription(issue.description, modelPayloadByObservationId) ?? issue.label } : {}),
        ...(typeof issueObservation?.payload.url === "string" ? { url: issueObservation.payload.url } : issueNumber
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
    const causalCommit = !wantsCausality ? undefined : request.commitSha
      ? payload.introducedBy.find((commit) => commit.sha.startsWith(commitPrefix))
      : request.pullRequestNumber
        ? payload.introducedBy.find((commit) => commit.pullRequests?.some((pullRequest) => pullRequest.number === request.pullRequestNumber))
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

async function retrieveFeatureTrace(pool: Pool, request: RetrievalRequest, ref: string, limit: number): Promise<RetrievalItem[]> {
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
       select commit_sha from jina_ontology.refs
       where tenant_id=$1 and repository=$2 and ref_name=$3
     ), projected_ref as (
       select current_ref.commit_sha from current_ref
       where exists (
         select 1 from jina_ontology.graph_heads head
         join jina_ontology.graphs graph on graph.id=head.graph_id
         where head.tenant_id=$1 and head.repository=$2 and head.ref_name=$3
           and graph.commit_sha=current_ref.commit_sha
       )
     )
     select assertion.id,assertion.commit_sha,assertion.subject_id,assertion.subject_kind,assertion.subject_natural_key,assertion.subject_label,assertion.predicate,
            assertion.object_id,assertion.object_kind,assertion.object_natural_key,assertion.object_label,assertion.confidence,
            assertion.evidence,assertion.source_observation_id
     from jina_ontology.assertions assertion
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
               select blob_sha from jina_ontology.commit_manifest($1,$2,assertion.commit_sha)
               where path=citation.path
             ) source_file on true
             left join jina_ontology.ref_manifest current_file
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
      `select from_entity_id,to_entity_id,kind from jina_ontology.entity_redirects where tenant_id=$1 order by created_at,id`, [request.tenantId]
    ),
    pool.query<{ id: string; kind: string; natural_key: string; display_name: string }>(
      `select id,kind,natural_key,display_name from jina_ontology.entities where tenant_id=$1`, [request.tenantId]
    )
  ]);
  const mapping = redirectMap(redirects.rows);
  const entitiesById = new Map(entities.rows.map((entity) => [entity.id, entity]));
  const rows = result.rows.map((row) => {
    const subject = entitiesById.get(resolveRedirect(mapping, row.subject_id));
    const object = entitiesById.get(resolveRedirect(mapping, row.object_id));
    return {
      ...row,
      ...(subject ? { subject_kind: subject.kind, subject_natural_key: subject.natural_key, subject_label: subject.display_name } : {}),
      ...(object ? { object_kind: object.kind, object_natural_key: object.natural_key, object_label: object.display_name } : {})
    };
  }).filter((row) => {
    const feature = row.subject_kind === "Feature" ? row.subject_label + " " + row.subject_natural_key
      : row.object_kind === "Feature" ? row.object_label + " " + row.object_natural_key : "";
    return feature.toLocaleLowerCase().includes(featureText.toLocaleLowerCase());
  }).slice(0, limit);
  return rows.map((row) => {
    const featureIsSubject = row.subject_kind === "Feature";
    const feature = featureIsSubject
      ? { kind: row.subject_kind, naturalKey: row.subject_natural_key, label: row.subject_label }
      : { kind: row.object_kind, naturalKey: row.object_natural_key, label: row.object_label };
    const related = featureIsSubject
      ? { kind: row.object_kind, naturalKey: row.object_natural_key, label: row.object_label }
      : { kind: row.subject_kind, naturalKey: row.subject_natural_key, label: row.subject_label };
    const title = row.predicate === "IMPLEMENTS"
      ? `${related.label} implements ${feature.label}`
      : row.predicate === "DOCUMENTED_BY"
        ? `${feature.label} is documented by ${related.label}`
        : row.predicate === "LIKELY_AFFECTS"
          ? `${related.label} may affect ${feature.label}`
          : `${related.label} references ${feature.label}`;
    const citations: RetrievalCitation[] = [{
      kind: "assertion", id: row.id, repository: request.repository,
      ...(/^[a-f0-9]{40}$/i.test(row.commit_sha) ? { commitSha: row.commit_sha } : {})
    }];
    if (row.source_observation_id) citations.push({
      kind: "observation", id: row.source_observation_id, repository: request.repository
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

async function retrieveStructure(pool: Pool, request: RetrievalRequest, ref: string, limit: number): Promise<RetrievalItem[]> {
  const symbol = request.symbol ?? "";
  const path = request.path ?? "";
  const definitions = await pool.query<{
    path: string; commit_sha: string; blob_sha: string; moniker: string; name: string; symbol_kind: string; start_line: number; end_line: number;
  }>(
    `select m.path,m.commit_sha,m.blob_sha,s.moniker,s.name,s.kind as symbol_kind,s.start_line,s.end_line
     from jina_ontology.ref_manifest m
     join jina_ontology.blob_symbols s on s.tenant_id=m.tenant_id and s.blob_sha=m.blob_sha and s.parser_version=$6
     where m.tenant_id=$1 and m.repository=$2 and m.ref_name=$3
       and ($4='' or s.name ilike $4 or s.moniker ilike '%' || $4 || '%')
       and ($5='' or m.path=$5)
     order by case when s.name ilike $4 then 0 else 1 end,m.path,s.start_line limit $7`,
    [request.tenantId, request.repository, ref, symbol, path, ONTOLOGY_PARSER_VERSION, limit]
  );
  const items: RetrievalItem[] = definitions.rows.map((row) => ({
    kind: "symbol_definition", title: `${row.name} is ${row.symbol_kind} in ${row.path}`,
    data: { moniker: row.moniker, name: row.name, symbolKind: row.symbol_kind, path: row.path }, score: 2,
    citations: [{
      kind: "code", id: `${row.blob_sha}:${row.start_line}:${row.moniker}`, repository: request.repository,
      commitSha: row.commit_sha, path: row.path, startLine: row.start_line, endLine: row.end_line
    }]
  }));
  if (items.length >= limit) return items.slice(0, limit);
  const relationships = await pool.query<{
    path: string; commit_sha: string; blob_sha: string; from_moniker: string; kind: string; to_moniker: string; start_line: number; end_line: number;
  }>(
    `select m.path,m.commit_sha,m.blob_sha,e.from_moniker,e.kind,e.to_moniker,e.start_line,e.end_line
     from jina_ontology.ref_manifest m
     join jina_ontology.symbol_edges e on e.tenant_id=m.tenant_id and e.blob_sha=m.blob_sha and e.parser_version=$6
     where m.tenant_id=$1 and m.repository=$2 and m.ref_name=$3
       and ($4='' or e.from_moniker ilike '%' || $4 || '%' or e.to_moniker ilike '%' || $4 || '%')
       and ($5='' or m.path=$5)
     order by case when e.from_moniker ilike $4 || '%' then 0 else 1 end,m.path,e.start_line limit $7`,
    [request.tenantId, request.repository, ref, symbol, path, ONTOLOGY_PARSER_VERSION, limit - items.length]
  );
  items.push(...relationships.rows.map((row): RetrievalItem => ({
    kind: row.kind, title: `${row.from_moniker} ${row.kind} ${row.to_moniker}`,
    data: { fromMoniker: row.from_moniker, toMoniker: row.to_moniker, path: row.path }, score: 1,
    citations: [{
      kind: "code", id: `${row.blob_sha}:${row.start_line}:${row.from_moniker}`, repository: request.repository,
      commitSha: row.commit_sha, path: row.path, startLine: row.start_line, endLine: row.end_line
    }]
  })));
  return items;
}

async function retrieveChange(pool: Pool, request: RetrievalRequest, headSha: string, limit: number): Promise<RetrievalItem[]> {
  let commitShas = [headSha];
  if (request.pullRequestNumber) {
    const key = `github:pr:${request.repository}#${request.pullRequestNumber}`;
    const [included, redirects, entities] = await Promise.all([
      pool.query<{ subject_id: string; subject_natural_key: string; object_id: string; object_natural_key: string }>(
        `select subject_id,subject_natural_key,object_id,object_natural_key from jina_ontology.assertions
         where tenant_id=$1 and repository=$2 and predicate='INCLUDES' and status='active'`,
        [request.tenantId, request.repository]
      ),
      pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge" }>(
        `select from_entity_id,to_entity_id,kind from jina_ontology.entity_redirects where tenant_id=$1 order by created_at,id`, [request.tenantId]
      ),
      pool.query<{ id: string; natural_key: string }>(
        `select id,natural_key from jina_ontology.entities where tenant_id=$1`, [request.tenantId]
      )
    ]);
    const mapping = redirectMap(redirects.rows);
    const naturalKeys = new Map(entities.rows.map((entity) => [entity.id, entity.natural_key]));
    const parsed = included.rows.filter((row) =>
      (naturalKeys.get(resolveRedirect(mapping, row.subject_id)) ?? row.subject_natural_key) === key
    ).map((row) => {
      const naturalKey = naturalKeys.get(resolveRedirect(mapping, row.object_id)) ?? row.object_natural_key;
      return /:sha:([a-f0-9]{40})$/i.exec(naturalKey)?.[1];
    }).filter((sha): sha is string => Boolean(sha));
    if (parsed.length) commitShas = parsed;
  }
  const changes = await pool.query<{
    commit_sha: string; path: string; change: string; old_path: string | null; old_blob_sha: string | null; new_blob_sha: string | null;
  }>(
    `select commit_sha,path,change,old_path,old_blob_sha,new_blob_sha from jina_ontology.commit_changes
     where tenant_id=$1 and repository=$2 and commit_sha=any($3::text[])
       and ($4::text is null or path=$4 or old_path=$4)
     order by commit_sha,path limit $5`, [request.tenantId, request.repository, commitShas, request.path ?? null, limit]
  );
  const items: RetrievalItem[] = changes.rows.map((row) => ({
    kind: "commit_change", title: `${row.change} ${row.path}`,
    data: { change: row.change, oldPath: row.old_path, oldBlobSha: row.old_blob_sha, newBlobSha: row.new_blob_sha }, score: 1,
    citations: [{ kind: "commit_change", id: `${row.commit_sha}:${row.path}`, repository: request.repository, commitSha: row.commit_sha, path: row.path }]
  }));
  const newBlobs = changes.rows.flatMap((row) => row.new_blob_sha ? [row.new_blob_sha] : []);
  if (newBlobs.length && items.length < limit) {
    const inbound = await pool.query<{
      changed_path: string; changed_moniker: string; caller_path: string; caller_blob: string;
      commit_sha: string; from_moniker: string; kind: string; start_line: number; end_line: number;
    }>(
      `with changed as (
         select distinct ch.path,s.moniker,s.name
         from jina_ontology.commit_changes ch
         join jina_ontology.blob_symbols s on s.tenant_id=ch.tenant_id and s.blob_sha=ch.new_blob_sha and s.parser_version=$4
         where ch.tenant_id=$1 and ch.repository=$2 and ch.commit_sha=any($3::text[])
       )
       select changed.path as changed_path,changed.moniker as changed_moniker,m.path as caller_path,m.blob_sha as caller_blob,
              m.commit_sha,e.from_moniker,e.kind,e.start_line,e.end_line
       from changed
       join jina_ontology.ref_manifest m on m.tenant_id=$1 and m.repository=$2
       join jina_ontology.symbol_edges e on e.tenant_id=m.tenant_id and e.blob_sha=m.blob_sha and e.parser_version=$4
         and (e.to_moniker=changed.name or e.to_moniker=changed.moniker or e.to_moniker like '%.' || changed.name)
       where m.path<>changed.path
       order by changed.path,m.path,e.start_line limit $5`,
      [request.tenantId, request.repository, commitShas, ONTOLOGY_PARSER_VERSION, limit - items.length]
    );
    items.push(...inbound.rows.map((row): RetrievalItem => ({
      kind: "affected_surface", title: `${row.caller_path} may be affected by ${row.changed_path}`,
      data: { changedMoniker: row.changed_moniker, fromMoniker: row.from_moniker, relationship: row.kind }, score: 0.8,
      citations: [{
        kind: "code", id: `${row.caller_blob}:${row.start_line}:${row.from_moniker}`, repository: request.repository,
        commitSha: row.commit_sha, path: row.caller_path, startLine: row.start_line, endLine: row.end_line
      }]
    })));
  }
  return items.slice(0, limit);
}

async function retrieveIntent(pool: Pool, request: RetrievalRequest, limit: number): Promise<RetrievalItem[]> {
  const items: RetrievalItem[] = [];
  const historyCommitShas: string[] = [];
  if (request.path) {
    const history = await pool.query<{ commit_sha: string; path: string; change: string; message: string | null; committed_at: Date | null }>(
      `select c.commit_sha,c.path,c.change,m.message,m.committed_at from jina_ontology.commit_changes c
       join jina_ontology.commits m on m.tenant_id=c.tenant_id and m.repository=c.repository and m.sha=c.commit_sha
       where c.tenant_id=$1 and c.repository=$2 and (c.path=$3 or c.old_path=$3)
       order by m.committed_at desc nulls last limit $4`, [request.tenantId, request.repository, request.path, limit]
    );
    historyCommitShas.push(...history.rows.map((row) => row.commit_sha));
    items.push(...history.rows.map((row): RetrievalItem => ({
      kind: "history", title: row.message ?? `${row.change} ${row.path}`,
      data: { change: row.change, ...(row.committed_at ? { committedAt: row.committed_at.toISOString() } : {}) }, score: 1,
      citations: [{ kind: "commit_change", id: `${row.commit_sha}:${row.path}`, repository: request.repository, commitSha: row.commit_sha, path: row.path }]
    })));
  }
  if (historyCommitShas.length && items.length < limit) {
    const workLinks = await pool.query<{
      includes_id: string; relation_id: string; relation: string; pr_label: string; issue_label: string;
      source_observation_id: string | null;
    }>(
      `select includes.id as includes_id,relation.id as relation_id,relation.predicate as relation,
              includes.subject_label as pr_label,relation.object_label as issue_label,relation.source_observation_id
       from jina_ontology.assertions includes
       join jina_ontology.assertions relation
         on relation.tenant_id=includes.tenant_id and relation.repository=includes.repository
        and relation.subject_id=includes.subject_id and relation.predicate in ('RESOLVES','REFERENCES') and relation.status='active'
       where includes.tenant_id=$1 and includes.repository=$2 and includes.predicate='INCLUDES' and includes.status='active'
         and exists (select 1 from unnest($3::text[]) sha where includes.object_natural_key like '%:sha:' || sha)
       order by case relation.predicate when 'RESOLVES' then 0 else 1 end,relation.recorded_at desc limit $4`,
      [request.tenantId, request.repository, historyCommitShas, limit - items.length]
    );
    items.push(...workLinks.rows.map((row): RetrievalItem => ({
      kind: "work_intent", title: `${row.pr_label} ${row.relation.toLowerCase()} ${row.issue_label}`,
      data: { pullRequest: row.pr_label, issue: row.issue_label, relation: row.relation }, score: row.relation === "RESOLVES" ? 2 : 1,
      citations: [
        { kind: "assertion", id: row.includes_id, repository: request.repository },
        { kind: "assertion", id: row.relation_id, repository: request.repository },
        ...(row.source_observation_id ? [{ kind: "observation" as const, id: row.source_observation_id, repository: request.repository }] : [])
      ]
    })));
  }
  const query = request.query?.trim();
  if (query && items.length < limit) {
    const search = await pool.query<{ source_id: string; source_kind: string; title: string; body: string; score: number; embedding: number[] | null }>(
      `select source_id,source_kind,title,body,ts_rank(search_vector,plainto_tsquery('english',$3)) as score,embedding
       from jina_ontology.search_documents where tenant_id=$1 and repository=$2
       order by score desc,projected_at desc limit $4`, [request.tenantId, request.repository, query, Math.min(200, limit * 4)]
    );
    const queryEmbedding = embeddingForText(query);
    const ranked = search.rows.map((row) => ({ row, score: Number(row.score) + cosine(queryEmbedding, row.embedding ?? []) }))
      .sort((a, b) => b.score - a.score).slice(0, limit - items.length);
    items.push(...ranked.map(({ row, score }): RetrievalItem => ({
      kind: row.source_kind, title: row.title, data: { excerpt: row.body.slice(0, 500) }, score,
      citations: [{ kind: row.source_kind === "entity" ? "entity" : "observation", id: row.source_id, repository: request.repository }]
    })));
  }
  return items.slice(0, limit);
}

async function retrieveOwnership(pool: Pool, request: RetrievalRequest, limit: number): Promise<RetrievalItem[]> {
  const assertions = await pool.query<{
    id: string; subject_id: string; subject_label: string; subject_natural_key: string; object_id: string;
    object_label: string; object_natural_key: string; qualifiers: Record<string, unknown>; recorded_at: Date;
    generator: string | null; asserted_by: string | null;
  }>(
    `select id,subject_id,subject_label,subject_natural_key,object_id,object_label,object_natural_key,
            qualifiers,recorded_at,generator,asserted_by
     from jina_ontology.assertions where tenant_id=$1 and repository=$2 and predicate='OWNED_BY' and status='active'
     order by recorded_at desc limit $3`, [request.tenantId, request.repository, Math.min(800, limit * 4)]
  );
  const redirects = await pool.query<{ from_entity_id: string; to_entity_id: string; kind: "merge" | "unmerge"; created_at: Date; id: string }>(
    `select from_entity_id,to_entity_id,kind,created_at,id from jina_ontology.entity_redirects where tenant_id=$1 order by created_at,id`, [request.tenantId]
  );
  const mapping = redirectMap(redirects.rows);
  const resolved = await pool.query<{ id: string; display_name: string; natural_key: string }>(
    `select id,display_name,natural_key from jina_ontology.entities where tenant_id=$1`, [request.tenantId]
  );
  const names = new Map(resolved.rows.map((row) => [row.id, row]));
  const target = request.path ?? request.symbol;
  const applicable = assertions.rows.filter((row) => {
    const subject = names.get(resolveRedirect(mapping, row.subject_id));
    return !target || (subject?.natural_key ?? row.subject_natural_key).includes(target) ||
      (typeof row.qualifiers.pattern === "string" && codeownersPatternMatches(row.qualifiers.pattern, target));
  }
  ).sort((left, right) => ownershipAuthority(left) - ownershipAuthority(right) || right.recorded_at.getTime() - left.recorded_at.getTime());
  const items: RetrievalItem[] = applicable.map((row) => {
    const subject = names.get(resolveRedirect(mapping, row.subject_id));
    const owner = names.get(resolveRedirect(mapping, row.object_id));
    return {
      kind: "ownership", title: `${subject?.display_name ?? row.subject_label} owned by ${owner?.display_name ?? row.object_label}`,
      data: {
        subjectKey: subject?.natural_key ?? row.subject_natural_key,
        ownerKey: owner?.natural_key ?? row.object_natural_key,
        qualifiers: row.qualifiers,
        authority: row.asserted_by ? "human" : row.generator === "source:codeowners" ? "codeowners" : "model"
      }, score: 3 - ownershipAuthority(row),
      citations: [{ kind: "assertion", id: row.id, repository: request.repository }]
    };
  });
  if (request.path && items.length < limit) {
    const authors = await pool.query<{ sha: string; author_external_id: string; committed_at: Date | null; entity_id: string | null; display_name: string | null }>(
      `select c.sha,c.author_external_id,c.committed_at,i.entity_id,e.display_name
       from jina_ontology.commit_changes ch
       join jina_ontology.commits c on c.tenant_id=ch.tenant_id and c.repository=ch.repository and c.sha=ch.commit_sha
       left join jina_ontology.identities i on i.tenant_id=c.tenant_id and i.source='git-email' and i.external_id=c.author_external_id and i.status='accepted'
       left join jina_ontology.entities e on e.id=i.entity_id
       where ch.tenant_id=$1 and ch.repository=$2 and (ch.path=$3 or ch.old_path=$3) and c.author_external_id is not null
       order by c.committed_at desc nulls last limit $4`, [request.tenantId, request.repository, request.path, limit - items.length]
    );
    const seenAuthors = new Set<string>();
    const uniqueAuthors = authors.rows.filter((row) => {
      const key = row.entity_id ? resolveRedirect(mapping, row.entity_id) : row.author_external_id;
      return seenAuthors.has(key) ? false : (seenAuthors.add(key), true);
    });
    items.push(...uniqueAuthors.map((row, index): RetrievalItem => ({
      kind: "recent_author", title: (row.entity_id ? names.get(resolveRedirect(mapping, row.entity_id))?.display_name : undefined) ?? row.display_name ?? row.author_external_id,
      data: { authorExternalId: row.author_external_id, ...(row.committed_at ? { committedAt: row.committed_at.toISOString() } : {}) }, score: 1 / (index + 1),
      citations: [{ kind: "commit_change", id: `${row.sha}:${request.path}`, repository: request.repository, commitSha: row.sha, path: request.path! }]
    })));
  }
  return items.slice(0, limit);
}

function ownershipAuthority(row: { readonly generator: string | null; readonly asserted_by: string | null }): number {
  if (row.asserted_by) return 0;
  if (row.generator === "source:codeowners") return 1;
  return 2;
}

function codeownersPatternMatches(rawPattern: string, path: string): boolean {
  const pattern = rawPattern.trim();
  if (!pattern || pattern.startsWith("!")) return false;
  const anchored = pattern.startsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "/**");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\uE000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\uE000/g, ".*");
  if (!anchored && !normalized.includes("/")) return new RegExp(`(?:^|/)${escaped}$`).test(path);
  return new RegExp(`^${escaped}$`).test(path);
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

function cosine(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let product = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    product += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return product / ((Math.sqrt(leftNorm) || 1) * (Math.sqrt(rightNorm) || 1));
}

export const ONTOLOGY_SCHEMA_SQL = `
      create schema if not exists jina_ontology;
      drop table if exists jina_ontology.commit_files;
      drop table if exists jina_ontology.model_outputs;
      drop table if exists jina_ontology.issue_traces;
      create table if not exists jina_ontology.graphs (
        id text primary key,
        tenant_id text not null,
        repository text not null,
        ref text not null,
        commit_sha text not null,
        generated_at timestamptz not null,
        executor text not null check (executor in ('daytona','fixture','projection')),
        model text not null,
        sandbox_id text,
        summary text not null
      );
      alter table jina_ontology.graphs drop constraint if exists graphs_executor_check;
      alter table jina_ontology.graphs add constraint graphs_executor_check check (executor in ('daytona','fixture','projection'));
      create index if not exists ontology_graphs_tenant_generated
        on jina_ontology.graphs (tenant_id, generated_at desc);
      create table if not exists jina_ontology.graph_heads (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        graph_id text not null references jina_ontology.graphs(id) on delete cascade,
        updated_at timestamptz not null,
        primary key (tenant_id,repository,ref_name)
      );
      create table if not exists jina_ontology.nodes (
        graph_id text not null references jina_ontology.graphs(id) on delete cascade,
        node_id text not null,
        kind text not null,
        label text not null,
        description text not null,
        path text,
        evidence jsonb not null,
        primary key (graph_id, node_id)
      );
      alter table jina_ontology.nodes drop constraint if exists ontology_nodes_kind_check;
      alter table jina_ontology.nodes add constraint ontology_nodes_kind_check check (kind in (
        'Repository','File','Symbol','Commit','PullRequest','Issue','Engineer','Team','Document','Feature',
        'Package','Service','Deployment','Incident','VirtualIssue'
      ));
      create index if not exists ontology_nodes_graph_kind_description
        on jina_ontology.nodes (graph_id,kind,description);
      create table if not exists jina_ontology.edges (
        graph_id text not null references jina_ontology.graphs(id) on delete cascade,
        edge_id text not null,
        source_node_id text not null,
        target_node_id text not null,
        predicate text not null,
        plane text not null check (plane in ('code','knowledge')),
        confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
        why text,
        qualifiers jsonb not null default '{}'::jsonb,
        evidence jsonb not null,
        primary key (graph_id, edge_id),
        foreign key (graph_id, source_node_id) references jina_ontology.nodes(graph_id, node_id),
        foreign key (graph_id, target_node_id) references jina_ontology.nodes(graph_id, node_id)
      );
      alter table jina_ontology.edges add column if not exists confidence double precision;
      alter table jina_ontology.edges add column if not exists why text;
      alter table jina_ontology.edges add column if not exists qualifiers jsonb not null default '{}'::jsonb;
      alter table jina_ontology.edges drop constraint if exists edges_confidence_check;
      alter table jina_ontology.edges add constraint edges_confidence_check
        check (confidence is null or (confidence >= 0 and confidence <= 1));
      create index if not exists ontology_edges_graph_predicate_source
        on jina_ontology.edges (graph_id,predicate,source_node_id);
      create index if not exists ontology_edges_graph_predicate_target
        on jina_ontology.edges (graph_id,predicate,target_node_id);
      create table if not exists jina_ontology.observations (
        id text primary key,
        tenant_id text not null,
        source text not null,
        type text not null check (type in ('source_event','source_snapshot','analysis_result','human_input','model_output','tombstone')),
        external_id text,
        repository text,
        recorded_at timestamptz not null,
        payload jsonb,
        payload_sha text not null,
        redacted_at timestamptz,
        redaction_reason text,
        unique (tenant_id,source,external_id)
      );
      alter table jina_ontology.observations add column if not exists occurred_at timestamptz;
      alter table jina_ontology.observations drop constraint if exists observations_supersedes_same_tenant;
      alter table jina_ontology.observations drop constraint if exists observations_supersedes_id_fkey;
      alter table jina_ontology.observations drop column if exists supersedes_id;
      create index if not exists ontology_observations_work_item
        on jina_ontology.observations (tenant_id,repository,source,((payload->>'kind')),((payload->>'number')))
        where redacted_at is null and payload is not null;
      create table if not exists jina_ontology.commits (
        tenant_id text not null,
        repository text not null,
        sha text not null,
        tree_sha text not null,
        parents text[] not null,
        source_observation_id text not null references jina_ontology.observations(id),
        primary key (tenant_id,repository,sha)
      );
      alter table jina_ontology.commits add column if not exists author_external_id text;
      alter table jina_ontology.commits add column if not exists committed_at timestamptz;
      alter table jina_ontology.commits add column if not exists message text;
      alter table jina_ontology.commits add column if not exists tree_paths text[] not null default '{}';
      alter table jina_ontology.commits add column if not exists tree_blob_shas text[] not null default '{}';
      alter table jina_ontology.commits add column if not exists tree_recorded boolean not null default false;
      alter table jina_ontology.commits drop constraint if exists commits_tree_arrays_match;
      alter table jina_ontology.commits add constraint commits_tree_arrays_match
        check (cardinality(tree_paths)=cardinality(tree_blob_shas));
      create table if not exists jina_ontology.refs (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        commit_sha text not null,
        updated_at timestamptz not null,
        primary key (tenant_id,repository,ref_name)
      );
      alter table jina_ontology.refs add column if not exists is_default boolean not null default false;
      insert into jina_ontology.graph_heads (tenant_id,repository,ref_name,graph_id,updated_at)
      select ref.tenant_id,ref.repository,ref.ref_name,graph.id,graph.generated_at
      from jina_ontology.refs ref
      join lateral (
        select candidate.id,candidate.generated_at
        from jina_ontology.graphs candidate
        where candidate.tenant_id=ref.tenant_id and candidate.repository=ref.repository
          and candidate.ref=ref.ref_name and candidate.commit_sha=ref.commit_sha and candidate.executor='projection'
        order by candidate.generated_at desc,candidate.id
        limit 1
      ) graph on true
      on conflict (tenant_id,repository,ref_name) do nothing;
      create table if not exists jina_ontology.blobs (
        tenant_id text not null,
        blob_sha text not null,
        byte_size integer not null,
        primary key (tenant_id,blob_sha)
      );
      create table if not exists jina_ontology.commit_changes (
        tenant_id text not null,
        repository text not null,
        commit_sha text not null,
        path text not null,
        change text not null check (change in ('add','modify','delete','rename')),
        old_path text,
        old_blob_sha text,
        new_blob_sha text,
        primary key (tenant_id,repository,commit_sha,path,change),
        foreign key (tenant_id,repository,commit_sha) references jina_ontology.commits(tenant_id,repository,sha)
      );
      create index if not exists ontology_commit_changes_path
        on jina_ontology.commit_changes (tenant_id,repository,path,commit_sha);
      create or replace function jina_ontology.commit_manifest(
        p_tenant_id text,
        p_repository text,
        p_commit_sha text
      ) returns table(path text,blob_sha text)
      language sql stable parallel safe
      as $manifest$
        with recursive target as (
          select tree_paths,tree_blob_shas,tree_recorded
          from jina_ontology.commits
          where tenant_id=p_tenant_id and repository=p_repository and sha=p_commit_sha
        ), exact_tree as (
          select entry.path,entry.blob_sha
          from target
          cross join lateral unnest(target.tree_paths,target.tree_blob_shas) as entry(path,blob_sha)
          where target.tree_recorded
        ), ancestry(sha,depth,visited) as (
          select p_commit_sha,0,array[p_commit_sha]
          where not coalesce((select tree_recorded from target),false)
          union all
          select commit.parents[1],ancestry.depth+1,ancestry.visited || commit.parents[1]
          from ancestry
          join jina_ontology.commits commit
            on commit.tenant_id=p_tenant_id and commit.repository=p_repository and commit.sha=ancestry.sha
          where cardinality(commit.parents)>0 and not commit.parents[1]=any(ancestry.visited)
        ), events as (
          select ancestry.depth,change.path,
                 case when change.change='delete' then null else change.new_blob_sha end as blob_sha
          from ancestry
          join jina_ontology.commit_changes change
            on change.tenant_id=p_tenant_id and change.repository=p_repository and change.commit_sha=ancestry.sha
          union all
          select ancestry.depth,change.old_path as path,null as blob_sha
          from ancestry
          join jina_ontology.commit_changes change
            on change.tenant_id=p_tenant_id and change.repository=p_repository and change.commit_sha=ancestry.sha
          where change.change='rename' and change.old_path is not null
        ), latest as (
          select events.path,events.blob_sha,
                 row_number() over (partition by events.path order by events.depth) as position
          from events
        )
        select exact_tree.path,exact_tree.blob_sha from exact_tree
        union all
        select latest.path,latest.blob_sha from latest
        where latest.position=1 and latest.blob_sha is not null
        order by path
      $manifest$;
      create table if not exists jina_ontology.blob_analyses (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        language text,
        parsed_at timestamptz not null default now(),
        primary key (tenant_id,blob_sha,parser_version),
        foreign key (tenant_id,blob_sha) references jina_ontology.blobs(tenant_id,blob_sha)
      );
      alter table jina_ontology.blob_analyses add column if not exists parsed_at timestamptz not null default now();
      create table if not exists jina_ontology.blob_symbols (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        moniker text not null,
        name text not null,
        kind text not null,
        start_line integer not null,
        end_line integer not null,
        primary key (tenant_id,blob_sha,parser_version,moniker),
        foreign key (tenant_id,blob_sha,parser_version) references jina_ontology.blob_analyses(tenant_id,blob_sha,parser_version)
      );
      alter table jina_ontology.blob_symbols add column if not exists signature_hash text;
      update jina_ontology.blob_symbols set signature_hash=md5(moniker) where signature_hash is null;
      create table if not exists jina_ontology.blob_imports (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        specifier text not null,
        line integer not null,
        primary key (tenant_id,blob_sha,parser_version,specifier,line),
        foreign key (tenant_id,blob_sha,parser_version) references jina_ontology.blob_analyses(tenant_id,blob_sha,parser_version)
      );
      create table if not exists jina_ontology.symbol_edges (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        from_moniker text not null,
        kind text not null check (kind in ('calls','imports','references','extends')),
        to_moniker text not null,
        start_line integer not null,
        end_line integer not null,
        primary key (tenant_id,blob_sha,parser_version,from_moniker,kind,to_moniker,start_line,end_line),
        foreign key (tenant_id,blob_sha,parser_version) references jina_ontology.blob_analyses(tenant_id,blob_sha,parser_version)
      );
      create table if not exists jina_ontology.entities (
        id text primary key,
        tenant_id text not null,
        kind text not null,
        natural_key text not null,
        display_name text not null,
        created_at timestamptz not null default now(),
        retired_at timestamptz,
        unique (tenant_id,kind,natural_key)
      );
      alter table jina_ontology.entities drop constraint if exists ontology_entities_kind_check;
      alter table jina_ontology.entities add constraint ontology_entities_kind_check check (kind in (
        'Repository','File','Symbol','Commit','PullRequest','Issue','Engineer','Team','Document','Feature',
        'Package','Service','Deployment','Incident','VirtualIssue'
      ));
      create table if not exists jina_ontology.identities (
        id text primary key,
        tenant_id text not null,
        source text not null,
        external_id text not null,
        entity_id text not null references jina_ontology.entities(id),
        status text not null check (status in ('proposed','accepted','rejected','erased')),
        confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
        source_observation_id text references jina_ontology.observations(id),
        created_at timestamptz not null,
        unique (tenant_id,source,external_id,entity_id)
      );
      create unique index if not exists ontology_identities_one_accepted
        on jina_ontology.identities (tenant_id,source,external_id) where status='accepted';
      create table if not exists jina_ontology.audit_log (
        id text primary key,
        tenant_id text not null,
        actor_id text not null,
        action text not null,
        input jsonb not null,
        result text not null check (result in ('accepted','rejected')),
        reason text,
        parent_audit_id text references jina_ontology.audit_log(id),
        created_at timestamptz not null
      );
      create table if not exists jina_ontology.entity_redirects (
        id text primary key,
        tenant_id text not null,
        from_entity_id text not null references jina_ontology.entities(id),
        to_entity_id text not null references jina_ontology.entities(id),
        kind text not null check (kind in ('merge','unmerge')),
        audit_id text not null references jina_ontology.audit_log(id),
        created_at timestamptz not null,
        check (from_entity_id <> to_entity_id)
      );
      create table if not exists jina_ontology.assertions (
        id text primary key,
        tenant_id text not null,
        repository text not null,
        commit_sha text not null,
        subject_id text not null references jina_ontology.entities(id),
        subject_kind text not null,
        subject_natural_key text not null,
        subject_label text not null,
        predicate text not null,
        object_id text not null references jina_ontology.entities(id),
        object_kind text not null,
        object_natural_key text not null,
        object_label text not null,
        status text not null check (status in ('proposed','active','rejected','superseded','retracted')),
        confidence double precision not null check (confidence >= 0 and confidence <= 1),
        evidence jsonb not null,
        source_observation_id text not null,
        generator_version text not null,
        registry_version text not null,
        recorded_at timestamptz not null
      );
      create index if not exists ontology_assertions_current
        on jina_ontology.assertions (tenant_id,repository,commit_sha,status);
      alter table jina_ontology.assertions alter column object_id drop not null;
      alter table jina_ontology.assertions alter column source_observation_id drop not null;
      alter table jina_ontology.assertions alter column object_kind drop not null;
      alter table jina_ontology.assertions alter column object_natural_key drop not null;
      alter table jina_ontology.assertions alter column object_label drop not null;
      alter table jina_ontology.assertions alter column confidence drop not null;
      alter table jina_ontology.assertions add column if not exists literal_type text;
      alter table jina_ontology.assertions add column if not exists explanation text;
      alter table jina_ontology.assertions add column if not exists literal_value jsonb;
      alter table jina_ontology.assertions add column if not exists qualifiers jsonb not null default '{}'::jsonb;
      update jina_ontology.assertions
        set explanation=qualifiers->>'reason'
        where explanation is null and nullif(btrim(qualifiers->>'reason'),'') is not null;
      create or replace function jina_ontology.enforce_assertion_explanation()
      returns trigger language plpgsql as $$
      begin
        if new.explanation is null or btrim(new.explanation) = '' then
          raise exception 'assertion explanation is required';
        end if;
        if tg_op = 'UPDATE' and old.explanation is not null and new.explanation is distinct from old.explanation then
          raise exception 'assertion explanation is immutable';
        end if;
        return new;
      end;
      $$;
      drop trigger if exists ontology_assertion_explanation_guard on jina_ontology.assertions;
      create trigger ontology_assertion_explanation_guard
        before insert or update of explanation on jina_ontology.assertions
        for each row execute function jina_ontology.enforce_assertion_explanation();
      alter table jina_ontology.assertions add column if not exists qualifiers_hash text not null default 'q_empty';
      alter table jina_ontology.assertions add column if not exists asserted_by text;
      alter table jina_ontology.assertions add column if not exists generator text;
      alter table jina_ontology.assertions add column if not exists valid_from timestamptz;
      alter table jina_ontology.assertions add column if not exists valid_to timestamptz;
      alter table jina_ontology.assertions add column if not exists last_confirmed_at timestamptz;
      alter table jina_ontology.assertions add column if not exists superseded_by text references jina_ontology.assertions(id);
      alter table jina_ontology.assertions add column if not exists audit_id text references jina_ontology.audit_log(id);
      update jina_ontology.assertions set last_confirmed_at=recorded_at where last_confirmed_at is null;
      drop index if exists jina_ontology.ontology_assertions_cardinality;
      create index if not exists ontology_assertions_cardinality_repository
        on jina_ontology.assertions (tenant_id,repository,subject_id,predicate,qualifiers_hash,status);
      create index if not exists ontology_assertions_active_subject
        on jina_ontology.assertions (tenant_id,repository,subject_id,predicate) where status='active';
      create index if not exists ontology_assertions_active_object
        on jina_ontology.assertions (tenant_id,repository,object_id,predicate) where status='active';
      create table if not exists jina_ontology.assertion_relations (
        id text primary key,
        tenant_id text not null,
        source_assertion_id text not null references jina_ontology.assertions(id),
        relation text not null check (relation in ('supports','contradicts')),
        target_assertion_id text not null references jina_ontology.assertions(id),
        evidence_observation_id text not null references jina_ontology.observations(id),
        created_at timestamptz not null,
        check (source_assertion_id <> target_assertion_id),
        unique (tenant_id,source_assertion_id,relation,target_assertion_id,evidence_observation_id)
      );
      create index if not exists ontology_assertion_relations_source
        on jina_ontology.assertion_relations (tenant_id,source_assertion_id,relation);
      create index if not exists ontology_assertion_relations_target
        on jina_ontology.assertion_relations (tenant_id,target_assertion_id,relation);
      create table if not exists jina_ontology.outbox (
        id text primary key,
        tenant_id text not null,
        event_type text not null,
        consumer text not null default 'legacy',
        aggregate_id text not null,
        payload jsonb not null,
        created_at timestamptz not null,
        available_at timestamptz not null,
        claimed_by text,
        claimed_at timestamptz,
        claim_expires_at timestamptz,
        processed_at timestamptz,
        attempts integer not null default 0,
        last_error text
      );
      alter table jina_ontology.outbox add column if not exists consumer text not null default 'legacy';
      alter table jina_ontology.outbox drop constraint if exists ontology_outbox_consumer_check;
      alter table jina_ontology.outbox add constraint ontology_outbox_consumer_check
        check (consumer in ('legacy','manifest','search','reconciliation','graph'));
      drop index if exists jina_ontology.ontology_outbox_claim;
      create index ontology_outbox_claim
        on jina_ontology.outbox (consumer,available_at,created_at) where processed_at is null;
      create table if not exists jina_ontology.ref_manifest (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        commit_sha text not null,
        path text not null,
        blob_sha text not null,
        projected_at timestamptz not null,
        primary key (tenant_id,repository,ref_name,path)
      );
      create index if not exists ontology_ref_manifest_blob on jina_ontology.ref_manifest (tenant_id,repository,ref_name,blob_sha);
      create table if not exists jina_ontology.search_documents (
        id text primary key,
        tenant_id text not null,
        repository text not null,
        source_kind text not null,
        source_id text not null,
        title text not null,
        body text not null,
        search_vector tsvector generated always as (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) stored,
        embedding double precision[],
        projected_at timestamptz not null,
        unique (tenant_id,source_kind,source_id)
      );
      alter table jina_ontology.search_documents
        drop constraint if exists search_documents_tenant_id_source_kind_source_id_key;
      create unique index if not exists ontology_search_documents_scoped_source
        on jina_ontology.search_documents (tenant_id,repository,source_kind,source_id);
      create index if not exists ontology_search_documents_lexical on jina_ontology.search_documents using gin(search_vector);
      create table if not exists jina_ontology.retrieval_metrics (
        id bigint generated always as identity primary key,
        tenant_id text not null,
        repository text not null,
        template text not null,
        duration_ms double precision not null check (duration_ms>=0),
        truncated boolean not null,
        recorded_at timestamptz not null
      );
      create index if not exists ontology_retrieval_metrics_recent
        on jina_ontology.retrieval_metrics (tenant_id,recorded_at desc,template);
      create table if not exists jina_ontology.erasure_filters (
        id text primary key,
        tenant_id text not null,
        kind text not null check (kind in ('identity','observation','commit','repository')),
        value text not null,
        audit_id text not null references jina_ontology.audit_log(id),
        created_at timestamptz not null,
        unique (tenant_id,kind,value)
      );
      create table if not exists jina_ontology.repository_acl (
        tenant_id text not null,
        repository text not null,
        principal_id text not null,
        role text not null check (role in ('reader','writer','admin')),
        created_at timestamptz not null default now(),
        primary key (tenant_id,repository,principal_id)
      );
      create unique index if not exists ontology_observations_tenant_identity
        on jina_ontology.observations (tenant_id,id);
      create unique index if not exists ontology_entities_tenant_identity
        on jina_ontology.entities (tenant_id,id);
      create unique index if not exists ontology_audit_tenant_identity
        on jina_ontology.audit_log (tenant_id,id);
      create unique index if not exists ontology_assertions_tenant_identity
        on jina_ontology.assertions (tenant_id,id);
      drop index if exists jina_ontology.ontology_assertions_one_active;
      create unique index if not exists ontology_assertions_one_active_repository
        on jina_ontology.assertions (tenant_id,repository,subject_id,predicate,qualifiers_hash)
        where status='active' and predicate in ('OWNED_BY','MERGED_AS','MOVED_FROM');
      drop index if exists jina_ontology.ontology_assertions_one_live_candidate;
      create unique index if not exists ontology_assertions_one_live_candidate_repository
        on jina_ontology.assertions (tenant_id,repository,subject_id,predicate,object_id,qualifiers_hash)
        where status in ('proposed','active');
      do $$ begin
        if not exists (select 1 from pg_constraint where conname='commits_observation_same_tenant') then
          alter table jina_ontology.commits add constraint commits_observation_same_tenant
            foreign key (tenant_id,source_observation_id) references jina_ontology.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='refs_commit_same_tenant_repository') then
          alter table jina_ontology.refs add constraint refs_commit_same_tenant_repository
            foreign key (tenant_id,repository,commit_sha) references jina_ontology.commits(tenant_id,repository,sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='commit_changes_old_blob_same_tenant') then
          alter table jina_ontology.commit_changes add constraint commit_changes_old_blob_same_tenant
            foreign key (tenant_id,old_blob_sha) references jina_ontology.blobs(tenant_id,blob_sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='commit_changes_new_blob_same_tenant') then
          alter table jina_ontology.commit_changes add constraint commit_changes_new_blob_same_tenant
            foreign key (tenant_id,new_blob_sha) references jina_ontology.blobs(tenant_id,blob_sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='identities_entity_same_tenant') then
          alter table jina_ontology.identities add constraint identities_entity_same_tenant
            foreign key (tenant_id,entity_id) references jina_ontology.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='identities_observation_same_tenant') then
          alter table jina_ontology.identities add constraint identities_observation_same_tenant
            foreign key (tenant_id,source_observation_id) references jina_ontology.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='audit_parent_same_tenant') then
          alter table jina_ontology.audit_log add constraint audit_parent_same_tenant
            foreign key (tenant_id,parent_audit_id) references jina_ontology.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='redirect_from_entity_same_tenant') then
          alter table jina_ontology.entity_redirects add constraint redirect_from_entity_same_tenant
            foreign key (tenant_id,from_entity_id) references jina_ontology.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='redirect_to_entity_same_tenant') then
          alter table jina_ontology.entity_redirects add constraint redirect_to_entity_same_tenant
            foreign key (tenant_id,to_entity_id) references jina_ontology.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='redirect_audit_same_tenant') then
          alter table jina_ontology.entity_redirects add constraint redirect_audit_same_tenant
            foreign key (tenant_id,audit_id) references jina_ontology.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_subject_same_tenant') then
          alter table jina_ontology.assertions add constraint assertions_subject_same_tenant
            foreign key (tenant_id,subject_id) references jina_ontology.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_object_same_tenant') then
          alter table jina_ontology.assertions add constraint assertions_object_same_tenant
            foreign key (tenant_id,object_id) references jina_ontology.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_observation_same_tenant') then
          alter table jina_ontology.assertions add constraint assertions_observation_same_tenant
            foreign key (tenant_id,source_observation_id) references jina_ontology.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_superseded_same_tenant') then
          alter table jina_ontology.assertions add constraint assertions_superseded_same_tenant
            foreign key (tenant_id,superseded_by) references jina_ontology.assertions(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_audit_same_tenant') then
          alter table jina_ontology.assertions add constraint assertions_audit_same_tenant
            foreign key (tenant_id,audit_id) references jina_ontology.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertion_relations_source_same_tenant') then
          alter table jina_ontology.assertion_relations add constraint assertion_relations_source_same_tenant
            foreign key (tenant_id,source_assertion_id) references jina_ontology.assertions(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertion_relations_target_same_tenant') then
          alter table jina_ontology.assertion_relations add constraint assertion_relations_target_same_tenant
            foreign key (tenant_id,target_assertion_id) references jina_ontology.assertions(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertion_relations_evidence_same_tenant') then
          alter table jina_ontology.assertion_relations add constraint assertion_relations_evidence_same_tenant
            foreign key (tenant_id,evidence_observation_id) references jina_ontology.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='erasure_audit_same_tenant') then
          alter table jina_ontology.erasure_filters add constraint erasure_audit_same_tenant
            foreign key (tenant_id,audit_id) references jina_ontology.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='manifest_commit_same_tenant_repository') then
          alter table jina_ontology.ref_manifest add constraint manifest_commit_same_tenant_repository
            foreign key (tenant_id,repository,commit_sha) references jina_ontology.commits(tenant_id,repository,sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='manifest_blob_same_tenant') then
          alter table jina_ontology.ref_manifest add constraint manifest_blob_same_tenant
            foreign key (tenant_id,blob_sha) references jina_ontology.blobs(tenant_id,blob_sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_exactly_one_provenance') then
          alter table jina_ontology.assertions add constraint assertions_exactly_one_provenance
            check ((source_observation_id is null) <> (asserted_by is null)) not valid;
        end if;
      end $$;
    `;
