import { fingerprint, normalizeIsoTime, stableId } from "../domain/fingerprint.js";
import type {
  ContextDocument,
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
import { ExactProjector } from "./exact.js";
import { ManifestProjector } from "./manifest.js";
import { StructuralProjector } from "./structural.js";
import type { ContextWriteFence } from "../workflow/coordinator.js";

export const INDEX_COORDINATOR_VERSION = "context-index-v1";

function versions(): Record<ContextProjectionConsumer, string> {
  return {
    manifest: "manifest-v1",
    "knowledge-current": "knowledge-current-v1",
    lexical: "lexical-v1",
    dense: "disabled-v1",
    hierarchy: "hierarchy-v1",
    structural: "structural-v1",
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

  async index(checkpointId: string, createdAt: string, fence?: ContextWriteFence): Promise<IndexGeneration> {
    const checkpoint = await this.store.getCheckpoint(checkpointId);
    if (checkpoint === undefined) throw new Error("Unknown evidence checkpoint");
    const projectionInputFingerprint = await this.store.projectionInputFingerprint(
      checkpoint.tenantId,
      checkpoint.repository
    );
    const projectedAt = normalizeIsoTime(createdAt);
    const projectorVersions = versions();
    const eligibleRevisions = (
      await this.store.listCurrentEligibleRevisions(checkpoint.tenantId, checkpoint.repository)
    ).filter((revision) => revision.scope.ref === checkpoint.ref && revision.scope.commitSha === checkpoint.commitSha);
    const evidence = await this.store.listEvidence(checkpointId);
    const manifest = await this.store.listManifest(checkpointId);
    const structuralFacts = await this.store.listStructuralFacts(checkpointId);
    const allRevisions = await this.store.listRevisions(checkpoint.tenantId, checkpoint.repository);
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
      structuralFactIds: structuralFacts.map((fact) => fact.id).sort(),
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
    const providerDocuments: ContextDocument[] = evidence
      .filter((record) => record.anchor.sourceType !== "blob")
      .map((record) => ({
        id: stableId("cd", { generationId, sourceId: record.id }),
        generationId,
        tenantId: checkpoint.tenantId,
        repository: checkpoint.repository,
        ref: checkpoint.ref,
        commitSha: checkpoint.commitSha,
        sourceKind: "provider",
        sourceId: record.id,
        title: record.title,
        body: record.body,
        contextualText: `${record.anchor.sourceType} ${record.title}`,
        metadata: record.metadata,
        authorityClass: record.authorityClass,
        effectiveAclFingerprint: record.aclFingerprint,
        sourceFingerprint: fingerprint({ anchor: record.anchor, body: record.body }),
        anchors: [record.anchor],
        projectorName: "manifest",
        projectorVersion: "manifest-v1",
        projectedAt
      }));
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
        if (record !== undefined) aclMap.set(citation.id, record.aclFingerprint);
      }
    }
    const knowledge = new CurrentKnowledgeProjector().project({
      generationId,
      projectedAt,
      revisions: eligibleRevisions,
      citations: citationMap,
      aclFingerprints: aclMap
    });
    const documents = [...manifestOutput.documents, ...providerDocuments, ...knowledge.documents];
    const exactIndex = new ExactProjector().project(documents);
    const fragments = new LexicalProjector().project(documents);
    const structuralRelations = new StructuralProjector().project(generationId, structuralFacts);
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
      structural: "ready",
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
      exactIndex: projectionPayload.exactIndex,
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
            : eligibleRevisions.length === allRevisions.length
              ? "available"
              : "partial",
        dense: "disabled",
        hierarchy: hierarchyStatus === "ready" ? "available" : hierarchyStatus === "failed" ? "failed" : "disabled"
      },
      fingerprint: generationFingerprint,
      createdAt: projectedAt,
      publishedAt: projectedAt
    };
    return this.store.publish(
      {
        generation,
        manifest: projectionPayload.manifest,
        currentKnowledge: projectionPayload.currentKnowledge,
        documents: projectionPayload.documents,
        fragments: projectionPayload.fragments,
        exactIndex: projectionPayload.exactIndex,
        hierarchyNodes: projectionPayload.hierarchyNodes,
        structuralRelations: projectionPayload.structuralRelations
      },
      fence
    );
  }
}
