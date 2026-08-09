import {
  ExactProjector,
  LexicalProjector,
  WikiTriggerPublicationError,
  fingerprint,
  isContextArtifactKeyInScope,
  normalizeRepository,
  parseWikiFinalizationAttestationV1,
  parseWikiReleaseArtifactV2,
  repositoryAclFingerprint,
  stableId,
  validateWikiProjectionPreparationV2,
  validateWikiContentArtifactRef,
  wikiSearchableMarkdown,
  type ContextArtifactRef,
  type ContextDocument,
  type EvidenceSnapshot,
  type GenerationProjection,
  type KnowledgeDocumentKind,
  type KnowledgeDocumentRevision,
  type WikiReleaseArtifactV2,
  type WikiTriggerActivationCommitV2,
  type WikiTriggerExecutionFenceV1,
  type WikiTriggerPublicationCommitV2,
  type WikiTriggerPublicationRecordV2,
  type WikiTriggerProjectionPreparationRecordV2,
  type WikiTriggerProjectionPreparationV2,
  type WikiContentArtifactRef,
  type WikiTriggerPublicationStorePort
} from "@jina/context-engine";
import type { PoolClient, QueryResultRow } from "pg";
import { ContextDatabase, dateString } from "./database.js";
import { parseStoredContextCatalog, storedContextCatalog, type StoredContextCatalog } from "./release-catalog.js";

const REF_LOCK_PREFIX = "context-board-publication:";

interface PublicationRow extends QueryResultRow {
  release_id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  ref_sequence: string | null;
  commit_sha: string;
  build_id: string;
  publication_input_digest: string;
  public_snapshot_digest: string;
  release_artifact: ContextArtifactRef;
  catalog: unknown;
  trigger_parent_run_id: string | null;
  request_digest: string | null;
  scope_kind: "branch" | "pull_request" | "commit" | null;
  locale: string;
  pageindex_idempotency_key: string | null;
  pageindex_attachment_input_digest: string | null;
  pageindex_artifact: ContextArtifactRef | null;
  prepared_at: Date | string;
  published_at: Date | string | null;
}

export interface PublishedWikiReleaseInputs {
  readonly tenantId: string;
  readonly repository: string;
  readonly releaseId: string;
  readonly ref: string;
  readonly refSequence?: number;
  readonly scopeKind: "branch" | "pull_request" | "commit";
  readonly scopeKey: string;
  readonly commitSha: string;
  readonly locale: string;
  readonly generatorPolicyVersion: string;
  readonly releaseFamilyId: string;
  readonly publicSnapshotDigest: string;
  readonly contentBundleArtifact: WikiContentArtifactRef;
  /** Immutable V2 release envelope used by the independent audit workflow. */
  readonly releaseArtifact: ContextArtifactRef;
  /** Exact evidence checkpoint against which the release was projected. */
  readonly evidenceSnapshot: EvidenceSnapshot;
}

export interface PublishedWikiReleaseIdentity {
  readonly releaseId: string;
  readonly releaseFamilyId: string;
  readonly generationId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence?: number;
  readonly commitSha: string;
  readonly publicSnapshotDigest: string;
  readonly locale: string;
  readonly scopeKind: "branch" | "pull_request" | "commit";
  readonly scopeKey: string;
  readonly publishedAt: string;
  readonly contentBundleArtifact: WikiContentArtifactRef;
}

export interface PublishedWikiAuditSummary {
  readonly quality: "passed" | "needs_improvement" | "error";
  readonly auditId: string;
  readonly auditPolicyVersion: string;
  readonly auditedAt: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface ActivatedWikiBuildReceipt {
  readonly boardBuildId: string;
  readonly triggerParentRunId: string;
  readonly requestDigest: string;
  readonly releaseId: string;
  readonly releaseFamilyId: string;
  readonly commitSha: string;
  readonly locale: string;
  readonly publicSnapshotDigest: string;
  readonly releaseArtifactSha256: string;
  readonly contentBundleArtifactSha256: string;
  readonly pageindexAttachmentId: string;
  readonly activationOperationDigest: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costMicros: number };
  readonly completedAt: string;
}

interface WikiReleaseIdentityRow extends QueryResultRow {
  release_id: string;
  release_family_id: string;
  repository: string;
  ref_name: string;
  ref_sequence: string | null;
  commit_sha: string;
  public_snapshot_digest: string;
  locale: string;
  scope_kind: "branch" | "pull_request" | "commit";
  scope_key: string;
  published_at: Date | string;
  content_bundle_artifact: unknown;
}

export class PostgresWikiTriggerPublicationRepository implements WikiTriggerPublicationStorePort {
  constructor(private readonly database: ContextDatabase) {}

