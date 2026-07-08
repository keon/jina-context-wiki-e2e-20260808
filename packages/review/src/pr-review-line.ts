export type ReviewDecision =
  | { readonly type: "complete_review"; readonly findingCount: number }
  | { readonly type: "request_context"; readonly question: string; readonly sources: readonly string[] }
  | { readonly type: "fail_review"; readonly reason: string };

export function completeReview(findingCount: number): ReviewDecision {
  return { type: "complete_review", findingCount };
}

export function requestReviewContext(question: string, sources: readonly string[]): ReviewDecision {
  return { type: "request_context", question, sources };
}

