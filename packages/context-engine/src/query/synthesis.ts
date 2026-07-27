import type { ContextSynthesizer } from "../ports/synthesizer.js";

export class ExtractiveContextSynthesizer implements ContextSynthesizer {
  async synthesize(input: Parameters<ContextSynthesizer["synthesize"]>[0]) {
    if (input.evidence.items.length === 0) {
      return {
        answer: "I could not find accessible evidence for this question.",
        claims: [],
        ambiguities: [],
        missing: ["supporting evidence"]
      };
    }
    const selected = input.evidence.items.slice(0, 5);
    const claims = selected.map((item) => ({
      text: `${item.title}: ${item.sourceText.replace(/\s+/g, " ").trim().slice(0, 320)}`,
      citationIds: [item.citationId]
    }));
    return {
      answer: claims.map((claim) => `${claim.text} [${claim.citationIds[0]}]`).join("\n\n"),
      claims,
      ambiguities: input.conflicts,
      missing: []
    };
  }
}