  async findActivatedWikiBuildReceipt(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly boardBuildId: string;
    readonly requestDigest: string;
  }): Promise<ActivatedWikiBuildReceipt | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const boardBuildId = requiredText(input.boardBuildId, "boardBuildId", 240);
    const requestDigest = digest(input.requestDigest, "requestDigest");
    const result = await this.database.queryAs<{
      build_id: string;
      trigger_parent_run_id: string;
      request_digest: string;
      release_id: string;
      release_family_id: string;
      commit_sha: string;
      locale: string;
      public_snapshot_digest: string;
      release_artifact_sha256: string;
      content_bundle_sha256: string;
      pageindex_attachment_input_digest: string;
      pageindex_metadata: unknown;
      published_at: Date | string;
    }>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select build_id,trigger_parent_run_id,request_digest,release_id,release_family_id,
              commit_sha,locale,public_snapshot_digest,release_artifact->>'sha256' as release_artifact_sha256,
              content_bundle_artifact->>'bundleSha256' as content_bundle_sha256,
              pageindex_attachment_input_digest,pageindex_metadata,published_at
       from jina_context.context_board_publications
       where tenant_id=$1 and repository=$2 and build_id=$3 and request_digest=$4
         and artifact_version=2 and published_at is not null`,
      [tenantId, repository, boardBuildId, requestDigest],
      "wiki_query.activated-build-receipt"
    );
    const row = result.rows[0];
    if (!row?.trigger_parent_run_id || !row.pageindex_attachment_input_digest) return undefined;
    const attachmentInputDigest = digest(row.pageindex_attachment_input_digest, "pageindexAttachmentInputDigest");
    const usage = wikiActivationUsage(row.pageindex_metadata);
    return {
      boardBuildId: row.build_id,
      triggerParentRunId: row.trigger_parent_run_id,
      requestDigest: digest(row.request_digest, "requestDigest"),
      releaseId: row.release_id,
      releaseFamilyId: row.release_family_id,
      commitSha: commitText(row.commit_sha),
      locale: localeText(row.locale),
      publicSnapshotDigest: digest(row.public_snapshot_digest, "publicSnapshotDigest"),
      releaseArtifactSha256: digest(row.release_artifact_sha256, "releaseArtifactSha256"),
      contentBundleArtifactSha256: digest(row.content_bundle_sha256, "contentBundleArtifactSha256"),
      pageindexAttachmentId: stableId("pia", { releaseId: row.release_id, attachmentInputDigest }),
      activationOperationDigest: fingerprint({
        operationId: `wiki:${requestDigest}:pageindex`,
        attachmentInputDigest
      }),
      usage,
      completedAt: dateString(row.published_at)
    };
  }

  async withCurrentPublishedWikiReleaseLock<T>(
    input: { readonly tenantId: string; readonly repository: string; readonly ref: string; readonly locale: string },
    operation: (release: PublishedWikiReleaseIdentity | undefined) => Promise<T>
  ): Promise<T> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const ref = requiredText(input.ref, "ref", 512);
    const locale = localeText(input.locale);
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${REF_LOCK_PREFIX}${tenantId}:${repository}:${ref}:${locale}`
        ]);
        const result = await client.query<WikiReleaseIdentityRow>(
          `select ${WIKI_RELEASE_IDENTITY_COLUMNS}
           from jina_context.current_context_board_releases current_release
           join jina_context.context_board_publications publication
             on publication.tenant_id=current_release.tenant_id
            and publication.repository=current_release.repository
            and publication.release_id=current_release.release_id
           where current_release.tenant_id=$1 and current_release.repository=$2
             and current_release.ref_name=$3 and current_release.locale=$4
             and publication.artifact_version=2 and publication.published_at is not null
           for share of current_release,publication`,
          [tenantId, repository, ref, locale]
        );
        return operation(result.rows[0] ? wikiReleaseIdentity(result.rows[0], tenantId) : undefined);
      },
      "wiki_query.current-ref-lock"
    );
  }

  async getPublishedReleaseInputs(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly releaseId: string;
  }): Promise<PublishedWikiReleaseInputs | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const releaseId = requiredText(input.releaseId, "releaseId", 240);
    const result = await this.database.queryAs<{
      tenant_id: string;
      repository: string;
      release_id: string;
      ref_name: string;
      ref_sequence: string | null;
      scope_kind: "branch" | "pull_request" | "commit";
      scope_key: string;
      commit_sha: string;
      locale: string;
      generator_policy_version: string;
      release_family_id: string;
      public_snapshot_digest: string;
      content_bundle_artifact: unknown;
      release_artifact: unknown;
      evidence_snapshot: unknown;
      build_id: string;
    }>(
      // Independent audits re-read the immutable evidence snapshot, which is
      // intentionally not exposed to the public query capability. Keep this
      // material-reader path on the tenant-scoped administrative capability.
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select publication.tenant_id,publication.repository,publication.release_id,
              publication.ref_name,publication.ref_sequence::text,
              publication.scope_kind,publication.scope_key,
              publication.commit_sha,publication.locale,publication.generator_policy_version,
              publication.release_family_id,
              publication.public_snapshot_digest,publication.content_bundle_artifact,
              publication.release_artifact,evidence.snapshot as evidence_snapshot,publication.build_id
       from jina_context.context_board_publications publication
       join jina_context.context_evidence_snapshots evidence
         on evidence.checkpoint_id=publication.checkpoint_id
        and evidence.tenant_id=publication.tenant_id
        and evidence.repository=publication.repository
        and evidence.ref_name=publication.ref_name
        and evidence.commit_sha=publication.commit_sha
       where publication.tenant_id=$1 and publication.repository=$2 and publication.release_id=$3
         and publication.artifact_version=2 and publication.published_at is not null`,
      [tenantId, repository, releaseId],
      "wiki_release_inputs"
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tenantId: row.tenant_id,
      repository: row.repository,
      releaseId: row.release_id,
      ref: row.ref_name,
      ...(row.ref_sequence === null ? {} : { refSequence: Number(row.ref_sequence) }),
      scopeKind: row.scope_kind,
      scopeKey: row.scope_key,
      commitSha: row.commit_sha,
      locale: row.locale,
      generatorPolicyVersion: row.generator_policy_version,
      releaseFamilyId: row.release_family_id,
      publicSnapshotDigest: row.public_snapshot_digest,
      contentBundleArtifact: validateWikiContentArtifactRef(row.content_bundle_artifact, { tenantId, repository }),
      releaseArtifact: publishedReleaseArtifactRef(row.release_artifact, {
        tenantId,
        repository,
        buildId: row.build_id
      }),
      evidenceSnapshot: row.evidence_snapshot as EvidenceSnapshot
    };
  }

  async findPublishedWikiRelease(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly releaseId: string;
  }): Promise<PublishedWikiReleaseIdentity | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const releaseId = requiredText(input.releaseId, "releaseId", 240);
    const result = await this.database.queryAs<WikiReleaseIdentityRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${WIKI_RELEASE_IDENTITY_COLUMNS}
       from jina_context.context_board_publications publication
       where publication.tenant_id=$1 and publication.repository=$2
         and publication.release_id=$3 and publication.artifact_version=2
         and publication.published_at is not null`,
      [tenantId, repository, releaseId],
      "wiki_query.release"
    );
    return result.rows[0] ? wikiReleaseIdentity(result.rows[0], tenantId) : undefined;
  }

  async findCurrentPublishedWikiRelease(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly locale: string;
  }): Promise<PublishedWikiReleaseIdentity | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const ref = requiredText(input.ref, "ref", 512);
    const locale = localeText(input.locale);
    const result = await this.database.queryAs<WikiReleaseIdentityRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${WIKI_RELEASE_IDENTITY_COLUMNS}
       from jina_context.current_context_board_releases current_release
       join jina_context.context_board_publications publication
         on publication.tenant_id=current_release.tenant_id
        and publication.repository=current_release.repository
        and publication.release_id=current_release.release_id
       where current_release.tenant_id=$1 and current_release.repository=$2
         and current_release.ref_name=$3 and current_release.locale=$4
         and publication.artifact_version=2 and publication.published_at is not null`,
      [tenantId, repository, ref, locale],
      "wiki_query.current-ref"
    );
    return result.rows[0] ? wikiReleaseIdentity(result.rows[0], tenantId) : undefined;
  }

  async findNewestPublishedWikiReleaseForCommit(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly commitSha: string;
    readonly locale: string;
  }): Promise<PublishedWikiReleaseIdentity | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const commitSha = commitText(input.commitSha);
    const locale = localeText(input.locale);
    const result = await this.database.queryAs<WikiReleaseIdentityRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${WIKI_RELEASE_IDENTITY_COLUMNS}
       from jina_context.context_board_publications publication
       where publication.tenant_id=$1 and publication.repository=$2
         and publication.commit_sha=$3 and publication.locale=$4
         and publication.artifact_version=2 and publication.published_at is not null
       order by publication.published_at desc,publication.release_id desc
       limit 1`,
      [tenantId, repository, commitSha, locale],
      "wiki_query.newest-commit"
    );
    return result.rows[0] ? wikiReleaseIdentity(result.rows[0], tenantId) : undefined;
  }

  async listPublishedWikiReleases(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly locale?: string;
    readonly ref?: string;
    readonly commitSha?: string;
    readonly releaseId?: string;
    readonly limit?: number;
  }): Promise<readonly PublishedWikiReleaseIdentity[]> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const locale = input.locale === undefined ? null : localeText(input.locale);
    const ref = input.ref === undefined ? null : requiredText(input.ref, "ref", 512);
    const commitSha = input.commitSha === undefined ? null : commitText(input.commitSha);
    const releaseId = input.releaseId === undefined ? null : requiredText(input.releaseId, "releaseId", 240);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const result = await this.database.queryAs<WikiReleaseIdentityRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select ${WIKI_RELEASE_IDENTITY_COLUMNS}
       from jina_context.context_board_publications publication
       left join jina_context.current_context_board_releases current_release
         on current_release.tenant_id=publication.tenant_id
        and current_release.repository=publication.repository
        and current_release.ref_name=publication.ref_name
        and current_release.locale=publication.locale
        and current_release.release_id=publication.release_id
       where publication.tenant_id=$1 and publication.repository=$2
         and publication.artifact_version=2 and publication.published_at is not null
         and ($3::text is null or publication.locale=$3)
         and ($4::text is null or publication.ref_name=$4)
         and ($5::text is null or publication.commit_sha=$5)
         and ($6::text is null or publication.release_id=$6)
       order by (current_release.release_id is not null) desc,
                publication.published_at desc,publication.release_id desc
       limit $7`,
      [tenantId, repository, locale, ref, commitSha, releaseId, limit],
      "wiki_query.list-releases"
    );
    return result.rows.map((row) => wikiReleaseIdentity(row, tenantId));
  }

  async latestWikiAuditSummary(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly releaseId: string;
    readonly locale: string;
    readonly auditPolicyVersion: string;
  }): Promise<PublishedWikiAuditSummary | undefined> {
    const tenantId = requiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const releaseId = requiredText(input.releaseId, "releaseId", 240);
    const locale = localeText(input.locale);
    const policy = requiredText(input.auditPolicyVersion, "auditPolicyVersion", 240);
    const result = await this.database.queryAs<{
      audit_id: string;
      audit_policy_version: string;
      outcome: "passed" | "needs_improvement" | "error";
      summary: unknown;
      completed_at: Date | string;
    }>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select audit_id,audit_policy_version,outcome,summary,completed_at
       from jina_context.context_release_audits
       where tenant_id=$1 and repository=$2 and release_id=$3 and locale=$4
         and audit_policy_version=$5
       order by completed_at desc,audit_id desc
       limit 1`,
      [tenantId, repository, releaseId, locale, policy],
      "wiki_query.latest-audit"
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (!row.summary || typeof row.summary !== "object" || Array.isArray(row.summary)) {
      throw invalid("stored wiki audit summary is invalid");
    }
    return {
      quality: row.outcome,
      auditId: row.audit_id,
      auditPolicyVersion: row.audit_policy_version,
      auditedAt: dateString(row.completed_at),
      summary: row.summary as Readonly<Record<string, unknown>>
    };
  }

  async prepareProjection(
    input: WikiTriggerProjectionPreparationV2
  ): Promise<WikiTriggerProjectionPreparationRecordV2> {
    const validated = validateWikiProjectionPreparationV2(input);
    const { release, bundle, finalization, projectorVersion } = validated;
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [release.release.tenantId] },
      async (client) => {
        const evidence = await client.query<{ snapshot: unknown }>(
          `select snapshot from jina_context.context_evidence_snapshots
           where checkpoint_id=$1 and tenant_id=$2 and repository=$3
             and ref_name=$4 and commit_sha=$5
           for share`,
          [
            release.release.checkpointId,
            release.release.tenantId,
            release.release.repository,
            release.release.ref,
            release.release.commitSha
          ]
        );
        const snapshot = evidence.rows[0]?.snapshot as EvidenceSnapshot | undefined;
        assertCitationSnapshot(release, snapshot);
        const catalog = materializeWikiCatalog(
          release,
          bundle,
          snapshot!,
          finalization.projectionInputDigest,
          projectorVersion
        );
        const counts = projectionCounts(catalog.projection);
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `context-wiki-projection:${release.release.releaseId}`
        ]);
        await client.query(
          `insert into jina_context.repositories
             (tenant_id,repository,default_ref,created_at,updated_at)
           values ($1,$2,$3,$4,$4)
           on conflict (tenant_id,repository) do nothing`,
          [release.release.tenantId, release.release.repository, release.release.ref, release.release.preparedAt]
        );
        const inserted = await client.query(
          `insert into jina_context.context_wiki_projections
             (release_id,tenant_id,repository,projection_input_digest,catalog,
              document_count,fragment_count,exact_entry_count,hierarchy_node_count,created_at)
           values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
           on conflict (release_id) do nothing`,
          [
            release.release.releaseId,
            release.release.tenantId,
            release.release.repository,
            finalization.projectionInputDigest,
            JSON.stringify(catalog),
            counts.documents,
            counts.fragments,
            counts.exactEntries,
            counts.hierarchy,
            release.release.preparedAt
          ]
        );
        const existing = await client.query<ProjectionRow>(
          `select projection.release_id,projection.tenant_id,projection.repository,
                  projection.projection_input_digest,projection.catalog,
                  projection.document_count,projection.fragment_count,
                  projection.exact_entry_count,projection.hierarchy_node_count,
                  publication.published_at
           from jina_context.context_wiki_projections projection
           left join jina_context.context_board_publications publication
             on publication.release_id=projection.release_id
           where projection.release_id=$1 for share of projection`,
          [release.release.releaseId]
        );
        const row = existing.rows[0];
        assertExistingProjection(row, release, finalization.projectionInputDigest, catalog, counts);
        return projectionRecord(
          release.release.releaseId,
          row.published_at ? "published" : "building",
          counts,
          inserted.rowCount === 1
        );
      },
      "wiki_trigger_projection_prepare"
    );
  }

  async prepare(input: WikiTriggerPublicationCommitV2): Promise<WikiTriggerPublicationRecordV2> {
    const release = parseWikiReleaseArtifactV2(input.release);
    const finalization = parseWikiFinalizationAttestationV1(input.finalization);
    assertFence(input.fence, release);
    assertFinalization(finalization, release);
    assertReleaseArtifact(input.releaseArtifact, release.release);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 512);
    const pipelineVersion = requiredText(input.pipelineVersion, "pipelineVersion", 240);
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [release.release.tenantId] },
      async (client) => {
        await publicationLock(client, input.fence);
        const existing = await byIdempotency(client, release.release.tenantId, idempotencyKey);
        if (existing) {
          if (
            existing.release_id !== release.release.releaseId ||
            existing.publication_input_digest !== release.publicationInputDigest ||
            existing.request_digest !== release.release.requestDigest
          ) {
            throw new WikiTriggerPublicationError(
              "idempotency_conflict",
              "wiki publication idempotency key is already bound to different immutable inputs"
            );
          }
          return record(existing);
        }
        const projection = await client.query<ProjectionRow>(
          `select release_id,tenant_id,repository,projection_input_digest,catalog,
                  document_count,fragment_count,exact_entry_count,hierarchy_node_count,
                  null::timestamptz as published_at
           from jina_context.context_wiki_projections
           where release_id=$1 and tenant_id=$2 and repository=$3
             and projection_input_digest=$4
           for share`,
          [
            release.release.generationId,
            release.release.tenantId,
            release.release.repository,
            finalization.projectionInputDigest
          ]
        );
        const preparedProjection = projection.rows[0];
        if (!preparedProjection) {
          throw new WikiTriggerPublicationError(
            "release_not_prepared",
            "wiki V2 projection must be completely prepared in building state before metadata binding"
          );
        }
        const preparedCatalog = parseStoredContextCatalog(preparedProjection.catalog);
        assertPreparedCatalogIdentity(preparedCatalog, release, finalization.projectionInputDigest);
        const inserted = await client.query<PublicationRow>(
          `insert into jina_context.context_board_publications (
             release_id,tenant_id,repository,ref_name,ref_sequence,commit_sha,build_id,
             checkpoint_id,idempotency_key,publication_input_digest,public_snapshot_digest,
             certification_artifact,publication_plan_artifact,release_artifact,catalog,page_count,published_at,
             artifact_version,orchestrator,pipeline_version,trigger_parent_run_id,request_digest,
             scope_kind,scope_key,base_commit_sha,parent_release_id,release_family_id,
             source_release_id,source_locale,generation_reason,instruction_digest,
             exclusion_policy_digest,generator_policy_version,finalizer_version,mermaid_version,
             diagram_policy_version,locale,model_provider_family,model_id,prompt_digest,
             inference_config_digest,generation_plan_artifact,finalization_artifact,
             release_manifest_artifact,content_bundle_artifact,prepared_at
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             null,null,$12::jsonb,$13::jsonb,$14,null,
             2,'trigger',$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             $30,$31,$32,$33,$34,$35,$36,$37::jsonb,$38::jsonb,$39::jsonb,$40::jsonb,$41
           )
           returning ${PUBLICATION_COLUMNS}`,
          [
            release.release.releaseId,
            release.release.tenantId,
            release.release.repository,
            release.release.ref,
            release.release.refSequence ?? null,
            release.release.commitSha,
            release.release.buildId,
            release.release.checkpointId,
            idempotencyKey,
            release.publicationInputDigest,
            release.publicSnapshotDigest,
            JSON.stringify(input.releaseArtifact),
            JSON.stringify(preparedCatalog),
            release.pages.length,
            pipelineVersion,
            release.release.triggerParentRunId,
            release.release.requestDigest,
            release.release.scopeKind,
            release.release.scopeKey,
            release.release.baseCommitSha ?? null,
            release.release.parentReleaseId ?? null,
            release.release.releaseFamilyId,
            release.release.sourceReleaseId ?? null,
            release.release.sourceLocale ?? null,
            release.release.generationReason,
            digest(input.instructionDigest, "instructionDigest"),
            digest(input.exclusionPolicyDigest, "exclusionPolicyDigest"),
            finalization.generatorPolicyVersion,
            finalization.finalizerVersion,
            finalization.mermaidVersion,
            finalization.diagramPolicyVersion,
            release.release.locale,
            requiredText(input.modelProviderFamily, "modelProviderFamily", 240),
            requiredText(input.modelId, "modelId", 240),
            digest(input.promptDigest, "promptDigest"),
            digest(input.inferenceConfigDigest, "inferenceConfigDigest"),
            JSON.stringify(release.generationPlanArtifact),
            JSON.stringify(release.finalizationArtifact),
            JSON.stringify(release.releaseManifestArtifact),
            JSON.stringify(release.contentBundleArtifact),
            release.release.preparedAt
          ]
        );
        if (!inserted.rows[0])
          throw new WikiTriggerPublicationError("publication_race", "wiki publication insert failed");
        return record(inserted.rows[0]);
      },
      "wiki_trigger_publication_prepare"
    );
  }

  async activate(input: WikiTriggerActivationCommitV2): Promise<WikiTriggerPublicationRecordV2> {
    const releaseId = requiredText(input.releaseId, "releaseId", 240);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 512);
    const attachmentInputDigest = digest(input.attachmentInputDigest, "attachmentInputDigest");
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [input.fence.tenantId] },
      async (client) => {
        await publicationLock(client, input.fence);
        // Freeze Board cancellation/supersession while the release becomes
        // query-visible. The lock order is ref -> API state, matching audit-fix
        // admission, so the two workflows cannot deadlock.
        await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
        // The advisory lock already prevents a concurrent Board write. Keep
        // this authority check a plain SELECT so the Context publication role
        // needs no INSERT/UPDATE capability on the Board snapshot table.
        const runtime = await client.query<{ snapshot: unknown }>(
          "select snapshot from jina_runtime.api_state where id=1"
        );
        assertLiveWikiTriggerAuthority(runtime.rows[0]?.snapshot, input.fence);
        const publication = await byReleaseForUpdate(client, releaseId);
        assertStoredFence(publication, input.fence);
        if (publication.pageindex_attachment_input_digest !== null) {
          if (
            publication.pageindex_idempotency_key !== idempotencyKey ||
            publication.pageindex_attachment_input_digest !== attachmentInputDigest ||
            !sameArtifact(publication.pageindex_artifact, input.pageIndexArtifact)
          ) {
            throw new WikiTriggerPublicationError(
              "idempotency_conflict",
              "wiki release has a different PageIndex attachment"
            );
          }
          return record(publication);
        }

        const activationClock = await client.query<{ attached_at: Date | string }>(
          "select transaction_timestamp() as attached_at"
        );
        const attachedAt = dateString(activationClock.rows[0]!.attached_at);

        if (publication.scope_kind !== "commit") {
          if (publication.ref_sequence === null) throw invalid("mutable wiki release has no ref sequence");
          const current = await client.query<{ release_id: string; ref_sequence: string }>(
            `select release_id,ref_sequence::text
             from jina_context.current_context_board_releases
             where tenant_id=$1 and repository=$2 and ref_name=$3 and locale=$4
             for update`,
            [publication.tenant_id, publication.repository, publication.ref_name, publication.locale]
          );
          const currentSequence = Number(current.rows[0]?.ref_sequence ?? 0);
          const intendedSequence = Number(publication.ref_sequence);
          if (currentSequence > intendedSequence) {
            throw new WikiTriggerPublicationError(
              "stale_ref_sequence",
              "newer locale-specific wiki release is already active"
            );
          }
          if (currentSequence === intendedSequence && current.rows[0]?.release_id !== releaseId) {
            throw new WikiTriggerPublicationError("publication_race", "wiki ref sequence is bound to another release");
          }
        }

        assertPageIndexArtifact(input.pageIndexArtifact, publication);
        if (
          !input.pageIndexMetadata ||
          typeof input.pageIndexMetadata !== "object" ||
          Array.isArray(input.pageIndexMetadata) ||
          Buffer.byteLength(JSON.stringify(input.pageIndexMetadata), "utf8") > 65_536
        ) {
          throw invalid("wiki PageIndex metadata is invalid or too large");
        }
        const catalog = parseStoredContextCatalog(publication.catalog);
        if (
          catalog.projection.generation.id !== releaseId ||
          catalog.projection.generation.tenantId !== publication.tenant_id ||
          catalog.projection.generation.repository !== publication.repository ||
          catalog.projection.generation.status !== "building" ||
          catalog.projection.hierarchyNodes.length === 0
        ) {
          throw new WikiTriggerPublicationError(
            "release_not_prepared",
            "wiki compact catalog is incomplete or not in prepared state"
          );
        }
        const publishedCatalog: StoredContextCatalog = {
          ...catalog,
          projection: {
            ...catalog.projection,
            generation: {
              ...catalog.projection.generation,
              status: "published",
              capabilities: { ...catalog.projection.generation.capabilities, hierarchy: "available" },
              publishedAt: attachedAt
            }
          }
        };
        const attached = await client.query<PublicationRow>(
          `update jina_context.context_board_publications
           set catalog=$2::jsonb,pageindex_idempotency_key=$3,pageindex_attachment_input_digest=$4,
               pageindex_artifact=$5::jsonb,pageindex_metadata=$6::jsonb,
               pageindex_attached_at=$7,published_at=$7
           where release_id=$1 and artifact_version=2
             and pageindex_attachment_input_digest is null
           returning ${PUBLICATION_COLUMNS}`,
          [
            releaseId,
            JSON.stringify(publishedCatalog),
            idempotencyKey,
            attachmentInputDigest,
            JSON.stringify(input.pageIndexArtifact),
            JSON.stringify(input.pageIndexMetadata),
            attachedAt
          ]
        );
        const activated = attached.rows[0];
        if (!activated) throw new WikiTriggerPublicationError("publication_race", "wiki release activation raced");
        if (activated.scope_kind !== "commit") {
          await client.query(
            `insert into jina_context.current_context_board_releases
               (tenant_id,repository,ref_name,locale,ref_sequence,release_id,commit_sha,
                public_snapshot_digest,advanced_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict (tenant_id,repository,ref_name,locale) do update
             set ref_sequence=excluded.ref_sequence,release_id=excluded.release_id,
                 commit_sha=excluded.commit_sha,public_snapshot_digest=excluded.public_snapshot_digest,
                 advanced_at=excluded.advanced_at
             where jina_context.current_context_board_releases.ref_sequence < excluded.ref_sequence
                or jina_context.current_context_board_releases.release_id=excluded.release_id`,
            [
              activated.tenant_id,
              activated.repository,
              activated.ref_name,
              activated.locale,
              activated.ref_sequence,
              activated.release_id,
              activated.commit_sha,
              activated.public_snapshot_digest,
              attachedAt
            ]
          );
        }
        return record(activated);
      },
      "wiki_trigger_publication_activate"
    );
  }
}

