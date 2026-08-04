export const DAYTONA_WORKER_SOURCE_FILES = [
  {
    name: "codex-review.ts",
    sourcePath: "./src/review/codex-review.ts",
    modulePath: "../review/codex-review.ts",
    remotePath: "review/codex-review.ts"
  },
  {
    name: "jina-instructions.ts",
    sourcePath: "./src/review/jina-instructions.ts",
    modulePath: "../review/jina-instructions.ts",
    remotePath: "review/jina-instructions.ts"
  },
  {
    name: "runtime-review.ts",
    sourcePath: "./src/runtime-review/index.ts",
    modulePath: "../runtime-review/index.ts",
    remotePath: "runtime-review/index.ts"
  },
  {
    name: "openrouter-proxy.ts",
    sourcePath: "./src/daytona/openrouter-proxy.ts",
    modulePath: "./openrouter-proxy.ts",
    remotePath: "daytona/openrouter-proxy.ts"
  },
  {
    name: "utils.ts",
    sourcePath: "./src/shared/utils.ts",
    modulePath: "../shared/utils.ts",
    remotePath: "shared/utils.ts"
  }
] as const;

export type DaytonaWorkerSourceName = (typeof DAYTONA_WORKER_SOURCE_FILES)[number]["name"];
