import {
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  assertionObservationId,
  canonicalJson,
  computeCommitChanges,
  createOntologyProjection,
  knowledgeCheckpoint,
  normalizeAssertionBatchLenient,
  normalizeGitHubSourceObservation,
  sourceObservationId,
  stableId,
  predicateDefinition,
  validatePredicateEndpoints,
  validateQualifiers,
  type BlobAnalysis,
  type GitHubSourceObservation,
  type OntologyAssertionBatch,
  type OntologyAssertionResult,
  type OntologyCommand,
  type OntologyCommandResult,
  type OntologyEdge,
  type OntologyGraph,
  type OntologyGraphStore,
  type OntologyIngestPlan,
  type OntologyNode,
  type OntologyProjectionRequest,
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
      const repositoryFilter = await client.query(
        `select 1 from jina_ontology.erasure_filters where tenant_id=$1 and kind='repository' and value=$2`,
        [snapshot.tenantId, snapshot.repository]
      );
      if (repositoryFilter.rowCount) throw new Error("repository is tombstoned");
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
          (tenant_id,repository,sha,tree_sha,parents,author_external_id,committed_at,message,source_observation_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
        [snapshot.tenantId, snapshot.repository, snapshot.commitSha, snapshot.treeSha, snapshot.parents,
          authorExternalId ?? null, snapshot.committedAt ?? snapshot.recordedAt, message ?? null, observationId]
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

  async applyGitHubObservations(observations: readonly GitHubSourceObservation[]): Promise<{ readonly observationCount: number; readonly assertionCount: number }> {
    await this.initialize();
    const client = await this.pool.connect();
    let assertionCount = 0;
    try {
      await client.query("begin");
      for (const observation of observations) {
        const normalized = normalizeGitHubSourceObservation(observation);
        const externalId = observation.kind === "codeowners"
          ? `${observation.repository}:codeowners:${observation.commitSha}:${observation.path}`
          : `${observation.repository}:${observation.kind}:${observation.number}:${observation.occurredAt ?? observation.recordedAt}`;
        const observationId = stableId("observation", `${observation.tenantId}:github:${externalId}`);
        const payload = JSON.stringify(observation);
        const insertedObservation = await client.query(
          `insert into jina_ontology.observations
            (id,tenant_id,source,type,external_id,repository,occurred_at,recorded_at,payload,payload_sha)
           values ($1,$2,'github','source_snapshot',$3,$4,$5,$6,$7::jsonb,$8)
           on conflict (tenant_id,source,external_id) do nothing returning id`,
          [observationId, observation.tenantId, externalId, observation.repository, observation.kind === "codeowners" ? null : observation.occurredAt ?? null,
            observation.recordedAt, payload, stableId("sha", payload)]
        );
        if (insertedObservation.rowCount === 1) {
          await insertOutbox(client, observation.tenantId, "observation_recorded", observationId, {
            observationId, repoId: observation.repository
          }, observation.recordedAt);
        }
        const entityIds = new Map<string, string>();
        for (const entity of normalized.entities) {
          const id = await ensureEntity(client, observation.tenantId, {
            kind: entity.kind, naturalKey: entity.key, label: entity.displayName
          }, observation.recordedAt);
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
        for (const intent of normalized.assertions) {
          const subjectId = entityIds.get(`${intent.subject.kind}:${intent.subject.key}`)!;
          const objectId = entityIds.get(`${intent.object.kind}:${intent.object.key}`)!;
          const qualifiers = intent.qualifiers ?? {};
          const qualifiersHash = stableId("q", canonicalJson(qualifiers));
          const assertionId = stableId("assertion", `${observation.tenantId}:${subjectId}:${intent.predicate}:${objectId}:${qualifiersHash}`);
          if (predicateDefinition(intent.predicate).cardinality === "one") {
            await client.query(
              `update jina_ontology.assertions set status='superseded',valid_to=$5,superseded_by=$6
               where tenant_id=$1 and subject_id=$2 and predicate=$3 and qualifiers_hash=$4 and status='active' and id<>$6`,
              [observation.tenantId, subjectId, intent.predicate, qualifiersHash, observation.recordedAt, assertionId]
            );
          }
          const inserted = await client.query(
            `insert into jina_ontology.assertions
              (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
               object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,source_observation_id,
               generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,generator,last_confirmed_at)
             values ($1,$2,$3,'source',$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',1,'[]'::jsonb,$13,
               'github-normalizer-v1',$14,$15,$16::jsonb,$17,$18,$15)
             on conflict (id) do update set last_confirmed_at=excluded.last_confirmed_at
             returning id,(xmax=0) as created`,
            [assertionId, observation.tenantId, observation.repository, subjectId, intent.subject.kind, intent.subject.key,
              intent.subject.displayName, intent.predicate, objectId, intent.object.kind, intent.object.key,
              intent.object.displayName, observationId, ONTOLOGY_REGISTRY_VERSION, observation.recordedAt,
              JSON.stringify(qualifiers), qualifiersHash, observation.kind === "codeowners" ? "source:codeowners" : "source:github"]
          );
          assertionCount += inserted.rowCount ?? 0;
          if (inserted.rows[0]?.created === true) {
            await insertOutbox(client, observation.tenantId, "assertion_changed", assertionId, {
              assertionId, repoId: observation.repository, status: "active"
            }, observation.recordedAt);
          }
        }
      }
      await client.query("commit");
      return { observationCount: observations.length, assertionCount };
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
        await insertOutbox(client, batch.tenantId, "observation_recorded", observationId, {
          observationId, repoId: batch.repository
        }, batch.generatedAt);
        for (const assertion of assertions) {
          const subjectId = await ensureEntity(client, batch.tenantId, assertion.subject, batch.generatedAt);
          const objectId = await ensureEntity(client, batch.tenantId, assertion.object, batch.generatedAt);
          await client.query(
            `insert into jina_ontology.assertions
              (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
               predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
               source_observation_id,generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,generator,last_confirmed_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22,$23,$20)
             on conflict do nothing`,
            [assertion.id, assertion.tenantId, assertion.repository, assertion.commitSha,
              subjectId, assertion.subject.kind, assertion.subject.naturalKey, assertion.subject.label,
              assertion.predicate, objectId, assertion.object.kind, assertion.object.naturalKey, assertion.object.label,
              assertion.status, assertion.confidence, JSON.stringify(assertion.evidence), assertion.sourceObservationId,
              assertion.generatorVersion, assertion.registryVersion, assertion.recordedAt, JSON.stringify(assertion.qualifiers ?? {}),
              stableId("q", canonicalJson(assertion.qualifiers ?? {})), `model:${assertion.generatorVersion}`]
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
    const [assertionRows, assertionFiles, redirectRows, entityRows] = await Promise.all([
      this.pool.query<StoredAssertionRow>(
      `select * from jina_ontology.assertions
       where tenant_id=$1 and repository=$2 and status='active' order by recorded_at,id`,
      [request.tenantId, request.repository]
      ),
      this.pool.query<{ commit_sha: string; path: string; blob_sha: string }>(
        `select commit_sha,path,blob_sha from jina_ontology.commit_files where tenant_id=$1 and repository=$2`,
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
      await insertAudit(client, {
        id: auditId, tenantId, actorId, action: command.type, input: command, result: "accepted", now,
        ...("reason" in command && command.reason ? { reason: command.reason } : {})
      });
      if (command.type === "review_assertion") {
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
        await client.query(
          `update jina_ontology.assertions set status=$3,valid_to=case when $3='retracted' then $4 else valid_to end,audit_id=$5
           where tenant_id=$1 and id=$2`,
          [tenantId, assertion.id, status, now, auditId]
        );
        affectedIds.push(assertion.id);
        if (status === "active" && predicateDefinition(assertion.predicate).cardinality === "one") {
          const superseded = await client.query<{ id: string }>(
            `update jina_ontology.assertions set status='superseded',valid_to=$6,superseded_by=$5,audit_id=$7
             where tenant_id=$1 and subject_id=$2 and predicate=$3 and qualifiers_hash=$4 and status='active' and id<>$5
             returning id`,
            [tenantId, assertion.subject_id, assertion.predicate, assertion.qualifiers_hash, assertion.id, now, auditId]
          );
          affectedIds.push(...superseded.rows.map((row) => row.id));
        }
        for (const id of affectedIds) {
          outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", id, {
            assertionId: id, repoId: assertion.repository
          }, now));
        }
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
        const retracted = await client.query<{ id: string }>(
          `update jina_ontology.assertions set status='retracted',valid_to=$3,audit_id=$4
           where tenant_id=$1 and (subject_id=$2 or object_id=$2) and status in ('active','proposed') returning id`,
          [tenantId, command.entityId, now, auditId]
        );
        await client.query(`delete from jina_ontology.search_documents where tenant_id=$1 and source_id=$2`, [tenantId, command.entityId]);
        affectedIds.push(command.entityId, ...identities.rows.map((identity) => identity.id), ...retracted.rows.map((row) => row.id));
        for (const id of identities.rows.map((identity) => identity.id)) {
          outboxEventIds.push(await insertOutbox(client, tenantId, "identity_changed", id, { identityId: id }, now));
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
        await client.query(`delete from jina_ontology.issue_traces where tenant_id=$1 and repository=$2`, [tenantId, command.repository]);
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
        const assertionId = stableId("assertion", `${tenantId}:${subjectId}:${definition.name}:${objectId}:${qualifiersHash}:${now}`);
        if (definition.cardinality === "one") {
          const superseded = await client.query<{ id: string }>(
            `update jina_ontology.assertions set status='superseded',valid_to=$5,superseded_by=$6,audit_id=$7
             where tenant_id=$1 and subject_id=$2 and predicate=$3 and qualifiers_hash=$4 and status='active' returning id`,
            [tenantId, subjectId, definition.name, qualifiersHash, now, assertionId, auditId]
          );
          affectedIds.push(...superseded.rows.map((row) => row.id));
        }
        await client.query(
          `insert into jina_ontology.assertions
            (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
             object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,asserted_by,generator_version,
             registry_version,recorded_at,qualifiers,qualifiers_hash,last_confirmed_at,audit_id)
           values ($1,$2,$3,'command',$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',1,'[]'::jsonb,$13,'command',$14,$15,$16::jsonb,$17,$15,$18)`,
          [assertionId, tenantId, command.repository ?? "", subjectId, command.subject.kind, command.subject.key,
            command.subject.displayName ?? command.subject.key, definition.name, objectId, command.object.kind, command.object.key,
            command.object.displayName ?? command.object.key, actorId, ONTOLOGY_REGISTRY_VERSION, now,
            JSON.stringify(qualifiers), qualifiersHash, auditId]
        );
        affectedIds.push(assertionId);
        outboxEventIds.push(await insertOutbox(client, tenantId, "assertion_changed", assertionId, {
          assertionId, repoId: command.repository ?? null, status: "active"
        }, now));
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

  async rebuildDerivedProjections(tenantId: string, repository: string, ref: string, now: string): Promise<ProjectionRebuildResult> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const claimed = await client.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
        `with candidates as (
           select id from jina_ontology.outbox
           where tenant_id=$1 and processed_at is null and available_at<=now()
             and (claim_expires_at is null or claim_expires_at<now())
             and coalesce(payload->>'repoId',payload#>>'{scope,repository}')=$3
             and (payload->>'refName' is null or payload->>'refName'=$4)
           order by created_at,id for update skip locked limit 1000
         )
         update jina_ontology.outbox o set claimed_by='projection:' || $3,claimed_at=$2,claim_expires_at=$2::timestamptz+interval '15 minutes',attempts=o.attempts+1
         from candidates where o.id=candidates.id returning o.id,o.event_type,o.payload`,
        [tenantId, now, repository, ref]
      );
      const head = await client.query<{ commit_sha: string }>(
        `select commit_sha from jina_ontology.refs where tenant_id=$1 and repository=$2 and ref_name=$3`,
        [tenantId, repository, ref]
      );
      const commitSha = head.rows[0]?.commit_sha;
      if (!commitSha) throw new Error("repository ref has not been ingested");
      if (claimed.rows.length === 0) {
        const existing = await client.query<{
          manifest_count: string; search_count: string; issue_entity_count: string; issue_trace_count: string;
        }>(
          `select
             (select count(*) from jina_ontology.ref_manifest
              where tenant_id=$1 and repository=$2 and ref_name=$3 and commit_sha=$4) as manifest_count,
             (select count(*) from jina_ontology.search_documents
              where tenant_id=$1 and repository=$2) as search_count,
             (select count(*) from jina_ontology.entities
              where tenant_id=$1 and kind='Issue' and retired_at is null
                and natural_key like 'github:issue:' || $2 || '#%') as issue_entity_count,
             (select count(*) from jina_ontology.issue_traces
              where tenant_id=$1 and repository=$2 and ref_name=$3) as issue_trace_count`,
          [tenantId, repository, ref, commitSha]
        );
        const manifestFileCount = Number(existing.rows[0]?.manifest_count ?? 0);
        const searchDocumentCount = Number(existing.rows[0]?.search_count ?? 0);
        const issueEntityCount = Number(existing.rows[0]?.issue_entity_count ?? 0);
        const issueTraceCount = Number(existing.rows[0]?.issue_trace_count ?? 0);
        if (manifestFileCount > 0 && searchDocumentCount > 0 && issueTraceCount === issueEntityCount) {
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
      await client.query(`delete from jina_ontology.ref_manifest where tenant_id=$1 and repository=$2 and ref_name=$3`, [tenantId, repository, ref]);
      const manifest = await client.query(
        `insert into jina_ontology.ref_manifest (tenant_id,repository,ref_name,commit_sha,path,blob_sha,projected_at)
         select tenant_id,repository,$3,commit_sha,path,blob_sha,$5
         from jina_ontology.commit_files where tenant_id=$1 and repository=$2 and commit_sha=$4`,
        [tenantId, repository, ref, commitSha, now]
      );

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
      for (const document of documents.rows) {
        await client.query(
          `insert into jina_ontology.search_documents
            (id,tenant_id,repository,source_kind,source_id,title,body,embedding,projected_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [stableId("search", `${tenantId}:${repository}:${document.source_kind}:${document.id}`), tenantId, repository,
            document.source_kind, document.id, document.title, document.body, embeddingForText(`${document.title} ${document.body}`), now]
        );
      }
      await projectIssueTraces(client, tenantId, repository, ref, claimed.rows, claimed.rows.length === 0, now);
      const reconciledAssertionCount = await reconcileRedirectCollisions(client, tenantId, now);
      await garbageCollectCodePlane(client, tenantId, now, 90);
      await purgeRejectedModelPayloads(client, tenantId, now, 30);
      if (claimed.rows.length) {
        await client.query(
          `update jina_ontology.outbox set processed_at=$2,claimed_by=null,claimed_at=null,claim_expires_at=null
           where id=any($1::text[])`,
          [claimed.rows.map((row) => row.id), now]
        );
      }
      await client.query("commit");
      return {
        manifestFileCount: manifest.rowCount ?? 0,
        searchDocumentCount: documents.rowCount ?? 0,
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
    const globalClient = await this.pool.connect();
    let globalEventIds: readonly string[] = [];
    try {
      await globalClient.query("begin");
      const claimed = await globalClient.query<{ id: string }>(
        `with candidates as (
           select id from jina_ontology.outbox
           where tenant_id=$1 and processed_at is null and available_at<=now()
             and (claim_expires_at is null or claim_expires_at<now())
             and coalesce(payload->>'repoId',payload#>>'{scope,repository}') is null
           order by created_at,id for update skip locked limit 1000
         )
         update jina_ontology.outbox o
         set claimed_by='projection:global',claimed_at=$2,
             claim_expires_at=$2::timestamptz+interval '15 minutes',attempts=o.attempts+1
         from candidates where o.id=candidates.id returning o.id`,
        [tenantId, now]
      );
      globalEventIds = claimed.rows.map((row) => row.id);
      await globalClient.query("commit");
    } catch (error) {
      await globalClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      globalClient.release();
    }

    const pending = await this.pool.query<{ id: string; repository: string }>(
      `select id,coalesce(payload->>'repoId',payload#>>'{scope,repository}') as repository
       from jina_ontology.outbox
       where tenant_id=$1 and processed_at is null and available_at<=now()
         and coalesce(payload->>'repoId',payload#>>'{scope,repository}') is not null
         and (claim_expires_at is null or claim_expires_at<now())
       order by created_at,id limit 10000`,
      [tenantId]
    );
    const pendingIds = pending.rows.map((row) => row.id);
    const affectedRepositories = new Set(pending.rows.map((row) => row.repository));
    if (globalEventIds.length > 0) {
      const repositories = await this.pool.query<{ repository: string }>(
        `select distinct repository from jina_ontology.refs where tenant_id=$1`,
        [tenantId]
      );
      for (const row of repositories.rows) affectedRepositories.add(row.repository);
    }

    const rebuiltRepositories: string[] = [];
    try {
      for (const repository of [...affectedRepositories].sort()) {
        const refs = await this.pool.query<{ ref_name: string }>(
          `select ref_name from jina_ontology.refs
           where tenant_id=$1 and repository=$2
           order by is_default desc,ref_name`,
          [tenantId, repository]
        );
        // A tombstoned repository has no ref left to rebuild; the command already
        // purged its derived state, so only its canonical event needs acknowledging.
        if (refs.rows.length === 0) {
          await this.ackRepositoryProjectionEvents(tenantId, repository, now);
          continue;
        }
        for (const row of refs.rows) {
          await this.rebuildDerivedProjections(tenantId, repository, row.ref_name, now);
        }
        rebuiltRepositories.push(repository);
      }

      if (globalEventIds.length > 0) {
        const client = await this.pool.connect();
        try {
          await client.query("begin");
          await reconcileRedirectCollisions(client, tenantId, now);
          await client.query(
            `update jina_ontology.outbox
             set processed_at=$2,claimed_by=null,claimed_at=null,claim_expires_at=null,last_error=null
             where id=any($1::text[]) and claimed_by='projection:global'`,
            [globalEventIds, now]
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
    } catch (error) {
      if (globalEventIds.length > 0) {
        await this.pool.query(
          `update jina_ontology.outbox
           set claimed_by=null,claimed_at=null,claim_expires_at=null,last_error=$2,available_at=now()+interval '30 seconds'
           where id=any($1::text[]) and claimed_by='projection:global'`,
          [globalEventIds, error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000)]
        ).catch(() => undefined);
      }
      throw error;
    }

    const candidateIds = [...pendingIds, ...globalEventIds];
    const processed = candidateIds.length === 0
      ? { rows: [{ count: "0" }] }
      : await this.pool.query<{ count: string }>(
        `select count(*) from jina_ontology.outbox where id=any($1::text[]) and processed_at is not null`,
        [candidateIds]
      );
    return {
      processedEventCount: Number(processed.rows[0]?.count ?? 0),
      rebuiltRepositories
    };
  }

  private async ackRepositoryProjectionEvents(tenantId: string, repository: string, now: string): Promise<void> {
    await this.pool.query(
      `update jina_ontology.outbox
       set processed_at=$3,claimed_by=null,claimed_at=null,claim_expires_at=null,last_error=null,attempts=attempts+1
       where tenant_id=$1 and processed_at is null and available_at<=now()
         and (claim_expires_at is null or claim_expires_at<now())
         and coalesce(payload->>'repoId',payload#>>'{scope,repository}')=$2`,
      [tenantId, repository, now]
    );
  }

  async operationalMetrics(tenantId: string, now: string): Promise<OntologyOperationalMetrics> {
    await this.initialize();
    const [outbox, backlog, proposed, freshness, labels] = await Promise.all([
      this.pool.query<{ event_type: string; count: string; oldest: Date | null }>(
        `select event_type,count(*),min(created_at) as oldest from jina_ontology.outbox
         where tenant_id=$1 and processed_at is null group by event_type`, [tenantId]
      ),
      this.pool.query<{ count: string }>(
        `select count(distinct (b.blob_sha,b.tenant_id)) from jina_ontology.blobs b
         left join jina_ontology.blob_analyses a on a.tenant_id=b.tenant_id and a.blob_sha=b.blob_sha and a.parser_version=$2
         where b.tenant_id=$1 and a.blob_sha is null`, [tenantId, ONTOLOGY_PARSER_VERSION]
      ),
      this.pool.query<{ count: string }>(`select count(*) from jina_ontology.assertions where tenant_id=$1 and status='proposed'`, [tenantId]),
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
      )
    ]);
    const nowMs = new Date(now).getTime();
    const oldest = outbox.rows.flatMap((row) => row.oldest ? [row.oldest.getTime()] : []).sort((a, b) => a - b)[0];
    const manifest = freshness.rows[0]?.manifest?.getTime();
    const search = freshness.rows[0]?.search?.getTime();
    return {
      outboxDepth: Object.fromEntries(outbox.rows.map((row) => [row.event_type, Number(row.count)])),
      oldestOutboxAgeSeconds: oldest ? Math.max(0, (nowMs - oldest) / 1000) : 0,
      unparsedBlobCount: Number(backlog.rows[0]?.count ?? 0),
      manifestStalenessSeconds: manifest ? Math.max(0, (nowMs - manifest) / 1000) : 0,
      searchStalenessSeconds: search ? Math.max(0, (nowMs - search) / 1000) : 0,
      proposedAssertionCount: Number(proposed.rows[0]?.count ?? 0),
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

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    await this.initialize();
    if (!request.allowedRepositories.includes(request.repository)) throw new Error("repository access denied");
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const refResult = await this.pool.query<{ ref_name: string; commit_sha: string }>(
      `select ref_name,commit_sha from jina_ontology.refs
       where tenant_id=$1 and repository=$2 and ($3::text is null or ref_name=$3)
       order by case when ref_name=$3 then 0 when is_default then 1 else 2 end,updated_at desc limit 1`,
      [request.tenantId, request.repository, request.ref ?? null]
    );
    const ref = refResult.rows[0];
    if (!ref) throw new Error("repository ref not found");
    const items = request.template === "issue_trace"
      ? await retrieveIssueTrace(this.pool, request, ref.ref_name, limit + 1)
      : request.template === "structure"
        ? await retrieveStructure(this.pool, request, ref.ref_name, limit + 1)
        : request.template === "change"
          ? await retrieveChange(this.pool, request, ref.commit_sha, limit + 1)
          : request.template === "intent"
            ? await retrieveIntent(this.pool, request, limit + 1)
            : await retrieveOwnership(this.pool, request, limit + 1);
    // Exit filter repeats the entry permission check so a future template cannot widen scope accidentally.
    const permitted = items.filter((item) => item.citations.every((citation) => request.allowedRepositories.includes(citation.repository)));
    return {
      template: request.template, repository: request.repository, ref: ref.ref_name,
      items: permitted.slice(0, limit), truncated: permitted.length > limit,
      totalBeforeLimit: permitted.length, limit
    };
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

async function ensureEntity(client: PoolClient, tenantId: string, entity: StoredAssertion["subject"], eventAt?: string): Promise<string> {
  const id = stableId("entity", `${tenantId}:${entity.kind}:${entity.naturalKey}`);
  const inserted = await client.query(
    `insert into jina_ontology.entities (id,tenant_id,kind,natural_key,display_name)
     values ($1,$2,$3,$4,$5)
     on conflict (tenant_id,kind,natural_key) do update set display_name=excluded.display_name
     returning (xmax = 0) as created`,
    [id, tenantId, entity.kind, entity.naturalKey, entity.label]
  );
  if (eventAt && inserted.rows[0]?.created === true) await insertOutbox(client, tenantId, "entity_changed", id, { entityId: id }, eventAt);
  return id;
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
    throw new Error("tenant administrator access required");
  }

  let repository: string | undefined;
  let requiresAdmin = false;
  if (command.type === "review_assertion") {
    const result = await client.query<{ repository: string }>(
      `select repository from jina_ontology.assertions where tenant_id=$1 and id=$2`,
      [tenantId, command.assertionId]
    );
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
  if (!repository) throw new Error("ontology command access denied");
  const access = await client.query<{ role: "reader" | "writer" | "admin" }>(
    `select role from jina_ontology.repository_acl
     where tenant_id=$1 and repository=$2 and principal_id=$3`,
    [tenantId, repository, actorId]
  );
  const role = access.rows[0]?.role;
  if (!role || role === "reader" || (requiresAdmin && role !== "admin")) {
    throw new Error("ontology command access denied");
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
      ? assertion.commitSha === "source" && Boolean(assertion.sourceObservationId)
      : assertion.evidence.every((citation) => {
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

async function insertOutbox(
  client: PoolClient,
  tenantId: string,
  eventType: string,
  aggregateId: string,
  payload: Readonly<Record<string, unknown>>,
  createdAt: string
): Promise<string> {
  const id = stableId("outbox", `${tenantId}:${eventType}:${aggregateId}:${createdAt}:${JSON.stringify(payload)}`);
  await client.query(
    `insert into jina_ontology.outbox (id,tenant_id,event_type,aggregate_id,payload,created_at,available_at)
     values ($1,$2,$3,$4,$5::jsonb,$6,$6) on conflict do nothing`,
    [id, tenantId, eventType, aggregateId, JSON.stringify(payload), createdAt]
  );
  return id;
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
      predicate: string; qualifiers_hash: string; valid_from: Date | null; recorded_at: Date;
    }>(
      `select id,subject_id,object_id,literal_type,literal_value,predicate,qualifiers_hash,valid_from,recorded_at
       from jina_ontology.assertions where tenant_id=$1 and status='active' for update`, [tenantId]
    )
  ]);
  const mapping = redirectMap(redirectRows.rows);
  const groups = new Map<string, typeof assertionRows.rows>();
  for (const assertion of assertionRows.rows) {
    const subject = resolveRedirect(mapping, assertion.subject_id);
    const object = assertion.object_id ? resolveRedirect(mapping, assertion.object_id) : `${assertion.literal_type}:${canonicalJson(assertion.literal_value)}`;
    const definition = predicateDefinition(assertion.predicate);
    const key = definition.cardinality === "one"
      ? `${subject}:${assertion.predicate}:${assertion.qualifiers_hash}`
      : `${subject}:${assertion.predicate}:${object}:${assertion.qualifiers_hash}`;
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
  await client.query(`delete from jina_ontology.ref_manifest where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  await client.query(`delete from jina_ontology.commit_changes where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  await client.query(`delete from jina_ontology.refs where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  const removed = await client.query<{ blob_sha: string }>(
    `delete from jina_ontology.commit_files where tenant_id=$1 and repository=$2 returning blob_sha`, [tenantId, repository]
  );
  await client.query(`delete from jina_ontology.commits where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  const candidates = [...new Set(removed.rows.map((row) => row.blob_sha))];
  if (candidates.length) {
    const orphaned = await client.query<{ blob_sha: string }>(
      `select source.sha as blob_sha from unnest($2::text[]) source(sha)
       where not exists (select 1 from jina_ontology.commit_files f where f.tenant_id=$1 and f.blob_sha=source.sha)`,
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
  await client.query(`delete from jina_ontology.model_outputs where tenant_id=$1 and repository=$2`, [tenantId, repository]);
  await client.query(`delete from jina_ontology.repository_acl where tenant_id=$1 and repository=$2`, [tenantId, repository]);
}

async function garbageCollectCodePlane(client: PoolClient, tenantId: string, now: string, recentDays: number): Promise<void> {
  const garbage = await client.query<{ repository: string; sha: string }>(
    `with recursive reachable(repository,sha) as (
       select repository,commit_sha from jina_ontology.refs where tenant_id=$1
       union
       select c.repository,parent.sha
       from reachable r
       join jina_ontology.commits c on c.tenant_id=$1 and c.repository=r.repository and c.sha=r.sha
       cross join lateral unnest(c.parents) parent(sha)
     ), pr_linked as (
       select repository,substring(object_natural_key from ':sha:([a-f0-9]{40})$') as sha
       from jina_ontology.assertions
       where tenant_id=$1 and predicate='INCLUDES' and status='active'
     )
     select c.repository,c.sha from jina_ontology.commits c
     where c.tenant_id=$1 and c.committed_at < $2::timestamptz - make_interval(days=>$3)
       and not exists (select 1 from reachable r where r.repository=c.repository and r.sha=c.sha)
       and not exists (select 1 from pr_linked p where p.repository=c.repository and p.sha=c.sha)`,
    [tenantId, now, recentDays]
  );
  if (garbage.rows.length === 0) return;
  const removed = await client.query<{ blob_sha: string }>(
    `delete from jina_ontology.commit_files f using (
       select source.repository,source.sha from unnest($2::text[],$3::text[]) source(repository,sha)
     ) doomed where f.tenant_id=$1 and f.repository=doomed.repository and f.commit_sha=doomed.sha returning f.blob_sha`,
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
     where not exists (select 1 from jina_ontology.commit_files f where f.tenant_id=$1 and f.blob_sha=source.sha)`,
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
    `select m.observation_id from jina_ontology.model_outputs m
     where m.tenant_id=$1 and m.generated_at < $2::timestamptz - make_interval(days=>$3)
       and not exists (
         select 1 from jina_ontology.assertions a
         where a.source_observation_id=m.observation_id and a.status in ('active','proposed')
       )`, [tenantId, now, retentionDays]
  );
  const ids = expired.rows.map((row) => row.observation_id);
  if (ids.length === 0) return;
  await client.query(`delete from jina_ontology.model_outputs where observation_id=any($1::text[])`, [ids]);
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
}

interface IssueTraceEntityRow {
  readonly id: string;
  readonly kind: string;
  readonly natural_key: string;
  readonly display_name: string;
}

interface IssueTraceProjectionEvent {
  readonly id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
}

const ISSUE_TRACE_PREDICATES = ["RESOLVES", "RESOLVED_BY", "MERGED_AS", "INCLUDES", "INTRODUCED_BY"] as const;

/**
 * Incrementally materialize issue-centric traces from canonical assertions.
 * The projection may traverse the small relationship subgraph to discover an
 * affected issue, but it rewrites only rows reachable from the claimed events.
 */
async function projectIssueTraces(
  client: PoolClient,
  tenantId: string,
  repository: string,
  ref: string,
  events: readonly IssueTraceProjectionEvent[],
  forceAll: boolean,
  now: string
): Promise<void> {
  const [activeResult, entityResult] = await Promise.all([
    client.query<IssueTraceAssertionRow>(
      `select id,predicate,subject_id,subject_kind,subject_natural_key,subject_label,
              object_id,object_kind,object_natural_key,object_label,source_observation_id
       from jina_ontology.assertions
       where tenant_id=$1 and repository=$2 and status='active' and predicate=any($3::text[])`,
      [tenantId, repository, [...ISSUE_TRACE_PREDICATES]]
    ),
    client.query<IssueTraceEntityRow>(
      `select id,kind,natural_key,display_name from jina_ontology.entities
       where tenant_id=$1 and retired_at is null and (
         natural_key like 'github:issue:' || $2 || '#%' or
         natural_key like 'github:pr:' || $2 || '#%' or
         natural_key like 'repo:' || $2 || ':sha:%'
       )`,
      [tenantId, repository]
    )
  ]);
  const entitiesById = new Map(entityResult.rows.map((entity) => [entity.id, entity]));
  const entityIdByKey = new Map(entityResult.rows.map((entity) => [entity.natural_key, entity.id]));
  const issueNumberByEntityId = new Map<string, number>();
  for (const entity of entityResult.rows) {
    const issueNumber = entity.kind === "Issue" ? numberFromNaturalKey(entity.natural_key) : undefined;
    if (issueNumber) issueNumberByEntityId.set(entity.id, issueNumber);
  }
  let rebuildAll = forceAll;
  if (!rebuildAll) {
    const existingTraceCount = await client.query<{ count: string }>(
      `select count(*) from jina_ontology.issue_traces
       where tenant_id=$1 and repository=$2 and ref_name=$3`,
      [tenantId, repository, ref]
    );
    rebuildAll = Number(existingTraceCount.rows[0]?.count ?? 0) < issueNumberByEntityId.size;
  }

  const changedAssertionIds = events.flatMap((event) =>
    event.event_type === "assertion_changed" && typeof event.payload.assertionId === "string"
      ? [event.payload.assertionId]
      : []
  );
  const observationIds = events.flatMap((event) =>
    (event.event_type === "observation_recorded" || event.event_type === "observation_redacted") &&
      typeof event.payload.observationId === "string"
      ? [event.payload.observationId]
      : []
  );
  const changedResult = changedAssertionIds.length > 0 || observationIds.length > 0
    ? await client.query<IssueTraceAssertionRow>(
        `select id,predicate,subject_id,subject_kind,subject_natural_key,subject_label,
                object_id,object_kind,object_natural_key,object_label,source_observation_id
         from jina_ontology.assertions
         where tenant_id=$1 and repository=$2
           and (id=any($3::text[]) or source_observation_id=any($4::text[]))`,
        [tenantId, repository, changedAssertionIds, observationIds]
      )
    : { rows: [] as IssueTraceAssertionRow[] };
  const changedObservations = observationIds.length > 0
    ? await client.query<{ id: string; payload: Record<string, unknown> | null }>(
        `select id,payload from jina_ontology.observations where tenant_id=$1 and repository=$2 and id=any($3::text[])`,
        [tenantId, repository, observationIds]
      )
    : { rows: [] as { id: string; payload: Record<string, unknown> | null }[] };

  const adjacency = new Map<string, Set<string>>();
  const link = (left: string, right: string): void => {
    adjacency.set(left, new Set([...(adjacency.get(left) ?? []), right]));
    adjacency.set(right, new Set([...(adjacency.get(right) ?? []), left]));
  };
  const relationshipRows = [...new Map([...activeResult.rows, ...changedResult.rows].map((row) => [row.id, row])).values()];
  for (const assertion of relationshipRows) link(assertion.subject_id, assertion.object_id);

  const affectedIssueNumbers = new Set<number>();
  if (rebuildAll) {
    for (const issueNumber of issueNumberByEntityId.values()) affectedIssueNumbers.add(issueNumber);
  } else {
    const pending = new Set<string>();
    for (const assertion of changedResult.rows) {
      pending.add(assertion.subject_id);
      pending.add(assertion.object_id);
    }
    for (const observation of changedObservations.rows) {
      const payload = observation.payload;
      if (!payload || typeof payload.number !== "number") continue;
      const key = payload.kind === "issue"
        ? `github:issue:${repository}#${payload.number}`
        : payload.kind === "pull_request"
          ? `github:pr:${repository}#${payload.number}`
          : undefined;
      if (key && entityIdByKey.has(key)) pending.add(entityIdByKey.get(key)!);
    }
    const visited = new Set<string>();
    while (pending.size > 0) {
      const current = pending.values().next().value as string;
      pending.delete(current);
      if (visited.has(current)) continue;
      visited.add(current);
      const issueNumber = issueNumberByEntityId.get(current);
      if (issueNumber) affectedIssueNumbers.add(issueNumber);
      for (const adjacent of adjacency.get(current) ?? []) if (!visited.has(adjacent)) pending.add(adjacent);
    }
  }
  if (rebuildAll) {
    await client.query(
      `delete from jina_ontology.issue_traces where tenant_id=$1 and repository=$2 and ref_name=$3`,
      [tenantId, repository, ref]
    );
  }
  if (affectedIssueNumbers.size === 0) return;
  if (!rebuildAll) {
    await client.query(
      `delete from jina_ontology.issue_traces
       where tenant_id=$1 and repository=$2 and ref_name=$3 and issue_number=any($4::int[])`,
      [tenantId, repository, ref, [...affectedIssueNumbers]]
    );
  }

  const workItemObservations = await client.query<{
    id: string; payload: Record<string, unknown>; recorded_at: Date;
  }>(
    `select id,payload,recorded_at from jina_ontology.observations
     where tenant_id=$1 and repository=$2 and source='github' and redacted_at is null
       and payload is not null and payload->>'kind' in ('issue','pull_request')
     order by recorded_at,id`,
    [tenantId, repository]
  );
  const latestObservationByKey = new Map<string, { readonly id: string; readonly payload: Record<string, unknown> }>();
  for (const observation of workItemObservations.rows) {
    const kind = observation.payload.kind;
    const number = observation.payload.number;
    if ((kind === "issue" || kind === "pull_request") && typeof number === "number") {
      latestObservationByKey.set(`${kind}:${number}`, observation);
    }
  }

  const active = activeResult.rows;
  const includedByPullRequest = new Map<string, IssueTraceAssertionRow[]>();
  const causesByIssue = new Map<string, IssueTraceAssertionRow[]>();
  const resolutionByPair = new Map<string, {
    readonly issueId: string; readonly pullRequestId: string; readonly assertions: IssueTraceAssertionRow[];
  }>();
  for (const assertion of active) {
    if (assertion.predicate === "INCLUDES" || assertion.predicate === "MERGED_AS") {
      includedByPullRequest.set(assertion.subject_id, [...(includedByPullRequest.get(assertion.subject_id) ?? []), assertion]);
    } else if (assertion.predicate === "INTRODUCED_BY") {
      causesByIssue.set(assertion.subject_id, [...(causesByIssue.get(assertion.subject_id) ?? []), assertion]);
    } else if (assertion.predicate === "RESOLVES" || assertion.predicate === "RESOLVED_BY") {
      const issueId = assertion.predicate === "RESOLVES" ? assertion.object_id : assertion.subject_id;
      const pullRequestId = assertion.predicate === "RESOLVES" ? assertion.subject_id : assertion.object_id;
      const key = `${issueId}:${pullRequestId}`;
      const pair = resolutionByPair.get(key) ?? { issueId, pullRequestId, assertions: [] };
      pair.assertions.push(assertion);
      resolutionByPair.set(key, pair);
    }
  }

  const relevantCommitShas = new Set<string>();
  for (const pair of resolutionByPair.values()) {
    if (!affectedIssueNumbers.has(issueNumberByEntityId.get(pair.issueId) ?? -1)) continue;
    for (const assertion of includedByPullRequest.get(pair.pullRequestId) ?? []) {
      const sha = shaFromNaturalKey(assertion.object_natural_key);
      if (sha) relevantCommitShas.add(sha);
    }
  }
  for (const [issueId, assertions] of causesByIssue) {
    if (!affectedIssueNumbers.has(issueNumberByEntityId.get(issueId) ?? -1)) continue;
    for (const assertion of assertions) {
      const sha = shaFromNaturalKey(assertion.object_natural_key);
      if (sha) relevantCommitShas.add(sha);
    }
  }
  const changes = relevantCommitShas.size > 0
    ? await client.query<{
        commit_sha: string; path: string; change: string; old_path: string | null;
      }>(
        `select commit_sha,path,change,old_path from jina_ontology.commit_changes
         where tenant_id=$1 and repository=$2 and commit_sha=any($3::text[])
         order by commit_sha,path`,
        [tenantId, repository, [...relevantCommitShas]]
      )
    : { rows: [] as { commit_sha: string; path: string; change: string; old_path: string | null }[] };
  const changesByCommit = new Map<string, typeof changes.rows>();
  for (const change of changes.rows) {
    changesByCommit.set(change.commit_sha, [...(changesByCommit.get(change.commit_sha) ?? []), change]);
  }

  for (const [issueId, issueNumber] of issueNumberByEntityId) {
    if (!affectedIssueNumbers.has(issueNumber)) continue;
    const issueEntity = entitiesById.get(issueId)!;
    const issueObservation = latestObservationByKey.get(`issue:${issueNumber}`);
    const issuePayload = issueObservation?.payload;
    const citations: RetrievalCitation[] = [{ kind: "entity", id: issueId, repository }];
    if (issueObservation) citations.push({ kind: "observation", id: issueObservation.id, repository });
    const resolutions = [...resolutionByPair.values()]
      .filter((pair) => pair.issueId === issueId)
      .map((pair) => {
        const pullRequest = entitiesById.get(pair.pullRequestId);
        const pullRequestNumber = pullRequest ? numberFromNaturalKey(pullRequest.natural_key) : undefined;
        if (!pullRequest || !pullRequestNumber) return undefined;
        const pullRequestObservation = latestObservationByKey.get(`pull_request:${pullRequestNumber}`);
        const assertionIds = new Set(pair.assertions.map((assertion) => assertion.id));
        const sourceObservationIds = new Set(pair.assertions.flatMap((assertion) => assertion.source_observation_id ? [assertion.source_observation_id] : []));
        const commitAssertions = includedByPullRequest.get(pair.pullRequestId) ?? [];
        for (const assertion of commitAssertions) {
          assertionIds.add(assertion.id);
          if (assertion.source_observation_id) sourceObservationIds.add(assertion.source_observation_id);
        }
        if (pullRequestObservation) sourceObservationIds.add(pullRequestObservation.id);
        for (const assertionId of assertionIds) citations.push({ kind: "assertion", id: assertionId, repository });
        for (const observationId of sourceObservationIds) citations.push({ kind: "observation", id: observationId, repository });
        const bySha = new Map<string, "merge" | "included">();
        for (const assertion of commitAssertions) {
          const sha = shaFromNaturalKey(assertion.object_natural_key);
          if (sha) bySha.set(sha, assertion.predicate === "MERGED_AS" ? "merge" : bySha.get(sha) ?? "included");
        }
        const commits = [...bySha].sort((left, right) =>
          (left[1] === "merge" ? 0 : 1) - (right[1] === "merge" ? 0 : 1) || left[0].localeCompare(right[0])
        ).map(([sha, role]) => {
          const commitChanges = (changesByCommit.get(sha) ?? []).map((change) => ({
            commitSha: sha,
            path: change.path,
            change: change.change,
            ...(change.old_path ? { oldPath: change.old_path } : {})
          }));
          for (const change of commitChanges) citations.push({
            kind: "commit_change", id: `${sha}:${change.path}`, repository, commitSha: sha, path: change.path
          });
          return { sha, url: `https://github.com/${repository}/commit/${sha}`, role, changes: commitChanges };
        });
        return {
          pullRequestNumber,
          title: typeof pullRequestObservation?.payload.title === "string" ? pullRequestObservation.payload.title : pullRequest.display_name,
          url: typeof pullRequestObservation?.payload.url === "string"
            ? pullRequestObservation.payload.url
            : `https://github.com/${repository}/pull/${pullRequestNumber}`,
          commits,
          assertionIds: [...assertionIds],
          observationIds: [...sourceObservationIds]
        };
      })
      .filter((resolution): resolution is NonNullable<typeof resolution> => Boolean(resolution))
      .sort((left, right) => left.pullRequestNumber - right.pullRequestNumber);
    const introducedBy = (causesByIssue.get(issueId) ?? []).flatMap((assertion) => {
      const sha = shaFromNaturalKey(assertion.object_natural_key);
      if (!sha) return [];
      citations.push({ kind: "assertion", id: assertion.id, repository });
      if (assertion.source_observation_id) citations.push({ kind: "observation", id: assertion.source_observation_id, repository });
      const commitChanges = (changesByCommit.get(sha) ?? []).map((change) => ({
        commitSha: sha, path: change.path, change: change.change, ...(change.old_path ? { oldPath: change.old_path } : {})
      }));
      for (const change of commitChanges) citations.push({
        kind: "commit_change", id: `${sha}:${change.path}`, repository, commitSha: sha, path: change.path
      });
      return [{ sha, url: `https://github.com/${repository}/commit/${sha}`, role: "introduced" as const, changes: commitChanges }];
    });
    const payload: IssueTraceProjection = {
      issue: {
        number: issueNumber,
        title: typeof issuePayload?.title === "string" ? issuePayload.title : issueEntity.display_name,
        url: typeof issuePayload?.url === "string" ? issuePayload.url : `https://github.com/${repository}/issues/${issueNumber}`,
        ...(typeof issuePayload?.state === "string" ? { state: issuePayload.state } : {})
      },
      resolutions,
      introducedBy,
      citations: dedupeRetrievalCitations(citations)
    };
    await client.query(
      `insert into jina_ontology.issue_traces
        (tenant_id,repository,ref_name,issue_number,issue_entity_id,payload,projected_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7)
       on conflict (tenant_id,repository,ref_name,issue_number)
       do update set issue_entity_id=excluded.issue_entity_id,payload=excluded.payload,projected_at=excluded.projected_at`,
      [tenantId, repository, ref, issueNumber, issueId, JSON.stringify(payload), now]
    );
  }
}

function numberFromNaturalKey(naturalKey: string): number | undefined {
  const value = /#(\d+)$/.exec(naturalKey)?.[1];
  return value ? Number.parseInt(value, 10) : undefined;
}

function shaFromNaturalKey(naturalKey: string): string | undefined {
  return /:sha:([a-f0-9]{40})$/i.exec(naturalKey)?.[1]?.toLowerCase();
}

function dedupeRetrievalCitations(citations: readonly RetrievalCitation[]): RetrievalCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = JSON.stringify(citation);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

async function retrieveIssueTrace(
  pool: Pool,
  request: RetrievalRequest,
  ref: string,
  limit: number
): Promise<RetrievalItem[]> {
  if (!request.issueNumber) return [];
  const result = await pool.query<{ payload: IssueTraceProjection }>(
    `select payload from jina_ontology.issue_traces
     where tenant_id=$1 and repository=$2 and ref_name=$3 and issue_number=$4
     limit $5`,
    [request.tenantId, request.repository, ref, request.issueNumber, limit]
  );
  return result.rows.map(({ payload }) => {
    const firstResolution = payload.resolutions[0];
    const firstCommit = firstResolution?.commits[0];
    const title = firstResolution
      ? `Issue #${payload.issue.number} → PR #${firstResolution.pullRequestNumber}${firstCommit ? ` → ${firstCommit.sha.slice(0, 12)}` : ""}`
      : payload.introducedBy[0]
        ? `Issue #${payload.issue.number} introduced by ${payload.introducedBy[0].sha.slice(0, 12)}`
        : `Issue #${payload.issue.number} has no verified commit relationship`;
    return {
      kind: "issue_trace",
      title,
      data: payload as unknown as Readonly<Record<string, unknown>>,
      citations: payload.citations,
      score: firstResolution ? 3 : payload.introducedBy.length > 0 ? 2 : 1
    };
  });
}

async function retrieveStructure(pool: Pool, request: RetrievalRequest, ref: string, limit: number): Promise<RetrievalItem[]> {
  const query = request.symbol ?? request.query ?? "";
  const result = await pool.query<{
    path: string; commit_sha: string; blob_sha: string; from_moniker: string; kind: string; to_moniker: string; start_line: number; end_line: number;
  }>(
    `select m.path,m.commit_sha,m.blob_sha,e.from_moniker,e.kind,e.to_moniker,e.start_line,e.end_line
     from jina_ontology.ref_manifest m
     join jina_ontology.symbol_edges e on e.tenant_id=m.tenant_id and e.blob_sha=m.blob_sha and e.parser_version=$5
     where m.tenant_id=$1 and m.repository=$2 and m.ref_name=$3
       and ($4='' or e.from_moniker ilike '%' || $4 || '%' or e.to_moniker ilike '%' || $4 || '%')
     order by case when e.from_moniker ilike $4 || '%' then 0 else 1 end,m.path,e.start_line limit $6`,
    [request.tenantId, request.repository, ref, query, ONTOLOGY_PARSER_VERSION, limit]
  );
  return result.rows.map((row) => ({
    kind: row.kind, title: `${row.from_moniker} ${row.kind} ${row.to_moniker}`,
    data: { fromMoniker: row.from_moniker, toMoniker: row.to_moniker, path: row.path }, score: 1,
    citations: [{
      kind: "code", id: `${row.blob_sha}:${row.start_line}:${row.from_moniker}`, repository: request.repository,
      commitSha: row.commit_sha, path: row.path, startLine: row.start_line, endLine: row.end_line
    }]
  }));
}

async function retrieveChange(pool: Pool, request: RetrievalRequest, headSha: string, limit: number): Promise<RetrievalItem[]> {
  let commitShas = [headSha];
  if (request.pullRequestNumber) {
    const key = `github:pr:${request.repository}#${request.pullRequestNumber}`;
    const included = await pool.query<{ natural_key: string }>(
      `select object_natural_key as natural_key from jina_ontology.assertions
       where tenant_id=$1 and repository=$2 and subject_natural_key=$3 and predicate='INCLUDES' and status='active'`,
      [request.tenantId, request.repository, key]
    );
    const parsed = included.rows.map((row) => /:sha:([a-f0-9]{40})$/i.exec(row.natural_key)?.[1]).filter((sha): sha is string => Boolean(sha));
    if (parsed.length) commitShas = parsed;
  }
  const changes = await pool.query<{
    commit_sha: string; path: string; change: string; old_path: string | null; old_blob_sha: string | null; new_blob_sha: string | null;
  }>(
    `select commit_sha,path,change,old_path,old_blob_sha,new_blob_sha from jina_ontology.commit_changes
     where tenant_id=$1 and repository=$2 and commit_sha=any($3::text[])
     order by commit_sha,path limit $4`, [request.tenantId, request.repository, commitShas, limit]
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
    const history = await pool.query<{ commit_sha: string; path: string; change: string; message: string | null; committed_at: Date }>(
      `select c.commit_sha,c.path,c.change,m.message,m.committed_at from jina_ontology.commit_changes c
       join jina_ontology.commits m on m.tenant_id=c.tenant_id and m.repository=c.repository and m.sha=c.commit_sha
       where c.tenant_id=$1 and c.repository=$2 and (c.path=$3 or c.old_path=$3)
       order by m.committed_at desc limit $4`, [request.tenantId, request.repository, request.path, limit]
    );
    historyCommitShas.push(...history.rows.map((row) => row.commit_sha));
    items.push(...history.rows.map((row): RetrievalItem => ({
      kind: "history", title: row.message ?? `${row.change} ${row.path}`,
      data: { change: row.change, committedAt: row.committed_at.toISOString() }, score: 1,
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
  const resolvedIds = [...new Set(assertions.rows.map((row) => resolveRedirect(mapping, row.object_id)))];
  const resolved = resolvedIds.length ? await pool.query<{ id: string; display_name: string; natural_key: string }>(
    `select id,display_name,natural_key from jina_ontology.entities where tenant_id=$1 and id=any($2::text[])`, [request.tenantId, resolvedIds]
  ) : { rows: [] as { id: string; display_name: string; natural_key: string }[] };
  const names = new Map(resolved.rows.map((row) => [row.id, row]));
  const target = request.path ?? request.symbol;
  const applicable = assertions.rows.filter((row) =>
    !target || row.subject_natural_key.includes(target) ||
    (typeof row.qualifiers.pattern === "string" && codeownersPatternMatches(row.qualifiers.pattern, target))
  ).sort((left, right) => ownershipAuthority(left) - ownershipAuthority(right) || right.recorded_at.getTime() - left.recorded_at.getTime());
  const items: RetrievalItem[] = applicable.map((row) => {
    const owner = names.get(resolveRedirect(mapping, row.object_id));
    return {
      kind: "ownership", title: `${row.subject_label} owned by ${owner?.display_name ?? row.object_label}`,
      data: {
        subjectKey: row.subject_natural_key,
        ownerKey: owner?.natural_key ?? row.object_natural_key,
        qualifiers: row.qualifiers,
        authority: row.asserted_by ? "human" : row.generator === "source:codeowners" ? "codeowners" : "model"
      }, score: 3 - ownershipAuthority(row),
      citations: [{ kind: "assertion", id: row.id, repository: request.repository }]
    };
  });
  if (request.path && items.length < limit) {
    const authors = await pool.query<{ sha: string; author_external_id: string; committed_at: Date; entity_id: string | null; display_name: string | null }>(
      `select c.sha,c.author_external_id,c.committed_at,i.entity_id,e.display_name
       from jina_ontology.commit_changes ch
       join jina_ontology.commits c on c.tenant_id=ch.tenant_id and c.repository=ch.repository and c.sha=ch.commit_sha
       left join jina_ontology.identities i on i.tenant_id=c.tenant_id and i.source='git-email' and i.external_id=c.author_external_id and i.status='accepted'
       left join jina_ontology.entities e on e.id=i.entity_id
       where ch.tenant_id=$1 and ch.repository=$2 and (ch.path=$3 or ch.old_path=$3) and c.author_external_id is not null
       order by c.committed_at desc limit $4`, [request.tenantId, request.repository, request.path, limit - items.length]
    );
    items.push(...authors.rows.map((row, index): RetrievalItem => ({
      kind: "recent_author", title: row.display_name ?? row.author_external_id,
      data: { authorExternalId: row.author_external_id, committedAt: row.committed_at.toISOString() }, score: 1 / (index + 1),
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
    .replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
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
      alter table jina_ontology.observations add column if not exists occurred_at timestamptz;
      alter table jina_ontology.observations add column if not exists supersedes_id text references jina_ontology.observations(id);
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
      update jina_ontology.commits set committed_at=now() where committed_at is null;
      create table if not exists jina_ontology.refs (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        commit_sha text not null,
        updated_at timestamptz not null,
        primary key (tenant_id,repository,ref_name)
      );
      alter table jina_ontology.refs add column if not exists is_default boolean not null default false;
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
      alter table jina_ontology.assertions add column if not exists literal_value jsonb;
      alter table jina_ontology.assertions add column if not exists qualifiers jsonb not null default '{}'::jsonb;
      alter table jina_ontology.assertions add column if not exists qualifiers_hash text not null default 'q_empty';
      alter table jina_ontology.assertions add column if not exists asserted_by text;
      alter table jina_ontology.assertions add column if not exists generator text;
      alter table jina_ontology.assertions add column if not exists valid_from timestamptz;
      alter table jina_ontology.assertions add column if not exists valid_to timestamptz;
      alter table jina_ontology.assertions add column if not exists last_confirmed_at timestamptz;
      alter table jina_ontology.assertions add column if not exists superseded_by text references jina_ontology.assertions(id);
      alter table jina_ontology.assertions add column if not exists audit_id text references jina_ontology.audit_log(id);
      update jina_ontology.assertions set last_confirmed_at=recorded_at where last_confirmed_at is null;
      create index if not exists ontology_assertions_cardinality
        on jina_ontology.assertions (tenant_id,subject_id,predicate,qualifiers_hash,status);
      create table if not exists jina_ontology.outbox (
        id text primary key,
        tenant_id text not null,
        event_type text not null,
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
      create index if not exists ontology_outbox_claim
        on jina_ontology.outbox (available_at,created_at) where processed_at is null;
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
      create table if not exists jina_ontology.issue_traces (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        issue_number integer not null check (issue_number > 0),
        issue_entity_id text not null references jina_ontology.entities(id),
        payload jsonb not null,
        projected_at timestamptz not null,
        primary key (tenant_id,repository,ref_name,issue_number)
      );
      create index if not exists ontology_issue_traces_entity
        on jina_ontology.issue_traces (tenant_id,issue_entity_id);
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
    `;
