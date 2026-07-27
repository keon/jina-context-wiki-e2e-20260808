import type { RetrievalCandidate } from "../domain/query.js";

export interface FusedCandidate {
  candidate: RetrievalCandidate;
  score: number;
  contributions: { retriever: string; rank: number; contribution: number }[];
}

export function fuseRetrievalCandidates(
  candidateLists: RetrievalCandidate[][],
  limit = 20,
  rankConstant = 60
): FusedCandidate[] {
  const fused = new Map<string, FusedCandidate>();
  const sortedLists = [...candidateLists].sort((left, right) =>
    (left[0]?.retriever ?? "").localeCompare(right[0]?.retriever ?? "")
  );
  for (const candidates of sortedLists) {
    const stable = [...candidates].sort(
      (left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id)
    );
    stable.forEach((candidate, index) => {
      const dedupeKey = `${candidate.sourceId}\u0000${candidate.sourceRevisionId ?? ""}\u0000${candidate.contentFingerprint}`;
      const rank = index + 1;
      const exactBoost = candidate.exactMatch ? 0.25 : 0;
      const authorityBoost =
        candidate.authorityClass === "source_code" || candidate.authorityClass === "provider_state" ? 0.05 : 0;
      const contribution = 1 / (rankConstant + rank) + exactBoost + authorityBoost;
      const existing = fused.get(dedupeKey);
      if (existing === undefined) {
        fused.set(dedupeKey, {
          candidate,
          score: contribution,
          contributions: [{ retriever: candidate.retriever, rank, contribution }]
        });
      } else {
        existing.score += contribution;
        existing.contributions.push({ retriever: candidate.retriever, rank, contribution });
        if (candidate.exactMatch && !existing.candidate.exactMatch) existing.candidate = candidate;
      }
    });
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
    .slice(0, limit);
}
