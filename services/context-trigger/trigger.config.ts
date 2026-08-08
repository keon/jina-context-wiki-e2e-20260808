import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

import { resolveSyncedEnvVars } from "./src/shared/env.js";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_context_wiki",
  dirs: ["./src/trigger"],
  build: {
    extensions: [syncEnvVars(({ env }) => resolveSyncedEnvVars({ manifestEnv: env }))]
  },
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true
    }
  },
  maxDuration: 3_600
});
