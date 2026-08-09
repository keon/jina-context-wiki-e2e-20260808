import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { FileMetadata, Storage } from "@google-cloud/storage";
import {
  ContextCatalogService,
  contextPublicSnapshotDigest,
  createEvidenceRecord,
  fingerprint,
  parseWikiContentBundle,
  repositoryAclFingerprint,
  WikiTriggerPublicationError,
  wikiAuditArtifactKey,
  wikiContentArtifactKey,
  wikiContentBundleSha256,
  wikiPublicationInputDigestV2,
  wikiReleaseIdV2,
  wikiSearchableMarkdown,
  type ContextArtifactRef,
  type WikiFinalizationAttestationV1,
  type WikiReleaseArtifactV2
} from "@jina/context-engine";
import { Pool } from "pg";
import { ContextDatabase } from "./context/database.js";
import { PostgresEvidenceStore } from "./context/evidence-store.js";
import { PostgresContextEngineStore } from "./context/store.js";
import { PostgresWikiAuditRepository } from "./context/wiki-audit-repository.js";
import { PostgresWikiTriggerPublicationRepository } from "./context/wiki-publication-repository.js";
import { parseStoredContextCatalog } from "./context/release-catalog.js";
import { CONTEXT_ROLES_SQL } from "./context/roles.js";
import { CONTEXT_SCHEMA_SQL } from "./context/schema.js";
import { GcsWikiArtifactStore } from "./context/gcs-wiki-artifact-store.js";

interface FakeObject {
  content: Buffer;
  metadata: FileMetadata;
}

