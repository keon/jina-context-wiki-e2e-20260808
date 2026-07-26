import { stableId } from "../domain/fingerprint.js";
import type { EvidencePack } from "../domain/query.js";
import type { FusedCandidate } from "./fusion.js";

export function assembleEvidencePack(
  candidates: FusedCandidate[],
  limits: { maxCharacters: number; maxItems: number } = { maxCharacters: 24_000, maxItems: 16 }
): EvidencePack {
  const items: EvidencePack["items"] = [];
  const omittedCandidateIds: string[] = [];
  let characterCount = 0;
  for (const { candidate } of candidates) {
    if (items.length >= limits.maxItems || characterCount >= limits.maxCharacters) {
      omittedCandidateIds.push(candidate.id);
      continue;
    }
    const remaining = limits.maxCharacters - characterCount;
    const sourceText = candidate.excerpt.slice(0, remaining);
    if (sourceText.length === 0) {
      omittedCandidateIds.push(candidate.id);
      continue;
    }
    items.push({
      citationId: stableId("cite", { candidateId: candidate.id, sourceText }),
      title: candidate.title,
      sourceText,
      contextualText: candidate.contextualText,
      candidate
    });
    characterCount += sourceText.length;
  }
  return { items, omittedCandidateIds, characterCount };
}
