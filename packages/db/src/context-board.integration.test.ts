import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  BoardContextPublicationError,
  BoardPageIndexAttachmentError,
  ContextCatalogService,
  IngestEvidenceService,
  MemoryContextEngineStore,
  PAGEINDEX_OSS_ADAPTER_NAME,
  PAGEINDEX_OSS_SOURCE_DIGEST,
  PAGEINDEX_OSS_SOURCE_PIN,
  boardPageIndexAttachmentInputDigest,
  createKnowledgeCitation,
  createKnowledgeRevision,
  fingerprint,
  repositoryAclFingerprint,
  serializeBoardPageIndexTreeArtifact,
  stableId,
  type BoardContextPublicationCommit,
  type BoardPageIndexTreeArtifactV1,
  type ContextArtifactRef,
  type QueryPlan,
  type ContextTenantQuotaLedger
} from "@jina/context-engine";
import { ContextDatabase } from "./context/database.js";
import { PostgresBoardPageIndexAttachmentRepository } from "./context/board-pageindex-attachment-repository.js";
import { PostgresBoardContextPublicationRepository } from "./context/board-publication-repository.js";
import { PostgresContextQuotaStore } from "./context/context-quota-store.js";
import { CONTEXT_RUNTIME_ROLES } from "./context/roles.js";
import { hardenContextRuntimeRole } from "./context/runtime-role.js";
import { PostgresContextEngineStore } from "./context/store.js";

// This test drops and recreates the Context and runtime schemas. Never fall
// back to a generic application DATABASE_URL: an ordinary `pnpm test` in a
// configured shell must not be able to erase a retained or deployed database.
const databaseUrl = process.env.TEST_DATABASE_URL;
const TENANT = "tenant-board-persistence";
const OTHER_TENANT = "tenant-board-persistence-other";
const REPOSITORY = "acme/context";
const REF = "main";
const COMMIT = "a".repeat(40);
const CREATED_AT = "2026-07-30T12:00:00.000Z";
const BUILD_ID = "task_context_build";
const PUBLICATION_TASK_ID = "task_context_publication";
const PUBLICATION_MESSAGE_ID = "outbox_context_publication";
const PAGEINDEX_TASK_ID = "task_context_pageindex";
const PAGEINDEX_MESSAGE_ID = "outbox_context_pageindex";
const RUNTIME_LOGIN = "jina_context_runtime_integration";
const RUNTIME_PASSWORD = "runtime-integration-password";
const CONTEXT_READ_PATH_INDEXES = [
  "context_documents_manifest_path",
  "context_documents_revision",
  "context_fragments_generation_acl",
  "context_generations_dashboard",
  "context_knowledge_events_revision_lookup",
  "context_knowledge_evidence_revision",
  "context_knowledge_revisions_id",
  "context_query_runs_completed_metrics"
] as const;

