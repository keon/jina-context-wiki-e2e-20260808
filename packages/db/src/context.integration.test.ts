import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IndexContextService,
  createKnowledgeCitation,
  createKnowledgeRevision,
  createEvidenceRecord,
  fingerprint,
  stableId,
  type EvidenceSnapshot
} from "@jina/context-engine";
import { Pool } from "pg";
import { ContextDatabase } from "./context/database.js";
import { PostgresContextEmbeddingRepository } from "./context/embedding-repository.js";
import { PostgresEvidenceRepository } from "./context/evidence-repository.js";
import { PostgresContextOutboxRepository } from "./context/outbox-repository.js";
import { PostgresContextPipelineCoordinator } from "./context/pipeline-coordinator.js";
import { PostgresContextQueryRepository } from "./context/query-repository.js";
import { PostgresContextEngineStore } from "./context/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "clean context persistence fences writes, publishes an ACL-scoped generation, and serves lexical queries",
  { skip: !databaseUrl },
  async () => {
    const bootstrap = new Pool({ connectionString: databaseUrl });
    await bootstrap.query("drop schema if exists jina_context cascade");
    await bootstrap.end();

    const database = new ContextDatabase({
      connectionString: databaseUrl,
      manageSchema: true,
      manageRoles: true
    });
    const store = new PostgresContextEngineStore(database);
    const evidence = new PostgresEvidenceRepository(database);
    const coordinator = new PostgresContextPipelineCoordinator(database);
    const outbox = new PostgresContextOutboxRepository(database);
    const query = new PostgresContextQueryRepository(database);
    const embeddings = new PostgresContextEmbeddingRepository(database);

    const tenantId = "tenant-context-integration";
    const repository = "acme/context-fixture";
    const ref = "main";
    const commitSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    const aclFingerprint = fingerprint("fixture-reader-acl");
    const epoch = Date.now();
    const at = (offsetMs: number) => new Date(epoch + offsetMs).toISOString();
    const createdAt = at(0);
    const build = await coordinator.createBuild({
      tenantId,
      repository,
      ref,
      commitSha,
      githubInstallationId: 140435029,
      requestKey: "integration-build-1",
      createdAt
    });
    assert.match(build.id, /^cb_/);
    assert.ok(build.stages.every((stage) => stage.id.startsWith("cs_")));

    const ingestClaim = await coordinator.claim({
      tenantId,
      workerId: "integration-ingest",
      topics: ["run-ingest-evidence"],
      now: createdAt,
      leaseExpiresAt: at(600_000)
    });
    assert.ok(ingestClaim);
    assert.equal(ingestClaim.stage.metadata.commitSha, commitSha);
    assert.equal(ingestClaim.stage.metadata.githubInstallationId, 140435029);

    const aclPayload = { principalId: "reader-1", permission: "read" };
    const aclObservationId = stableId("observation", aclPayload);
    await evidence.appendObservation(
      {
        id: aclObservationId,
        tenantId,
        repository,
        source: "access",
        sourceType: "human_input",
        recordedAt: createdAt,
        payload: aclPayload,
        contentDigest: fingerprint(aclPayload)
      },
      ingestClaim.fence
    );
    await evidence.appendRepositoryAcl(
      {
        id: stableId("acl", aclPayload),
        tenantId,
        repository,
        principalId: "reader-1",
        permission: "read",
        aclFingerprint,
        sourceObservationId: aclObservationId,
        observedAt: createdAt
      },
      ingestClaim.fence
    );

    const source = "export function deployContext(): string { return 'ready'; }\n";
    const record = createEvidenceRecord({
      anchor: {
        tenantId,
        repository,
        sourceType: "blob",
        sourceId: blobSha,
        contentDigest: fingerprint(source),
        commitSha,
        pathOrUrl: "src/context.ts",
        startLine: 1,
        endLine: 1
      },
      ref,
      title: "src/context.ts",
      body: source,
      metadata: { language: "typescript", mediaType: "text/typescript" },
      authorityClass: "source_code",
      aclFingerprint,
      createdAt
    });
    const snapshot: EvidenceSnapshot = {
      checkpoint: {
        id: stableId("ec", { tenantId, repository, commitSha }),
        tenantId,
        repository,
        ref,
        commitSha,
        parserVersion: "fixture-parser-v1",
        sourceCompleteness: "complete",
        observationFrontier: createdAt,
        evidenceFingerprint: fingerprint([record.id]),
        manifestFingerprint: fingerprint(["src/context.ts", blobSha]),
        aclFingerprint,
        createdAt
      },
      records: [record],
      manifest: [
        {
          tenantId,
          repository,
          ref,
          commitSha,
          path: "src/context.ts",
          blobSha,
          contentDigest: record.anchor.contentDigest,
          language: "typescript",
          executable: false
        }
      ],
      structuralFacts: [],
      git: {
        commit: {
          treeSha: "c".repeat(40),
          parentShas: ["d".repeat(40)],
          author: "Integration Test <test@example.com>",
          authoredAt: createdAt,
          committedAt: createdAt,
          message: "Add context deployment fixture"
        },
        changes: [{ kind: "add", path: "src/context.ts", newBlobSha: blobSha }]
      }
    };
    await store.commitSnapshot(snapshot, ingestClaim.fence);
    for (const table of ["refs", "commits", "commit_parents", "trees", "tree_entries", "blob_analyses"]) {
      const canonical = await database.pool.query<{ count: string }>(
        `select count(*)::text as count from jina_context.${table}`
      );
      assert.ok(Number(canonical.rows[0]!.count) > 0, `${table} was not populated`);
    }
    const manifestDeliveries = await outbox.claim({
      consumer: "manifest",
      workerId: "manifest-projector",
      now: at(500),
      leaseExpiresAt: at(30_000),
      tenantId,
      repository
    });
    assert.ok(manifestDeliveries.length > 0);
    assert.ok(manifestDeliveries.every((delivery) => delivery.consumer === "manifest"));
    assert.equal(
      await outbox.acknowledge(manifestDeliveries[0]!.deliveryId, manifestDeliveries[0]!.leaseId, at(600)),
      true
    );
    const lexicalDeliveries = await outbox.claim({
      consumer: "lexical",
      workerId: "lexical-projector",
      now: at(700),
      leaseExpiresAt: at(30_000),
      tenantId,
      repository
    });
    assert.ok(lexicalDeliveries.length > 0);
    assert.ok(lexicalDeliveries.every((delivery) => delivery.consumer === "lexical"));
    assert.equal(
      await coordinator.complete({
        tenantId,
        stageId: ingestClaim.stage.id,
        fence: ingestClaim.fence,
        outcome: "succeeded",
        now: at(1_000),
        metadata: { checkpointId: snapshot.checkpoint.id }
      }),
      true
    );

    await assert.rejects(store.commitSnapshot(snapshot, ingestClaim.fence), /write fence is stale or invalid/);

    const indexClaim = await coordinator.claim({
      tenantId,
      workerId: "integration-index",
      topics: ["run-derive-knowledge", "run-index-context"],
      now: at(2_000),
      leaseExpiresAt: at(600_000)
    });
    assert.ok(indexClaim);
    assert.equal(indexClaim.stage.topic, "run-index-context");
    const generation = await new IndexContextService(store).index(snapshot.checkpoint.id, at(3_000), indexClaim.fence);
    assert.equal(generation.status, "published");
    assert.equal(
      await coordinator.complete({
        tenantId,
        stageId: indexClaim.stage.id,
        fence: indexClaim.fence,
        outcome: "succeeded",
        now: at(4_000),
        metadata: { generationId: generation.id }
      }),
      true
    );

    const deriveClaim = await coordinator.claim({
      tenantId,
      workerId: "integration-derive",
      topics: ["run-derive-knowledge", "run-index-context"],
      now: at(5_000),
      leaseExpiresAt: at(600_000)
    });
    assert.ok(deriveClaim);
    assert.equal(deriveClaim.stage.topic, "run-derive-knowledge");
    assert.equal(
      await coordinator.complete({
        tenantId,
        stageId: deriveClaim.stage.id,
        fence: deriveClaim.fence,
        outcome: "failed",
        now: at(6_000),
        error: "optional fixture derivation disabled"
      }),
      true
    );

    const revision = createKnowledgeRevision({
      logicalId: `component:${repository}:deployment`,
      tenantId,
      repository,
      kind: "component",
      title: "Context deployment",
      bodyMarkdown: "The context deployment entry point is `deployContext`.",
      summary: "Deployment context entry point.",
      structuredSummary: { entryPoint: "deployContext" },
      scope: {
        ref,
        commitSha,
        paths: ["src/context.ts"],
        symbols: ["deployContext"],
        pullRequests: [],
        issues: []
      },
      evidenceFingerprint: snapshot.checkpoint.evidenceFingerprint,
      generatorName: "fixture",
      generatorVersion: "fixture-v1",
      model: "fixture",
      promptVersion: "fixture-v1",
      confidence: 1,
      createdAt: at(7_000)
    });
    const citation = createKnowledgeCitation(
      revision.id,
      0,
      "deployContext is the deployment entry point",
      record.anchor
    );
    await store.commitKnowledge({
      run: {
        id: stableId("dr", { checkpointId: snapshot.checkpoint.id, revisionId: revision.id }),
        tenantId,
        repository,
        checkpointId: snapshot.checkpoint.id,
        cacheKey: fingerprint({ checkpointId: snapshot.checkpoint.id, revisionId: revision.id }),
        focusFingerprint: fingerprint(["src/context.ts"]),
        generatorName: "fixture",
        generatorVersion: "fixture-v1",
        model: "fixture",
        promptVersion: "fixture-v1",
        schemaVersion: "knowledge-v1",
        rawOutputs: [{ documents: [revision.logicalId] }],
        status: "succeeded",
        diagnostics: [],
        revisionIds: [revision.id],
        createdAt: at(7_000)
      },
      revisions: [revision],
      citations: [citation]
    });
    assert.deepEqual(await store.listCitations(revision.id), [citation]);
    const enrichedGeneration = await new IndexContextService(store).index(snapshot.checkpoint.id, at(8_000));
    assert.notEqual(enrichedGeneration.id, generation.id);
    assert.equal(enrichedGeneration.capabilities.derivedKnowledge, "available");

    const published = await query.latestPublished(tenantId, repository, ref, "reader-1");
    assert.equal(published?.id, enrichedGeneration.id);
    assert.equal(await query.latestPublished(tenantId, repository, ref, "intruder"), undefined);
    const candidates = await query.lexicalSearch({
      tenantId,
      repository,
      principalId: "reader-1",
      generationId: enrichedGeneration.id,
      query: "deployContext",
      limit: 10
    });
    assert.ok(candidates.some((candidate) => candidate.text.includes("deployContext")));
    assert.ok(candidates.some((candidate) => candidate.sourceKind === "knowledge"));
    const enrichedProjection = await store.getGeneration(enrichedGeneration.id);
    const fragment = enrichedProjection?.fragments[0];
    assert.ok(fragment);
    await embeddings.store({
      tenantId,
      repository,
      generationId: enrichedGeneration.id,
      projectorVersion: "dense-evaluation-v1",
      createdAt: at(8_500),
      embeddings: [
        {
          id: fragment.id,
          model: "fixture-embedding-v1",
          dimensions: 2,
          inputFingerprint: fragment.tokenFingerprint,
          vector: [1, 0]
        }
      ]
    });
    const denseMatches = await embeddings.search({
      tenantId,
      repository,
      generationId: enrichedGeneration.id,
      model: "fixture-embedding-v1",
      vector: [1, 0],
      allowedAclFingerprints: [aclFingerprint],
      limit: 10
    });
    assert.equal(denseMatches[0]?.fragmentId, fragment.id);
    assert.equal(denseMatches[0]?.score, 1);
    await store.recordQueryRun({
      id: "trace_integration",
      tenantId,
      repository,
      principalFingerprint: fingerprint("reader-1"),
      generationId: enrichedGeneration.id,
      requestFingerprint: fingerprint({ query: "deployContext" }),
      taskKind: "exact",
      routes: ["exact", "lexical"],
      coverageStatus: "complete",
      degradedCapabilities: [],
      citationFailureCount: 0,
      conflictCount: 0,
      startedAt: at(9_000),
      completedAt: at(9_042),
      durationMs: 42
    });
    assert.deepEqual(await store.queryMetrics(tenantId), {
      count: 1,
      p95Ms: 42,
      citationFailureCount: 0,
      conflictCount: 0
    });

    const erased = await store.eraseEvidence({
      tenantId,
      repository,
      sourceType: "blob",
      sourceId: blobSha,
      actorId: "security-admin",
      reason: "integration erasure",
      createdAt: at(10_000)
    });
    assert.ok(erased.erasedGenerationCount >= 1);
    assert.equal(await store.getRevision(revision.id), undefined);
    assert.deepEqual(await store.listCitations(revision.id), []);
    const rebuiltAfterErasure = await new IndexContextService(store).index(snapshot.checkpoint.id, at(11_000));
    assert.notEqual(rebuiltAfterErasure.id, enrichedGeneration.id);
    const postErasureCandidates = await query.lexicalSearch({
      tenantId,
      repository,
      principalId: "reader-1",
      generationId: rebuiltAfterErasure.id,
      query: "deployContext",
      limit: 10
    });
    assert.deepEqual(postErasureCandidates, []);
    const backlog = await store.projectionBacklog(tenantId);
    assert.ok(Object.values(backlog).every((value) => value.count === 0));

    const buildAfter = await coordinator.get(build.id);
    assert.equal(buildAfter?.status, "degraded");
    assert.equal(buildAfter?.stages.find((stage) => stage.topic === "run-index-context")?.status, "succeeded");
    const forbidden = await database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema='jina_context'
         and table_name in ('graphs','nodes','edges','assertions')`
    );
    assert.deepEqual(forbidden.rows, []);
    await assert.rejects(
      database.pool.query(
        "update jina_context.evidence_records set title='mutated' where tenant_id=$1 and repository=$2",
        [tenantId, repository]
      ),
      /append-only/
    );
    const privileges = await database.pool.query<{
      ingest_insert: boolean;
      ingest_update: boolean;
      query_projection: boolean;
      query_observation: boolean;
      derive_insert: boolean;
      derive_update: boolean;
      projector_lease_update: boolean;
      projector_payload_update: boolean;
    }>(
      `select
         has_table_privilege('jina_context_ingest','jina_context.evidence_records','insert') ingest_insert,
         has_table_privilege('jina_context_ingest','jina_context.evidence_records','update') ingest_update,
         has_table_privilege('jina_context_query','jina_context.published_context_documents','select') query_projection,
         has_table_privilege('jina_context_query','jina_context.observations','select') query_observation,
         has_table_privilege('jina_context_derive','jina_context.knowledge_document_revisions','insert') derive_insert,
         has_table_privilege('jina_context_derive','jina_context.knowledge_document_revisions','update') derive_update,
         has_column_privilege('jina_context_manifest','jina_context.outbox','lease_id','update') projector_lease_update,
         has_column_privilege('jina_context_manifest','jina_context.outbox','payload','update') projector_payload_update`
    );
    assert.deepEqual(privileges.rows[0], {
      ingest_insert: true,
      ingest_update: false,
      query_projection: true,
      query_observation: false,
      derive_insert: true,
      derive_update: false,
      projector_lease_update: true,
      projector_payload_update: false
    });
    const roleClient = await database.pool.connect();
    try {
      await roleClient.query("set role jina_context_manifest");
      const visibleConsumers = await roleClient.query<{ consumer: string }>(
        "select distinct consumer from jina_context.outbox order by consumer"
      );
      assert.deepEqual(visibleConsumers.rows, [{ consumer: "manifest" }]);
    } finally {
      await roleClient.query("reset role").catch(() => undefined);
      roleClient.release();
    }

    await store.close();
  }
);