interface ProjectionRow extends QueryResultRow {
  readonly release_id: string;
  readonly tenant_id: string;
  readonly repository: string;
  readonly projection_input_digest: string;
  readonly catalog: unknown;
  readonly document_count: number;
  readonly fragment_count: number;
  readonly exact_entry_count: number;
  readonly hierarchy_node_count: number;
  readonly published_at: Date | string | null;
}

interface ProjectionCounts {
  readonly documents: number;
  readonly fragments: number;
  readonly exactEntries: number;
  readonly hierarchy: number;
}

function assertCitationSnapshot(release: WikiReleaseArtifactV2, snapshot: EvidenceSnapshot | undefined): void {
  const identity = release.release;
  if (
    !snapshot ||
    snapshot.checkpoint.id !== identity.checkpointId ||
    snapshot.checkpoint.tenantId !== identity.tenantId ||
    normalizeRepository(snapshot.checkpoint.repository) !== identity.repository ||
    snapshot.checkpoint.ref !== identity.ref ||
    snapshot.checkpoint.commitSha !== identity.commitSha
  ) {
    throw invalid("wiki projection checkpoint does not match the release source scope");
  }
  const citations = release.pages.flatMap((page) => page.citations);
  if (
    citations.length === 0 ||
    release.pages.some((page) => page.citations.length === 0) ||
    new Set(citations.map((citation) => citation.id)).size !== citations.length
  ) {
    throw invalid("wiki projection pages require uniquely identified checkpoint citations");
  }
  const repositoryAcl = repositoryAclFingerprint(identity.tenantId, identity.repository);
  for (const citation of citations) {
    const evidence = snapshot.records.find(
      (candidate) =>
        candidate.anchor.tenantId === citation.anchor.tenantId &&
        normalizeRepository(candidate.anchor.repository) === normalizeRepository(citation.anchor.repository) &&
        candidate.anchor.sourceType === citation.anchor.sourceType &&
        candidate.anchor.sourceId === citation.anchor.sourceId &&
        candidate.anchor.contentDigest === citation.anchor.contentDigest &&
        candidate.anchor.commitSha === citation.anchor.commitSha &&
        candidate.anchor.pathOrUrl === citation.anchor.pathOrUrl &&
        candidate.anchor.startLine === citation.anchor.startLine &&
        candidate.anchor.endLine === citation.anchor.endLine &&
        candidate.anchor.jsonPointer === citation.anchor.jsonPointer
    );
    if (!evidence) throw invalid(`wiki projection citation ${citation.id} is absent from its exact checkpoint`);
    if (evidence.aclFingerprint !== repositoryAcl) {
      throw invalid(`wiki projection citation ${citation.id} is outside the repository ACL scope`);
    }
  }
}