class FakeStorage {
  readonly objects = new Map<string, FakeObject>();
  #generation = 0;
  bucket(_name: string) {
    return {
      file: (key: string, options?: { readonly generation?: string }) => ({
        save: async (
          content: Buffer,
          saveOptions: {
            readonly metadata: { readonly contentType: string; readonly metadata: Record<string, string> };
          }
        ) => {
          if (this.objects.has(key)) throw Object.assign(new Error("precondition"), { code: 412 });
          this.objects.set(key, {
            content: Buffer.from(content),
            metadata: {
              generation: String(++this.#generation),
              size: String(content.byteLength),
              contentType: saveOptions.metadata.contentType,
              metadata: { ...saveOptions.metadata.metadata }
            }
          });
        },
        getMetadata: async () => {
          const object = this.object(key, options?.generation);
          return [{ ...object.metadata, metadata: { ...object.metadata.metadata } }];
        },
        download: async () => [Buffer.from(this.object(key, options?.generation).content)]
      })
    };
  }
  object(key: string, generation?: string): FakeObject {
    const object = this.objects.get(key);
    if (!object || (generation && object.metadata.generation !== generation)) {
      throw Object.assign(new Error("not found"), { code: 404 });
    }
    return object;
  }
}

test("wiki search projection omits Mermaid programs while preserving surrounding prose", () => {
  const source = [
    "# Architecture",
    "",
    "Requests enter through the API and are processed asynchronously.",
    "",
    "```mermaid",
    "flowchart LR",
    '  PRIVATE_NODE["Internal node"] --> WORKER',
    "```",
    "",
    "*Diagram: API to worker request flow*",
    "",
    "The worker publishes the completed release."
  ].join("\n");

  const projected = wikiSearchableMarkdown(source);

  assert.match(projected, /Requests enter through the API/);
  assert.match(projected, /Mermaid diagram \(source omitted from the search index\)/);
  assert.match(projected, /Diagram: API to worker request flow/);
  assert.match(projected, /worker publishes the completed release/);
  assert.doesNotMatch(projected, /flowchart|PRIVATE_NODE|-->/);
  assert.match(source, /flowchart LR/);
  assert.doesNotMatch(
    wikiSearchableMarkdown("# Broken diagram\n\n```mermaid\nflowchart LR\n  UNTERMINATED --> PRIVATE"),
    /flowchart|UNTERMINATED|PRIVATE/
  );
  assert.doesNotMatch(
    wikiSearchableMarkdown("# Fallback\n\n~~~mermaid-source\nflowchart LR\n  DEGRADED --> PRIVATE\n~~~"),
    /flowchart|DEGRADED|PRIVATE/
  );
});

test("repository-scoped wiki content is durable, create-only, and byte verified", async () => {
  const fake = new FakeStorage();
  const store = new GcsWikiArtifactStore("wiki-artifacts", { storage: fake as unknown as Storage });
  const bodyMarkdown = "# Quickstart\n\nReady.\n";
  const bundle = parseWikiContentBundle({
    version: 1,
    publicSnapshotDigest: contextPublicSnapshotDigest([
      { documentPath: "quickstart.md", title: "quickstart.md", bodyMarkdown }
    ]),
    pages: [
      {
        documentPath: "quickstart.md",
        bodyMarkdown,
        bodySha256: createHash("sha256").update(bodyMarkdown).digest("hex")
      }
    ]
  });
  const first = await store.putIfAbsent({ tenantId: "tenant-a", repository: "Acme/Widgets", bundle });
  assert.deepEqual(await store.putIfAbsent({ tenantId: "tenant-a", repository: "acme/widgets", bundle }), first);
  assert.deepEqual(await store.get(first), bundle);
  assert.equal(fake.object(first.key).metadata.customTime, undefined);
  assert.deepEqual(
    await store.find({
      tenantId: "tenant-a",
      repository: "acme/widgets",
      bundleSha256: first.bundleSha256,
      publicSnapshotDigest: first.publicSnapshotDigest
    }),
    first
  );
  fake.object(first.key).content = Buffer.from("x".repeat(first.bytes));
  await assert.rejects(store.get(first), /bytes do not match/);
});

test("audit reports bind report identity to durable audit-scoped keys", async () => {
  const fake = new FakeStorage();
  const store = new GcsWikiArtifactStore("wiki-artifacts", { storage: fake as unknown as Storage });
  const identity = {
    tenantId: "tenant-a",
    repository: "acme/widgets",
    auditId: "audit-1",
    releaseId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    auditInputDigest: "b".repeat(64)
  };
  const content = `${JSON.stringify({ version: 1, ...identity, findings: [] })}\n`;
  const ref = await store.putIfAbsent({ ...identity, content });
  assert.match(ref.key, /\/audits\/audit-1\/wiki-audit-report\/report\.json$/);
  assert.deepEqual(await store.find(identity), ref);
  assert.equal(await store.find({ ...identity, auditId: "audit-missing" }), undefined);
  assert.equal(Buffer.from(await store.get(ref)).toString("utf8"), content);
  await assert.rejects(
    store.putIfAbsent({ ...identity, releaseId: "cr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", content }),
    /identity does not match/
  );
});

test("V2 schema preserves the compact V1 catalog while adding locale, audit, and scope contracts", () => {
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.context_releases/);
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.context_evidence_snapshots/);
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.context_wiki_projections/);
  assert.doesNotMatch(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.context_documents/);
  assert.match(CONTEXT_SCHEMA_SQL, /artifact_version smallint not null default 2 check \(artifact_version=2\)/);
  assert.match(CONTEXT_SCHEMA_SQL, /scope_kind='commit' and ref_sequence is null/);
  assert.match(CONTEXT_SCHEMA_SQL, /primary key \(tenant_id,repository,ref_name,locale\)/);
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.context_release_audits/);
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.context_release_audit_runs/);
  assert.match(CONTEXT_SCHEMA_SQL, /context_release_audit_runs_immutable/);
  assert.match(CONTEXT_SCHEMA_SQL, /context_release_audit_followups_immutable/);
  assert.match(CONTEXT_ROLES_SQL, /context_release_audits/);
  assert.match(
    CONTEXT_ROLES_SQL,
    /alter table jina_context\.context_release_audit_followups enable row level security/
  );
});

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "V2 prepare, locale activation, immutable audit, due selection, and follow-up round-trip in Postgres",
  { skip: !databaseUrl },
  async () => {
    const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query("drop schema if exists jina_context cascade");
    await bootstrap.query(`
      do $roles$
      declare role_name text;
      begin
        foreach role_name in array array[
          'jina_context_query','jina_context_quota','jina_context_tokens',
          'jina_context_issue_publish','jina_context_tenant_admin','jina_context_admin'
        ] loop
          if not exists (select 1 from pg_roles where rolname=role_name) then
            execute format('create role %I nologin',role_name);
          end if;
        end loop;
      end
      $roles$;
      create schema if not exists jina_runtime;
      create table if not exists jina_runtime.api_state (
        id smallint primary key check (id=1),
        snapshot jsonb not null,
        version bigint not null default 1,
        updated_at timestamptz not null default now()
      );
      truncate table jina_runtime.api_state;
      grant all privileges on schema jina_runtime to
        jina_context_query,jina_context_quota,jina_context_tokens,
        jina_context_issue_publish,jina_context_tenant_admin,jina_context_admin;
      grant all privileges on jina_runtime.api_state to
        jina_context_query,jina_context_quota,jina_context_tokens,
        jina_context_issue_publish,jina_context_tenant_admin,jina_context_admin
    `);
    await bootstrap.end();
    const database = new ContextDatabase({ connectionString: databaseUrl, manageRoles: true, max: 2 });
    try {
      await database.initialize();
      const tenantId = "tenant-wiki-v2";
      const repository = "acme/widgets";
      const ref = "refs/heads/main";
      const commitSha = "a".repeat(40);
      const checkpointId = "checkpoint-wiki-v2";
      const preparedAt = "2026-08-08T12:00:00.000Z";
      const evidenceId = "evidence-wiki-v2";
      const runtimePrivileges = await database.pool.query<{
        role_name: string;
        schema_usage: boolean;
        schema_create: boolean;
        table_select: boolean;
        table_insert: boolean;
        table_update: boolean;
        table_delete: boolean;
        table_truncate: boolean;
        table_references: boolean;
        table_trigger: boolean;
      }>(
        `select role_name,
                has_schema_privilege(role_name,'jina_runtime','usage') as schema_usage,
                has_schema_privilege(role_name,'jina_runtime','create') as schema_create,
                has_table_privilege(role_name,'jina_runtime.api_state','select') as table_select,
                has_table_privilege(role_name,'jina_runtime.api_state','insert') as table_insert,
                has_table_privilege(role_name,'jina_runtime.api_state','update') as table_update,
                has_table_privilege(role_name,'jina_runtime.api_state','delete') as table_delete,
                has_table_privilege(role_name,'jina_runtime.api_state','truncate') as table_truncate,
                has_table_privilege(role_name,'jina_runtime.api_state','references') as table_references,
                has_table_privilege(role_name,'jina_runtime.api_state','trigger') as table_trigger
         from unnest($1::text[]) role_name
         order by role_name`,
        [
          [
            "jina_context_query",
            "jina_context_quota",
            "jina_context_tokens",
            "jina_context_issue_publish",
            "jina_context_tenant_admin",
            "jina_context_admin"
          ]
        ]
      );
      for (const privileges of runtimePrivileges.rows) {
        const publicationAdmin =
          privileges.role_name === "jina_context_tenant_admin" || privileges.role_name === "jina_context_admin";
        assert.equal(privileges.schema_usage, publicationAdmin);
        assert.equal(privileges.table_select, publicationAdmin);
        assert.equal(privileges.schema_create, false);
        assert.equal(privileges.table_insert, false);
        assert.equal(privileges.table_update, false);
        assert.equal(privileges.table_delete, false);
        assert.equal(privileges.table_truncate, false);
        assert.equal(privileges.table_references, false);
        assert.equal(privileges.table_trigger, false);
      }
      const evidenceBody = "Ready now.";
      const evidenceDigest = fingerprint(evidenceBody);
      const evidence = createEvidenceRecord({
        id: evidenceId,
        anchor: {
          tenantId,
          repository,
          sourceType: "blob",
          sourceId: "source-index",
          contentDigest: evidenceDigest,
          commitSha,
          pathOrUrl: "src/index.ts",
          startLine: 1,
          endLine: 1
        },
        ref,
        title: "Source index",
        body: evidenceBody,
        metadata: {},
        authorityClass: "source_code",
        aclFingerprint: repositoryAclFingerprint(tenantId, repository),
        createdAt: preparedAt
      });
      const evidenceStore = new PostgresEvidenceStore(database);
      const evidenceSnapshot = {
        checkpoint: {
          id: checkpointId,
          tenantId,
          repository,
          ref,
          refSequence: 1,
          commitSha,
          parserVersion: "parser-v2",
          sourceCompleteness: "complete" as const,
          observationFrontier: "frontier",
          evidenceFingerprint: fingerprint([evidence.id]),
          manifestFingerprint: fingerprint(["src/index.ts"]),
          aclFingerprint: repositoryAclFingerprint(tenantId, repository),
          createdAt: preparedAt
        },
        records: [evidence],
        manifest: [
          {
            tenantId,
            repository,
            ref,
            commitSha,
            path: "src/index.ts",
            blobSha: "b".repeat(40),
            contentDigest: evidenceDigest,
            contentAvailable: true,
            language: "typescript",
            executable: false
          }
        ],
        structuralFacts: []
      };
      assert.deepEqual(await evidenceStore.commitSnapshot(evidenceSnapshot), evidenceSnapshot.checkpoint);
      assert.deepEqual(await evidenceStore.commitSnapshot(evidenceSnapshot), evidenceSnapshot.checkpoint);
      assert.equal((await evidenceStore.getCheckpoint(checkpointId))?.id, checkpointId);
      assert.equal((await evidenceStore.latestCheckpoint(tenantId, repository, ref))?.id, checkpointId);
      assert.equal((await evidenceStore.listEvidence(checkpointId))[0]?.id, evidenceId);
      assert.equal(
        (
          await evidenceStore.resolveAnchor(checkpointId, {
            tenantId,
            repository,
            sourceType: "blob",
            sourceId: "source-index",
            commitSha,
            pathOrUrl: "src/index.ts",
            startLine: 1,
            endLine: 1
          })
        )?.id,
        evidenceId
      );

      const buildId = "build-wiki-v2";
      const bodyMarkdown = [
        "# Wiki",
        "",
        "Ready now.",
        "",
        "```mermaid",
        "flowchart LR",
        "  RAW_MERMAID_SENTINEL --> Worker",
        "```",
        "",
        "*Diagram: release projection flow*",
        ""
      ].join("\n");
      const bundle = parseWikiContentBundle({
        version: 1,
        publicSnapshotDigest: contextPublicSnapshotDigest([
          { documentPath: "index.md", title: "index.md", bodyMarkdown }
        ]),
        pages: [
          {
            documentPath: "index.md",
            bodyMarkdown,
            bodySha256: createHash("sha256").update(bodyMarkdown).digest("hex")
          }
        ]
      });
      const bundleSha256 = wikiContentBundleSha256(bundle);
      const contentBundleArtifact = {
        version: 1 as const,
        tenantId,
        repository,
        publicSnapshotDigest: bundle.publicSnapshotDigest,
        bundleSha256,
        uri: `gs://wiki/${wikiContentArtifactKey({ tenantId, repository, bundleSha256 })}`,
        key: wikiContentArtifactKey({ tenantId, repository, bundleSha256 }),
        contentType: "application/json" as const,
        bytes: 256,
        sha256: bundleSha256,
        objectGeneration: "1"
      };
      const artifact = (name: string, sha256: string): ContextArtifactRef => {
        const key = `context/tenants/${tenantId}/repositories/acme/widgets/builds/${buildId}/context-release/${name}`;
        return {
          uri: `gs://wiki/${key}`,
          key,
          contentType: "application/json",
          bytes: 128,
          sha256,
          objectGeneration: "2"
        };
      };
      const generationPlanArtifact = artifact("generation-plan.json", "4".repeat(64));
      const finalizationArtifact = artifact("finalization.json", "5".repeat(64));
      const releaseManifestArtifact = artifact("manifest.json", "6".repeat(64));
      const projectionInputDigest = "7".repeat(64);
      const revisionId = "revision-v2";
      const citation = {
        id: "citation-v2",
        revisionId,
        ordinal: 0,
        claim: "Ready now.",
        anchor: {
          tenantId,
          repository,
          sourceType: "blob" as const,
          sourceId: "source-index",
          contentDigest: evidenceDigest,
          commitSha,
          pathOrUrl: "src/index.ts",
          startLine: 1,
          endLine: 1
        }
      };
      const finalization: WikiFinalizationAttestationV1 = {
        version: 1,
        sourceSnapshotDigest: "8".repeat(64),
        publicSnapshotDigest: bundle.publicSnapshotDigest,
        contentBundleArtifactSha256: bundleSha256,
        manifestDigest: releaseManifestArtifact.sha256,
        projectionInputDigest,
        checks: {
          minimumUsableBundle: "passed",
          pathSafety: "passed",
          logicalIdentity: "passed",
          incrementalAccounting: "passed",
          linkDiagnostics: 0,
          validDiagramCount: 0,
          degradedDiagramCount: 0
        },
        generatorPolicyVersion: "generator-v2",
        finalizerVersion: "finalizer-v2",
        okfPolicyVersion: "okf-v1",
        mermaidVersion: "11.12.0",
        mermaidConfigDigest: "9".repeat(64),
        diagramPolicyVersion: "diagram-v2"
      };
      const releaseIdentity = {
        releaseId: "cr_placeholder",
        tenantId,
        repository,
        ref,
        refSequence: 1,
        scopeKind: "branch" as const,
        scopeKey: "main",
        commitSha,
        checkpointId,
        generationId: "cr_placeholder",
        buildId,
        triggerParentRunId: "trigger-run-v2",
        requestDigest: "b".repeat(64),
        releaseFamilyId: "family-v2",
        generationReason: "initial" as const,
        locale: "fr",
        preparedAt
      };
      const withoutDigest = {
        version: 2 as const,
        kind: "generated-wiki" as const,
        release: releaseIdentity,
        generationPlanArtifact,
        finalizationArtifact,
        releaseManifestArtifact,
        contentBundleArtifact,
        publicSnapshotDigest: bundle.publicSnapshotDigest,
        pages: [
          {
            documentPath: "index.md",
            title: "Wiki",
            bodySha256: bundle.pages[0]!.bodySha256,
            revisionId,
            citations: [citation],
            metadataDigest: "c".repeat(64)
          }
        ]
      };
      const publicationInputDigest = wikiPublicationInputDigestV2(withoutDigest);
      const releaseId = wikiReleaseIdV2(publicationInputDigest);
      const release: WikiReleaseArtifactV2 = {
        ...withoutDigest,
        release: { ...releaseIdentity, releaseId, generationId: releaseId },
        publicationInputDigest
      };
      const releaseArtifact = artifact("release-v2.json", "e".repeat(64));
      const fence = {
        boardBuildId: buildId,
        triggerParentRunId: releaseIdentity.triggerParentRunId,
        requestDigest: releaseIdentity.requestDigest,
        tenantId,
        repository,
        commitSha,
        scopeKind: "branch" as const,
        ref,
        refSequence: 1,
        locale: "fr",
        operationId: "prepare-op"
      };
      const publications = new PostgresWikiTriggerPublicationRepository(database);
      const citationEscape: WikiReleaseArtifactV2 = {
        ...release,
        pages: release.pages.map((page, pageIndex) => ({
          ...page,
          citations: page.citations.map((candidate, citationIndex) => ({
            ...candidate,
            anchor:
              pageIndex === 0 && citationIndex === 0
                ? { ...candidate.anchor, contentDigest: "d".repeat(64) }
                : candidate.anchor
          }))
        }))
      };
      await assert.rejects(
        publications.prepareProjection({
          release: citationEscape,
          contentBundle: bundle,
          finalization,
          projectorVersion: "wiki-projector-v2"
        }),
        /absent from its exact checkpoint/
      );
      const projection = await publications.prepareProjection({
        release,
        contentBundle: bundle,
        finalization,
        projectorVersion: "wiki-projector-v2"
      });
      assert.deepEqual(
        {
          created: projection.created,
          status: projection.status,
          documents: projection.documentCount,
          hierarchy: projection.hierarchyNodeCount
        },
        { created: true, status: "building", documents: 1, hierarchy: 1 }
      );
      const compactProjection = await database.pool.query<{ catalog: unknown }>(
        "select catalog from jina_context.context_wiki_projections where release_id=$1",
        [releaseId]
      );
      const storedProjection = parseStoredContextCatalog(compactProjection.rows[0]!.catalog);
      assert.match(storedProjection.projection.documents[0]?.body ?? "", /release projection flow/);
      assert.doesNotMatch(storedProjection.projection.documents[0]?.body ?? "", /flowchart|RAW_MERMAID_SENTINEL|-->/);
      assert.doesNotMatch(
        storedProjection.projection.fragments.map((fragment) => fragment.sourceText).join("\n"),
        /RAW_MERMAID_SENTINEL/
      );
      assert.equal(
        storedProjection.projection.exactIndex.some((entry) =>
          ["raw_mermaid_sentinel", "flowchart", "-->"].includes(entry.term)
        ),
        false
      );
      assert.match(storedProjection.revisions[0]?.bodyMarkdown ?? "", /RAW_MERMAID_SENTINEL/);
      assert.equal(
        (
          await publications.prepareProjection({
            release,
            contentBundle: bundle,
            finalization,
            projectorVersion: "wiki-projector-v2"
          })
        ).created,
        false
      );
      const prepared = await publications.prepare({
        release,
        releaseArtifact,
        finalization,
        fence,
        idempotencyKey: "wiki-publication-v2",
        pipelineVersion: "pipeline-v2",
        instructionDigest: "f".repeat(64),
        exclusionPolicyDigest: "0".repeat(64),
        modelProviderFamily: "openai",
        modelId: "model-v2",
        promptDigest: "1".repeat(64),
        inferenceConfigDigest: "2".repeat(64)
      });
      assert.equal(prepared.publishedAt, undefined);
      assert.deepEqual(
        await publications.prepare({
          release,
          releaseArtifact,
          finalization,
          fence,
          idempotencyKey: "wiki-publication-v2",
          pipelineVersion: "pipeline-v2",
          instructionDigest: "f".repeat(64),
          exclusionPolicyDigest: "0".repeat(64),
          modelProviderFamily: "openai",
          modelId: "model-v2",
          promptDigest: "1".repeat(64),
          inferenceConfigDigest: "2".repeat(64)
        }),
        prepared
      );

      const pageIndexArtifact = {
        ...artifact("../pageindex-tree/tree.json", "3".repeat(64)),
        key: `context/tenants/${tenantId}/repositories/acme/widgets/builds/${buildId}/pageindex-tree/tree.json`
      };
      pageIndexArtifact.uri = `gs://wiki/${pageIndexArtifact.key}`;
      const saveAuthority = async (status: "in_progress" | "canceled", includeNewerIntent = false) => {
        const task = {
          id: buildId,
          type: "build-wiki",
          kind: "dispatchable",
          status,
          metadata: {
            tenantId,
            repository,
            ref,
            refSequence: 1,
            commitSha,
            locale: "fr",
            requestDigest: releaseIdentity.requestDigest
          }
        };
        const newerTask = {
          ...task,
          id: `${buildId}-newer`,
          status: "pending",
          metadata: { ...task.metadata, refSequence: 2, commitSha: "b".repeat(40) }
        };
        const snapshot = {
          intakeState: {
            board: {
              tasks: includeNewerIntent ? [task, newerTask] : [task],
              dependencies: [],
              outbox: [],
              events: [
                {
                  type: "context.wiki_trigger_parent_claimed",
                  taskId: buildId,
                  payload: {
                    requestDigest: releaseIdentity.requestDigest,
                    triggerParentRunId: releaseIdentity.triggerParentRunId
                  }
                }
              ]
            }
          }
        };
        await database.pool.query(
          `insert into jina_runtime.api_state(id,snapshot)
           values (1,$1::jsonb)
           on conflict (id) do update
             set snapshot=excluded.snapshot,version=jina_runtime.api_state.version+1,updated_at=now()`,
          [JSON.stringify(snapshot)]
        );
      };
      const activation = {
        releaseId,
        fence: { ...fence, operationId: "activate-op" },
        idempotencyKey: "wiki-pageindex-v2",
        attachmentInputDigest: "4".repeat(64),
        pageIndexArtifact,
        pageIndexMetadata: {
          version: 1,
          nodes: 1,
          usage: { inputTokens: 10, outputTokens: 20, costMicros: 30 }
        }
      };
      const staleAuthority = (error: unknown): boolean =>
        error instanceof WikiTriggerPublicationError && error.code === "stale_ref_sequence";
      await assert.rejects(
        database.transactionAs(
          "jina_context_query",
          { tenantIds: [tenantId] },
          async (client) => client.query("select snapshot from jina_runtime.api_state where id=1"),
          "wiki_trigger_authority_query_role_denied"
        ),
        /permission denied/
      );
      await saveAuthority("canceled");
      await database.transactionAs(
        "jina_context_admin",
        { tenantIds: [tenantId] },
        async (client) => {
          const identity = await client.query<{
            current_user: string;
            runtime_usage: boolean;
            runtime_select: boolean;
          }>(
            `select current_user,
                    has_schema_privilege(current_user,'jina_runtime','usage') as runtime_usage,
                    has_table_privilege(current_user,'jina_runtime.api_state','select') as runtime_select`
          );
          assert.deepEqual(identity.rows[0], {
            current_user: "jina_context_tenant_admin",
            runtime_usage: true,
            runtime_select: true
          });
          await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
          const authority = await client.query<{ snapshot: unknown }>(
            "select snapshot from jina_runtime.api_state where id=1"
          );
          assert.equal(authority.rowCount, 1);
        },
        "wiki_trigger_authority_exact_access"
      );
      await assert.rejects(publications.activate(activation), staleAuthority);
      await saveAuthority("in_progress", true);
      await assert.rejects(publications.activate(activation), staleAuthority);
      await saveAuthority("in_progress");
      const activationStartedAt = Date.now();
      const published = await publications.activate(activation);
      assert.ok(Date.parse(published.publishedAt!) >= activationStartedAt - 1_000);
      assert.notEqual(published.publishedAt, "2026-08-08T12:05:00.000Z");
      assert.deepEqual(await publications.activate(activation), published);
      const pointer = await database.pool.query(
        `select release_id,locale from jina_context.current_context_board_releases
       where tenant_id=$1 and repository=$2 and ref_name=$3`,
        [tenantId, repository, ref]
      );
      assert.deepEqual(pointer.rows, [{ release_id: releaseId, locale: "fr" }]);
      const activatedReceipt = await publications.findActivatedWikiBuildReceipt({
        tenantId,
        repository,
        boardBuildId: buildId,
        requestDigest: releaseIdentity.requestDigest
      });
      assert.equal(activatedReceipt?.completedAt, published.publishedAt);
      assert.deepEqual(activatedReceipt?.usage, { inputTokens: 10, outputTokens: 20, costMicros: 30 });
      const auditInputs = await publications.getPublishedReleaseInputs({ tenantId, repository, releaseId });
      assert.equal(auditInputs?.tenantId, tenantId);
      assert.equal(auditInputs?.repository, repository);
      assert.equal(auditInputs?.releaseId, releaseId);
      assert.equal(auditInputs?.releaseArtifact.sha256, releaseArtifact.sha256);
      assert.equal(auditInputs?.contentBundleArtifact.sha256, contentBundleArtifact.sha256);
      assert.deepEqual(auditInputs?.evidenceSnapshot, evidenceSnapshot);

      const contextStore = new PostgresContextEngineStore(database);
      const contextCatalog = new ContextCatalogService(contextStore);
      const access = {
        tenantId,
        repository,
        principalId: "tenant-admin",
        tenantAdmin: true,
        releaseId
      };
      assert.deepEqual(
        (
          await contextCatalog.listReleases({ tenantId, repository, principalId: "tenant-admin", tenantAdmin: true })
        ).map((candidate) => candidate.id),
        [releaseId]
      );
      const listed = await contextCatalog.listContext(access);
      assert.equal(listed.documents[0]?.logicalId, "index.md");
      assert.equal(listed.tree[0]?.documentId, listed.documents[0]?.id);
      const read = await contextCatalog.readContext({ ...access, document: "index.md" });
      assert.match(read.document.bodyMarkdown, /release projection flow/);
      assert.doesNotMatch(read.document.bodyMarkdown, /RAW_MERMAID_SENTINEL|flowchart|-->/);
      const searched = await contextCatalog.searchContext({ ...access, query: "wiki" });
      assert.equal(searched.results[0]?.logicalId, "index.md");
      const diff = await contextCatalog.diffContext({
        tenantId,
        repository,
        principalId: "tenant-admin",
        tenantAdmin: true,
        fromReleaseId: releaseId,
        toReleaseId: releaseId
      });
      assert.deepEqual(diff.unchanged, ["index.md"]);
      assert.match(
        (await contextStore.listRevisions(tenantId, repository))[0]?.bodyMarkdown ?? "",
        /RAW_MERMAID_SENTINEL/
      );
      assert.equal((await contextStore.listCitations(revisionId))[0]?.id, citation.id);

      const audits = new PostgresWikiAuditRepository(database);
      assert.equal(
        (
          await audits.listDue({
            tenantId,
            auditPolicyVersion: "audit-v1",
            auditorConfigDigest: "5".repeat(64),
            auditWindow: "2026-08-08",
            limit: 100
          })
        ).length,
        1
      );
      const auditId = "audit-v2";
      const auditInputDigest = "6".repeat(64);
      const auditRun = {
        auditId,
        tenantId,
        repository,
        releaseId,
        locale: "fr",
        publicSnapshotDigest: bundle.publicSnapshotDigest,
        auditPolicyVersion: "audit-v1",
        auditorConfigDigest: "5".repeat(64),
        auditWindow: "2026-08-08",
        auditInputDigest,
        triggerRunId: "audit-run-v2",
        claimedAt: "2026-08-08T12:09:00.000Z"
      };
      assert.equal((await audits.claimRun(auditRun)).created, true);
      assert.equal((await audits.claimRun({ ...auditRun, claimedAt: "2026-08-08T12:09:30.000Z" })).created, false);
      assert.deepEqual(await audits.getRunClaim({ tenantId, repository, auditId }), auditRun);
      assert.equal((await audits.listUnsettledRuns({ tenantId })).length, 1);
      const reportKey = wikiAuditArtifactKey({ tenantId, repository, auditId });
      const auditRecord = {
        auditId,
        tenantId,
        repository,
        releaseId,
        locale: "fr",
        publicSnapshotDigest: bundle.publicSnapshotDigest,
        auditPolicyVersion: "audit-v1",
        auditorConfigDigest: "5".repeat(64),
        auditWindow: "2026-08-08",
        auditInputDigest,
        triggerRunId: "audit-run-v2",
        outcome: "needs_improvement" as const,
        summary: { findings: 1 },
        reportArtifact: {
          version: 1 as const,
          tenantId,
          repository,
          auditId,
          releaseId,
          auditInputDigest,
          uri: `gs://wiki/${reportKey}`,
          key: reportKey,
          contentType: "application/json" as const,
          bytes: 128,
          sha256: "7".repeat(64),
          objectGeneration: "9"
        },
        completedAt: "2026-08-08T12:10:00.000Z"
      };
      assert.equal((await audits.insertTerminal(auditRecord)).created, true);
      assert.equal((await audits.insertTerminal(auditRecord)).created, false);
      assert.equal((await audits.listUnsettledRuns({ tenantId })).length, 0);
      assert.deepEqual(await audits.listPendingImprovementRuns({ tenantId }), [auditRun]);
      assert.equal(
        (
          await audits.listDue({
            tenantId,
            auditPolicyVersion: "audit-v1",
            auditorConfigDigest: "5".repeat(64),
            auditWindow: "2026-08-08"
          })
        ).length,
        0
      );
      const followup = {
        auditId,
        tenantId,
        repository,
        requestKey: `wiki-audit-fix:${auditId}`,
        currentReleaseIdAtDecision: releaseId,
        admissionOutcome: "policy_denied" as const,
        decidedAt: "2026-08-08T12:11:00.000Z"
      };
      assert.equal((await audits.recordFollowup(followup)).created, true);
      assert.equal((await audits.recordFollowup(followup)).created, false);
      assert.deepEqual(await audits.getFollowup({ tenantId, repository, auditId }), followup);
      assert.deepEqual(await audits.listPendingImprovementRuns({ tenantId }), []);
      await assert.rejects(
        database.pool.query("update jina_context.context_release_audits set outcome='error' where audit_id=$1", [
          auditId
        ]),
        /append-only/
      );
      await assert.rejects(
        database.pool.query("delete from jina_context.context_release_audit_runs where audit_id=$1", [auditId]),
        /append-only/
      );
    } finally {
      await database.close();
    }
  }
);
