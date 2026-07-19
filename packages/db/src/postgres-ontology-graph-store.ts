import {
  ONTOLOGY_PARSER_VERSION,
  assertionObservationId,
  createOntologyProjection,
  knowledgeCheckpoint,
  normalizeAssertionBatchLenient,
  sourceObservationId,
  stableId,
  type BlobAnalysis,
  type OntologyAssertionBatch,
  type OntologyAssertionResult,
  type OntologyEdge,
  type OntologyGraph,
  type OntologyGraphStore,
  type OntologyIngestPlan,
  type OntologyNode,
  type OntologyProjectionRequest,
  type RepositorySnapshot,
  type StoredAssertion
} from "@jina/ontology";
import { Pool, type PoolClient, type PoolConfig } from "pg";

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
  evidence: readonly string[];
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
  subject_kind: StoredAssertion["subject"]["kind"];
  subject_natural_key: string;
  subject_label: string;
  predicate: string;
  object_kind: StoredAssertion["object"]["kind"];
  object_natural_key: string;
  object_label: string;
  status: StoredAssertion["status"];
  confidence: number;
  evidence: string[];
  source_observation_id: string;
  generator_version: string;
  registry_version: string;
  recorded_at: Date;
}

export class PostgresOntologyGraphStore implements OntologyGraphStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(config: PoolConfig) {
    this.pool = new Pool({ ...config, application_name: "jina-ontology", max: config.max ?? 5 });
  }

  async save(graph: OntologyGraph): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await insertOntologyGraph(client, graph);
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

  async planIngestion(snapshot: RepositorySnapshot): Promise<OntologyIngestPlan> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const observationId = sourceObservationId(snapshot);
      await client.query(
        `insert into jina_ontology.observations
          (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
         values ($1,$2,'git','source_snapshot',$3,$4,$5,$6::jsonb,$7)
         on conflict (id) do nothing`,
        [observationId, snapshot.tenantId, `${snapshot.repository}:${snapshot.commitSha}`, snapshot.repository,
          snapshot.recordedAt, JSON.stringify(snapshot), stableId("sha", JSON.stringify(snapshot))]
      );
      await client.query(
        `insert into jina_ontology.commits (tenant_id,repository,sha,tree_sha,parents,source_observation_id)
         values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
        [snapshot.tenantId, snapshot.repository, snapshot.commitSha, snapshot.treeSha, snapshot.parents, observationId]
      );
      await client.query(
        `insert into jina_ontology.refs (tenant_id,repository,ref_name,commit_sha,updated_at)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id,repository,ref_name) do update
         set commit_sha=excluded.commit_sha, updated_at=excluded.updated_at`,
        [snapshot.tenantId, snapshot.repository, snapshot.ref, snapshot.commitSha, snapshot.recordedAt]
      );
      if (snapshot.files.length > 0) {
        const uniqueBlobs = [...new Map(snapshot.files.map((file) => [file.blobSha, file.size])).entries()];
        await client.query(
          `insert into jina_ontology.blobs (tenant_id,blob_sha,byte_size)
           select $1,source.blob_sha,source.byte_size
           from unnest($2::text[],$3::integer[]) as source(blob_sha,byte_size)
           on conflict do nothing`,
          [snapshot.tenantId, uniqueBlobs.map(([sha]) => sha), uniqueBlobs.map(([, size]) => size)]
        );
        await client.query(
          `insert into jina_ontology.commit_files (tenant_id,repository,commit_sha,path,blob_sha)
           select $1,$2,$3,source.path,source.blob_sha
           from unnest($4::text[],$5::text[]) as source(path,blob_sha)
           on conflict do nothing`,
          [snapshot.tenantId, snapshot.repository, snapshot.commitSha,
            snapshot.files.map((file) => file.path), snapshot.files.map((file) => file.blobSha)]
        );
      }
      const missing = await client.query<{ blob_sha: string; path: string; byte_size: number }>(
        `select distinct on (f.blob_sha) f.blob_sha, f.path, b.byte_size
         from jina_ontology.commit_files f
         join jina_ontology.blobs b on b.tenant_id=f.tenant_id and b.blob_sha=f.blob_sha
         left join jina_ontology.blob_analyses a
           on a.tenant_id=f.tenant_id and a.blob_sha=f.blob_sha and a.parser_version=$4
         where f.tenant_id=$1 and f.repository=$2 and f.commit_sha=$3 and a.blob_sha is null
         order by f.blob_sha, f.path`,
        [snapshot.tenantId, snapshot.repository, snapshot.commitSha, ONTOLOGY_PARSER_VERSION]
      );
      const parentFiles = snapshot.parents[0]
        ? await client.query<{ path: string; blob_sha: string }>(
            `select path,blob_sha from jina_ontology.commit_files
             where tenant_id=$1 and repository=$2 and commit_sha=$3`,
            [snapshot.tenantId, snapshot.repository, snapshot.parents[0]]
          )
        : { rows: [] as { path: string; blob_sha: string }[] };
      await client.query("commit");
      const discoveredBlobCount = new Set(snapshot.files.map((file) => file.blobSha)).size;
      const parentBlobByPath = new Map(parentFiles.rows.map((file) => [file.path, file.blob_sha]));
      return {
        observationId,
        commitSha: snapshot.commitSha,
        fileCount: snapshot.files.length,
        discoveredBlobCount,
        reusedBlobCount: discoveredBlobCount - missing.rows.length,
        changedPaths: snapshot.files
          .filter((file) => parentBlobByPath.get(file.path) !== file.blobSha)
          .map((file) => file.path)
          .sort(),
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
      for (const analysis of analyses) {
        const known = await client.query(
          `select 1 from jina_ontology.commit_files
           where tenant_id=$1 and repository=$2 and commit_sha=$3 and blob_sha=$4 limit 1`,
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
              (tenant_id,blob_sha,parser_version,moniker,name,kind,start_line,end_line)
             values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
            [scope.tenantId, analysis.blobSha, analysis.parserVersion, symbol.moniker, symbol.name,
              symbol.kind, symbol.startLine, symbol.endLine]
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
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string
  ): Promise<OntologyAssertionResult | undefined> {
    await this.initialize();
    const observationId = assertionObservationId({ tenantId, repository, commitSha, generatorVersion });
    const generated = await this.pool.query("select 1 from jina_ontology.model_outputs where observation_id=$1", [observationId]);
    if (generated.rowCount !== 1) return undefined;
    return this.assertionResult(tenantId, repository, commitSha, generatorVersion, observationId, true);
  }

  async saveAssertionBatch(batch: OntologyAssertionBatch): Promise<OntologyAssertionResult> {
    await this.initialize();
    const normalized = normalizeAssertionBatchLenient(batch);
    const assertions = normalized.assertions;
    const observationId = assertionObservationId(batch);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        `insert into jina_ontology.model_outputs
          (observation_id,tenant_id,repository,commit_sha,generator_version,registry_version,model,summary,generated_at,payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         on conflict do nothing returning observation_id`,
        [observationId, batch.tenantId, batch.repository, batch.commitSha, batch.generatorVersion,
          batch.registryVersion, batch.model, batch.summary, batch.generatedAt, JSON.stringify(batch)]
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `insert into jina_ontology.observations
            (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
           values ($1,$2,$3,'model_output',$4,$5,$6,$7::jsonb,$8) on conflict do nothing`,
          [observationId, batch.tenantId, `model:${batch.model}`, `${batch.repository}:${batch.commitSha}:${batch.generatorVersion}`,
            batch.repository, batch.generatedAt, JSON.stringify(batch), stableId("sha", JSON.stringify(batch))]
        );
        for (const assertion of assertions) {
          const subjectId = await ensureEntity(client, batch.tenantId, assertion.subject);
          const objectId = await ensureEntity(client, batch.tenantId, assertion.object);
          await client.query(
            `insert into jina_ontology.assertions
              (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
               predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
               source_observation_id,generator_version,registry_version,recorded_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20)
             on conflict do nothing`,
            [assertion.id, assertion.tenantId, assertion.repository, assertion.commitSha,
              subjectId, assertion.subject.kind, assertion.subject.naturalKey, assertion.subject.label,
              assertion.predicate, objectId, assertion.object.kind, assertion.object.naturalKey, assertion.object.label,
              assertion.status, assertion.confidence, JSON.stringify(assertion.evidence), assertion.sourceObservationId,
              assertion.generatorVersion, assertion.registryVersion, assertion.recordedAt]
          );
        }
      }
      await client.query("commit");
      const result = await this.assertionResult(
        batch.tenantId,
        batch.repository,
        batch.commitSha,
        batch.generatorVersion,
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
    const commit = await this.pool.query<{ tree_sha: string; parents: string[]; source_observation_id: string }>(
      `select tree_sha,parents,source_observation_id from jina_ontology.commits
       where tenant_id=$1 and repository=$2 and sha=$3`,
      [request.tenantId, request.repository, request.commitSha]
    );
    if (!commit.rows[0]) throw new Error("cannot project an ontology before repository ingestion");
    const filesResult = await this.pool.query<{ path: string; blob_sha: string; byte_size: number }>(
      `select f.path,f.blob_sha,b.byte_size from jina_ontology.commit_files f
       join jina_ontology.blobs b on b.tenant_id=f.tenant_id and b.blob_sha=f.blob_sha
       where f.tenant_id=$1 and f.repository=$2 and f.commit_sha=$3 order by f.path`,
      [request.tenantId, request.repository, request.commitSha]
    );
    const analyses = await this.loadAnalyses(request.tenantId, [...new Set(filesResult.rows.map((row) => row.blob_sha))]);
    const [assertionRows, assertionFiles] = await Promise.all([
      this.pool.query<StoredAssertionRow>(
      `select * from jina_ontology.assertions
       where tenant_id=$1 and repository=$2 and status='active' order by recorded_at,id`,
      [request.tenantId, request.repository]
      ),
      this.pool.query<{ commit_sha: string; path: string; blob_sha: string }>(
        `select commit_sha,path,blob_sha from jina_ontology.commit_files where tenant_id=$1 and repository=$2`,
        [request.tenantId, request.repository]
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
      applicableAssertions(assertionRows.rows.map(storedAssertion), assertionFiles.rows, filesResult.rows),
      request
    );
    await this.save(graph);
    return graph;
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

  private async assertionResult(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string,
    observationId: string,
    cached: boolean
  ): Promise<OntologyAssertionResult> {
    const counts = await this.pool.query<{ status: string; count: string }>(
      `select status,count(*) from jina_ontology.assertions
       where tenant_id=$1 and repository=$2 and commit_sha=$3 and generator_version=$4 group by status`,
      [tenantId, repository, commitSha, generatorVersion]
    );
    const count = (status: string) => Number(counts.rows.find((row) => row.status === status)?.count ?? 0);
    return {
      observationId,
      assertionCount: counts.rows.reduce((total, row) => total + Number(row.count), 0),
      activeCount: count("active"),
      proposedCount: count("proposed"),
      knowledgeCheckpoint: knowledgeCheckpoint(tenantId, repository, commitSha, generatorVersion),
      cached,
      warnings: []
    };
  }

  private async loadAnalyses(tenantId: string, blobShas: readonly string[]): Promise<ReadonlyMap<string, BlobAnalysis>> {
    const analyses = new Map<string, BlobAnalysis>();
    if (blobShas.length === 0) return analyses;
    const [rows, symbols, imports] = await Promise.all([
      this.pool.query<{ blob_sha: string; parser_version: string; language: string | null }>(
        `select blob_sha,parser_version,language from jina_ontology.blob_analyses
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, ONTOLOGY_PARSER_VERSION]
      ),
      this.pool.query<{ blob_sha: string; parser_version: string; moniker: string; name: string; kind: string; start_line: number; end_line: number }>(
        `select blob_sha,parser_version,moniker,name,kind,start_line,end_line from jina_ontology.blob_symbols
         where tenant_id=$1 and blob_sha=any($2::text[]) and parser_version=$3`,
        [tenantId, blobShas, ONTOLOGY_PARSER_VERSION]
      ),
      this.pool.query<{ blob_sha: string; parser_version: string; specifier: string; line: number }>(
        `select blob_sha,parser_version,specifier,line from jina_ontology.blob_imports
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
          startLine: symbol.start_line,
          endLine: symbol.end_line
        })),
        imports: imports.rows.filter((item) => item.blob_sha === row.blob_sha).map((item) => ({ specifier: item.specifier, line: item.line }))
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
        evidence: edge.evidence
      }))
    };
  }

  private initialize(): Promise<void> {
    this.initialized ??= this.createSchema();
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
        (graph_id,edge_id,source_node_id,target_node_id,predicate,plane,confidence,evidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [graph.id, edge.id, edge.source, edge.target, edge.predicate, edge.plane,
        edge.confidence ?? null, JSON.stringify(edge.evidence)]
    );
  }
}

async function ensureEntity(client: PoolClient, tenantId: string, entity: StoredAssertion["subject"]): Promise<string> {
  const id = stableId("entity", `${tenantId}:${entity.kind}:${entity.naturalKey}`);
  await client.query(
    `insert into jina_ontology.entities (id,tenant_id,kind,natural_key,display_name)
     values ($1,$2,$3,$4,$5)
     on conflict (tenant_id,kind,natural_key) do update set display_name=excluded.display_name`,
    [id, tenantId, entity.kind, entity.naturalKey, entity.label]
  );
  return id;
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
    evidence: row.evidence,
    sourceObservationId: row.source_observation_id,
    generatorVersion: row.generator_version,
    registryVersion: row.registry_version,
    recordedAt: row.recorded_at.toISOString()
  };
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
    const current = assertion.evidence.every((citation) => {
      const path = citation.replace(/:\d+(?:-\d+)?$/, "");
      const sourceBlob = sourceMap.get(`${assertion.commitSha}:${path}`);
      return sourceBlob !== undefined && sourceBlob === currentMap.get(path);
    });
    if (!current) continue;
    const key = `${assertion.subject.kind}:${assertion.subject.naturalKey}:${assertion.predicate}:${assertion.object.kind}:${assertion.object.naturalKey}`;
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

export const ONTOLOGY_SCHEMA_SQL = `
      create schema if not exists jina_ontology;
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
      create table if not exists jina_ontology.edges (
        graph_id text not null references jina_ontology.graphs(id) on delete cascade,
        edge_id text not null,
        source_node_id text not null,
        target_node_id text not null,
        predicate text not null,
        plane text not null check (plane in ('code','knowledge')),
        confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
        evidence jsonb not null,
        primary key (graph_id, edge_id),
        foreign key (graph_id, source_node_id) references jina_ontology.nodes(graph_id, node_id),
        foreign key (graph_id, target_node_id) references jina_ontology.nodes(graph_id, node_id)
      );
      alter table jina_ontology.edges add column if not exists confidence double precision;
      alter table jina_ontology.edges drop constraint if exists edges_confidence_check;
      alter table jina_ontology.edges add constraint edges_confidence_check
        check (confidence is null or (confidence >= 0 and confidence <= 1));
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
      create table if not exists jina_ontology.commits (
        tenant_id text not null,
        repository text not null,
        sha text not null,
        tree_sha text not null,
        parents text[] not null,
        source_observation_id text not null references jina_ontology.observations(id),
        primary key (tenant_id,repository,sha)
      );
      create table if not exists jina_ontology.refs (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        commit_sha text not null,
        updated_at timestamptz not null,
        primary key (tenant_id,repository,ref_name)
      );
      create table if not exists jina_ontology.blobs (
        tenant_id text not null,
        blob_sha text not null,
        byte_size integer not null,
        primary key (tenant_id,blob_sha)
      );
      create table if not exists jina_ontology.commit_files (
        tenant_id text not null,
        repository text not null,
        commit_sha text not null,
        path text not null,
        blob_sha text not null,
        primary key (tenant_id,repository,commit_sha,path),
        foreign key (tenant_id,repository,commit_sha) references jina_ontology.commits(tenant_id,repository,sha),
        foreign key (tenant_id,blob_sha) references jina_ontology.blobs(tenant_id,blob_sha)
      );
      create index if not exists ontology_commit_files_blob on jina_ontology.commit_files (tenant_id,blob_sha);
      create table if not exists jina_ontology.blob_analyses (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        language text,
        parsed_at timestamptz not null default now(),
        primary key (tenant_id,blob_sha,parser_version),
        foreign key (tenant_id,blob_sha) references jina_ontology.blobs(tenant_id,blob_sha)
      );
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
      create table if not exists jina_ontology.blob_imports (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        specifier text not null,
        line integer not null,
        primary key (tenant_id,blob_sha,parser_version,specifier,line),
        foreign key (tenant_id,blob_sha,parser_version) references jina_ontology.blob_analyses(tenant_id,blob_sha,parser_version)
      );
      create table if not exists jina_ontology.model_outputs (
        observation_id text primary key,
        tenant_id text not null,
        repository text not null,
        commit_sha text not null,
        generator_version text not null,
        registry_version text not null,
        model text not null,
        summary text not null,
        generated_at timestamptz not null,
        payload jsonb not null,
        unique (tenant_id,repository,commit_sha,generator_version)
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
    `;
