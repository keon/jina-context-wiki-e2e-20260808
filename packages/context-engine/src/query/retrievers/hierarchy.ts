import type { RetrievalCandidate } from "../../domain/query.js";
import type { ContextRetriever, RetrieverInput } from "./common.js";
import { aclAllows, documentCandidate, overlapScore } from "./common.js";

export class HierarchyIndexRetriever implements ContextRetriever {
  readonly route = "hierarchy" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    const documents = new Map(
      input.projection.documents
        .filter((document) => aclAllows(document, input.allowedAclFingerprints))
        .map((document) => [document.id, document])
    );
    return input.projection.hierarchyNodes
      .map((node) => ({
        node,
        document: documents.get(node.documentId),
        score: overlapScore(input.plan.normalizedQuestion, `${node.title} ${node.summary}`)
      }))
      .filter(
        (value): value is typeof value & { document: NonNullable<typeof value.document> } =>
          value.document !== undefined && value.score > 0
      )
      .map(({ node, document, score }) =>
        documentCandidate(
          { ...document, anchors: node.anchors },
          this.route,
          node.summary,
          score,
          false,
          `matched hierarchy section ${node.title}`
        )
      )
      .sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}