function materializeWikiCatalog(
  release: WikiReleaseArtifactV2,
  bundle: WikiTriggerProjectionPreparationV2["contentBundle"],
  snapshot: EvidenceSnapshot,
  projectionInputDigest: string,
  projectorVersion: string
): StoredContextCatalog {
  const identity = release.release;
  const bundleByPath = new Map(bundle.pages.map((page) => [page.documentPath, page]));
  const aclFingerprint = repositoryAclFingerprint(identity.tenantId, identity.repository);
  const documents: ContextDocument[] = release.pages.map((page) => {
    const bodyMarkdown = bundleByPath.get(page.documentPath)!.bodyMarkdown;
    return {
      id: stableId("cd", { generationId: identity.generationId, revisionId: page.revisionId }),
      generationId: identity.generationId,
      tenantId: identity.tenantId,
      repository: identity.repository,
      ref: identity.ref,
      commitSha: identity.commitSha,
      sourceKind: "knowledge",
      sourceId: page.documentPath,
      sourceRevisionId: page.revisionId,
      knowledgeKind: knowledgeKindForPath(page.documentPath),
      title: page.title,
      body: wikiSearchableMarkdown(bodyMarkdown),
      contextualText: `${page.title}\n${page.documentPath}`,
      metadata: {
        path: page.documentPath,
        locale: identity.locale,
        releaseFamilyId: identity.releaseFamilyId,
        metadataDigest: page.metadataDigest
      },
      authorityClass: "generated_interpretation",
      effectiveAclFingerprint: aclFingerprint,
      sourceFingerprint: fingerprint({
        revisionId: page.revisionId,
        bodySha256: page.bodySha256,
        metadataDigest: page.metadataDigest,
        citationIds: page.citations.map((citation) => citation.id)
      }),
      anchors: page.citations.map((citation) => citation.anchor)
    };
  });
  const fragments = new LexicalProjector().project(documents);
  const exactIndex = new ExactProjector().project(documents);
  const hierarchyNodes = documents.map((document, ordinal) => ({
    id: stableId("hn", {
      generationId: identity.generationId,
      documentId: document.id,
      adapter: "wiki-release-v2",
      ordinal
    }),
    generationId: identity.generationId,
    documentId: document.id,
    title: document.title,
    summary: String(document.metadata.path),
    depth: 1,
    preorderStart: ordinal + 1,
    preorderEnd: ordinal + 1,
    anchors: document.anchors,
    adapterName: "wiki-release-v2",
    adapterVersion: projectorVersion
  }));
  const revisions: KnowledgeDocumentRevision[] = release.pages.map((page) => {
    const bodyMarkdown = bundleByPath.get(page.documentPath)!.bodyMarkdown;
    return {
      id: page.revisionId,
      logicalId: logicalIdForPath(identity.repository, page.documentPath),
      tenantId: identity.tenantId,
      repository: identity.repository,
      kind: knowledgeKindForPath(page.documentPath),
      title: page.title,
      bodyMarkdown,
      summary: page.title,
      structuredSummary: { documentPath: page.documentPath, locale: identity.locale },
      scope: {
        ref: identity.ref,
        commitSha: identity.commitSha,
        paths: [
          ...new Set(
            page.citations
              .map((citation) => citation.anchor.pathOrUrl)
              .filter((path): path is string => typeof path === "string" && !/^https?:\/\//i.test(path))
          )
        ].sort(),
        symbols: [],
        pullRequests: [],
        issues: []
      },
      evidenceFingerprint: fingerprint(
        page.citations.map((citation) => ({ id: citation.id, anchor: citation.anchor }))
      ),
      bodyDigest: fingerprint(bodyMarkdown),
      generatorName: "context-wiki-trigger",
      generatorVersion: projectorVersion,
      model: "wiki-release-v2",
      promptVersion: projectorVersion,
      confidence: 1,
      createdAt: identity.preparedAt
    };
  });
  const projection: GenerationProjection = {
    generation: {
      id: identity.generationId,
      tenantId: identity.tenantId,
      repository: identity.repository,
      ref: identity.ref,
      commitSha: identity.commitSha,
      checkpointId: identity.checkpointId,
      status: "building",
      capabilities: {
        sourceCompleteness: snapshot.checkpoint.sourceCompleteness,
        derivedKnowledge: "available",
        hierarchy: "available"
      },
      fingerprint: fingerprint({
        projectionInputDigest,
        documents: documents.map((document) => document.sourceFingerprint),
        fragments: fragments.map((fragment) => fragment.tokenFingerprint),
        exactIndex,
        hierarchyNodes
      }),
      createdAt: identity.preparedAt
    },
    manifest: [...snapshot.manifest],
    currentKnowledge: revisions.map((revision) => ({
      generationId: identity.generationId,
      tenantId: identity.tenantId,
      repository: identity.repository,
      logicalId: revision.logicalId,
      revisionId: revision.id,
      selectionReason: "wiki release page"
    })),
    documents,
    fragments,
    exactIndex,
    hierarchyNodes,
    structuralRelations: []
  };
  return storedContextCatalog({
    projection,
    revisions,
    citations: release.pages.flatMap((page) => page.citations)
  });
}

function projectionCounts(projection: GenerationProjection): ProjectionCounts {
  return {
    documents: projection.documents.length,
    fragments: projection.fragments.length,
    exactEntries: projection.exactIndex.length,
    hierarchy: projection.hierarchyNodes.length
  };
}

function assertExistingProjection(
  row: ProjectionRow | undefined,
  release: WikiReleaseArtifactV2,
  projectionInputDigest: string,
  expectedCatalog: StoredContextCatalog,
  expected: ProjectionCounts
): asserts row is ProjectionRow {
  if (
    !row ||
    row.release_id !== release.release.releaseId ||
    row.tenant_id !== release.release.tenantId ||
    row.repository !== release.release.repository ||
    row.projection_input_digest !== projectionInputDigest ||
    row.document_count !== expected.documents ||
    row.fragment_count !== expected.fragments ||
    row.exact_entry_count !== expected.exactEntries ||
    row.hierarchy_node_count !== expected.hierarchy ||
    fingerprint(parseStoredContextCatalog(row.catalog)) !== fingerprint(expectedCatalog)
  ) {
    throw new WikiTriggerPublicationError(
      "idempotency_conflict",
      "wiki generation ID is bound to a different compact projection"
    );
  }
}

function assertPreparedCatalogIdentity(
  catalog: StoredContextCatalog,
  release: WikiReleaseArtifactV2,
  projectionInputDigest: string
): void {
  const generation = catalog.projection.generation;
  if (
    generation.id !== release.release.generationId ||
    generation.tenantId !== release.release.tenantId ||
    generation.repository !== release.release.repository ||
    generation.ref !== release.release.ref ||
    generation.commitSha !== release.release.commitSha ||
    generation.checkpointId !== release.release.checkpointId ||
    generation.status !== "building" ||
    catalog.projection.documents.length !== release.pages.length ||
    !generation.fingerprint ||
    !projectionInputDigest
  ) {
    throw new WikiTriggerPublicationError("release_not_prepared", "wiki compact projection identity is invalid");
  }
}

function knowledgeKindForPath(documentPath: string): KnowledgeDocumentKind {
  const path = documentPath.toLowerCase();
  if (/(^|\/)architecture(?:\/|\.md$)/.test(path)) return "architecture";
  if (/(^|\/)components?\//.test(path)) return "component";
  if (/(^|\/)(?:workflows?|flows?)\//.test(path)) return "flow";
  if (/(^|\/)(?:runbooks?|operations?)\//.test(path)) return "runbook";
  if (/(^|\/)glossary(?:\/|\.md$)/.test(path)) return "glossary";
  return "topic";
}

function logicalIdForPath(repository: string, documentPath: string): string {
  const kind = knowledgeKindForPath(documentPath);
  if (kind === "architecture") return `repository:${repository}:architecture`;
  const slug =
    documentPath
      .toLowerCase()
      .replace(/\.md$/, "")
      .replace(/[^a-z0-9_.:/-]+/g, "-")
      .replace(/^[-/:.]+|[-/:.]+$/g, "") || "index";
  return `${kind}:${repository}:${slug}`;
}
function projectionRecord(
  releaseId: string,
  status: "building" | "published",
  counts: ProjectionCounts,
  created: boolean
): WikiTriggerProjectionPreparationRecordV2 {
  return {
    releaseId,
    generationId: releaseId,
    status,
    documentCount: counts.documents,
    fragmentCount: counts.fragments,
    exactEntryCount: counts.exactEntries,
    hierarchyNodeCount: counts.hierarchy,
    created
  };
}

const PUBLICATION_COLUMNS = `release_id,tenant_id,repository,ref_name,ref_sequence::text,commit_sha,
  build_id,publication_input_digest,public_snapshot_digest,release_artifact,catalog,
  trigger_parent_run_id,request_digest,scope_kind,locale,pageindex_idempotency_key,
  pageindex_attachment_input_digest,pageindex_artifact,prepared_at,published_at`;

const WIKI_RELEASE_IDENTITY_COLUMNS = `publication.release_id,publication.release_family_id,
  publication.repository,publication.ref_name,publication.ref_sequence::text,
  publication.commit_sha,publication.public_snapshot_digest,publication.locale,
  publication.scope_kind,publication.scope_key,publication.published_at,
  publication.content_bundle_artifact`;

function wikiReleaseIdentity(row: WikiReleaseIdentityRow, tenantId: string): PublishedWikiReleaseIdentity {
  if (!row.release_family_id || !row.scope_kind || !row.scope_key || !row.published_at) {
    throw invalid("stored V2 wiki release identity is incomplete");
  }
  const refSequence = row.ref_sequence === null ? undefined : Number(row.ref_sequence);
  if (refSequence !== undefined && (!Number.isSafeInteger(refSequence) || refSequence <= 0)) {
    throw invalid("stored V2 wiki release ref sequence is invalid");
  }
  return {
    releaseId: row.release_id,
    releaseFamilyId: row.release_family_id,
    generationId: row.release_id,
    repository: row.repository,
    ref: row.ref_name,
    ...(refSequence === undefined ? {} : { refSequence }),
    commitSha: row.commit_sha,
    publicSnapshotDigest: digest(row.public_snapshot_digest, "publicSnapshotDigest"),
    locale: row.locale,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    publishedAt: dateString(row.published_at),
    contentBundleArtifact: validateWikiContentArtifactRef(row.content_bundle_artifact, {
      tenantId,
      repository: row.repository
    })
  };
}

async function byIdempotency(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string
): Promise<PublicationRow | undefined> {
  const result = await client.query<PublicationRow>(
    `select ${PUBLICATION_COLUMNS} from jina_context.context_board_publications
     where tenant_id=$1 and idempotency_key=$2 for update`,
    [tenantId, idempotencyKey]
  );
  return result.rows[0];
}

async function byReleaseForUpdate(client: PoolClient, releaseId: string): Promise<PublicationRow> {
  const result = await client.query<PublicationRow>(
    `select ${PUBLICATION_COLUMNS} from jina_context.context_board_publications
     where release_id=$1 and artifact_version=2 for update`,
    [releaseId]
  );
  if (!result.rows[0]) throw new WikiTriggerPublicationError("release_not_prepared", "wiki V2 release is not prepared");
  return result.rows[0];
}

async function publicationLock(client: PoolClient, fence: WikiTriggerExecutionFenceV1): Promise<void> {
  const repository = normalizeRepository(fence.repository);
  const lock =
    fence.scopeKind === "commit"
      ? `context-wiki-release:${fence.tenantId}:${repository}:${fence.commitSha}:${fence.locale}`
      : `${REF_LOCK_PREFIX}${fence.tenantId}:${repository}:${fence.ref}:${fence.locale}`;
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [lock]);
}

function assertFence(fence: WikiTriggerExecutionFenceV1, release: ReturnType<typeof parseWikiReleaseArtifactV2>): void {
  const identity = release.release;
  if (
    fence.boardBuildId !== identity.buildId ||
    fence.triggerParentRunId !== identity.triggerParentRunId ||
    fence.requestDigest !== identity.requestDigest ||
    fence.tenantId !== identity.tenantId ||
    normalizeRepository(fence.repository) !== identity.repository ||
    fence.commitSha !== identity.commitSha ||
    fence.scopeKind !== identity.scopeKind ||
    fence.ref !== identity.ref ||
    fence.refSequence !== identity.refSequence ||
    fence.locale.toLowerCase() !== identity.locale ||
    !fence.operationId.trim()
  )
    throw invalid("wiki publication execution fence does not match release identity");
}

function assertStoredFence(publication: PublicationRow, fence: WikiTriggerExecutionFenceV1): void {
  if (
    publication.tenant_id !== fence.tenantId ||
    publication.repository !== normalizeRepository(fence.repository) ||
    publication.build_id !== fence.boardBuildId ||
    publication.trigger_parent_run_id !== fence.triggerParentRunId ||
    publication.request_digest !== fence.requestDigest ||
    publication.commit_sha !== fence.commitSha ||
    publication.scope_kind !== fence.scopeKind ||
    publication.ref_name !== fence.ref ||
    (publication.ref_sequence === null ? undefined : Number(publication.ref_sequence)) !== fence.refSequence ||
    publication.locale !== fence.locale.toLowerCase()
  )
    throw invalid("wiki activation fence does not match prepared release");
}

function assertLiveWikiTriggerAuthority(snapshot: unknown, fence: WikiTriggerExecutionFenceV1): void {
  const root = recordOrUndefined(snapshot);
  const intake = recordOrUndefined(root?.intakeState);
  const board = recordOrUndefined(intake?.board);
  const tasks = Array.isArray(board?.tasks) ? board.tasks.map(recordOrUndefined).filter(isRecord) : [];
  const events = Array.isArray(board?.events) ? board.events.map(recordOrUndefined).filter(isRecord) : [];
  const task = tasks.find((candidate) => candidate.id === fence.boardBuildId);
  const metadata = recordOrUndefined(task?.metadata);
  const claimed = events.some((candidate) => {
    const payload = recordOrUndefined(candidate.payload);
    return (
      candidate.type === "context.wiki_trigger_parent_claimed" &&
      candidate.taskId === fence.boardBuildId &&
      payload?.requestDigest === fence.requestDigest &&
      payload.triggerParentRunId === fence.triggerParentRunId
    );
  });
  const newerIntent =
    fence.refSequence === undefined
      ? false
      : tasks.some((candidate) => {
          const candidateMetadata = recordOrUndefined(candidate.metadata);
          return (
            candidate.type === "build-wiki" &&
            candidate.id !== fence.boardBuildId &&
            candidateMetadata?.tenantId === fence.tenantId &&
            candidateMetadata.repository === normalizeRepository(fence.repository) &&
            candidateMetadata.ref === fence.ref &&
            candidateMetadata.locale === fence.locale.toLowerCase() &&
            typeof candidateMetadata.refSequence === "number" &&
            candidateMetadata.refSequence > fence.refSequence! &&
            candidate.status !== "failed" &&
            candidate.status !== "canceled"
          );
        });
  if (
    !task ||
    task.type !== "build-wiki" ||
    task.kind !== "dispatchable" ||
    task.status !== "in_progress" ||
    metadata?.tenantId !== fence.tenantId ||
    metadata.repository !== normalizeRepository(fence.repository) ||
    metadata.ref !== fence.ref ||
    metadata.refSequence !== fence.refSequence ||
    metadata.commitSha !== fence.commitSha ||
    metadata.locale !== fence.locale.toLowerCase() ||
    metadata.requestDigest !== fence.requestDigest ||
    !claimed ||
    newerIntent
  ) {
    throw new WikiTriggerPublicationError(
      "stale_ref_sequence",
      "wiki build was canceled, superseded, or lost durable Trigger authority before activation"
    );
  }
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function wikiActivationUsage(value: unknown): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
} {
  const metadata = recordOrUndefined(value);
  const usage = recordOrUndefined(metadata?.usage);
  if (!usage) throw invalid("wiki activation metadata has no usage receipt");
  return {
    inputTokens: nonnegativeSafeInteger(usage.inputTokens, "inputTokens"),
    outputTokens: nonnegativeSafeInteger(usage.outputTokens, "outputTokens"),
    costMicros: nonnegativeSafeInteger(usage.costMicros, "costMicros")
  };
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`wiki activation usage ${label} is invalid`);
  }
  return value;
}

function isRecord(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return value !== undefined;
}

function assertFinalization(
  finalization: ReturnType<typeof parseWikiFinalizationAttestationV1>,
  release: ReturnType<typeof parseWikiReleaseArtifactV2>
): void {
  if (
    finalization.publicSnapshotDigest !== release.publicSnapshotDigest ||
    finalization.contentBundleArtifactSha256 !== release.contentBundleArtifact.bundleSha256 ||
    finalization.manifestDigest !== release.releaseManifestArtifact.sha256
  )
    throw invalid("wiki finalization attestation does not bind release artifacts");
  validateWikiContentArtifactRef(release.contentBundleArtifact, release.release);
}

function assertReleaseArtifact(
  ref: ContextArtifactRef,
  release: { tenantId: string; repository: string; buildId: string }
): void {
  if (
    !isContextArtifactKeyInScope(ref.key, release) ||
    !ref.key.endsWith("/context-release/release-v2.json") ||
    ref.contentType !== "application/json" ||
    !/^[0-9a-f]{64}$/.test(ref.sha256)
  ) {
    throw invalid("wiki release artifact is outside its exact build scope");
  }
}

function publishedReleaseArtifactRef(
  value: unknown,
  release: { tenantId: string; repository: string; buildId: string }
): ContextArtifactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("stored wiki release artifact reference is invalid");
  }
  const input = value as Record<string, unknown>;
  const objectGeneration =
    input.objectGeneration === undefined
      ? undefined
      : requiredText(input.objectGeneration, "releaseArtifact.objectGeneration", 240);
  const ref: ContextArtifactRef = {
    uri: requiredText(input.uri, "releaseArtifact.uri", 4_096),
    key: requiredText(input.key, "releaseArtifact.key", 4_096),
    contentType: requiredText(input.contentType, "releaseArtifact.contentType", 240),
    bytes: Number(input.bytes),
    sha256: digest(input.sha256, "releaseArtifact.sha256"),
    ...(objectGeneration === undefined ? {} : { objectGeneration })
  };
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 16 * 1024 * 1024) {
    throw invalid("stored wiki release artifact size is invalid");
  }
  assertReleaseArtifact(ref, release);
  return ref;
}

