import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IndexContextService,
  IngestEvidenceService,
  QueryContextService,
  StoreScopeAuthorizer,
  createKnowledgeCitation,
  createKnowledgeRevision,
  createEvidenceRecord,
  fingerprint,
  repositoryAclFingerprint,
  stableId,
  type EvidenceSnapshot,
  type StructuralFact
} from "@jina/context-engine";
import { Pool } from "pg";
import { ContextDatabase } from "./context/database.js";
import { PostgresContextEmbeddingRepository } from "./context/embedding-repository.js";
import { PostgresEvidenceRepository } from "./context/evidence-repository.js";
import { PostgresContextOutboxRepository } from "./context/outbox-repository.js";
import { PostgresContextPipelineCoordinator } from "./context/pipeline-coordinator.js";
import { PostgresContextQueryRepository } from "./context/query-repository.js";
import { CONTEXT_ROLES } from "./context/roles.js";
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
    const aclFingerprint = repositoryAclFingerprint(tenantId, repository);
    const epoch = Date.now();
    const at = (offsetMs: number) => new Date(epoch + offsetMs).toISOString();
    const createdAt = at(0);
    const omittedTenantId = "tenant-omitted-integration";
    const omittedRepository = "acme/omitted-fixture";
    const omittedService = new IngestEvidenceService(store);
    const omittedCheckpoint = await omittedService.ingest({
      tenantId: omittedTenantId,
      repository: omittedRepository,
      ref,
      refSequence: 1,
      commitSha: "1".repeat(40),
      files: [
        { path: "assets/one.bin", blobSha: "2".repeat(40), body: "", contentOmitted: true },
        { path: "assets/two.bin", blobSha: "3".repeat(40), body: "", contentOmitted: true }
      ],
      aclFingerprint: repositoryAclFingerprint(omittedTenantId, omittedRepository),
      observationFrontier: "omitted:1",
      createdAt,
      sourceComplete: false,
      git: {
        commit: {
          treeSha: "5".repeat(40),
          parentShas: [],
          message: "Partial binary snapshot"
        },
        changes: [
          { kind: "add", path: "assets/one.bin", newBlobSha: "2".repeat(40) },
          { kind: "add", path: "assets/two.bin", newBlobSha: "3".repeat(40) }
        ]
      }
    });
    assert.equal((await store.listEvidence(omittedCheckpoint.id)).length, 0);
    const omittedBlobs = await database.queryAs<{ count: string }>(
      "jina_context_admin",
      { tenantIds: [omittedTenantId] },
      `select count(*)::text as count
       from jina_context.blobs
       where tenant_id=$1 and repository=$2`,
      [omittedTenantId, omittedRepository]
    );
    assert.equal(omittedBlobs.rows[0]?.count, "0");
    const omittedTree = await database.queryAs<{
      entry_count: number;
      content_digest: string;
    }>(
      "jina_context_admin",
      { tenantIds: [omittedTenantId] },
      `select entry_count,content_digest
       from jina_context.trees
       where tenant_id=$1 and repository=$2 and tree_sha=$3`,
      [omittedTenantId, omittedRepository, "5".repeat(40)]
    );
    const omittedTreeEntries = await database.queryAs<{
      path: string;
      blob_sha: string;
      mode: string;
    }>(
      "jina_context_admin",
      { tenantIds: [omittedTenantId] },
      `select path,blob_sha,mode
       from jina_context.tree_entries
       where tenant_id=$1 and repository=$2 and tree_sha=$3
       order by path`,
      [omittedTenantId, omittedRepository, "5".repeat(40)]
    );
    const expectedOmittedTree = [
      { path: "assets/one.bin", blobSha: "2".repeat(40), executable: false },
      { path: "assets/two.bin", blobSha: "3".repeat(40), executable: false }
    ];
    assert.equal(omittedTree.rows[0]?.entry_count, omittedTreeEntries.rows.length);
    assert.equal(omittedTree.rows[0]?.content_digest, fingerprint(expectedOmittedTree));
    assert.deepEqual(
      omittedTreeEntries.rows,
      expectedOmittedTree.map((entry) => ({
        path: entry.path,
        blob_sha: entry.blobSha,
        mode: "100644"
      }))
    );
    await omittedService.ingest({
      tenantId: omittedTenantId,
      repository: omittedRepository,
      ref,
      refSequence: 2,
      commitSha: "4".repeat(40),
      files: [{ path: "assets/one.bin", blobSha: "2".repeat(40), body: "available source" }],
      aclFingerprint: repositoryAclFingerprint(omittedTenantId, omittedRepository),
      observationFrontier: "omitted:2",
      createdAt: at(1),
      sourceComplete: true
    });
    const completedBlob = await database.queryAs<{ content_digest: string; content: string | null }>(
      "jina_context_admin",
      { tenantIds: [omittedTenantId] },
      `select content_digest,content
       from jina_context.blobs
       where tenant_id=$1 and repository=$2 and blob_sha=$3`,
      [omittedTenantId, omittedRepository, "2".repeat(40)]
    );
    assert.deepEqual(completedBlob.rows[0], {
      content_digest: fingerprint("available source"),
      content: "available source"
    });
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
    assert.equal(build.refSequence, 1);
    assert.ok(build.stages.every((stage) => stage.id.startsWith("cs_")));
    assert.ok(build.stages.every((stage) => stage.required));

    let ingestClaim = await coordinator.claim({
      tenantId,
      workerId: "integration-ingest",
      topics: ["run-ingest-evidence"],
      now: createdAt,
      leaseExpiresAt: at(600_000)
    });
    assert.ok(ingestClaim);
    assert.equal(ingestClaim.stage.metadata.refSequence, 1);
    assert.equal(ingestClaim.stage.metadata.commitSha, commitSha);
    assert.equal(ingestClaim.stage.metadata.githubInstallationId, 140435029);
    assert.equal(
      await coordinator.release({
        tenantId,
        stageId: ingestClaim.stage.id,
        leaseId: ingestClaim.fence.leaseId,
        now: at(1),
        reason: "integration release"
      }),
      true
    );
    ingestClaim = (await coordinator.claim({
      tenantId,
      workerId: "integration-ingest-retry",
      topics: ["run-ingest-evidence"],
      now: at(2),
      leaseExpiresAt: at(600_000)
    }))!;
    assert.equal(ingestClaim.stage.attempt, 2);
    assert.equal(ingestClaim.stage.metadata.releaseReason, "integration release");

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
        pathOrUrl: "src/context.ts"
      },
      ref,
      title: "src/context.ts",
      body: source,
      metadata: { language: "typescript", mediaType: "text/typescript" },
      authorityClass: "source_code",
      aclFingerprint,
      createdAt
    });
    const projectionBatchFixtures = Array.from({ length: 2_000 }, (_, ordinal) => {
      const path = `docs/readme-projection-${ordinal.toString().padStart(3, "0")}.md`;
      const body =
        ordinal === 0
          ? [
              ...Array.from({ length: 500 }, (_, heading) => `# Projection fixture ${heading}`),
              "## Cross-batch hierarchy child"
            ].join("\n")
          : `# Projection fixture ${ordinal}\n`;
      const fixtureBlobSha = (ordinal + 1).toString(16).padStart(40, "0");
      return {
        path,
        blobSha: fixtureBlobSha,
        record: createEvidenceRecord({
          anchor: {
            tenantId,
            repository,
            sourceType: "blob",
            sourceId: fixtureBlobSha,
            contentDigest: fingerprint(body),
            commitSha,
            pathOrUrl: path
          },
          ref,
          title: path,
          body,
          metadata: { language: "markdown", mediaType: "text/markdown" },
          authorityClass: "source_code",
          aclFingerprint,
          createdAt
        })
      };
    });
    const structuralFacts: StructuralFact[] = [
      ...Array.from({ length: 2_001 }, (_, ordinal) => ({
        id: stableId("sf", { repository, commitSha, ordinal }),
        tenantId,
        repository,
        ref,
        commitSha,
        kind: "references" as const,
        from: "src/context.ts#deployContext",
        to: `src/context.ts#target-${ordinal}`,
        anchors: [{ ...record.anchor, startLine: 1, endLine: 1 }],
        derivationName: "fixture-parser",
        derivationVersion: "fixture-parser-v1",
        metadata: { ordinal }
      })),
      {
        id: stableId("sf", { repository, commitSha, kind: "defines" }),
        tenantId,
        repository,
        ref,
        commitSha,
        kind: "defines",
        from: "src/context.ts",
        to: "src/context.ts#deployContext",
        anchors: [{ ...record.anchor, startLine: 1, endLine: 1 }],
        derivationName: "fixture-parser",
        derivationVersion: "fixture-parser-v1",
        metadata: {
          symbol: { name: "deployContext", kind: "function", startLine: 1, endLine: 1 }
        }
      },
      {
        id: stableId("sf", { repository, commitSha, kind: "imports" }),
        tenantId,
        repository,
        ref,
        commitSha,
        kind: "imports",
        from: "src/context.ts",
        to: "./runtime.js",
        anchors: [{ ...record.anchor, startLine: 1, endLine: 1 }],
        derivationName: "fixture-parser",
        derivationVersion: "fixture-parser-v1",
        metadata: { importedNames: ["startRuntime", "stopRuntime"] }
      }
    ];
    const snapshot: EvidenceSnapshot = {
      checkpoint: {
        id: stableId("ec", { tenantId, repository, commitSha }),
        tenantId,
        repository,
        ref,
        refSequence: 1,
        commitSha,
        parserVersion: "fixture-parser-v1",
        sourceCompleteness: "complete",
        observationFrontier: createdAt,
        evidenceFingerprint: fingerprint([record.id, ...projectionBatchFixtures.map((fixture) => fixture.record.id)]),
        manifestFingerprint: fingerprint([
          ["src/context.ts", blobSha],
          ...projectionBatchFixtures.map((fixture) => [fixture.path, fixture.blobSha])
        ]),
        aclFingerprint,
        createdAt
      },
      records: [record, ...projectionBatchFixtures.map((fixture) => fixture.record)],
      manifest: [
        {
          tenantId,
          repository,
          ref,
          commitSha,
          path: "src/context.ts",
          blobSha,
          contentDigest: record.anchor.contentDigest,
          contentAvailable: true,
          language: "typescript",
          executable: false
        },
        ...projectionBatchFixtures.map((fixture) => ({
          tenantId,
          repository,
          ref,
          commitSha,
          path: fixture.path,
          blobSha: fixture.blobSha,
          contentDigest: fixture.record.anchor.contentDigest,
          contentAvailable: true,
          language: "markdown",
          executable: false
        }))
      ],
      structuralFacts,
      git: {
        commit: {
          treeSha: "c".repeat(40),
          parentShas: ["d".repeat(40)],
          author: "Integration Test <test@example.com>",
          authoredAt: createdAt,
          committedAt: createdAt,
          message: "Add context deployment fixture"
        },
        changes: [{ kind: "add", path: "src/context.ts", newBlobSha: blobSha }],
        history: Array.from({ length: 500 }, (_, ordinal) => ({
          sha: ordinal.toString(16).padStart(40, "0"),
          treeSha: "e".repeat(40),
          parentShas: ["f".repeat(40)],
          author: "Integration Test <test@example.com>",
          authoredAt: createdAt,
          committedAt: createdAt,
          message: `Historical context fixture ${ordinal}`
        }))
      }
    };
    await store.commitSnapshot(snapshot, ingestClaim.fence);
    const persistedStructuralFacts = await database.pool.query<{ count: string }>(
      `select count(*)::text count
       from jina_context.evidence_checkpoint_structural_facts
       where checkpoint_id=$1`,
      [snapshot.checkpoint.id]
    );
    assert.equal(persistedStructuralFacts.rows[0]?.count, "2003");
    const batchedGitRows = await database.pool.query<{
      observations: string;
      commits: string;
      parents: string;
      tree_entries: string;
      analyses: string;
      symbols: string;
      imports: string;
      changes: string;
    }>(
      `select
         (select count(*)::text from jina_context.observations
          where tenant_id=$1 and repository=$2 and source='git') observations,
         (select count(*)::text from jina_context.commits
          where tenant_id=$1 and repository=$2) commits,
         (select count(*)::text from jina_context.commit_parents
          where tenant_id=$1 and repository=$2) parents,
         (select count(*)::text from jina_context.tree_entries
          where tenant_id=$1 and repository=$2) tree_entries,
         (select count(*)::text from jina_context.blob_analyses
          where tenant_id=$1 and repository=$2) analyses,
         (select count(*)::text from jina_context.symbols
          where tenant_id=$1 and repository=$2) symbols,
         (select count(*)::text from jina_context.imports
          where tenant_id=$1 and repository=$2) imports,
         (select count(*)::text from jina_context.commit_changes
          where tenant_id=$1 and repository=$2) changes`,
      [tenantId, repository]
    );
    assert.deepEqual(batchedGitRows.rows[0], {
      observations: "501",
      commits: "501",
      parents: "501",
      tree_entries: "2001",
      analyses: "2001",
      symbols: "1",
      imports: "2",
      changes: "1"
    });
    await database.pool.query(
      `insert into jina_context.outbox
        (delivery_id,event_id,tenant_id,repository,aggregate_type,aggregate_id,aggregate_sequence,
         event_type,consumer,payload,occurred_at,available_at)
       select
         'delivery_projection_batch_' || ordinal,
         'event_projection_batch_' || ordinal,
         $1,$2,'evidence','projection-batch-' || ordinal,1,
         'evidence.observed','structural',
         jsonb_build_object('ref',$3::text,'commitSha',$4::text),$5,$5
       from generate_series(0,500) ordinal`,
      [tenantId, repository, ref, commitSha, createdAt]
    );
    const repeatedFailureCacheKey = fingerprint("repeated-failed-derivation");
    for (const attempt of [1, 2]) {
      await store.recordFailedRun({
        id: stableId("dr", { repeatedFailureCacheKey, attempt }),
        tenantId,
        repository,
        checkpointId: snapshot.checkpoint.id,
        cacheKey: repeatedFailureCacheKey,
        focusFingerprint: fingerprint("repeated-failed-focus"),
        generatorName: "fixture",
        generatorVersion: "fixture-v1",
        model: "fixture",
        promptVersion: "fixture-v1",
        schemaVersion: "fixture-v1",
        rawOutputs: [{ attempt }],
        status: "failed",
        diagnostics: [`attempt ${attempt} failed validation`],
        revisionIds: [],
        createdAt: at(100 + attempt)
      });
    }
    const repeatedFailures = await database.pool.query<{ count: string }>(
      `select count(*)::text count
       from jina_context.derivation_runs
       where tenant_id=$1 and repository=$2 and cache_key=$3 and status='failed'`,
      [tenantId, repository, repeatedFailureCacheKey]
    );
    assert.equal(repeatedFailures.rows[0]?.count, "2");
    assert.equal(
      await store.projectionInputFingerprint(tenantId, repository),
      fingerprint({
        tenantId,
        repository,
        sequence: 1,
        eventId: `projection-input:evidence:${snapshot.checkpoint.id}`
      })
    );
    assert.ok(
      await store.resolveAnchor(snapshot.checkpoint.id, {
        tenantId,
        repository,
        sourceType: "blob",
        sourceId: blobSha,
        commitSha,
        pathOrUrl: "src/context.ts",
        startLine: 1,
        endLine: 1
      })
    );
    assert.equal(
      await store.resolveAnchor(snapshot.checkpoint.id, {
        tenantId,
        repository,
        sourceType: "blob",
        sourceId: blobSha,
        commitSha,
        pathOrUrl: "src/context.ts",
        startLine: 1,
        endLine: 3
      }),
      undefined
    );
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
    for (const delivery of lexicalDeliveries) {
      assert.equal(
        await outbox.fail({
          deliveryId: delivery.deliveryId,
          leaseId: delivery.leaseId,
          now: at(800),
          retryAt: at(900),
          error: "simulated projector restart"
        }),
        true
      );
      assert.equal(await outbox.acknowledge(delivery.deliveryId, delivery.leaseId, at(850)), false);
    }
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

    const [indexClaim, prematureDeriveClaim] = await Promise.all([
      coordinator.claim({
        tenantId,
        workerId: "integration-index",
        topics: ["run-derive-knowledge", "run-index-context"],
        now: at(2_000),
        leaseExpiresAt: at(600_000)
      }),
      coordinator.claim({
        tenantId,
        workerId: "integration-derive",
        topics: ["run-derive-knowledge", "run-index-context"],
        now: at(2_000),
        leaseExpiresAt: at(600_000)
      })
    ]);
    assert.ok(indexClaim);
    assert.equal(prematureDeriveClaim, undefined);
    assert.equal(indexClaim.stage.topic, "run-index-context");
    const generation = await new IndexContextService(store).index(snapshot.checkpoint.id, at(3_000), indexClaim.fence);
    assert.equal(generation.status, "published");
    const batchedProjectionRows = await database.pool.query<{
      manifest: string;
      documents: string;
      fragments: string;
      hierarchy: string;
      relations: string;
      acknowledged: string;
    }>(
      `select
         (select count(*)::text from jina_context.ref_manifest where generation_id=$1) manifest,
         (select count(*)::text from jina_context.context_documents where generation_id=$1) documents,
         (select count(*)::text from jina_context.context_fragments where generation_id=$1) fragments,
         (select count(*)::text from jina_context.hierarchy_nodes where generation_id=$1) hierarchy,
         (select count(*)::text from jina_context.structural_relations where generation_id=$1) relations,
         (select count(*)::text from jina_context.outbox
          where delivery_id like 'delivery_projection_batch_%' and processed_at is not null) acknowledged`,
      [generation.id]
    );
    assert.equal(batchedProjectionRows.rows[0]?.manifest, "2001");
    assert.equal(batchedProjectionRows.rows[0]?.documents, "2001");
    assert.ok(Number(batchedProjectionRows.rows[0]?.fragments) > 500);
    assert.equal(batchedProjectionRows.rows[0]?.hierarchy, "2500");
    assert.equal(batchedProjectionRows.rows[0]?.relations, "2003");
    assert.equal(batchedProjectionRows.rows[0]?.acknowledged, "501");
    const crossBatchHierarchy = await database.pool.query<{ child_parent_id: string; parent_id: string }>(
      `select child.parent_id child_parent_id,parent.id parent_id
       from jina_context.hierarchy_nodes child
       join jina_context.hierarchy_nodes parent
         on parent.generation_id=child.generation_id and parent.id=child.parent_id
       where child.generation_id=$1 and child.ordinal=500 and child.title='Cross-batch hierarchy child'`,
      [generation.id]
    );
    assert.equal(crossBatchHierarchy.rows.length, 1);
    assert.equal(crossBatchHierarchy.rows[0]?.child_parent_id, crossBatchHierarchy.rows[0]?.parent_id);
    assert.equal(
      (await new IndexContextService(store).index(snapshot.checkpoint.id, at(3_500), indexClaim.fence)).id,
      generation.id
    );
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
        error: "required fixture derivation failed"
      }),
      true
    );

    const releaseCommitSha = "e".repeat(40);
    const releaseCheckpoint = await new IngestEvidenceService(store).ingest({
      tenantId,
      repository,
      ref: "release",
      refSequence: 1,
      commitSha: releaseCommitSha,
      files: [
        {
          path: "src/context.ts",
          blobSha,
          body: source,
          language: "typescript"
        }
      ],
      observations: [],
      aclFingerprint,
      observationFrontier: at(6_100),
      createdAt: at(6_100),
      sourceComplete: true
    });
    const releaseGenerationBeforeRegrant = await new IndexContextService(store).index(releaseCheckpoint.id, at(6_200));
    const queryRunsBeforeRevocation = await database.pool.query<{ count: string }>(
      "select count(*)::text count from jina_context.query_runs where tenant_id=$1",
      [tenantId]
    );
    await store.replaceRepositoryAccess(tenantId, "reader-1", []);
    assert.equal((await query.authorize(tenantId, repository, "reader-1", generation.id)).allowed, false);
    assert.equal(await query.latestPublished(tenantId, repository, ref, "reader-1"), undefined);
    await assert.rejects(
      new QueryContextService(store).query({
        tenantId,
        repository,
        principalId: "reader-1",
        question: "Where is deployContext?"
      }),
      /access/i
    );
    const queryRunsAfterRevocation = await database.pool.query<{ count: string }>(
      "select count(*)::text count from jina_context.query_runs where tenant_id=$1",
      [tenantId]
    );
    assert.equal(queryRunsAfterRevocation.rows[0]?.count, queryRunsBeforeRevocation.rows[0]?.count);
    await store.replaceRepositoryAccess(tenantId, "reader-1", [repository]);
    // Access replacement records use the database wall clock. Advance the logical clock from
    // wall time here so batching performance cannot make those events unavailable.
    let liveClock = epoch + 6_200;
    const nextLiveAt = () => {
      liveClock = Math.max(liveClock + 1, Date.now());
      return new Date(liveClock).toISOString();
    };
    const mainGenerationAfterRegrant = await new IndexContextService(store).index(snapshot.checkpoint.id, nextLiveAt());
    assert.notEqual(mainGenerationAfterRegrant.id, generation.id);
    const partialAccessProjection = await store.projectionBacklog(tenantId);
    assert.ok(partialAccessProjection.acl.count > 0);
    assert.ok(partialAccessProjection.retention.count > 0);
    const releaseGenerationAfterRegrant = await new IndexContextService(store).index(
      releaseCheckpoint.id,
      nextLiveAt()
    );
    assert.notEqual(releaseGenerationAfterRegrant.id, releaseGenerationBeforeRegrant.id);
    const completedAccessProjection = await store.projectionBacklog(tenantId);
    assert.equal(completedAccessProjection.acl.count, 0);
    assert.equal(completedAccessProjection.retention.count, 0);

    const providerBody = JSON.stringify({ repository: { defaultBranch: "main" } });
    const providerRecord = createEvidenceRecord({
      anchor: {
        tenantId,
        repository,
        sourceType: "observation",
        sourceId: "provider-repository-fixture",
        contentDigest: fingerprint(providerBody),
        observedAt: createdAt
      },
      ref,
      title: "Repository metadata",
      body: providerBody,
      metadata: { provider: "github" },
      authorityClass: "provider_state",
      aclFingerprint,
      createdAt
    });
    const providerSnapshot: EvidenceSnapshot = {
      ...snapshot,
      checkpoint: {
        ...snapshot.checkpoint,
        id: stableId("ec", { tenantId, repository, commitSha, provider: true }),
        refSequence: 2,
        evidenceFingerprint: fingerprint([...snapshot.records.map((entry) => entry.id), providerRecord.id]),
        createdAt: nextLiveAt()
      },
      records: [...snapshot.records, providerRecord]
    };
    await store.commitSnapshot(providerSnapshot);
    const knowledgeCreatedAt = nextLiveAt();
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
      evidenceFingerprint: providerSnapshot.checkpoint.evidenceFingerprint,
      generatorName: "fixture",
      generatorVersion: "fixture-v1",
      model: "fixture",
      promptVersion: "fixture-v1",
      confidence: 1,
      createdAt: knowledgeCreatedAt
    });
    const citation = createKnowledgeCitation(
      revision.id,
      0,
      "export function deployContext(): string { return 'ready'; }",
      { ...record.anchor, startLine: 1, endLine: 1 }
    );
    const providerCitation = createKnowledgeCitation(revision.id, 1, "main", {
      ...providerRecord.anchor,
      jsonPointer: "/repository/defaultBranch"
    });
    await store.commitKnowledge({
      run: {
        id: stableId("dr", { checkpointId: providerSnapshot.checkpoint.id, revisionId: revision.id }),
        tenantId,
        repository,
        checkpointId: providerSnapshot.checkpoint.id,
        cacheKey: fingerprint({ checkpointId: providerSnapshot.checkpoint.id, revisionId: revision.id }),
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
        createdAt: knowledgeCreatedAt
      },
      revisions: [revision],
      citations: [citation, providerCitation]
    });
    const repeatedKnowledgeCreatedAt = nextLiveAt();
    const repeatedRevision = createKnowledgeRevision({
      ...revision,
      createdAt: repeatedKnowledgeCreatedAt
    });
    assert.equal(repeatedRevision.id, revision.id);
    await store.commitKnowledge({
      run: {
        id: stableId("dr", {
          checkpointId: providerSnapshot.checkpoint.id,
          revisionId: repeatedRevision.id,
          repeatedKnowledgeCreatedAt
        }),
        tenantId,
        repository,
        checkpointId: providerSnapshot.checkpoint.id,
        cacheKey: fingerprint({
          checkpointId: providerSnapshot.checkpoint.id,
          revisionId: repeatedRevision.id,
          repeatedKnowledgeCreatedAt
        }),
        focusFingerprint: fingerprint(["src/context.ts"]),
        generatorName: "fixture",
        generatorVersion: "fixture-v1",
        model: "fixture",
        promptVersion: "fixture-v1",
        schemaVersion: "knowledge-v1",
        rawOutputs: [{ documents: [repeatedRevision.logicalId] }],
        status: "succeeded",
        diagnostics: [],
        revisionIds: [repeatedRevision.id],
        createdAt: repeatedKnowledgeCreatedAt
      },
      revisions: [repeatedRevision],
      citations: [citation, providerCitation]
    });
    assert.equal((await store.getRevision(revision.id))?.createdAt, knowledgeCreatedAt);
    assert.deepEqual(await store.listCitations(revision.id), [citation, providerCitation]);
    const enrichedGeneration = await new IndexContextService(store).index(providerSnapshot.checkpoint.id, nextLiveAt());
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
    assert.equal(
      (await store.getScopedGeneration(tenantId, [repository], enrichedGeneration.id))?.generation.id,
      enrichedGeneration.id
    );
    assert.equal(await store.getScopedGeneration(omittedTenantId, [repository], enrichedGeneration.id), undefined);
    assert.equal(await store.getScopedGeneration(tenantId, ["acme/not-authorized"], enrichedGeneration.id), undefined);
    assert.equal((await store.getScopedRevision(tenantId, [repository], revision.id))?.id, revision.id);
    assert.equal(await store.getScopedRevision(omittedTenantId, [repository], revision.id), undefined);
    assert.equal(await store.getScopedRevision(tenantId, ["acme/not-authorized"], revision.id), undefined);
    const authorizedProjection = await store.getAuthorizedGeneration(enrichedGeneration.id, "reader-1");
    const unauthorizedProjection = await store.getAuthorizedGeneration(enrichedGeneration.id, "reader-without-access");
    assert.equal(authorizedProjection?.documents.length, enrichedProjection?.documents.length);
    assert.equal(unauthorizedProjection, undefined);
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
    await database.pool.query(
      `update jina_context.context_documents
       set metadata=jsonb_set(metadata,'{requiredAclFingerprints}',$2::jsonb)
       where generation_id=$1 and id=$3`,
      [enrichedGeneration.id, JSON.stringify([aclFingerprint, fingerprint("second-required-acl")]), fragment.documentId]
    );
    assert.deepEqual(
      await embeddings.search({
        tenantId,
        repository,
        generationId: enrichedGeneration.id,
        model: "fixture-embedding-v1",
        vector: [1, 0],
        allowedAclFingerprints: [aclFingerprint],
        limit: 10
      }),
      []
    );
    assert.deepEqual(
      await embeddings.search({
        tenantId,
        repository,
        generationId: enrichedGeneration.id,
        model: "fixture-embedding-v1",
        vector: [1, 0],
        allowedAclFingerprints: ["*"],
        limit: 10
      }),
      []
    );
    const allAclDenseMatches = await embeddings.search({
      tenantId,
      repository,
      generationId: enrichedGeneration.id,
      model: "fixture-embedding-v1",
      vector: [1, 0],
      allowedAclFingerprints: [aclFingerprint, fingerprint("second-required-acl")],
      limit: 10
    });
    assert.equal(allAclDenseMatches[0]?.fragmentId, fragment.id);
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
      durationMs: 42,
      candidates: [
        {
          ordinal: 0,
          candidateId: "candidate_integration",
          retriever: "lexical",
          sourceKind: "code",
          sourceId: blobSha,
          rawScore: 0.8,
          fusedScore: 0.9,
          selected: true,
          diagnostics: { explanation: "integration fixture" }
        }
      ],
      citations: [
        {
          ordinal: 0,
          citationId: "citation_integration",
          sourceKind: "code",
          sourceId: blobSha,
          sourceAnchor: { ...record.anchor },
          contentDigest: record.anchor.contentDigest,
          accessible: true,
          digestValid: true,
          supportsClaim: true,
          diagnostics: {}
        }
      ],
      routeMetrics: [{ route: "lexical", candidateCount: 1, durationMs: 7 }]
    });
    assert.deepEqual(await store.queryMetrics(tenantId), {
      count: 1,
      p95Ms: 42,
      citationFailureCount: 0,
      conflictCount: 0
    });
    const persistedTrace = await database.queryAs<{
      candidates: string;
      citations: string;
      metrics: string;
    }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select
         (select count(*)::text from jina_context.retrieval_candidates where query_run_id='trace_integration')
           as candidates,
         (select count(*)::text from jina_context.answer_citations where query_run_id='trace_integration')
           as citations,
         (select count(*)::text from jina_context.retrieval_metrics where query_run_id='trace_integration')
           as metrics`
    );
    assert.deepEqual(persistedTrace.rows[0], { candidates: "1", citations: "1", metrics: "2" });

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
    assert.deepEqual(await store.listCitations(revision.id), [providerCitation]);
    const rebuiltAfterErasure = await new IndexContextService(store).index(providerSnapshot.checkpoint.id, at(11_000));
    assert.notEqual(rebuiltAfterErasure.id, enrichedGeneration.id);
    const releaseAfterErasure = await new IndexContextService(store).index(releaseCheckpoint.id, at(11_100));
    assert.notEqual(releaseAfterErasure.id, releaseGenerationAfterRegrant.id);
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
    const projectorBarrier = await database.pool.query<{
      status: string;
      lease_id: string | null;
      completed_at: Date | null;
    }>(
      `select status,lease_id,completed_at
       from jina_context.generation_projectors
       where generation_id=$1
       order by consumer`,
      [rebuiltAfterErasure.id]
    );
    assert.ok(projectorBarrier.rows.length > 0);
    assert.ok(
      projectorBarrier.rows.every(
        (projector) =>
          !["pending", "running"].includes(projector.status) &&
          projector.lease_id === null &&
          projector.completed_at !== null
      )
    );
    const recordedProjectorCheckpoints = await database.pool.query<{ count: string }>(
      `select count(*)::text count
       from jina_context.projection_checkpoints checkpoint
       join jina_context.generation_projectors projector
         on projector.generation_id=$1
        and projector.consumer=checkpoint.consumer
       where checkpoint.tenant_id=$2 and checkpoint.repository=$3 and checkpoint.ref_name=$4
         and projector.status <> 'failed'`,
      [rebuiltAfterErasure.id, tenantId, repository, ref]
    );
    assert.equal(Number(recordedProjectorCheckpoints.rows[0]?.count), projectorBarrier.rows.length);
    const successorCheckpoint = await new IngestEvidenceService(store).ingest({
      tenantId,
      repository,
      ref,
      refSequence: 3,
      commitSha: "9".repeat(40),
      files: [
        {
          path: "src/context-v2.ts",
          blobSha: "8".repeat(40),
          body: "export const contextVersion = 2;\n",
          language: "typescript"
        }
      ],
      observations: [],
      aclFingerprint,
      observationFrontier: at(12_000),
      createdAt: at(12_000),
      sourceComplete: true,
      git: {
        commit: {
          treeSha: "7".repeat(40),
          parentShas: [commitSha],
          message: "Advance context fixture"
        },
        changes: [
          {
            kind: "add",
            path: "src/context-v2.ts",
            newBlobSha: "8".repeat(40)
          }
        ]
      }
    });
    await assert.rejects(
      new IndexContextService(store).index(providerSnapshot.checkpoint.id, at(12_100)),
      /superseded/
    );
    const successorGeneration = await new IndexContextService(store).index(successorCheckpoint.id, at(12_200));
    assert.equal((await store.latestPublished(tenantId, repository, ref))?.generation.id, successorGeneration.id);
    assert.equal(
      (
        await database.pool.query<{ commit_sha: string }>(
          `select commit_sha from jina_context.current_refs
           where tenant_id=$1 and repository=$2 and ref_name=$3`,
          [tenantId, repository, ref]
        )
      ).rows[0]?.commit_sha,
      "9".repeat(40)
    );
    assert.ok(Object.values(await store.projectionBacklog(tenantId)).every((value) => value.count === 0));

    const providerStateRepository = "acme/provider-state-race";
    const providerStateCommit = "c".repeat(40);
    const ingestProviderState = (refSequence: number, state: string, observedAt: string) =>
      new IngestEvidenceService(store).ingest({
        tenantId,
        repository: providerStateRepository,
        ref,
        refSequence,
        commitSha: providerStateCommit,
        files: [],
        observations: [
          {
            sourceType: "issue",
            sourceId: "issue-7",
            title: "Issue #7",
            payload: { number: 7, state },
            pathOrUrl: `https://example.test/${providerStateRepository}/issues/7`,
            observedAt,
            metadata: { number: 7, state }
          }
        ],
        aclFingerprint: repositoryAclFingerprint(tenantId, providerStateRepository),
        observationFrontier: `provider-state:${refSequence}`,
        createdAt: at(12_200 + refSequence),
        sourceComplete: true
      });
    const openProviderState = await ingestProviderState(1, "open", at(12_201));
    const openIssueRecord = (await store.listEvidence(openProviderState.id))[0]!;
    const providerStateRevision = createKnowledgeRevision({
      logicalId: `component:${providerStateRepository}:issue-7`,
      tenantId,
      repository: providerStateRepository,
      kind: "component",
      title: "Issue 7 state",
      bodyMarkdown: "Issue 7 is open.",
      summary: "Issue 7 is open.",
      structuredSummary: { state: "open" },
      scope: {
        ref,
        commitSha: providerStateCommit,
        paths: [],
        symbols: [],
        pullRequests: [],
        issues: ["7"]
      },
      evidenceFingerprint: fingerprint(openIssueRecord.anchor),
      generatorName: "fixture",
      generatorVersion: "fixture-v1",
      model: "fixture",
      promptVersion: "fixture-v1",
      confidence: 1,
      createdAt: at(12_204)
    });
    const providerStateCitation = createKnowledgeCitation(providerStateRevision.id, 0, "open", {
      ...openIssueRecord.anchor,
      jsonPointer: "/state"
    });
    await store.commitKnowledge({
      run: {
        id: "provider-state-run",
        tenantId,
        repository: providerStateRepository,
        checkpointId: openProviderState.id,
        cacheKey: fingerprint("provider-state-cache"),
        focusFingerprint: fingerprint("provider-state-focus"),
        generatorName: "fixture",
        generatorVersion: "fixture-v1",
        model: "fixture",
        promptVersion: "fixture-v1",
        schemaVersion: "fixture-v1",
        rawOutputs: [],
        status: "succeeded",
        diagnostics: [],
        revisionIds: [providerStateRevision.id],
        createdAt: at(12_204)
      },
      revisions: [providerStateRevision],
      citations: [providerStateCitation]
    });
    assert.deepEqual(
      (await store.listCheckpointRevisions(tenantId, providerStateRepository, openProviderState.id)).map(
        (revision) => revision.id
      ),
      [providerStateRevision.id]
    );
    const closedProviderState = await ingestProviderState(2, "closed", at(12_205));
    assert.deepEqual(
      await store.listCheckpointRevisions(tenantId, providerStateRepository, closedProviderState.id),
      []
    );
    assert.equal(
      (await new IndexContextService(store).index(closedProviderState.id, at(12_206))).capabilities.derivedKnowledge,
      "unavailable"
    );
    const identicalProviderState = await ingestProviderState(3, "open", at(12_201));
    assert.equal(identicalProviderState.evidenceFingerprint, openProviderState.evidenceFingerprint);
    assert.deepEqual(
      (await store.listCheckpointRevisions(tenantId, providerStateRepository, identicalProviderState.id)).map(
        (revision) => revision.id
      ),
      [providerStateRevision.id]
    );
    assert.equal(
      (await new IndexContextService(store).index(identicalProviderState.id, at(12_207))).capabilities.derivedKnowledge,
      "available"
    );

    const supersededBacklogRepository = "acme/superseded-backlog";
    const supersededBacklogBuild = await coordinator.createBuild({
      tenantId,
      repository: supersededBacklogRepository,
      ref,
      commitSha: "a".repeat(40),
      requestKey: "superseded-backlog-older",
      createdAt: at(12_210)
    });
    const supersededBacklogCheckpoint = await new IngestEvidenceService(store).ingest({
      tenantId,
      repository: supersededBacklogRepository,
      ref,
      refSequence: supersededBacklogBuild.refSequence,
      commitSha: "a".repeat(40),
      files: [],
      observations: [],
      aclFingerprint: repositoryAclFingerprint(tenantId, supersededBacklogRepository),
      observationFrontier: "superseded-backlog-older",
      createdAt: at(12_220),
      sourceComplete: true
    });
    assert.ok(
      Number(
        (
          await database.pool.query<{ count: string }>(
            `select count(*)::text count from jina_context.outbox
             where tenant_id=$1 and repository=$2 and processed_at is null`,
            [tenantId, supersededBacklogRepository]
          )
        ).rows[0]?.count
      ) > 0
    );
    await coordinator.createBuild({
      tenantId,
      repository: supersededBacklogRepository,
      ref,
      commitSha: "b".repeat(40),
      requestKey: "superseded-backlog-newer",
      createdAt: at(12_230)
    });
    assert.ok(!(await store.pendingProjectionCheckpoints(tenantId, 100)).includes(supersededBacklogCheckpoint.id));
    const supersededDeliveries = await database.pool.query<{ pending: string; superseded: string }>(
      `select
         count(*) filter (where processed_at is null)::text pending,
         count(*) filter (
           where processed_at is not null
             and last_error='superseded by a newer admitted ref sequence'
         )::text superseded
       from jina_context.outbox
       where tenant_id=$1 and repository=$2`,
      [tenantId, supersededBacklogRepository]
    );
    assert.equal(Number(supersededDeliveries.rows[0]?.pending), 0);
    assert.ok(Number(supersededDeliveries.rows[0]?.superseded) > 0);

    const refRaceRepository = "acme/ref-race";
    const olderBuild = await coordinator.createBuild({
      tenantId,
      repository: refRaceRepository,
      ref,
      commitSha: "1".repeat(40),
      requestKey: "ref-race-older",
      createdAt: at(12_300)
    });
    const newerBuild = await coordinator.createBuild({
      tenantId,
      repository: refRaceRepository,
      ref,
      commitSha: "2".repeat(40),
      requestKey: "ref-race-newer",
      createdAt: at(12_400)
    });
    assert.equal(olderBuild.refSequence, 1);
    assert.equal(newerBuild.refSequence, 2);
    const initialRefFrontier = await store.projectionInputFingerprint(tenantId, refRaceRepository);
    const delayedOlderRefCheckpoint = await new IngestEvidenceService(store).ingest({
      tenantId,
      repository: refRaceRepository,
      ref,
      refSequence: olderBuild.refSequence,
      commitSha: "1".repeat(40),
      files: [],
      observations: [],
      aclFingerprint: repositoryAclFingerprint(tenantId, refRaceRepository),
      observationFrontier: "older-delayed",
      createdAt: at(12_500),
      sourceComplete: true
    });
    assert.equal(await store.projectionInputFingerprint(tenantId, refRaceRepository), initialRefFrontier);
    await assert.rejects(new IndexContextService(store).index(delayedOlderRefCheckpoint.id, at(12_600)), /superseded/);
    await assert.rejects(
      store.commitKnowledge({
        run: {
          id: "stale-pg-derive-run",
          tenantId,
          repository: refRaceRepository,
          checkpointId: delayedOlderRefCheckpoint.id,
          cacheKey: "stale-pg-derive-cache",
          focusFingerprint: "stale",
          generatorName: "test",
          generatorVersion: "1",
          model: "test",
          promptVersion: "1",
          schemaVersion: "1",
          rawOutputs: [],
          status: "succeeded",
          diagnostics: [],
          revisionIds: [],
          createdAt: at(12_600)
        },
        revisions: [],
        citations: []
      }),
      /superseded/
    );
    assert.equal(
      Number(
        (
          await database.pool.query<{ count: string }>(
            `select count(*)::text count from jina_context.outbox
             where tenant_id=$1 and repository=$2 and processed_at is null`,
            [tenantId, refRaceRepository]
          )
        ).rows[0]?.count
      ),
      0
    );

    const newerRefCheckpoint = await new IngestEvidenceService(store).ingest({
      tenantId,
      repository: refRaceRepository,
      ref,
      refSequence: newerBuild.refSequence,
      commitSha: "2".repeat(40),
      files: [],
      observations: [],
      aclFingerprint: repositoryAclFingerprint(tenantId, refRaceRepository),
      observationFrontier: "newer",
      createdAt: at(12_700),
      sourceComplete: true
    });
    assert.equal((await store.latestCheckpoint(tenantId, refRaceRepository, ref))?.id, newerRefCheckpoint.id);
    assert.equal(
      (await new IndexContextService(store).index(newerRefCheckpoint.id, at(12_900))).commitSha,
      "2".repeat(40)
    );
    assert.ok(Object.values(await store.projectionBacklog(tenantId)).every((value) => value.count === 0));

    const numericSequenceRepository = "acme/numeric-checkpoint-order";
    let numericSequenceCheckpointId = "";
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      const sequenceCommitSha = sequence.toString(16).padStart(40, "0");
      const sequenceBuild = await coordinator.createBuild({
        tenantId,
        repository: numericSequenceRepository,
        ref,
        commitSha: sequenceCommitSha,
        requestKey: `numeric-checkpoint-order-${sequence}`,
        createdAt: at(12_900 + sequence * 10)
      });
      const sequenceCheckpoint = await new IngestEvidenceService(store).ingest({
        tenantId,
        repository: numericSequenceRepository,
        ref,
        refSequence: sequenceBuild.refSequence,
        commitSha: sequenceCommitSha,
        files: [],
        observations: [],
        aclFingerprint: repositoryAclFingerprint(tenantId, numericSequenceRepository),
        observationFrontier: `numeric-checkpoint-order-${sequence}`,
        createdAt: at(12_900 + sequence * 10 + 1),
        sourceComplete: true
      });
      numericSequenceCheckpointId = sequenceCheckpoint.id;
    }
    assert.equal(
      (await new IndexContextService(store).index(numericSequenceCheckpointId, at(13_100))).commitSha,
      "a".padStart(40, "0")
    );

    const raceTenantId = `${tenantId}-acl-race`;
    const raceRepository = "acme/acl-race";
    const raceAclFingerprint = repositoryAclFingerprint(raceTenantId, raceRepository);
    await Promise.all([
      store.mergeRepositoryAccess(raceTenantId, "merge-reader", [raceRepository]),
      store.mergeRepositoryAccess(raceTenantId, "merge-reader", ["acme/merge-second"])
    ]);
    assert.deepEqual(await store.repositoriesForPrincipal(raceTenantId, "merge-reader"), [
      raceRepository,
      "acme/merge-second"
    ]);
    await store.replaceRepositoryAccess(raceTenantId, "race-reader", [raceRepository]);
    const raceCheckpoint = await new IngestEvidenceService(store).ingest({
      tenantId: raceTenantId,
      repository: raceRepository,
      ref,
      refSequence: 1,
      commitSha: "7".repeat(40),
      files: [
        {
          path: "README.md",
          blobSha: "6".repeat(40),
          body: "# ACL publication race fixture\n",
          language: "markdown"
        }
      ],
      observations: [],
      aclFingerprint: raceAclFingerprint,
      observationFrontier: at(13_000),
      createdAt: at(13_000),
      sourceComplete: true
    });
    const mutableDatabase = database as unknown as { transactionAs: ContextDatabase["transactionAs"] };
    const originalTransactionAs = database.transactionAs.bind(database);
    let revokeAfterAclProjection = true;
    mutableDatabase.transactionAs = async (role, scope, operation) => {
      const result = await originalTransactionAs(role, scope, operation);
      if (role === "jina_context_acl" && revokeAfterAclProjection) {
        revokeAfterAclProjection = false;
        await store.replaceRepositoryAccess(raceTenantId, "race-reader", []);
      }
      return result;
    };
    try {
      await assert.rejects(
        new IndexContextService(store).index(raceCheckpoint.id, at(14_000)),
        /Repository access changed while indexing/
      );
    } finally {
      mutableDatabase.transactionAs = originalTransactionAs;
    }
    assert.equal(revokeAfterAclProjection, false);
    assert.equal(
      Number(
        (
          await database.pool.query<{ count: string }>(
            `select count(*)::text count
             from jina_context.index_generations
             where tenant_id=$1 and repository=$2 and status='published'`,
            [raceTenantId, raceRepository]
          )
        ).rows[0]?.count
      ),
      0
    );
    await store.replaceRepositoryAccess(raceTenantId, "race-reader", [raceRepository]);
    const raceGeneration = await new IndexContextService(store).index(raceCheckpoint.id, at(15_000));
    assert.equal(
      raceGeneration.repositoryAccessFingerprint,
      await store.repositoryAccessFingerprint(raceTenantId, raceRepository)
    );
    class PostgresRevokingAuthorizer extends StoreScopeAuthorizer {
      calls = 0;

      override async authorize(input: Parameters<StoreScopeAuthorizer["authorize"]>[0]) {
        this.calls += 1;
        if (this.calls === 2) {
          await store.replaceRepositoryAccess(raceTenantId, "race-reader", []);
        }
        return super.authorize(input);
      }
    }
    await assert.rejects(
      () =>
        new QueryContextService(store, new PostgresRevokingAuthorizer(store)).query({
          tenantId: raceTenantId,
          repository: raceRepository,
          principalId: "race-reader",
          question: "ACL publication race fixture"
        }),
      /access changed|does not have repository access/i
    );
    await store.replaceRepositoryAccess(raceTenantId, "race-reader", [raceRepository]);

    const inputRaceTenantId = `${tenantId}-input-race`;
    const inputRaceRepository = "acme/input-race";
    const inputRaceCheckpoint = await new IngestEvidenceService(store).ingest({
      tenantId: inputRaceTenantId,
      repository: inputRaceRepository,
      ref,
      refSequence: 1,
      commitSha: "5".repeat(40),
      files: [
        {
          path: "README.md",
          blobSha: "4".repeat(40),
          body: "# Projection input race fixture\n",
          language: "markdown"
        }
      ],
      observations: [],
      aclFingerprint: repositoryAclFingerprint(inputRaceTenantId, inputRaceRepository),
      observationFrontier: at(15_100),
      createdAt: at(15_100),
      sourceComplete: true
    });
    let eraseAfterRetentionProjection = true;
    mutableDatabase.transactionAs = async (role, scope, operation) => {
      const result = await originalTransactionAs(role, scope, operation);
      if (role === "jina_context_retention" && eraseAfterRetentionProjection) {
        eraseAfterRetentionProjection = false;
        await store.eraseEvidence({
          tenantId: inputRaceTenantId,
          repository: inputRaceRepository,
          sourceType: "blob",
          sourceId: "4".repeat(40),
          actorId: "security-test",
          reason: "deterministic publication race",
          createdAt: at(15_200)
        });
      }
      return result;
    };
    try {
      await assert.rejects(
        new IndexContextService(store).index(inputRaceCheckpoint.id, at(15_300)),
        /Canonical projection inputs changed while indexing/
      );
    } finally {
      mutableDatabase.transactionAs = originalTransactionAs;
    }
    assert.equal(eraseAfterRetentionProjection, false);
    assert.equal(await store.latestPublished(inputRaceTenantId, inputRaceRepository, ref), undefined);
    assert.equal((await query.authorize(raceTenantId, raceRepository, "race-reader", raceGeneration.id)).allowed, true);

    const relandedSnapshot: EvidenceSnapshot = {
      ...snapshot,
      checkpoint: {
        ...snapshot.checkpoint,
        id: stableId("ec", { tenantId, repository, commitSha, refSequence: 4 }),
        refSequence: 4,
        createdAt: at(15_400)
      }
    };
    await store.commitSnapshot(relandedSnapshot);
    assert.equal(
      (
        await database.pool.query<{ commit_sha: string }>(
          `select commit_sha from jina_context.current_refs
           where tenant_id=$1 and repository=$2 and ref_name=$3`,
          [tenantId, repository, ref]
        )
      ).rows[0]?.commit_sha,
      commitSha
    );
    assert.equal(
      (
        await database.pool.query<{ ref_sequence: string }>(
          `select ref.ref_sequence::text ref_sequence
           from jina_context.refs ref
           where ref.tenant_id=$1 and ref.repository=$2 and ref.ref_name=$3 and ref.commit_sha=$4
           order by ref.ref_sequence desc limit 1`,
          [tenantId, repository, ref, commitSha]
        )
      ).rows[0]?.ref_sequence,
      "4"
    );

    const buildAfter = await coordinator.get(build.id);
    assert.equal(buildAfter?.status, "failed");
    assert.equal(buildAfter?.stages.find((stage) => stage.topic === "run-derive-knowledge")?.required, true);
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
      await roleClient.query("select set_config('jina.tenant_id',$1,false)", [tenantId]);
      const visibleConsumers = await roleClient.query<{ consumer: string }>(
        "select distinct consumer from jina_context.outbox order by consumer"
      );
      assert.deepEqual(visibleConsumers.rows, [{ consumer: "manifest" }]);
      await roleClient.query("reset role");
      await roleClient.query("set role jina_context_query");
      await roleClient.query("select set_config('jina.tenant_id',$1,false)", ["tenant-with-no-context-access"]);
      const isolatedDependentRows = await roleClient.query<{
        exact_count: string;
        candidate_count: string;
        citation_count: string;
      }>(
        `select
           (select count(*)::text from jina_context.exact_index) exact_count,
           (select count(*)::text from jina_context.retrieval_candidates) candidate_count,
           (select count(*)::text from jina_context.answer_citations) citation_count`
      );
      assert.deepEqual(isolatedDependentRows.rows[0], {
        exact_count: "0",
        candidate_count: "0",
        citation_count: "0"
      });
    } finally {
      await roleClient.query("reset role").catch(() => undefined);
      roleClient.release();
    }

    const runtimeRole = "jina_context_runtime_test";
    const runtimePassword = "context-runtime-test-password";
    await database.pool.query(`drop role if exists ${runtimeRole}`);
    await database.pool.query(`create role ${runtimeRole} login password '${runtimePassword}' noinherit`);
    await database.pool.query(`grant ${CONTEXT_ROLES.join(",")} to ${runtimeRole}`);
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    const rawRuntime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    await assert.rejects(
      rawRuntime.query("select count(*) from jina_context.evidence_checkpoints"),
      /permission denied/
    );
    await rawRuntime.end();
    const runtimeDatabase = new ContextDatabase({
      connectionString: runtimeUrl.toString(),
      manageSchema: false,
      manageRoles: false
    });
    const runtimeStore = new PostgresContextEngineStore(runtimeDatabase);
    assert.ok((await runtimeStore.listRepositories(tenantId)).includes(repository));
    assert.equal((await runtimeStore.getGeneration(successorGeneration.id))?.generation.id, successorGeneration.id);
    const scopedTenantRows = await runtimeDatabase.queryAs<{ tenant_id: string }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      "select distinct tenant_id from jina_context.evidence_checkpoints order by tenant_id"
    );
    assert.deepEqual(scopedTenantRows.rows, [{ tenant_id: tenantId }]);
    const crossTenantRows = await runtimeDatabase.queryAs<{ count: string }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      "select count(*)::text count from jina_context.evidence_checkpoints where tenant_id=$1",
      [omittedTenantId]
    );
    assert.equal(crossTenantRows.rows[0]?.count, "0");
    await runtimeStore.close();
    await database.pool.query(`revoke ${CONTEXT_ROLES.join(",")} from ${runtimeRole}`);
    await database.pool.query(`drop role ${runtimeRole}`);

    await store.close();
  }
);
