import { fingerprint, normalizeIsoTime, stableId } from "../domain/fingerprint.js";
import type {
  ContextProjectionConsumer,
  GenerationProjection,
  IndexGeneration,
  ProjectorStatus
} from "../domain/projection.js";
import type { KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import { contextProjectionConsumers } from "../domain/projection.js";
import type { ContextEngineStore } from "../ports/context-engine-store.js";
import type { HierarchyIndexer } from "../ports/hierarchy.js";
import { FallbackHierarchyIndexer, hierarchyEligibleDocuments, materializeHierarchyNodes } from "./hierarchy.js";
import { CurrentKnowledgeProjector } from "./knowledge-current.js";
import { LexicalProjector } from "./lexical.js";
import { EXACT_PROJECTOR_VERSION, ExactProjector } from "./exact.js";
import { ManifestProjector } from "./manifest.js";

export const INDEX_COORDINATOR_VERSION = "context-release-v2";

function versions(): Record<ContextProjectionConsumer, string> {
  return {
    manifest: "manifest-v1",
    "knowledge-current": "knowledge-current-v2",
    lexical: "lexical-v2",
    dense: "disabled-v1",
    hierarchy: "hierarchy-v1",
    structural: "disabled-derived-only-v1",
    identity: "identity-v1",
    acl: "acl-v1",
    retention: "retention-v1"
  };
}

function initialStatuses(): Record<ContextProjectionConsumer, ProjectorStatus> {
  return Object.fromEntries(contextProjectionConsumers.map((consumer) => [consumer, "skipped"])) as Record<
    ContextProjectionConsumer,
    ProjectorStatus
  >;
}

export class IndexContextService {
  constructor(
    private readonly store: ContextEngineStore,
    private readonly hierarchyIndexer: HierarchyIndexer = new FallbackHierarchyIndexer()
  ) {}

  async index(
    checkpointId: string,
    createdAt: string,
    releaseMode: "complete" | "partial" = "complete"
  ): Promise<IndexGeneration> {
    const checkpoint = await this.store.getCheckpoint(checkpointId);
    if (checkpoint === undefined) throw new Error("Unknown evidence checkpoint");
    const latest = await this.store.latestCheckpoint(checkpoint.tenantId, checkpoint.repository, checkpoint.ref);
    if (latest?.id !== checkpoint.id) {
      throw new Error(`Checkpoint ${checkpoint.id} is superseded for ${checkpoint.repository}@${checkpoint.ref}`);
    }
    const projectionInputFingerprint = await this.store.projectionInputFingerprint(
      checkpoint.tenantId,
      checkpoint.repository
    );
    const projectedAt = normalizeIsoTime(createdAt);
    const projectorVersions = versions();
    const eligibleRevisions = await this.store.listCurrentEligibleRevisions(
      checkpoint.tenantId,
      checkpoint.repository,
      checkpointId
    );
    const evidence = await this.store.listEvidence(checkpointId);
    const manifest = await this.store.listManifest(checkpointId);
    const scopedLogicalIds = new Set(
      (await this.store.listCheckpointRevisions(checkpoint.tenantId, checkpoint.repository, checkpointId)).map(
        (revision) => revision.logicalId
      )
    );
    const repositoryAccessFingerprint = await this.store.repositoryAccessFingerprint(
      checkpoint.tenantId,
      checkpoint.repository
    );
    const generationId = stableId("ig", {
      checkpointId,
      projectorVersions,
      revisionIds: eligibleRevisions.map((revision) => revision.id).sort(),
      evidenceIds: evidence.map((record) => record.id).sort(),
      manifest: manifest.map((entry) => [entry.path, entry.blobSha]).sort(),
      repositoryAccessFingerprint,
      projectionInputFingerprint
    });
    const manifestOutput = new ManifestProjector().project({
      generationId,
      commitSha: checkpoint.commitSha,
      ref: checkpoint.ref,
      projectedAt,
      manifest,
      evidence
    });
    const citationMap = new Map<string, KnowledgeEvidenceCitation[]>();
    const aclMap = new Map<string, string>();
    for (const revision of eligibleRevisions) {
      const citations = await this.store.listCitations(revision.id);
      citationMap.set(revision.id, citations);
      for (const citation of citations) {
        const record = await this.store.resolveAnchor(checkpointId, {
          tenantId: citation.anchor.tenantId,
          repository: citation.anchor.repository,
          sourceType: citation.anchor.sourceType,
          sourceId: citation.anchor.sourceId,
          ...(citation.anchor.commitSha === undefined ? {} : { commitSha: citation.anchor.commitSha }),
          ...(citation.anchor.pathOrUrl === undefined ? {} : { pathOrUrl: citation.anchor.pathOrUrl }),
          ...(citation.anchor.startLine === undefined ? {} : { startLine: citation.anchor.startLine }),
          ...(citation.anchor.endLine === undefined ? {} : { endLine: citation.anchor.endLine }),
          ...(citation.anchor.jsonPointer === undefined ? {} : { jsonPointer: citation.anchor.jsonPointer })
        });
        if (record?.anchor.contentDigest === citation.anchor.contentDigest) {
          aclMap.set(citation.id, record.aclFingerprint);
        }
      }
    }
    const knowledge = new CurrentKnowledgeProjector().project({
      generationId,
      projectedAt,
      revisions: eligibleRevisions,
      citations: citationMap,
      aclFingerprints: aclMap
    });
    // Raw repository files and provider observations are immutable evidence, not
    // context. They remain available to citation validation through the
    // checkpoint and manifest, but only citation-valid derived revisions enter
    // any public retrieval projection.
    const documents = knowledge.documents;
    const exactIndex = new ExactProjector().project(documents, this.store.nativeExactIndex ? ["metadata"] : undefined);
    const exactIndexInputFingerprint = fingerprint({
      projectorVersion: EXACT_PROJECTOR_VERSION,
      documents: documents
        .map((document) => ({
          id: document.id,
          title: document.title,
          sourceFingerprint: document.sourceFingerprint,
          metadataFingerprint: fingerprint(document.metadata)
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    });
    const fragments = new LexicalProjector().project(documents);
    const structuralRelations: GenerationProjection["structuralRelations"] = [];
    let hierarchyNodes: GenerationProjection["hierarchyNodes"] = [];
    let hierarchyStatus: ProjectorStatus = "disabled";
    const probe = await this.hierarchyIndexer.probe();
    if (probe.available) {
      try {
        const hierarchyDocuments = hierarchyEligibleDocuments(documents);
        const result = await this.hierarchyIndexer.build({
          tenantId: checkpoint.tenantId,
          repository: checkpoint.repository,
          ref: checkpoint.ref,
          commitSha: checkpoint.commitSha,
          generationId,
          adapterVersion: projectorVersions.hierarchy,
          documents: hierarchyDocuments.map((document) => ({
            id: document.id,
            title: document.title,
            body: document.body,
            anchors: document.anchors,
            aclFingerprint: document.effectiveAclFingerprint
          })),
          limits: { timeoutMs: 15_000, maxDocumentCharacters: 500_000, maxNodes: 10_000 }
        });
        hierarchyNodes = materializeHierarchyNodes(generationId, result);
        hierarchyStatus = "ready";
      } catch {
        hierarchyStatus = "failed";
      }
    }
    const completedProjectionInputFingerprint = await this.store.projectionInputFingerprint(
      checkpoint.tenantId,
      checkpoint.repository
    );
    if (completedProjectionInputFingerprint !== projectionInputFingerprint) {
      throw new Error(
        `Canonical projection inputs changed while indexing ${checkpoint.repository}; retry with a new generation`
      );
    }
    const projectorStatuses = initialStatuses();
    Object.assign(projectorStatuses, {
      manifest: "ready",
      "knowledge-current": eligibleRevisions.length > 0 ? "ready" : "skipped",
      lexical: "ready",
      dense: "disabled",
      hierarchy: hierarchyStatus,
      structural: "skipped",
      identity: "ready",
      acl: "ready",
      retention: "ready"
    });
    const projectionPayload = {
      manifest: manifestOutput.manifest,
      currentKnowledge: knowledge.selections,
      documents,
      fragments,
      exactIndex,
      hierarchyNodes,
      structuralRelations,
      projectorVersions,
      projectorStatuses,
      repositoryAccessFingerprint,
      projectionInputFingerprint
    };
    const generationFingerprint = fingerprint({
      checkpointId,
      manifest: projectionPayload.manifest,
      currentKnowledge: projectionPayload.currentKnowledge.map((selection) => ({
        logicalId: selection.logicalId,
        revisionId: selection.revisionId
      })),
      documents: projectionPayload.documents.map((document) => ({
        sourceFingerprint: document.sourceFingerprint,
        effectiveAclFingerprint: document.effectiveAclFingerprint
      })),
      fragments: projectionPayload.fragments.map((fragment) => ({
        sourceText: fragment.sourceText,
        tokenFingerprint: fragment.tokenFingerprint,
        anchors: fragment.anchors
      })),
      exactIndex: {
        projectorVersion: EXACT_PROJECTOR_VERSION,
        inputFingerprint: exactIndexInputFingerprint
      },
      hierarchyNodes: projectionPayload.hierarchyNodes.map((node) => ({
        title: node.title,
        summary: node.summary,
        anchors: node.anchors,
        adapterName: node.adapterName,
        adapterVersion: node.adapterVersion
      })),
      structuralRelations: projectionPayload.structuralRelations.map((relation) => ({
        kind: relation.kind,
        from: relation.from,
        to: relation.to,
        anchors: relation.anchors
      })),
      repositoryAccessFingerprint,
      projectionInputFingerprint,
      projectorVersions,
      projectorStatuses
    });
    const generation: IndexGeneration = {
      id: generationId,
      tenantId: checkpoint.tenantId,
      repository: checkpoint.repository,
      repositoryAccessFingerprint,
      projectionInputFingerprint,
      ref: checkpoint.ref,
      commitSha: checkpoint.commitSha,
      checkpointId,
      status: "published",
      projectorVersions,
      projectorStatuses,
      capabilities: {
        sourceCompleteness: checkpoint.sourceCompleteness,
        derivedKnowledge:
          eligibleRevisions.length === 0
            ? "unavailable"
            : releaseMode === "partial"
              ? "partial"
              : new Set(eligibleRevisions.map((revision) => revision.logicalId)).size === scopedLogicalIds.size
                ? "available"
                : "partial",
        dense: "disabled",
        hierarchy: hierarchyStatus === "ready" ? "available" : hierarchyStatus === "failed" ? "failed" : "disabled"
      },
      fingerprint: generationFingerprint,
      createdAt: projectedAt,
      publishedAt: projectedAt
    };
    return this.store.publish({
      generation,
      manifest: projectionPayload.manifest,
      currentKnowledge: projectionPayload.currentKnowledge,
      documents: projectionPayload.documents,
      fragments: projectionPayload.fragments,
      exactIndex: projectionPayload.exactIndex,
      hierarchyNodes: projectionPayload.hierarchyNodes,
      structuralRelations: projectionPayload.structuralRelations
    });
  }
}
