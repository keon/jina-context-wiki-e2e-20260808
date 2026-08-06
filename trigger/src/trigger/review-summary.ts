import { tags, task } from "@trigger.dev/sdk";

import { runReviewSummaryStage } from "../review/summary-stage.js";
import { stageTags, type ReviewStagePayload, type ReviewStageResult } from "../review/workflow.js";

export const reviewSummary = task({
  id: "review-summary",
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
  machine: {
    preset: "small-1x",
  },
  maxDuration: 3_600,
  run: async (payload: ReviewStagePayload, { ctx }): Promise<ReviewStageResult> => {
    await tags.add(stageTags(payload, "summary")).catch(() => undefined);
    return runReviewSummaryStage(payload, ctx.run.id);
  },
});