test(
  "Board publication, PageIndex attachment, citations, and tenant quotas survive a fresh Postgres round trip",
  { skip: !databaseUrl },
  async () => {
    const database = new ContextDatabase({
      connectionString: databaseUrl,
      manageSchema: true,
      manageRoles: true,
      max: 8
    });
    try {
      await database.pool.query("drop schema if exists jina_runtime cascade");
      await database.pool.query("drop schema if exists jina_context cascade");
      await database.initialize();
      const readPathIndexes = await database.pool.query<{ indexname: string }>(
        `select indexname
         from pg_indexes
         where schemaname='jina_context' and indexname=any($1::text[])
         order by indexname`,
        [[...CONTEXT_READ_PATH_INDEXES]]
      );
      assert.deepEqual(
        readPathIndexes.rows.map((row) => row.indexname),
        [...CONTEXT_READ_PATH_INDEXES].sort()
      );
      await database.pool.query(`
        create schema jina_runtime;
        create table jina_runtime.api_state (
          id smallint primary key check (id=1),
          snapshot jsonb not null,
          version bigint not null default 1,
          updated_at timestamptz not null default now()
        )
      `);

      const publication = await publicationFixture();
      const accessStore = new PostgresContextEngineStore(database);
      await accessStore.replaceRepositoryAccess(TENANT, "user:context-reader", [REPOSITORY]);
      await saveBoardState(database, publicationBoardState(publication.commit));
      const publisher = new PostgresBoardContextPublicationRepository(database);

      const [first, replay] = await Promise.all([
        publisher.publishAtomically(publication.commit),
        publisher.publishAtomically(publication.commit)
      ]);
      assert.deepEqual(replay, first);
      assert.equal(
        (
          await database.pool.query(
            `select 1 from jina_context.repository_acl_projection
             where generation_id=$1 and principal_id='user:context-reader' and permission='read'`,
            [publication.commit.releaseId]
          )
        ).rowCount,
        1
      );
      const publicationCount = await database.pool.query<{ count: string }>(
        "select count(*)::text count from jina_context.context_board_publications where release_id=$1",
        [publication.commit.releaseId]
      );
      assert.equal(publicationCount.rows[0]?.count, "1");
      const current = await database.pool.query<{ release_id: string }>(
        `select release_id
         from jina_context.current_context_board_releases
         where tenant_id=$1 and repository=$2 and ref_name=$3`,
        [TENANT, REPOSITORY, REF]
      );
      assert.equal(current.rowCount, 0);
      const prepared = await database.pool.query<{ status: string; published_at: Date | null }>(
        "select status,published_at from jina_context.index_generations where id=$1",
        [publication.commit.releaseId]
      );
      assert.deepEqual(prepared.rows[0], { status: "building", published_at: null });
      const preparedStore = new PostgresContextEngineStore(database);
      assert.equal(await preparedStore.getGeneration(publication.commit.releaseId), undefined);
      assert.deepEqual(
        await new ContextCatalogService(preparedStore).listReleases({
          tenantId: TENANT,
          principalId: "tenant-admin",
          repository: REPOSITORY,
          tenantAdmin: true
        }),
        []
      );

      // Simulate an API process crash after prepared publication. A fresh
      // connection must read the durable prepared state without exposing it.
      const restartedBeforeAttach = new ContextDatabase({
        connectionString: databaseUrl,
        manageSchema: false,
        manageRoles: false,
        max: 2
      });
      try {
        const restartedStore = new PostgresContextEngineStore(restartedBeforeAttach);
        assert.equal(await restartedStore.getGeneration(publication.commit.releaseId), undefined);
        assert.equal(
          (
            await restartedBeforeAttach.pool.query(
              "select 1 from jina_context.context_board_publications where release_id=$1",
              [publication.commit.releaseId]
            )
          ).rowCount,
          1
        );
      } finally {
        await restartedBeforeAttach.close();
      }

      const citationRoundTrip = await database.pool.query<{
        revision_id: string;
        claim_role: string;
        anchor: unknown;
      }>(
        `select revision_id,claim_role,anchor
         from jina_context.knowledge_revision_evidence
         where tenant_id=$1 and repository=$2 and revision_id=$3`,
        [TENANT, REPOSITORY, publication.revisionId]
      );
      assert.equal(citationRoundTrip.rowCount, 1);
      assert.equal(citationRoundTrip.rows[0]?.claim_role, publication.claim);
      assert.deepEqual(citationRoundTrip.rows[0]?.anchor, publication.anchor);

      await saveBoardState(database, pageIndexBoardState(publication.commit));
      const attachment = pageIndexFixture(publication);
      const attachmentDatabase = new ContextDatabase({
        connectionString: databaseUrl,
        manageSchema: false,
        manageRoles: false,
        max: 2
      });
      const pageIndex = new PostgresBoardPageIndexAttachmentRepository(attachmentDatabase);
      let attached: Awaited<ReturnType<typeof pageIndex.attachPageIndexAtomically>>;
      let attachedReplay: Awaited<ReturnType<typeof pageIndex.attachPageIndexAtomically>>;
      try {
        const invalidTree = {
          ...attachment.commit,
          treeArtifact: {
            ...attachment.commit.treeArtifact,
            diagnostics: ["simulated incomplete PageIndex output"]
          }
        };
        await assert.rejects(
          () => pageIndex.attachPageIndexAtomically(invalidTree),
          (error: unknown) =>
            error instanceof BoardPageIndexAttachmentError && error.code === "invalid_pageindex_attachment"
        );
        assert.equal(
          (
            await database.pool.query("select 1 from jina_context.current_context_board_releases where release_id=$1", [
              publication.commit.releaseId
            ])
          ).rowCount,
          0
        );
        assert.equal(
          (
            await database.pool.query<{ status: string }>(
              "select status from jina_context.index_generations where id=$1",
              [publication.commit.releaseId]
            )
          ).rows[0]?.status,
          "building"
        );

        // Force a failure after hierarchy insertion but before release
        // publication. PostgreSQL must roll the complete attachment back, and
        // the same Board task must remain safely retryable.
        await database.pool.query(
          `update jina_context.generation_projectors
           set status='ready'
           where generation_id=$1 and consumer='hierarchy'`,
          [publication.commit.releaseId]
        );
        await assert.rejects(
          () => pageIndex.attachPageIndexAtomically(attachment.commit),
          (error: unknown) => error instanceof BoardPageIndexAttachmentError && error.code === "attachment_race"
        );
        assert.equal(
          (
            await database.pool.query("select 1 from jina_context.hierarchy_nodes where generation_id=$1", [
              publication.commit.releaseId
            ])
          ).rowCount,
          0
        );
        assert.equal(
          (
            await database.pool.query("select 1 from jina_context.current_context_board_releases where release_id=$1", [
              publication.commit.releaseId
            ])
          ).rowCount,
          0
        );
        await database.pool.query(
          `update jina_context.generation_projectors
           set status='disabled'
           where generation_id=$1 and consumer='hierarchy'`,
          [publication.commit.releaseId]
        );
        attached = await pageIndex.attachPageIndexAtomically(attachment.commit);
        attachedReplay = await pageIndex.attachPageIndexAtomically(attachment.commit);
      } finally {
        await attachmentDatabase.close();
      }
      assert.deepEqual(attachedReplay, attached);
      assert.equal(attached.releaseId, publication.commit.releaseId);
      assert.equal(attached.documentCount, 1);
      assert.equal(attached.nodeCount, 1);
      const hierarchyCount = await database.pool.query<{ count: string }>(
        "select count(*)::text count from jina_context.hierarchy_nodes where generation_id=$1",
        [publication.commit.releaseId]
      );
      assert.equal(hierarchyCount.rows[0]?.count, "1");
      const readyCurrent = await database.pool.query<{ release_id: string }>(
        `select release_id
         from jina_context.current_context_board_releases
         where tenant_id=$1 and repository=$2 and ref_name=$3`,
        [TENANT, REPOSITORY, REF]
      );
      assert.equal(readyCurrent.rows[0]?.release_id, publication.commit.releaseId);
      const published = await preparedStore.getGeneration(publication.commit.releaseId);
      assert.equal(published?.generation.status, "published");
      assert.equal(published?.generation.projectorStatuses.hierarchy, "ready");
      assert.equal(published?.generation.capabilities.hierarchy, "available");
      assert.equal(
        (await preparedStore.latestPublished(TENANT, REPOSITORY, REF))?.generation.id,
        publication.commit.releaseId
      );
      await preparedStore.replaceRepositoryAccess(TENANT, "tenant-admin", [REPOSITORY]);
      assert.equal(
        (
          await database.pool.query(
            `select 1 from jina_context.repository_acl_projection
             where generation_id=$1 and principal_id='tenant-admin' and permission='read'`,
            [publication.commit.releaseId]
          )
        ).rowCount,
        1
      );
      assert.equal(
        (
          await database.pool.query(
            `select 1 from jina_context.outbox
             where tenant_id=$1 and repository=$2 and aggregate_type='access' and processed_at is null`,
            [TENANT, REPOSITORY]
          )
        ).rowCount,
        0
      );
      const authorizedGeneration = await preparedStore.latestAuthorizedGeneration(
        TENANT,
        REPOSITORY,
        REF,
        "tenant-admin"
      );
      assert.ok(authorizedGeneration);
      assert.equal(authorizedGeneration.id, publication.commit.releaseId);
      assert.equal(authorizedGeneration.projectorStatuses.hierarchy, "ready");
      const exact = await preparedStore.retrieveIndexed({
        tenantId: TENANT,
        repository: REPOSITORY,
        principalId: "tenant-admin",
        generation: authorizedGeneration,
        plan: {
          normalizedQuestion: "Find the architecture context",
          taskKind: "lookup",
          routes: [],
          targets: {
            paths: [],
            symbols: ["component:acme/context:architecture"],
            pullRequests: [],
            issues: []
          },
          plannerVersion: "integration"
        } satisfies QueryPlan,
        route: "exact",
        limit: 12,
        allowedAclFingerprints: new Set([repositoryAclFingerprint(TENANT, REPOSITORY)])
      });
      assert.equal(exact.length, 1);
      assert.equal(exact[0]?.sourceRevisionId, publication.revisionId);
      assert.deepEqual(
        (
          await new ContextCatalogService(preparedStore).listReleases({
            tenantId: TENANT,
            principalId: "tenant-admin",
            repository: REPOSITORY,
            tenantAdmin: true
          })
        ).map((release) => release.id),
        [publication.commit.releaseId]
      );
      assert.deepEqual(await preparedStore.contextCatalogMetrics(TENANT), {
        publishedGenerationCount: 1,
        documentCount: 1,
        fragmentCount: 1,
        hierarchyNodeCount: 1
      });
      await seedExactSelectionFixtures(database, publication.commit.releaseId);
      const coveredTargets = await preparedStore.retrieveIndexed({
        tenantId: TENANT,
        repository: REPOSITORY,
        principalId: "tenant-admin",
        generation: authorizedGeneration,
        plan: exactPlan("`first-target` and `later-target`"),
        route: "exact",
        limit: 2,
        allowedAclFingerprints: new Set([repositoryAclFingerprint(TENANT, REPOSITORY)])
      });
      assert.deepEqual(coveredTargets.map((candidate) => candidate.sourceId).sort(), ["exact-first-a", "exact-later"]);
      const multiTarget = await preparedStore.retrieveIndexed({
        tenantId: TENANT,
        repository: REPOSITORY,
        principalId: "tenant-admin",
        generation: authorizedGeneration,
        plan: exactPlan("`multi-a` and `multi-b`"),
        route: "exact",
        limit: 1,
        allowedAclFingerprints: new Set([repositoryAclFingerprint(TENANT, REPOSITORY)])
      });
      assert.equal(multiTarget[0]?.sourceId, "exact-multi");
      assert.equal(multiTarget[0]?.rawScore, 2);

      const restartedAfterAttach = new ContextDatabase({
        connectionString: databaseUrl,
        manageSchema: false,
        manageRoles: false,
        max: 2
      });
      try {
        const restartedStore = new PostgresContextEngineStore(restartedAfterAttach);
        const readBack = await restartedStore.getGeneration(publication.commit.releaseId);
        assert.equal(readBack?.generation.status, "published");
        assert.equal(readBack?.hierarchyNodes.length, 1);
        assert.equal(
          (await restartedStore.latestPublished(TENANT, REPOSITORY, REF))?.generation.id,
          publication.commit.releaseId
        );
      } finally {
        await restartedAfterAttach.close();
      }

      const quotas = new PostgresContextQuotaStore(database);
      await Promise.all([
        incrementQuota(quotas, TENANT),
        incrementQuota(quotas, TENANT),
        incrementQuota(quotas, OTHER_TENANT)
      ]);
      const tenantLedger = await readQuota(quotas, TENANT);
      const otherLedger = await readQuota(quotas, OTHER_TENANT);
      assert.equal(tenantLedger.queryRate.used, 2);
      assert.equal(otherLedger.queryRate.used, 1);
      assert.equal(tenantLedger.tenantId, TENANT);
      assert.equal(otherLedger.tenantId, OTHER_TENANT);
      const quotaRows = await database.pool.query<{ tenant_id: string }>(
        "select tenant_id from jina_context.context_quota_ledgers order by tenant_id"
      );
      assert.deepEqual(
        quotaRows.rows.map((row) => row.tenant_id),
        [TENANT, OTHER_TENANT].sort()
      );
    } finally {
      await database.close();
    }
  }
);

