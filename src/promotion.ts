export interface PromotionGate {
  readonly environment: "staging" | "production";
  readonly wikiReady: boolean;
  readonly causalGraphReady: boolean;
  readonly reviewReady: boolean;
}

export function canPromote(gate: PromotionGate): boolean {
  return gate.wikiReady && gate.causalGraphReady && gate.reviewReady;
}
