import { CodexCliReviewHarness } from "./codex-harness.js";
import { OpenRouterReviewHarness } from "./openrouter-harness.js";

export type HarnessType = "openrouter-chat" | "codex-cli";

type ReviewSeverity = "low" | "medium" | "high" | "critical";

export interface ReviewFinding {
  readonly title: string;
  readonly body: string;
  readonly severity: ReviewSeverity;
  readonly confidence: number;
  readonly filePath: string;
  readonly lineStart: number;
  readonly category: string;
}

export interface HarnessStep {
  readonly seq: number;
  readonly type: "model_call" | "tool_call" | "note";
  readonly detail: string;
  readonly model?: string;
}

export interface ModelUsageRecord {
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly requestSeq: number;
  readonly dedupeKey: string;
  readonly generationId?: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd?: number;
  readonly raw: unknown;
}

export interface ReviewRequest {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly title: string;
  readonly diff: string;
  readonly model?: string;
}

export interface ReviewResult {
  readonly harnessType: HarnessType;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly steps: readonly HarnessStep[];
  readonly usage: readonly ModelUsageRecord[];
}

export interface ReviewHarness {
  readonly type: HarnessType;
  review(request: ReviewRequest): Promise<ReviewResult>;
}

export function createReviewHarness(type: HarnessType): ReviewHarness {
  switch (type) {
    case "openrouter-chat":
      return new OpenRouterReviewHarness();
    case "codex-cli":
      return new CodexCliReviewHarness();
  }
}

export function isHarnessType(value: string): value is HarnessType {
  return value === "openrouter-chat" || value === "codex-cli";
}
