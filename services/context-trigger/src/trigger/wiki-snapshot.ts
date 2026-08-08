import { task } from "@trigger.dev/sdk";

import type { WikiStageTaskPayload } from "../shared/contracts.js";
import { runContextWikiStage } from "../workflow/stage.js";

export const wikiSnapshot = task({
  id: "wiki-snapshot",
  queue: { concurrencyLimit: 10 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, randomize: true },
  machine: { preset: "small-1x" },
  maxDuration: 1_800,
  run: async (payload: WikiStageTaskPayload) => runContextWikiStage("snapshot", payload)
});
