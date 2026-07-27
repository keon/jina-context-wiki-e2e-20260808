import { fingerprint, stableId } from "../../domain/fingerprint.js";
import type { RetrievalCandidate } from "../../domain/query.js";
import type { ContextRetriever, RetrieverInput } from "./common.js";
import { aclAllows, exactTerms, overlapScore } from "./common.js";

export class StructuralRetriever implements ContextRetriever {
  readonly route = "structural" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    const exact = exactTerms(input.plan).map((value) => value.toLowerCase());
    const allowedSources = new Set(
      input.projection.documents
        .filter((document) => aclAllows(document, input.allowedAclFingerprints))
        .flatMap((document) =>
          document.anchors.map((anchor) => `${anchor.sourceType}\u0000${anchor.sourceId}\u0000${anchor.contentDigest}`)
        )
    );
    return input.projection.structuralRelations
      .filter((relation) =>
        relation.anchors.every((anchor) =>
          allowedSources.has(`${anchor.sourceType}\u0000${anchor.sourceId}\u0000${anchor.contentDigest}`)
        )
      )
      .map((relation) => {
        const text = `${relation.kind} ${relation.from} ${relation.to}`;
        const exactMatch = exact.some((term) => text.toLowerCase().includes(term));
        return { relation, exactMatch, score: exactMatch ? 1 : overlapScore(input.plan.normalizedQuestion, text) };
      })
      .filter(({ score }) => score > 0)
      .map(({ relation, exactMatch, score }): RetrievalCandidate => ({
        id: stableId("rc", { route: this.route, relationId: relation.id }),
        retriever: this.route,
        sourceKind: "structure",
        sourceId: relation.id,
        title: `${relation.from} ${relation.kind} ${relation.to}`,
        excerpt: `${relation.from} ${relation.kind} ${relation.to}`,
        contextualText: "",
        anchors: relation.anchors,
        rawScore: score,
        scoreSemantics: "deterministic relation token overlap",
        exactMatch,
        authorityClass: "deterministic_analysis",
        effectiveAclFingerprint: "",
        contentFingerprint: fingerprint(relation),
        explanation: `parser-derived ${relation.kind} relation`,
        metadata: relation.metadata
      }))
      .sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}
