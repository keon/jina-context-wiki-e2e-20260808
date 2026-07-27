import { fingerprint } from "../../domain/fingerprint.js";
import type { RetrievalCandidate } from "../../domain/query.js";
import type { DenseSearchPort, EmbeddingProvider } from "../../ports/embeddings.js";
import { aclAllows, documentCandidate } from "./common.js";
import type { ContextRetriever, RetrieverInput } from "./common.js";

export class DenseRetriever implements ContextRetriever {
  readonly route = "dense" as const;

  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly search: DenseSearchPort
  ) {}

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    const [query] = await this.embeddings.embed([
      {
        id: "query",
        text: input.plan.normalizedQuestion,
        inputFingerprint: fingerprint(input.plan.normalizedQuestion)
      }
    ]);
    if (!query) return [];
    const matches = await this.search.search({
      tenantId: input.projection.generation.tenantId,
      repository: input.projection.generation.repository,
      generationId: input.projection.generation.id,
      model: query.model,
      vector: query.vector,
      allowedAclFingerprints: [...input.allowedAclFingerprints],
      limit: input.limit
    });
    const fragments = new Map(input.projection.fragments.map((fragment) => [fragment.id, fragment]));
    const documents = new Map(input.projection.documents.map((document) => [document.id, document]));
    return matches.flatMap((match) => {
      const fragment = fragments.get(match.fragmentId);
      const document = documents.get(match.documentId);
      if (!fragment || !document || !aclAllows(document, input.allowedAclFingerprints)) return [];
      return [
        documentCandidate(
          document,
          this.route,
          fragment.sourceText,
          match.score,
          false,
          `dense similarity using ${query.model}`
        )
      ];
    });
  }
}