function assertPageIndexArtifact(ref: ContextArtifactRef, publication: PublicationRow): void {
  if (
    !isContextArtifactKeyInScope(ref.key, {
      tenantId: publication.tenant_id,
      repository: publication.repository,
      buildId: publication.build_id
    }) ||
    !ref.key.includes("/pageindex-tree/") ||
    ref.contentType !== "application/json" ||
    !/^[0-9a-f]{64}$/.test(ref.sha256)
  ) {
    throw invalid("wiki PageIndex artifact escapes its release build scope");
  }
}

function record(row: PublicationRow): WikiTriggerPublicationRecordV2 {
  return {
    releaseId: row.release_id,
    generationId: row.release_id,
    publicationInputDigest: row.publication_input_digest,
    publicSnapshotDigest: row.public_snapshot_digest,
    releaseArtifact: row.release_artifact,
    preparedAt: dateString(row.prepared_at),
    ...(row.published_at ? { publishedAt: dateString(row.published_at) } : {})
  };
}

function sameArtifact(left: ContextArtifactRef | null, right: ContextArtifactRef): boolean {
  return (
    left !== null &&
    left.uri === right.uri &&
    left.key === right.key &&
    left.contentType === right.contentType &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.objectGeneration === right.objectGeneration
  );
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0"))
    throw invalid(`${label} is invalid`);
  return value;
}

function localeText(value: unknown): string {
  const locale = requiredText(value, "locale", 80).toLowerCase();
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(locale)) throw invalid("locale is invalid");
  return locale;
}

function commitText(value: unknown): string {
  const commit = requiredText(value, "commitSha", 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw invalid("commitSha must be a full Git SHA");
  return commit;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw invalid(`${label} must be SHA-256`);
  return value;
}

function invalid(message: string): WikiTriggerPublicationError {
  return new WikiTriggerPublicationError("invalid_publication", message);
}
