import type { RetrievalCandidate } from "../../domain/query.js";
import type { ContextRetriever, RetrieverInput } from "./common.js";
import { aclAllows, documentCandidate, exactTerms, matchesExplicitCodeTargets, overlapScore } from "./common.js";

export class ExactRetriever implements ContextRetriever {
  readonly route = "exact" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    const terms = exactTerms(input.plan);
    const matchedDocuments = new Map<string, string[]>();
    for (const term of terms) {
      const normalized = term.toLowerCase();
      for (const entry of input.projection.exactIndex) {
        if (entry.term !== normalized) continue;
        const values = matchedDocuments.get(entry.documentId) ?? [];
        values.push(term);
        matchedDocuments.set(entry.documentId, values);
      }
    }
    return input.projection.documents
      .filter(
        (document) =>
          aclAllows(document, input.allowedAclFingerprints) && matchesExplicitCodeTargets(document, input.plan)
      )
      .map((document) => ({ document, matched: [...new Set(matchedDocuments.get(document.id) ?? [])] }))
      .filter(({ matched }) => matched.length > 0)
      .map(({ document, matched }) =>
        documentCandidate(
          document,
          this.route,
          document.body.slice(0, 1_600),
          matched.length,
          true,
          `matched exact terms: ${matched.join(", ")}`
        )
      )
      .sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}

export class LexicalRetriever implements ContextRetriever {
  readonly route = "lexical" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    const documents = new Map(
      input.projection.documents
        .filter(
          (document) =>
            aclAllows(document, input.allowedAclFingerprints) && matchesExplicitCodeTargets(document, input.plan)
        )
        .map((document) => [document.id, document])
    );
    return input.projection.fragments
      .map((fragment) => {
        const document = documents.get(fragment.documentId);
        const score =
          document === undefined
            ? 0
            : overlapScore(
                input.plan.normalizedQuestion,
                `${document.title}\n${fragment.contextualText}\n${fragment.sourceText}`
              );
        return { fragment, document, score };
      })
      .filter(
        (value): value is typeof value & { document: NonNullable<typeof value.document> } =>
          value.document !== undefined && value.score > 0
      )
      .map(({ fragment, document, score }) =>
        documentCandidate(
          document,
          this.route,
          fragment.sourceText,
          score,
          false,
          "query token overlap in source fragment"
        )
      )
      .sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}

export class StructuredRetriever implements ContextRetriever {
  readonly route = "structured" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    const targets = [
      ...(input.plan.targets.pullRequests ?? []),
      ...(input.plan.targets.issues ?? []),
      ...[...input.plan.normalizedQuestion.matchAll(/#[1-9][0-9]*/g)].map((match) => match[0])
    ].map((target) => target.toLowerCase());
    if (
      targets.length === 0 &&
      ((input.plan.targets.paths?.length ?? 0) > 0 || (input.plan.targets.symbols?.length ?? 0) > 0)
    ) {
      return [];
    }
    return input.projection.documents
      .filter(
        (document) =>
          document.sourceKind === "provider" &&
          aclAllows(document, input.allowedAclFingerprints) &&
          (targets.length === 0 ||
            targets.some((target) =>
              `${document.title}\n${document.sourceId}\n${document.body}`.toLowerCase().includes(target)
            ))
      )
      .map((document) =>
        documentCandidate(
          document,
          this.route,
          document.body.slice(0, 1_600),
          1,
          targets.length > 0,
          "canonical provider record"
        )
      )
      .slice(0, input.limit);
  }
}

export class KnowledgeRetriever implements ContextRetriever {
  readonly route = "knowledge" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    return input.projection.documents
      .filter((document) => document.sourceKind === "knowledge" && aclAllows(document, input.allowedAclFingerprints))
      .map((document) => ({
        document,
        score: overlapScore(
          input.plan.normalizedQuestion,
          `${document.title}\n${document.contextualText}\n${document.body}`
        )
      }))
      .filter(({ score }) => score > 0)
      .map(({ document, score }) =>
        documentCandidate(
          document,
          this.route,
          document.body.slice(0, 2_400),
          score,
          false,
          "current eligible knowledge revision"
        )
      )
      .sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}

export class TemporalRetriever implements ContextRetriever {
  readonly route = "temporal" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    return input.projection.documents
      .filter(
        (document) =>
          aclAllows(document, input.allowedAclFingerprints) &&
          (document.sourceKind === "provider" || document.knowledgeKind === "change_summary") &&
          withinTimeWindow(document.anchors, input.plan.timeWindow)
      )
      .map((document) => ({
        document,
        score: overlapScore(input.plan.normalizedQuestion, `${document.title}\n${document.body}`)
      }))
      .filter(({ score }) => score > 0)
      .map(({ document, score }) =>
        documentCandidate(
          document,
          this.route,
          document.body.slice(0, 1_600),
          score,
          false,
          "time-relevant provider or change source"
        )
      )
      .sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}

export class LongContextRetriever implements ContextRetriever {
  readonly route = "long_context" as const;

  async retrieve(input: RetrieverInput): Promise<RetrievalCandidate[]> {
    return input.projection.documents
      .filter((document) => document.body.length >= 16_000 && aclAllows(document, input.allowedAclFingerprints))
      .map((document) => {
        const score = overlapScore(
          input.plan.normalizedQuestion,
          `${document.title}\n${document.contextualText}\n${document.body}`
        );
        return { document, score };
      })
      .filter(({ score }) => score > 0)
      .map(({ document, score }) =>
        documentCandidate(
          document,
          this.route,
          document.body.slice(0, 12_000),
          score,
          false,
          "bounded long-context source window"
        )
      )
      .sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }
}

function withinTimeWindow(
  anchors: readonly { observedAt?: string }[],
  window: { from?: string; to?: string } | undefined
): boolean {
  if (!window?.from && !window?.to) return true;
  const observed = anchors.map((anchor) => anchor.observedAt).filter((value): value is string => Boolean(value));
  if (observed.length === 0) return false;
  return observed.some((value) => (!window.from || value >= window.from) && (!window.to || value <= window.to));
}
