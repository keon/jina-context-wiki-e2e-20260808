import { tags, task } from "@trigger.dev/sdk";

import { runReviewRuntimeStage } from "../review/runtime-stage.js";
import { stageTags, type ReviewStagePayload, type ReviewStageResult } from "../review/workflow.js";

export const reviewRuntime = task({
  id: "review-runtime",
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
    await tags.add(stageTags(payload, "runtime")).catch(() => undefined);
    return runReviewRuntimeStage(payload, ctx.run.id);
  },
});
