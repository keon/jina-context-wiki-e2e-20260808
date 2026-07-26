import type { EvidencePack, SynthesisOutput } from "../domain/query.js";

export interface CitationVerificationResult {
  valid: boolean;
  errors: string[];
}

export function verifySynthesisCitations(output: SynthesisOutput, evidence: EvidencePack): CitationVerificationResult {
  const allowed = new Map(evidence.items.map((item) => [item.citationId, item]));
  const errors: string[] = [];
  if (output.answer.trim() === "") errors.push("answer is empty");
  for (const [index, claim] of output.claims.entries()) {
    if (claim.text.trim() === "") errors.push(`claim ${index} is empty`);
    if (!output.answer.includes(claim.text)) errors.push(`claim ${index} is not present in the answer`);
    if (claim.citationIds.length === 0) errors.push(`claim ${index} has no citation`);
    for (const citationId of claim.citationIds) {
      const item = allowed.get(citationId);
      if (item === undefined) {
        errors.push(`claim ${index} references an unknown citation`);
      } else if (
        item.candidate.anchors.length === 0 ||
        item.candidate.anchors.some((anchor) => !/^[0-9a-f]{64}$/i.test(anchor.contentDigest))
      ) {
        errors.push(`claim ${index} references an invalid source anchor`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
