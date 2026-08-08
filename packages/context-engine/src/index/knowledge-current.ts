import { fingerprint, stableId } from "../domain/fingerprint.js";
import type { KnowledgeDocumentRevision, KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import type { ContextDocument, CurrentKnowledgeRevision } from "../domain/projection.js";

export class CurrentKnowledgeBuilder {
  project(input: {
    generationId: string;
    revisions: KnowledgeDocumentRevision[];
    citations: Map<string, KnowledgeEvidenceCitation[]>;
    aclFingerprints: Map<string, string>;
  }): { selections: CurrentKnowledgeRevision[]; documents: ContextDocument[] } {
    const selections: CurrentKnowledgeRevision[] = [];
    const documents: ContextDocument[] = [];
    for (const revision of input.revisions) {
      const citations = input.citations.get(revision.id) ?? [];
      if (citations.length === 0) throw new Error(`Knowledge revision ${revision.id} has no source citations`);
      const requiredAcls = [
        ...new Set(
          citations
            .map((citation) => input.aclFingerprints.get(citation.id))
            .filter((value): value is string => value !== undefined)
        )
      ].sort();
      if (requiredAcls.length === 0) throw new Error(`Knowledge revision ${revision.id} has unresolved ACLs`);
      selections.push({
        generationId: input.generationId,
        tenantId: revision.tenantId,
        repository: revision.repository,
        logicalId: revision.logicalId,
        revisionId: revision.id,
        selectionReason: "latest eligible immutable revision"
      });
      documents.push({
        id: stableId("cd", { generationId: input.generationId, revisionId: revision.id }),
        generationId: input.generationId,
        tenantId: revision.tenantId,
        repository: revision.repository,
        ref: revision.scope.ref,
        commitSha: revision.scope.commitSha,
        sourceKind: "knowledge",
        sourceId: revision.logicalId,
        sourceRevisionId: revision.id,
        knowledgeKind: revision.kind,
        title: revision.title,
        body: revision.bodyMarkdown,
        contextualText: [
          revision.summary,
          JSON.stringify(revision.structuredSummary),
          revision.scope.paths.join(" "),
          revision.scope.symbols.join(" "),
          revision.scope.pullRequests.join(" "),
          revision.scope.issues.join(" ")
        ].join("\n"),
        metadata: {
          logicalId: revision.logicalId,
          confidence: revision.confidence,
          generatorName: revision.generatorName,
          generatorVersion: revision.generatorVersion,
          structuredSummary: revision.structuredSummary,
          ...(typeof revision.structuredSummary.claimSubject === "string"
            ? { claimSubject: revision.structuredSummary.claimSubject }
            : {}),
          ...(typeof revision.structuredSummary.claimValue === "string"
            ? { claimValue: revision.structuredSummary.claimValue }
            : {}),
          requiredAclFingerprints: requiredAcls
        },
        authorityClass: "generated_interpretation",
        effectiveAclFingerprint: requiredAcls.length === 1 ? requiredAcls[0]! : fingerprint(requiredAcls),
        sourceFingerprint: fingerprint({
          revisionId: revision.id,
          bodyDigest: revision.bodyDigest,
          evidenceFingerprint: revision.evidenceFingerprint
        }),
        anchors: citations.map((citation) => citation.anchor)
      });
    }
    return { selections, documents };
  }
}
