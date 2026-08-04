import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles, additionalPackages, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { DAYTONA_WORKER_SOURCE_FILES } from "./src/daytona/worker-manifest.js";

const syncedEnvVars = [
  "API_BASE_URL",
  "CODEGRAPH_TIMEOUT_MS",
  "CODEX_REVIEW_TIMEOUT_MS",
  "DASHBOARD_URL",
  "DAYTONA_API_KEY",
  "DAYTONA_RUN_TIMEOUT_SECONDS",
  "DAYTONA_SETUP_TIMEOUT_SECONDS",
  "DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_SANDBOX_IMAGE",
  "DAYTONA_SANDBOX_CPU",
  "DAYTONA_SANDBOX_MEMORY",
  "DAYTONA_SANDBOX_DISK",
  "DAYTONA_SKIP_INSTALL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLONE_TOKEN",
  "INTERNAL_API_TOKEN",
  "JINA_GRAPH_MCP_ENABLED",
  // OPENAI_API_KEY is OPTIONAL (unlike the required OPENROUTER_API_KEY): when set it
  // enables the capture proxy's native route for managed openai/* reviews. Absent =>
  // not synced (the resolver drops empty non-daytona/non-clearable vars).
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_APP_TITLE",
  "OPENROUTER_APP_URL",
  "REVIEW_CODEX_MODEL",
  "REVIEW_CODEX_EFFORT",
  "RUNTIME_PLANNER_MODEL",
  "RUNTIME_AGENT_MODEL",
  "RUNTIME_MENTAL_TRACE_MODEL",
] as const;

const daytonaRuntimeEnvVars = new Set<string>([
  "DAYTONA_SNAPSHOT",
  "DAYTONA_SANDBOX_IMAGE",
  "DAYTONA_SANDBOX_CPU",
  "DAYTONA_SANDBOX_MEMORY",
  "DAYTONA_SANDBOX_DISK",
  "DAYTONA_SKIP_INSTALL",
  "DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS",
]);

const clearableRuntimeEnvVars = new Set<string>([
  "CODEGRAPH_TIMEOUT_MS",
  "CODEX_REVIEW_TIMEOUT_MS",
  "DASHBOARD_URL",
  "GITHUB_CLONE_TOKEN",
  "REVIEW_CODEX_MODEL",
  "REVIEW_CODEX_EFFORT",
  "RUNTIME_PLANNER_MODEL",
  "RUNTIME_AGENT_MODEL",
  "RUNTIME_MENTAL_TRACE_MODEL",
]);

const DEFAULT_DAYTONA_SANDBOX_IMAGE = "node:22-bookworm";
const DEFAULT_DAYTONA_SANDBOX_CPU = "4";
const DEFAULT_DAYTONA_SANDBOX_MEMORY = "8";
const DEFAULT_DAYTONA_SANDBOX_DISK = "10";

export function resolveSyncedEnvVars(input: {
  env: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const processEnv = input.processEnv ?? process.env;
  const resolved: Record<string, string> = {};
  for (const name of syncedEnvVars) {
    const value = resolveSyncedEnvVar(name, input.env, processEnv);
    if (
      typeof value === "string" &&
      (value.length > 0 || daytonaRuntimeEnvVars.has(name) || clearableRuntimeEnvVars.has(name))
    ) {
      resolved[name] = value;
    }
  }
  return resolved;
}

function resolveSyncedEnvVar(
  name: (typeof syncedEnvVars)[number],
  manifestEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): string | undefined {
  if (clearableRuntimeEnvVars.has(name)) {
    return Object.hasOwn(processEnv, name) ? processEnv[name] ?? "" : "";
  }

  if (!daytonaRuntimeEnvVars.has(name)) {
    return Object.hasOwn(processEnv, name) ? processEnv[name] : manifestEnv[name];
  }

  if (name === "DAYTONA_SANDBOX_IMAGE") {
    return processEnv.DAYTONA_SANDBOX_IMAGE?.trim() || DEFAULT_DAYTONA_SANDBOX_IMAGE;
  }
  if (name === "DAYTONA_SANDBOX_CPU") {
    return boundedResourceEnv(processEnv.DAYTONA_SANDBOX_CPU, DEFAULT_DAYTONA_SANDBOX_CPU);
  }
  if (name === "DAYTONA_SANDBOX_MEMORY") {
    return boundedResourceEnv(processEnv.DAYTONA_SANDBOX_MEMORY, DEFAULT_DAYTONA_SANDBOX_MEMORY);
  }
  if (name === "DAYTONA_SANDBOX_DISK") {
    return boundedResourceEnv(processEnv.DAYTONA_SANDBOX_DISK, DEFAULT_DAYTONA_SANDBOX_DISK);
  }

  return Object.hasOwn(processEnv, name) ? processEnv[name] ?? "" : "";
}

function boundedResourceEnv(raw: string | undefined, max: string): string {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return max;
  }
  return String(Math.min(parsed, Number.parseInt(max, 10)));
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me",
  dirs: ["./src/trigger"],
  build: {
    extensions: [
      additionalPackages({
        packages: ["busboy"],
      }),
      additionalFiles({
        // Raw worker-source files read at runtime (workerSource() in review-session.ts) and uploaded
        // INTO the Daytona sandbox. Every path passed to workerSource() MUST be listed here or the
        // deployed worker throws "Unable to load Daytona worker source ..." and every review fails.
        files: [
          ...DAYTONA_WORKER_SOURCE_FILES.map((file) => file.sourcePath),
          "./src/runtime-review/github.ts",
        ],
      }),
      syncEnvVars(({ env }) => resolveSyncedEnvVars({ env })),
    ],
  },
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  maxDuration: 3_600,
});