test(
  "a newer admitted ref fences a prepared release before PageIndex can make it public",
  { skip: !databaseUrl },
  async () => {
    const database = new ContextDatabase({
      connectionString: databaseUrl,
      manageSchema: true,
      manageRoles: true,
      max: 8
    });
    try {
      await database.pool.query("drop schema if exists jina_runtime cascade");
      await database.pool.query("drop schema if exists jina_context cascade");
      await database.initialize();
      await database.pool.query(`
        create schema jina_runtime;
        create table jina_runtime.api_state (
          id smallint primary key check (id=1),
          snapshot jsonb not null,
          version bigint not null default 1,
          updated_at timestamptz not null default now()
        )
      `);

      const publication = await publicationFixture();
      await saveBoardState(database, publicationBoardState(publication.commit));
      await new PostgresBoardContextPublicationRepository(database).publishAtomically(publication.commit);
      await saveBoardState(database, pageIndexBoardState(publication.commit, true));

      const attachment = pageIndexFixture(publication);
      await assert.rejects(
        () => new PostgresBoardPageIndexAttachmentRepository(database).attachPageIndexAtomically(attachment.commit),
        (error: unknown) =>
          error instanceof BoardPageIndexAttachmentError &&
          error.code === "stale_ref_sequence" &&
          error.message.includes("latest admitted is 2")
      );

      const state = await database.pool.query<{
        status: string;
        published_at: Date | null;
        pageindex_attached_at: Date | null;
      }>(
        `select generation.status,generation.published_at,publication.pageindex_attached_at
         from jina_context.index_generations generation
         join jina_context.context_board_publications publication
           on publication.release_id=generation.id
         where generation.id=$1`,
        [publication.commit.releaseId]
      );
      assert.deepEqual(state.rows[0], {
        status: "building",
        published_at: null,
        pageindex_attached_at: null
      });
      assert.equal(
        (
          await database.pool.query(
            `select 1 from jina_context.current_context_board_releases
             where tenant_id=$1 and repository=$2 and ref_name=$3`,
            [TENANT, REPOSITORY, REF]
          )
        ).rowCount,
        0
      );

      // Recreate the visibility bug from the previous schema, then initialize
      // a fresh process with the new schema. Upgrade must hide the unattached
      // generation and remove its public pointer.
      await database.pool.query(
        `update jina_context.index_generations
         set status='published',published_at=$2
         where id=$1`,
        [publication.commit.releaseId, CREATED_AT]
      );
      await database.pool.query(
        `insert into jina_context.current_context_board_releases
          (tenant_id,repository,ref_name,ref_sequence,release_id,commit_sha,
           public_snapshot_digest,advanced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          TENANT,
          REPOSITORY,
          REF,
          publication.commit.scope.refSequence,
          publication.commit.releaseId,
          publication.commit.scope.commitSha,
          publication.commit.publicSnapshotDigest,
          CREATED_AT
        ]
      );
      const upgraded = new ContextDatabase({
        connectionString: databaseUrl,
        manageSchema: true,
        manageRoles: true,
        max: 2
      });
      try {
        await upgraded.initialize();
        assert.equal(
          (
            await upgraded.pool.query("select 1 from jina_context.current_context_board_releases where release_id=$1", [
              publication.commit.releaseId
            ])
          ).rowCount,
          0
        );
        assert.deepEqual(
          (
            await upgraded.pool.query<{ status: string; published_at: Date | null }>(
              "select status,published_at from jina_context.index_generations where id=$1",
              [publication.commit.releaseId]
            )
          ).rows[0],
          { status: "building", published_at: null }
        );
      } finally {
        await upgraded.close();
      }
    } finally {
      await database.close();
    }
  }
);

test(
  "evidence erasure invalidates a prepared Board release before PageIndex can publish it",
  { skip: !databaseUrl },
  async () => {
    const database = new ContextDatabase({
      connectionString: databaseUrl,
      manageSchema: true,
      manageRoles: true,
      max: 8
    });
    try {
      await database.pool.query("drop schema if exists jina_runtime cascade");
      await database.pool.query("drop schema if exists jina_context cascade");
      await database.initialize();
      await database.pool.query(`
        create schema jina_runtime;
        create table jina_runtime.api_state (
          id smallint primary key check (id=1),
          snapshot jsonb not null,
          version bigint not null default 1,
          updated_at timestamptz not null default now()
        )
      `);

      const publication = await publicationFixture();
      await saveBoardState(database, publicationBoardState(publication.commit));
      await new PostgresBoardContextPublicationRepository(database).publishAtomically(publication.commit);
      assert.equal(
        (
          await database.pool.query<{ status: string }>(
            "select status from jina_context.index_generations where id=$1",
            [publication.commit.releaseId]
          )
        ).rows[0]?.status,
        "building"
      );

      await saveBoardState(database, pageIndexBoardState(publication.commit));
      const erased = await new PostgresContextEngineStore(database).eraseEvidence({
        tenantId: TENANT,
        repository: REPOSITORY,
        sourceType: publication.anchor.sourceType,
        sourceId: publication.anchor.sourceId,
        reason: "deterministic prepared-publication race",
        actorId: "context-chaos-acceptance",
        createdAt: "2026-07-30T12:00:01.000Z"
      });
      assert.equal(erased.erasedGenerationCount, 1);

      const attachment = pageIndexFixture(publication);
      await assert.rejects(
        () => new PostgresBoardPageIndexAttachmentRepository(database).attachPageIndexAtomically(attachment.commit),
        (error: unknown) => error instanceof BoardPageIndexAttachmentError && error.code === "release_not_current"
      );
      assert.deepEqual(
        (
          await database.pool.query<{ status: string; published_at: Date | null }>(
            "select status,published_at from jina_context.index_generations where id=$1",
            [publication.commit.releaseId]
          )
        ).rows[0],
        { status: "invalidated", published_at: null }
      );
      assert.equal(
        (
          await database.pool.query("select 1 from jina_context.current_context_board_releases where release_id=$1", [
            publication.commit.releaseId
          ])
        ).rowCount,
        0
      );
      assert.equal(
        (
          await database.pool.query("select 1 from jina_context.hierarchy_nodes where generation_id=$1", [
            publication.commit.releaseId
          ])
        ).rowCount,
        0
      );
      assert.equal(
        await new PostgresContextEngineStore(database).getGeneration(publication.commit.releaseId),
        undefined
      );
    } finally {
      await database.close();
    }
  }
);

test(
  "Board publication rejects citations erased before its authoritative transaction",
  { skip: !databaseUrl },
  async () => {
    const database = new ContextDatabase({
      connectionString: databaseUrl,
      manageSchema: true,
      manageRoles: true,
      max: 8
    });
    try {
      await database.pool.query("drop schema if exists jina_runtime cascade");
      await database.pool.query("drop schema if exists jina_context cascade");
      await database.initialize();
      await database.pool.query(`
        create schema jina_runtime;
        create table jina_runtime.api_state (
          id smallint primary key check (id=1),
          snapshot jsonb not null,
          version bigint not null default 1,
          updated_at timestamptz not null default now()
        )
      `);
      await database.pool.query(
        `insert into jina_context.repositories
          (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
         values ($1,$2,'unknown',$2,$3,'{}'::jsonb,$4,$4)`,
        [TENANT, REPOSITORY, REF, CREATED_AT]
      );

      const publication = await publicationFixture();
      await new PostgresContextEngineStore(database).eraseEvidence({
        tenantId: TENANT,
        repository: REPOSITORY,
        sourceType: publication.anchor.sourceType,
        sourceId: publication.anchor.sourceId,
        reason: "citation erased before publication",
        actorId: "context-chaos-acceptance",
        createdAt: "2026-07-30T12:00:01.000Z"
      });
      await saveBoardState(database, publicationBoardState(publication.commit));

      await assert.rejects(
        () => new PostgresBoardContextPublicationRepository(database).publishAtomically(publication.commit),
        (error: unknown) => error instanceof BoardContextPublicationError && error.code === "certification_mismatch"
      );
      assert.equal(
        (
          await database.pool.query("select 1 from jina_context.context_board_publications where release_id=$1", [
            publication.commit.releaseId
          ])
        ).rowCount,
        0
      );
      assert.equal(
        (
          await database.pool.query("select 1 from jina_context.index_generations where id=$1", [
            publication.commit.releaseId
          ])
        ).rowCount,
        0
      );
    } finally {
      await database.close();
    }
  }
);

test(
  "non-owner runtime login activates only the scoped capabilities needed to prepare, attach, and seed a release",
  { skip: !databaseUrl },
  async () => {
    const ownerDatabase = new ContextDatabase({
      connectionString: databaseUrl,
      manageSchema: true,
      manageRoles: true,
      max: 8
    });
    let runtimeDatabase: ContextDatabase | undefined;
    try {
      await removeRuntimeLogin(ownerDatabase);
      await ownerDatabase.pool.query("drop schema if exists jina_runtime cascade");
      await ownerDatabase.pool.query("drop schema if exists jina_context cascade");
      await ownerDatabase.initialize();
      await ownerDatabase.pool.query(`
        create schema jina_runtime;
        create table jina_runtime.api_state (
          id smallint primary key check (id=1),
          snapshot jsonb not null,
          version bigint not null default 1,
          updated_at timestamptz not null default now()
        )
      `);
      await ownerDatabase.pool.query(
        `create role "${RUNTIME_LOGIN}"
         login password '${RUNTIME_PASSWORD}'
         nosuperuser nobypassrls noreplication nocreatedb nocreaterole noinherit`
      );
      await hardenContextRuntimeRole(ownerDatabase.pool, RUNTIME_LOGIN);
      await ownerDatabase.pool.query(
        `grant ${CONTEXT_RUNTIME_ROLES.join(",")} to "${RUNTIME_LOGIN}" with inherit false`
      );

      const role = await ownerDatabase.pool.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolinherit: boolean;
      }>(
        `select rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit
         from pg_roles where rolname=$1`,
        [RUNTIME_LOGIN]
      );
      assert.deepEqual(role.rows[0], {
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolinherit: false
      });
      const memberships = await ownerDatabase.pool.query<{ capability: string; inherit_option: boolean }>(
        `select granted.rolname capability,membership.inherit_option
         from pg_auth_members membership
         join pg_roles granted on granted.oid=membership.roleid
         join pg_roles member on member.oid=membership.member
         where member.rolname=$1
         order by granted.rolname`,
        [RUNTIME_LOGIN]
      );
      assert.deepEqual(
        memberships.rows.map((row) => row.capability),
        [...CONTEXT_RUNTIME_ROLES].sort()
      );
      assert.ok(memberships.rows.every((row) => row.inherit_option === false));

      runtimeDatabase = new ContextDatabase({
        connectionString: runtimeConnectionString(databaseUrl!, RUNTIME_LOGIN, RUNTIME_PASSWORD),
        manageSchema: false,
        manageRoles: false,
        max: 4
      });
      await assert.rejects(
        () => runtimeDatabase!.pool.query("select 1 from jina_context.context_board_publications"),
        /permission denied/
      );

      const publication = await publicationFixture();
      await saveBoardState(ownerDatabase, publicationBoardState(publication.commit));
      assert.equal((await runtimeDatabase.pool.query("select 1 from jina_runtime.api_state where id=1")).rowCount, 1);
      const publisher = new PostgresBoardContextPublicationRepository(runtimeDatabase);
      const prepared = await publisher.publishAtomically(publication.commit);
      assert.equal(prepared.releaseId, publication.commit.releaseId);
      assert.deepEqual(
        (
          await ownerDatabase.pool.query<{ status: string; published_at: Date | null }>(
            "select status,published_at from jina_context.index_generations where id=$1",
            [publication.commit.releaseId]
          )
        ).rows[0],
        { status: "building", published_at: null }
      );
      assert.equal(
        (
          await ownerDatabase.pool.query(
            "select 1 from jina_context.current_context_board_releases where release_id=$1",
            [publication.commit.releaseId]
          )
        ).rowCount,
        0
      );

      await saveBoardState(ownerDatabase, pageIndexBoardState(publication.commit));
      const attachment = pageIndexFixture(publication);
      const attached = await new PostgresBoardPageIndexAttachmentRepository(runtimeDatabase).attachPageIndexAtomically(
        attachment.commit
      );
      assert.equal(attached.releaseId, publication.commit.releaseId);

      const seed = await publisher.findCurrentReleaseSeed({
        tenantId: TENANT,
        repository: REPOSITORY,
        ref: REF
      });
      assert.equal(seed?.releaseId, publication.commit.releaseId);
      assert.equal(seed?.refSequence, publication.commit.scope.refSequence);
      assert.equal(
        await publisher.findCurrentReleaseSeed({
          tenantId: OTHER_TENANT,
          repository: REPOSITORY,
          ref: REF
        }),
        undefined
      );
      await assert.rejects(
        () => runtimeDatabase!.pool.query("select 1 from jina_context.context_board_publications"),
        /permission denied/
      );

      await assert.rejects(
        () => runtimeDatabase!.pool.query("set role jina_context_admin"),
        /permission denied to set role/
      );
    } finally {
      await runtimeDatabase?.close();
      await removeRuntimeLogin(ownerDatabase);
      await ownerDatabase.close();
    }
  }
);

async function publicationFixture(): Promise<{
  readonly commit: BoardContextPublicationCommit;
  readonly revisionId: string;
  readonly claim: string;
  readonly anchor: BoardContextPublicationCommit["citations"][number]["anchor"];
}> {
  const source = "export function greeting() { return 'hello'; }\n";
  const memory = new MemoryContextEngineStore();
  const checkpoint = await new IngestEvidenceService(memory).ingest({
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: REF,
    refSequence: 1,
    commitSha: COMMIT,
    files: [
      {
        path: "src/index.ts",
        blobSha: "b".repeat(40),
        body: source,
        language: "typescript"
      }
    ],
    aclFingerprint: repositoryAclFingerprint(TENANT, REPOSITORY),
    observationFrontier: "board-persistence:1",
    createdAt: CREATED_AT,
    sourceComplete: true
  });
  const snapshot = {
    checkpoint,
    records: await memory.listEvidence(checkpoint.id),
    manifest: await memory.listManifest(checkpoint.id),
    structuralFacts: await memory.listStructuralFacts(checkpoint.id)
  };
  const record = snapshot.records[0]!;
  const claim = "The greeting function returns hello.";
  const bodyMarkdown = `# Architecture\n\n${claim}\n`;
  const revision = createKnowledgeRevision({
    logicalId: "component:acme/context:architecture",
    tenantId: TENANT,
    repository: REPOSITORY,
    kind: "component",
    title: "Architecture",
    bodyMarkdown,
    summary: claim,
    structuredSummary: {},
    scope: {
      ref: REF,
      commitSha: COMMIT,
      paths: ["src/index.ts"],
      symbols: ["greeting"],
      pullRequests: [],
      issues: []
    },
    evidenceFingerprint: fingerprint(record.anchor),
    generatorName: "integration",
    generatorVersion: "1",
    model: "gpt-5.6-terra",
    promptVersion: "1",
    confidence: 1,
    createdAt: CREATED_AT
  });
  const citation = createKnowledgeCitation(revision.id, 0, "return 'hello'", record.anchor);
  const publicSnapshotDigest = fingerprint({
    path: "architecture.md",
    bodyMarkdown
  });
  const publicationInputDigest = fingerprint({
    checkpointId: checkpoint.id,
    revisionId: revision.id,
    publicSnapshotDigest
  });
  const releaseId = stableId("cr", { publicationInputDigest });
  const releaseArtifact = artifactRef(BUILD_ID, "context-release", `${releaseId}.json`, JSON.stringify({ releaseId }));
  const commit: BoardContextPublicationCommit = {
    scope: {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: REF,
      refSequence: 1,
      commitSha: COMMIT,
      buildId: BUILD_ID
    },
    lease: {
      taskId: PUBLICATION_TASK_ID,
      messageId: PUBLICATION_MESSAGE_ID,
      attempt: 1,
      leaseId: "lease-publication",
      writeFenceToken: "fence-publication",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    },
    idempotencyKey: "publication:board-persistence:1",
    publicationInputDigest,
    publicSnapshotDigest,
    releaseId,
    releaseArtifact,
    certificationArtifact: artifactRef(BUILD_ID, "certification", "certification.json", "{}"),
    publicationPlanArtifact: artifactRef(BUILD_ID, "publication-plan", "plan.json", "{}"),
    snapshot,
    run: {
      id: stableId("dr", { checkpointId: checkpoint.id, revisionId: revision.id }),
      tenantId: TENANT,
      repository: REPOSITORY,
      checkpointId: checkpoint.id,
      cacheKey: fingerprint({ checkpointId: checkpoint.id }),
      focusFingerprint: fingerprint({ path: "src/index.ts" }),
      generatorName: "integration",
      generatorVersion: "1",
      model: "gpt-5.6-terra",
      promptVersion: "1",
      schemaVersion: "1",
      rawOutputs: [],
      status: "succeeded",
      diagnostics: [],
      revisionIds: [revision.id],
      createdAt: CREATED_AT
    },
    revisions: [revision],
    citations: [citation],
    pages: [
      {
        documentPath: "architecture.md",
        title: "Architecture",
        bodyMarkdown,
        bodySha256: createHash("sha256").update(bodyMarkdown).digest("hex"),
        revisionId: revision.id,
        citations: [citation]
      }
    ],
    publishedAt: CREATED_AT
  };
  return { commit, revisionId: revision.id, claim: citation.claim, anchor: record.anchor };
}

function runtimeConnectionString(ownerConnectionString: string, runtimeUser: string, runtimePassword: string): string {
  const url = new URL(ownerConnectionString);
  url.username = runtimeUser;
  url.password = runtimePassword;
  return url.toString();
}

async function removeRuntimeLogin(database: ContextDatabase): Promise<void> {
  const exists = await database.pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname=$1)",
    [RUNTIME_LOGIN]
  );
  if (!exists.rows[0]?.exists) return;
  await database.pool.query(`revoke ${CONTEXT_RUNTIME_ROLES.join(",")} from "${RUNTIME_LOGIN}"`);
  await database.pool.query(`drop owned by "${RUNTIME_LOGIN}"`);
  await database.pool.query(`drop role "${RUNTIME_LOGIN}"`);
}

async function seedExactSelectionFixtures(database: ContextDatabase, generationId: string): Promise<void> {
  const fixtures = ["exact-first-a", "exact-first-b", "exact-first-c", "exact-later", "exact-multi"];
  await database.pool.query(
    `with source as (
       select * from jina_context.context_documents where generation_id=$1 order by id limit 1
     ), fixture(document_id) as (
       select unnest($2::text[])
     )
     insert into jina_context.context_documents
       (id,generation_id,tenant_id,repository,ref_name,commit_sha,source_kind,source_id,
        source_revision_id,title,body,contextual_text,metadata,authority_class,
        effective_acl_fingerprint,source_fingerprint,source_anchors,projector_name,
        projector_version,projected_at)
     select fixture.document_id,source.generation_id,source.tenant_id,source.repository,
            source.ref_name,source.commit_sha,'code',fixture.document_id,null,
            fixture.document_id,source.body,source.contextual_text,
            jsonb_build_object('fixture',fixture.document_id),source.authority_class,
            source.effective_acl_fingerprint,source.source_fingerprint,source.source_anchors,
            source.projector_name,source.projector_version,source.projected_at
     from source cross join fixture`,
    [generationId, fixtures]
  );
  await database.pool.query(
    `with source as (
       select * from jina_context.context_fragments where generation_id=$1 order by id limit 1
     ), fixture(document_id) as (
       select unnest($2::text[])
     )
     insert into jina_context.context_fragments
       (id,generation_id,document_id,tenant_id,repository,ordinal,source_text,
        contextual_text,source_anchors,source_start,source_end,content_fingerprint,
        effective_acl_fingerprint)
     select 'fragment-' || fixture.document_id,source.generation_id,fixture.document_id,
            source.tenant_id,source.repository,0,source.source_text,source.contextual_text,
            source.source_anchors,source.source_start,source.source_end,source.content_fingerprint,
            source.effective_acl_fingerprint
     from source cross join fixture`,
    [generationId, fixtures]
  );
  await database.pool.query(
    `insert into jina_context.exact_index (generation_id,term,document_id,field)
     select $1,fixture.term,fixture.document_id,'metadata'
     from (values
       ('first-target','exact-first-a'),
       ('first-target','exact-first-b'),
       ('first-target','exact-first-c'),
       ('later-target','exact-later'),
       ('multi-a','exact-multi'),
       ('multi-b','exact-multi')
     ) as fixture(term,document_id)`,
    [generationId]
  );
}

function exactPlan(normalizedQuestion: string): QueryPlan {
  return {
    normalizedQuestion,
    taskKind: "lookup",
    routes: [],
    targets: { paths: [], symbols: [], pullRequests: [], issues: [] },
    plannerVersion: "integration"
  };
}

function publicationBoardState(commit: BoardContextPublicationCommit): unknown {
  return {
    intakeState: {
      board: {
        tasks: [
          boardBuildTask(),
          {
            id: PUBLICATION_TASK_ID,
            type: "publish-context-release",
            kind: "dispatchable",
            status: "in_progress",
            attempt: 1,
            metadata: boardMetadata(commit)
          }
        ],
        dependencies: [],
        events: [],
        outbox: [
          {
            id: PUBLICATION_MESSAGE_ID,
            taskId: PUBLICATION_TASK_ID,
            topic: "run-context-publication",
            status: "leased",
            payload: { attempt: 1 },
            leaseId: commit.lease.leaseId,
            writeFenceToken: commit.lease.writeFenceToken,
            leaseExpiresAt: commit.lease.leaseExpiresAt
          }
        ]
      }
    }
  };
}

function pageIndexBoardState(commit: BoardContextPublicationCommit, includeNewerBuild = false): unknown {
  return {
    intakeState: {
      board: {
        tasks: [
          boardBuildTask(),
          {
            id: PUBLICATION_TASK_ID,
            type: "publish-context-release",
            kind: "dispatchable",
            status: "done",
            attempt: 1,
            metadata: boardMetadata(commit)
          },
          {
            id: PAGEINDEX_TASK_ID,
            type: "index-context-release",
            kind: "dispatchable",
            status: "in_progress",
            attempt: 1,
            metadata: boardMetadata(commit)
          },
          ...(includeNewerBuild
            ? [
                {
                  id: "task_context_build_newer",
                  type: "build-context",
                  kind: "aggregate",
                  status: "in_progress",
                  attempt: 1,
                  metadata: {
                    tenantId: TENANT,
                    repository: REPOSITORY,
                    ref: REF,
                    refSequence: 2,
                    commitSha: "b".repeat(40)
                  }
                }
              ]
            : [])
        ],
        dependencies: [
          {
            taskId: PAGEINDEX_TASK_ID,
            dependsOnTaskId: PUBLICATION_TASK_ID,
            required: true
          }
        ],
        events: [
          {
            taskId: PUBLICATION_TASK_ID,
            type: "task.completed",
            payload: {
              version: 1,
              releaseId: commit.releaseId,
              outputArtifact: commit.releaseArtifact
            }
          }
        ],
        outbox: [
          {
            id: PAGEINDEX_MESSAGE_ID,
            taskId: PAGEINDEX_TASK_ID,
            topic: "run-context-pageindex",
            status: "leased",
            payload: { attempt: 1 },
            leaseId: "lease-pageindex",
            writeFenceToken: "fence-pageindex",
            leaseExpiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]
      }
    }
  };
}

function boardBuildTask(): unknown {
  return {
    id: BUILD_ID,
    type: "build-context",
    kind: "aggregate",
    status: "in_progress",
    attempt: 1,
    metadata: {
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: REF,
      refSequence: 1,
      commitSha: COMMIT
    }
  };
}

function boardMetadata(commit: BoardContextPublicationCommit): unknown {
  return {
    tenantId: commit.scope.tenantId,
    repository: commit.scope.repository,
    ref: commit.scope.ref,
    refSequence: commit.scope.refSequence,
    commitSha: commit.scope.commitSha,
    contextBuildId: commit.scope.buildId
  };
}

function pageIndexFixture(publication: Awaited<ReturnType<typeof publicationFixture>>): {
  readonly commit: Parameters<PostgresBoardPageIndexAttachmentRepository["attachPageIndexAtomically"]>[0];
} {
  const node = {
    externalId: "architecture:root",
    documentId: publication.revisionId,
    title: "Architecture",
    summary: publication.claim,
    depth: 1,
    preorderStart: 1,
    preorderEnd: 1,
    anchors: [publication.anchor]
  };
  const inputDigest = fingerprint({
    releaseId: publication.commit.releaseId,
    documentId: publication.revisionId
  });
  const treeDigest = fingerprint([node]);
  const buildDigest = fingerprint({
    version: 1,
    releaseId: publication.commit.releaseId,
    publicSnapshotDigest: publication.commit.publicSnapshotDigest,
    inputDigest,
    treeDigest,
    adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
  });
  const tree: BoardPageIndexTreeArtifactV1 = {
    version: 1,
    release: {
      releaseId: publication.commit.releaseId,
      tenantId: TENANT,
      repository: REPOSITORY,
      ref: REF,
      refSequence: 1,
      commitSha: COMMIT,
      checkpointId: publication.commit.snapshot.checkpoint.id,
      buildId: BUILD_ID,
      publishedAt: CREATED_AT,
      publicSnapshotDigest: publication.commit.publicSnapshotDigest,
      publicationInputDigest: publication.commit.publicationInputDigest
    },
    source: {
      adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
      adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
      sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
      sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
    },
    representedDocuments: [
      {
        documentId: publication.revisionId,
        documentPath: "architecture.md",
        title: "Architecture",
        rootCount: 1,
        nodeCount: 1,
        maxDepth: 1
      }
    ],
    metrics: {
      documentCount: 1,
      representedDocumentCount: 1,
      rootCount: 1,
      nodeCount: 1,
      maxDepth: 1,
      documentCharacters: publication.claim.length,
      inputDigest,
      treeDigest,
      buildDigest
    },
    nodes: [node],
    diagnostics: []
  };
  const serialized = serializeBoardPageIndexTreeArtifact(tree);
  const treeArtifactRef = artifactRef(BUILD_ID, "pageindex-tree", "tree.json", serialized);
  const scope = publication.commit.scope;
  return {
    commit: {
      scope,
      lease: {
        taskId: PAGEINDEX_TASK_ID,
        messageId: PAGEINDEX_MESSAGE_ID,
        attempt: 1,
        leaseId: "lease-pageindex",
        writeFenceToken: "fence-pageindex",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z"
      },
      releaseId: publication.commit.releaseId,
      idempotencyKey: "pageindex:board-persistence:1",
      attachmentInputDigest: boardPageIndexAttachmentInputDigest({
        scope,
        releaseId: publication.commit.releaseId,
        treeArtifactRef,
        treeDigest,
        buildDigest
      }),
      treeArtifactRef,
      treeArtifact: tree,
      attachedAt: CREATED_AT
    }
  };
}

function artifactRef(buildId: string, kind: string, name: string, content: string): ContextArtifactRef {
  const key = [
    "context-v2",
    "tenants",
    encodeURIComponent(TENANT),
    "repositories",
    ...REPOSITORY.split("/").map(encodeURIComponent),
    "builds",
    encodeURIComponent(buildId),
    kind,
    name
  ].join("/");
  return {
    uri: `gs://context-test/${key}`,
    key,
    contentType: "application/json",
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    objectGeneration: "1"
  };
}

async function saveBoardState(database: ContextDatabase, state: unknown): Promise<void> {
  await database.pool.query(
    `insert into jina_runtime.api_state(id,snapshot)
     values (1,$1::jsonb)
     on conflict (id) do update
       set snapshot=excluded.snapshot,version=jina_runtime.api_state.version+1,updated_at=now()`,
    [JSON.stringify(state)]
  );
}

async function incrementQuota(store: PostgresContextQuotaStore, tenantId: string): Promise<number> {
  return store.transact(tenantId, (current) => {
    const prior = current ?? emptyQuotaLedger(tenantId);
    const used = prior.queryRate.used + 1;
    return {
      state: {
        ...prior,
        queryRate: {
          ...prior.queryRate,
          used,
          operationIds: {
            ...prior.queryRate.operationIds,
            [`op-${used}`]: true
          }
        },
        updatedAt: CREATED_AT
      },
      result: used
    };
  });
}

async function readQuota(store: PostgresContextQuotaStore, tenantId: string): Promise<ContextTenantQuotaLedger> {
  return store.transact(tenantId, (current) => {
    assert.ok(current);
    return { state: current, result: current };
  });
}

function emptyQuotaLedger(tenantId: string): ContextTenantQuotaLedger {
  return {
    version: 1,
    tenantId,
    queryRate: { windowStartedAtMs: 0, used: 0, operationIds: {} },
    buildRate: { windowStartedAtMs: 0, used: 0, operationIds: {} },
    activeBuilds: {},
    completedBuilds: {},
    activeModelTasks: {},
    artifactReservations: {},
    artifacts: {},
    artifactBytes: 0,
    artifactDeletionOperations: {},
    modelMonth: {
      month: "2026-07",
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reservedTokens: 0,
      completedTasks: {}
    },
    denials: {},
    updatedAt: CREATED_AT
  };
}
