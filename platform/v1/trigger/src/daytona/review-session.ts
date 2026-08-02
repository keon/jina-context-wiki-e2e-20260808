import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "@trigger.dev/sdk";
import { Daytona, type Resources, type Sandbox } from "@daytona/sdk";

import type {
  CodegraphReviewContextResult,
  PullRequestReviewInput,
} from "../review/codex-review.js";
import type { OpenaiModelPrice } from "./openrouter-proxy.js";
import type { RuntimeReviewInput, RuntimeReviewResult } from "../runtime-review/index.js";
import type { ContextGraphMcpAccess } from "../shared/jina-graph.js";
import {
  errorMessage,
  reviewCodexModel,
  runtimeAgentModel,
  runtimeMentalTraceModel,
  runtimePlannerModel,
  WORKER_WARNING_PREFIX,
} from "../shared/utils.js";
import { DAYTONA_WORKER_SOURCE_FILES, type DaytonaWorkerSourceName } from "./worker-manifest.js";

export type DaytonaStageResult<T> = {
  result: T;
  sandboxId: string;
};

export type WorkerWarning = {
  event: string;
  label?: string;
  path?: string;
  code?: string;
  message?: string;
  maxRetries?: number;
  retryDelay?: number;
  [key: string]: unknown;
};

/** Provider keys resolved for a run. `openrouter` is the model gateway key.
 *  `codexHarnessAuth` is the raw auth.json blob for a ChatGPT-subscription Codex
 *  harness: when present the review runs Codex NATIVELY on the author's
 *  subscription (no OpenRouter, no capture proxy) and the tenant is billed
 *  infra-only. `source` records which key was actually loaded into the sandbox so
 *  billing can attribute it per usage row. */
export type ProviderKeys = {
  openrouter?: string;
  /** Tenant BYOK native OpenAI key. When present (no harness), openai/* review models route NATIVELY to
   *  api.openai.com under this key via the capture proxy — a BYOK "user" run, billed infra-only. */
  openaiApiKey?: string;
  codexHarnessAuth?: string;
  /** Revision of the exact harness credential loaded into this run's sandbox. */
  codexHarnessConnectedAtMs?: number;
  /** Per-model OpenAI pricing (exact decimal per-token strings) keyed by the
   *  `openai/<model>` slug, supplied by the API's /internal/integrations/resolve.
   *  Threaded into the sandbox as JINA_OPENAI_MODEL_PRICING so the capture proxy can
   *  compute native-route cost. Only meaningful on managed runs (the only runs that
   *  wire the managed OPENAI_API_KEY); absent means native pricing is unknown. */
  openaiModelPricing?: Record<string, OpenaiModelPrice>;
  source?: "harness" | "user" | "managed";
};

/** Resolved per-tenant, per-stage model slugs. `null`/absent means platform
 *  default. Maps to the worker's RUNTIME and REVIEW_CODEX model envs. */
export type ReviewModelSettings = {
  planner_model?: string | null;
  investigation_model?: string | null;
  review_model?: string | null;
  planner_effort?: "low" | "medium" | "high" | null;
  investigation_effort?: "low" | "medium" | "high" | null;
  review_effort?: "low" | "medium" | "high" | null;
  review_fallback_policy?: "fail_notify" | "managed";
};

type DaytonaPhase = "review-context" | "runtime-review";

/** A Daytona sandbox session for one review stage. It is created and provisioned
 *  once, then runPhase writes the stage input and runs the worker. Call
 *  dispose() exactly once when the stage finishes. */
export type DaytonaReviewSession = {
  runPhase: <T>(phase: DaytonaPhase, phaseInput: Record<string, unknown>) => Promise<DaytonaStageResult<T>>;
  dispose: () => Promise<void>;
};

export async function runDaytonaReviewContext(
  session: DaytonaReviewSession,
  input: PullRequestReviewInput,
): Promise<DaytonaStageResult<CodegraphReviewContextResult>> {
  return session.runPhase<CodegraphReviewContextResult>("review-context", {
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    title: input.title,
    author: input.author,
    headSha: input.headSha,
    baseRef: input.baseRef,
    headRef: input.headRef,
    historyMarkdown: input.historyMarkdown,
  });
}

export async function runDaytonaRuntimeReview(
  session: DaytonaReviewSession,
  input: RuntimeReviewInput,
): Promise<DaytonaStageResult<RuntimeReviewResult>> {
  return session.runPhase<RuntimeReviewResult>("runtime-review", {
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    title: input.title,
    author: input.author,
    headSha: input.headSha,
    baseRef: input.baseRef,
    headRef: input.headRef,
    historyMarkdown: input.historyMarkdown ?? "",
    reviewInstructions: input.reviewInstructions,
  });
}

/** OPENROUTER_API_KEY value for a BYOK-OpenAI run, which has no OpenRouter credential of its own. It is a
 *  deliberately INVALID, non-secret placeholder: Codex needs the proxy provider's env_key to resolve to a
 *  set variable, and the proxy routes openai/* natively under the tenant's OpenAI key, so this value is
 *  only ever sent as the bearer to openrouter.ai for a NON-OpenAI model — where a 401 is the intended
 *  outcome. It must never be a real key (that would leak the tenant's OpenAI credential to a third party). */
export const BYOK_OPENAI_OPENROUTER_PLACEHOLDER = "byok-openai-no-openrouter-credential";

/** Resolve the OPENROUTER_API_KEY wired into a run's sandbox (the credential Codex sends to the capture
 *  proxy on the OpenRouter route). Precedence mirrors the worker's billing classification:
 *    - harness run        -> undefined (Codex runs natively on the subscription; no proxy, no key).
 *    - tenant OpenRouter   -> the tenant's own key (BYOK "user" run).
 *    - BYOK OpenAI         -> a non-secret PLACEHOLDER, never the tenant's OpenAI key. openai/* rides the
 *                             native route under the OpenAI key; a non-OpenAI model 401s at OpenRouter
 *                             without leaking a real credential or spending managed compute.
 *    - managed run         -> the managed OpenRouter key.
 *  Pure and exported so the security-sensitive choice is unit-tested without standing up a sandbox. */
export function resolveOpenrouterKeyForRun(input: {
  harnessMode: boolean;
  tenantOpenrouterKey?: string;
  byokOpenaiKey?: string;
  managedOpenrouterKey?: string;
}): string | undefined {
  if (input.harnessMode) {
    return undefined;
  }
  if (input.tenantOpenrouterKey) {
    return input.tenantOpenrouterKey;
  }
  if (input.byokOpenaiKey) {
    return BYOK_OPENAI_OPENROUTER_PLACEHOLDER;
  }
  return input.managedOpenrouterKey;
}

/** Model-gateway credential preflight. Fail-closed for phases that call the
 *  model (requiresModelKey=true): a run without an OpenRouter key is rejected
 *  before a sandbox is created. Codegraph-only phases pass requiresModelKey=false
 *  and tolerate an absent key.
 *
 *  Harness mode (harnessMode=true) satisfies the preflight WITHOUT any OpenRouter
 *  key: Codex runs natively on the author's ChatGPT subscription via the auth.json
 *  blob, so the model gateway is never used. A BYOK native OpenAI key likewise
 *  satisfies it: openai/* models route natively to api.openai.com under that key. */
export function ensureModelCredentials(input: {
  requiresModelKey: boolean;
  openrouterKey?: string;
  openaiKey?: string;
  harnessMode?: boolean;
}): void {
  if (!input.requiresModelKey || input.harnessMode) {
    return;
  }
  if (!input.openrouterKey && !input.openaiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required for Codex inside Daytona. Set OPENROUTER_API_KEY on the worker.",
    );
  }
}

/** Create and provision a sandbox for a review stage. On a provisioning failure
 *  the sandbox is deleted before the error propagates so nothing leaks. */
export async function createReviewSession(input: {
  token: string;
  providerKeys?: ProviderKeys;
  reviewRunId?: string;
  modelSettings?: ReviewModelSettings;
  /** Whether this phase actually calls the model gateway. Runtime review needs a
   *  key (fail-closed). Codegraph-only phases (summary) pass false: a missing key
   *  must not kill a phase that never talks to an LLM. Defaults to true. */
  requiresModelKey?: boolean;
  /** Short-lived repository/review-scoped graph credential minted by Trigger. */
  contextGraphMcp?: ContextGraphMcpAccess;
}): Promise<DaytonaReviewSession> {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is required because review workers run in Daytona");
  }

  // Harness mode: the PR author connected ChatGPT-subscription Codex credentials.
  // Codex runs NATIVELY on their subscription -- no OpenRouter key, no capture
  // proxy, tenant billed infra-only. Takes precedence over any OpenRouter key.
  const harnessAuth = input.providerKeys?.codexHarnessAuth;
  const harnessMode = Boolean(harnessAuth);

  // Tenant BYOK native OpenAI key: openai/* rides the tenant's own key natively on api.openai.com. Wired
  // whenever the tenant has an OpenAI key (and no harness) -- INCLUDING alongside an OpenRouter key: the
  // capture proxy routes openai/* to this native key and everything else to the OpenRouter key, so one
  // BYOK run uses BOTH company keys per-model (openai/* direct + cheaper). Precedence: harness > BYOK > managed.
  const byokOpenaiKey = harnessMode ? undefined : input.providerKeys?.openaiApiKey;

  const openrouterKey = resolveOpenrouterKeyForRun({
    harnessMode,
    tenantOpenrouterKey: input.providerKeys?.openrouter,
    byokOpenaiKey,
    managedOpenrouterKey: process.env.OPENROUTER_API_KEY,
  });

  // Native OpenAI route: the proxy rewrites openai/* to api.openai.com under this key.
  //  - managed run  -> the managed OPENAI_API_KEY (carries the pricing map to compute native-route cost).
  //  - BYOK openai  -> the tenant's own key (with or without a tenant OpenRouter key alongside); no pricing
  //                    map needed (a "user" run is billed infra-only, so its captured native cost is
  //                    telemetry, not a charge).
  // Never wired in harness mode (which skips the proxy).
  const isManagedRun = !harnessMode && !input.providerKeys?.openrouter && !byokOpenaiKey;
  const openaiKey = byokOpenaiKey ?? (isManagedRun ? process.env.OPENAI_API_KEY : undefined);
  const openaiModelPricing = isManagedRun ? input.providerKeys?.openaiModelPricing : undefined;

  ensureModelCredentials({
    requiresModelKey: input.requiresModelKey ?? true,
    openrouterKey,
    openaiKey,
    harnessMode,
  });

  // Secret values that may surface in sandbox stdout/stderr/result. They are
  // scrubbed before any sandbox output is thrown, logged, or sent to the API.
  // OPENAI_API_KEY is wired into the sandbox for native-route runs (managed OR tenant BYOK; below), and
  // is redacted here in all cases. CODEX_API_KEY is no longer wired in but stays redacted as cheap
  // defense in case it lingers in a deployment.
  //
  // SECURITY: in harness mode the raw auth.json blob AND its parsed token values
  // (access_token/refresh_token/id_token) are added so the subscription
  // credentials never appear in any thrown error, log line, or transported output.
  const secrets = collectSecrets([
    input.token,
    openrouterKey,
    // The native OpenAI key actually wired into the sandbox (managed OR tenant BYOK) plus the env key,
    // so a tenant's own key is scrubbed from any thrown error, log line, or transported output too.
    openaiKey,
    process.env.OPENROUTER_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.CODEX_API_KEY,
    harnessAuth,
    ...collectCodexHarnessTokenSecrets(harnessAuth),
    input.contextGraphMcp?.accessToken,
  ]);

  const daytona = new Daytona();
  const sandbox = await createReviewSandbox(daytona);
  const sandboxId = sandbox.id;
  const workDir = "/home/daytona/jina-review-worker";
  const workerEnv = daytonaWorkerEnv({
    token: input.token,
    openrouterKey,
    openaiKey,
    openaiModelPricing,
    reviewRunId: input.reviewRunId,
    modelSettings: input.modelSettings,
    harnessMode,
    contextGraphMcp: input.contextGraphMcp,
  });

  const dispose = async (): Promise<void> => {
    await sandbox.delete(120).catch((error: unknown) => {
      logger.warn("daytona_sandbox_delete_failed", {
        sandbox_id: sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  // Provision the shared worker files + dependencies once. A pre-baked
  // snapshot/image can ship the deps (DAYTONA_SKIP_INSTALL) to skip the install.
  try {
    await ensureSandboxDirectory(sandbox, workDir);
    const workerFiles = await Promise.all(
      DAYTONA_WORKER_SOURCE_FILES.map(async (file) => ({
        path: `${workDir}/${file.remotePath}`,
        source: await workerSource(file.name),
      })),
    );
    await writeWorkerFiles(sandbox, [
      ...workerFiles,
      { path: `${workDir}/runner.ts`, source: Buffer.from(daytonaRunnerSource()) },
    ]);

    await ensureSandboxDirectory(sandbox, `${workDir}/codex-home`);
    if (input.contextGraphMcp) {
      await writeWorkerFile(
        sandbox,
        `${workDir}/codex-home/config.toml`,
        Buffer.from(codexContextGraphMcpConfig(input.contextGraphMcp)),
      );
    }

    // Harness mode: land the auth.json blob under CODEX_HOME so native Codex reads
    // the author's ChatGPT-subscription credentials. daytonaWorkerEnv points
    // CODEX_HOME at this directory. The blob is in `secrets`, so any failure
    // writing it is redacted before it can surface.
    if (harnessMode && harnessAuth) {
      await writeWorkerFile(sandbox, `${workDir}/codex-home/auth.json`, Buffer.from(harnessAuth));
    }

    if (!daytonaSkipInstall()) {
      const install = await sandbox.process.executeCommand(
        "npm init -y >/dev/null && npm install --silent tsx typescript @colbymchenry/codegraph@1.0.1 @openai/codex@0.144.0 >/dev/null",
        workDir,
        undefined,
        daytonaSetupTimeoutSeconds(),
      );
      if (install.exitCode !== 0) {
        throw new Error(`Daytona worker dependency install failed: ${redact(daytonaProcessFailureMessage(install.result), secrets)}`);
      }
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  const runPhase = async <T>(
    phase: DaytonaPhase,
    phaseInput: Record<string, unknown>,
  ): Promise<DaytonaStageResult<T>> => {
    const startedAt = Date.now();
    const resultFilePath = `${workDir}/results/${phase}-${Date.now()}-${randomUUID()}.json`;
    await writeWorkerFile(
      sandbox,
      `${workDir}/input.json`,
      Buffer.from(JSON.stringify({ phase, input: phaseInput, resultFilePath }, null, 2)),
    );

    const run = await sandbox.process.executeCommand(
      "npx tsx runner.ts",
      workDir,
      workerEnv,
      daytonaRunTimeoutSeconds(),
    );

    let resultFileContent: string | undefined;
    let resultFileByteCount = 0;
    let resultFileReadError: unknown;
    try {
      const resultFile = await sandbox.fs.downloadFile(resultFilePath, daytonaResultDownloadTimeoutSeconds());
      resultFileByteCount = resultFile.byteLength;
      resultFileContent = resultFile.toString("utf8");
    } catch (error) {
      resultFileReadError = error;
    }

    const transportMetadata = daytonaTransportLogMetadata({
      phase,
      sandboxId,
      exitCode: run.exitCode,
      stdout: run.result,
      resultFileByteCount,
      resultFileReadError,
      durationMs: elapsedMs(startedAt),
      secrets,
    });

    for (const warning of extractWorkerWarnings(run.result)) {
      logger.warn("daytona_worker_warning", {
        phase,
        sandbox_id: sandboxId,
        ...redactWorkerWarningForLog(warning, secrets),
      });
    }

    try {
      const result = parseDaytonaTransportResult<T>({
        phase,
        exitCode: run.exitCode,
        stdout: run.result,
        resultFileContent,
        resultFileReadError,
        secrets,
      });
      logger.info("daytona_phase_completed", transportMetadata);
      return { result, sandboxId };
    } catch (error) {
      logger.warn("daytona_phase_failed", {
        ...transportMetadata,
        error_preview: truncateMiddle(redact(errorMessage(error), secrets), 500),
      });
      // The worker's structured error may contain secret values; scrub before
      // rethrowing. Result payloads are transported by file, stdout is only a
      // fallback preview for failed workers that never wrote the file.
      throw new Error(redact(errorMessage(error), secrets));
    }
  };

  return { runPhase, dispose };
}

async function ensureSandboxDirectory(sandbox: Sandbox, directory: string): Promise<void> {
  const result = await sandbox.process.executeCommand(`mkdir -p ${shellQuote(directory)}`, undefined, undefined, 120);
  if (result.exitCode !== 0) {
    throw new Error(`Daytona worker directory setup failed: ${daytonaProcessFailureMessage(result.result)}`);
  }
}

async function writeWorkerFiles(
  sandbox: Sandbox,
  files: Array<{ path: string; source: Buffer }>,
): Promise<void> {
  for (const file of files) {
    await writeWorkerFile(sandbox, file.path, file.source);
  }
}

async function writeWorkerFile(sandbox: Sandbox, remotePath: string, source: Buffer): Promise<void> {
  const directory = path.posix.dirname(remotePath);
  const init = await sandbox.process.executeCommand(
    `mkdir -p ${shellQuote(directory)} && : > ${shellQuote(remotePath)}`,
    undefined,
    undefined,
    120,
  );
  if (init.exitCode !== 0) {
    throw new Error(`Daytona worker file init failed for ${remotePath}: ${daytonaProcessFailureMessage(init.result)}`);
  }

  const encoded = source.toString("base64");
  const chunkSize = 32_000;
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    const chunk = encoded.slice(offset, offset + chunkSize);
    const append = await sandbox.process.executeCommand(
      `printf %s ${shellQuote(chunk)} | base64 -d >> ${shellQuote(remotePath)}`,
      undefined,
      undefined,
      120,
    );
    if (append.exitCode !== 0) {
      throw new Error(`Daytona worker file write failed for ${remotePath}: ${daytonaProcessFailureMessage(append.result)}`);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function workerSource(name: DaytonaWorkerSourceName): Promise<Buffer> {
  const candidates = workerSourceCandidates(name);

  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  throw new Error(
    `Unable to load Daytona worker source ${name}. Checked ${candidates.map(formatSourceCandidate).join(", ")}`,
  );
}

function workerSourceCandidates(
  name: DaytonaWorkerSourceName,
): Array<string | URL> {
  const file = DAYTONA_WORKER_SOURCE_FILES.find((candidate) => candidate.name === name);
  if (!file) {
    throw new Error(`Unknown Daytona worker source ${name}`);
  }
  return [
    new URL(file.modulePath, import.meta.url),
    path.join(process.cwd(), file.sourcePath.replace(/^\.\//, "")),
  ];
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function formatSourceCandidate(candidate: string | URL): string {
  return candidate instanceof URL ? fileURLToPath(candidate) : candidate;
}

export function daytonaWorkerEnv(input: {
  token: string;
  openrouterKey?: string;
  /** OpenAI key for the capture proxy's native route — the managed key on a managed run, or the tenant's
   *  own BYOK key on a "user" run. Emitted as OPENAI_API_KEY for any non-harness run; its presence is what
   *  makes the proxy route openai/* natively (to api.openai.com under whichever key was wired). */
  openaiKey?: string;
  /** Per-model OpenAI pricing map; emitted as JINA_OPENAI_MODEL_PRICING so the proxy
   *  can compute native-route cost. Only meaningful alongside openaiKey. */
  openaiModelPricing?: Record<string, OpenaiModelPrice>;
  reviewRunId?: string;
  modelSettings?: ReviewModelSettings;
  /** Codex harness (BYOH-native) mode: emit CODEX_HOME + JINA_HARNESS_MODE and
   *  omit OPENROUTER_API_KEY so Codex runs on the author's subscription. */
  harnessMode?: boolean;
  contextGraphMcp?: ContextGraphMcpAccess;
}): Record<string, string> {
  const toolBins = resolveDaytonaWorkerToolBins();
  const env: Record<string, string> = {
    GITHUB_TOKEN: input.token,
    // Customer PR checkouts must use the GitHub App installation token. A global
    // GITHUB_CLONE_TOKEN can be stale or scoped to the wrong account/repo, which
    // GitHub reports as "Repository not found" during clone.
    GITHUB_CLONE_TOKEN: input.token,
    CODEX_BIN: toolBins.codexBin,
    CODEGRAPH_BIN: toolBins.codegraphBin,
    // Per-tenant model slugs when provided, else the platform defaults.
    REVIEW_CODEX_MODEL: input.modelSettings?.review_model || reviewCodexModel(),
    RUNTIME_PLANNER_MODEL: input.modelSettings?.planner_model || runtimePlannerModel(),
    RUNTIME_AGENT_MODEL: input.modelSettings?.investigation_model || runtimeAgentModel(),
    RUNTIME_MENTAL_TRACE_MODEL: runtimeMentalTraceModel(),
    CODEX_REVIEW_TIMEOUT_MS: process.env.CODEX_REVIEW_TIMEOUT_MS || "600000",
    CODEGRAPH_TIMEOUT_MS: process.env.CODEGRAPH_TIMEOUT_MS || "120000",
    // Owner-controlled Codex state. V2 Context MCP config and harness auth.json are
    // provisioned here, never inside the customer-controlled checkout.
    CODEX_HOME: "/home/daytona/jina-review-worker/codex-home",
  };
  if (input.modelSettings?.review_effort) {
    env.REVIEW_CODEX_EFFORT = input.modelSettings.review_effort;
  }
  if (input.modelSettings?.planner_effort) {
    env.RUNTIME_PLANNER_EFFORT = input.modelSettings.planner_effort;
  }
  if (input.modelSettings?.investigation_effort) {
    env.RUNTIME_AGENT_EFFORT = input.modelSettings.investigation_effort;
  }

  // Harness mode: point Codex at the sandbox auth.json blob (written under this
  // CODEX_HOME) and flag the run for runtime-review. OPENROUTER_API_KEY is
  // deliberately NOT emitted below (input.openrouterKey is undefined in harness
  // mode). This is load-bearing: runtime-review/index.ts starts the capture proxy
  // ONLY when OPENROUTER_API_KEY is present, so omitting it here is exactly what
  // makes native Codex bypass the proxy.
  if (input.harnessMode) {
    env.JINA_HARNESS_MODE = "1";
  }

  if (input.contextGraphMcp) {
    env.JINA_GRAPH_ACCESS_TOKEN = input.contextGraphMcp.accessToken;
    env.JINA_GRAPH_MCP_ENABLED = "1";
  }

  // OpenRouter gateway: the key the proxy injects when Codex sends no auth, plus
  // the attribution + non-PII user tag used on every upstream request.
  if (input.openrouterKey) {
    env.OPENROUTER_API_KEY = input.openrouterKey;
  }
  const appUrl = process.env.OPENROUTER_APP_URL?.trim();
  if (appUrl) {
    env.OPENROUTER_APP_URL = appUrl;
  }
  const appTitle = process.env.OPENROUTER_APP_TITLE?.trim();
  if (appTitle) {
    env.OPENROUTER_APP_TITLE = appTitle;
  }
  if (input.reviewRunId) {
    env.JINA_OPENROUTER_USER = `review_${input.reviewRunId}`;
  }

  // Native OpenAI route (managed runs only): wire the managed OpenAI key and pricing
  // map into the sandbox. Guarded on !harnessMode so a harness (BYOH) run never gains
  // an env that would start the capture proxy it is meant to bypass.
  if (input.openaiKey && !input.harnessMode) {
    env.OPENAI_API_KEY = input.openaiKey;
    if (input.openaiModelPricing && Object.keys(input.openaiModelPricing).length > 0) {
      env.JINA_OPENAI_MODEL_PRICING = JSON.stringify(input.openaiModelPricing);
    }
  }

  const reviewEffort = process.env.REVIEW_CODEX_EFFORT?.trim();
  if (reviewEffort && !env.REVIEW_CODEX_EFFORT) {
    env.REVIEW_CODEX_EFFORT = reviewEffort;
  }
  return env;
}

/** Codex Streamable HTTP MCP configuration. The bearer value stays in the environment. */
export function codexContextGraphMcpConfig(access: ContextGraphMcpAccess): string {
  return [
    "[mcp_servers.jina_context]",
    `url = ${JSON.stringify(access.mcpUrl)}`,
    'bearer_token_env_var = "JINA_GRAPH_ACCESS_TOKEN"',
    'enabled_tools = ["search_context", "list_context", "read_context", "diff_context"]',
    "required = false",
    "startup_timeout_sec = 5",
    "tool_timeout_sec = 20",
    "",
  ].join("\n");
}

export function parseDaytonaResultPayload<T>(payload: string): T {
  const parsed = JSON.parse(payload) as { ok?: boolean; result?: T; error?: string };
  if (!parsed.ok) {
    throw new Error(parsed.error || "Daytona worker returned an unsuccessful result");
  }
  if (parsed.result === undefined) {
    throw new Error("Daytona worker did not return a result");
  }
  return parsed.result;
}

export function parseDaytonaTransportResult<T>(input: {
  phase: string;
  exitCode: number;
  stdout: string;
  resultFileContent?: string;
  resultFileReadError?: unknown;
  secrets?: string[];
}): T {
  const secrets = input.secrets ?? [];
  if (input.resultFileContent !== undefined) {
    try {
      return parseDaytonaResultPayload<T>(input.resultFileContent);
    } catch (error) {
      const message = redact(errorMessage(error), secrets);
      if (input.exitCode !== 0) {
        throw new Error(`Daytona ${input.phase} worker failed: ${message}`);
      }
      throw new Error(message);
    }
  }

  if (input.exitCode !== 0) {
    throw new Error(`Daytona ${input.phase} worker failed: ${redact(daytonaFailureMessage(input.stdout), secrets)}`);
  }

  if (input.resultFileReadError) {
    const message = truncateMiddle(redact(errorMessage(input.resultFileReadError), secrets), 500);
    throw new Error(`Daytona ${input.phase} result file download failed: ${message}`);
  }

  throw new Error(`Daytona ${input.phase} worker did not produce a result file`);
}

function daytonaTransportLogMetadata(input: {
  phase: DaytonaPhase;
  sandboxId: string;
  exitCode: number;
  stdout: string;
  resultFileByteCount: number;
  resultFileReadError?: unknown;
  durationMs: number;
  secrets: string[];
}): Record<string, unknown> {
  return {
    phase: input.phase,
    sandbox_id: input.sandboxId,
    exit_code: input.exitCode,
    stdout_byte_count: Buffer.byteLength(input.stdout, "utf8"),
    result_file_byte_count: input.resultFileByteCount,
    result_file_read_failed: Boolean(input.resultFileReadError),
    result_file_read_error: input.resultFileReadError
      ? truncateMiddle(redact(errorMessage(input.resultFileReadError), input.secrets), 500)
      : undefined,
    duration_ms: input.durationMs,
  };
}

export function extractWorkerWarnings(output: string): WorkerWarning[] {
  const warnings: WorkerWarning[] = [];
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf(WORKER_WARNING_PREFIX);
    if (index === -1) {
      continue;
    }
    const raw = line.slice(index + WORKER_WARNING_PREFIX.length).trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isWorkerWarning(parsed)) {
        warnings.push(parsed);
      }
    } catch {
      // Ignore malformed warning lines; the structured phase result remains the
      // source of truth for success/failure.
    }
  }
  return warnings;
}

export function redactWorkerWarningForLog(warning: WorkerWarning, secrets: string[]): WorkerWarning {
  const redacted: WorkerWarning = { event: warning.event };
  for (const [key, value] of Object.entries(warning)) {
    if (key === "event") {
      continue;
    }
    // Redact DEEPLY: a secret nested in an object/array field (e.g. details.env.OPENAI_API_KEY) must be
    // scrubbed too, not just top-level strings — mixed BYOK runs now carry both tenant keys.
    redacted[key] = redactDeep(value, secrets);
  }
  return redacted;
}

/** Recursively scrub secret substrings from strings anywhere in a JSON-ish value (strings, arrays, objects). */
function redactDeep(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactDeep(nested, secrets);
    }
    return out;
  }
  return value;
}

function isWorkerWarning(value: unknown): value is WorkerWarning {
  return (
    typeof value === "object" &&
    value !== null &&
    "event" in value &&
    typeof (value as { event?: unknown }).event === "string"
  );
}

function daytonaFailureMessage(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "worker exited without output";
  }

  const missingBash = daytonaMissingBashMessage(trimmed);
  if (missingBash) {
    return missingBash;
  }

  const match = trimmed.match(/__JINA_DAYTONA_RESULT_START__\s*([\s\S]*?)\s*__JINA_DAYTONA_RESULT_END__/);
  if (match?.[1]) {
    try {
      const parsed = JSON.parse(match[1]) as { error?: string };
      if (parsed.error) {
        // Keep head + tail: a crashing CLI (e.g. codex) prints its banner first
        // and the actual error last, so front-only truncation buries the cause.
        return truncateMiddle(parsed.error, 2_000);
      }
    } catch {
      // Fall through to the raw preview below.
    }
  }

  return `worker exited before writing a result file. Last output: ${truncateMiddle(trimmed, 2_000)}`;
}

function daytonaProcessFailureMessage(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "command exited without output";
  }

  const missingBash = daytonaMissingBashMessage(trimmed);
  if (missingBash) {
    return missingBash;
  }

  return truncateMiddle(trimmed, 2_000);
}

function daytonaMissingBashMessage(output: string): string | undefined {
  if (!/\/usr\/bin\/bash: no such file or directory/i.test(output)) {
    return undefined;
  }

  return [
    "Daytona sandbox image is missing /usr/bin/bash.",
    "Use a Debian/Ubuntu-based image such as node:22-bookworm,",
    "unset DAYTONA_SANDBOX_IMAGE/DAYTONA_SNAPSHOT to use Jina's default node:22-bookworm sandbox,",
    "or rebuild the snapshot with bash installed.",
  ].join(" ");
}

// Create the worker sandbox. The fallback image is Debian-based so Daytona's
// command runner can rely on /usr/bin/bash being present. Default resources use
// the highest profile currently supported by our Daytona configuration.
async function createReviewSandbox(daytona: Daytona): Promise<Sandbox> {
  const envVars = { NODE_ENV: "production" };
  const snapshot = process.env.DAYTONA_SNAPSHOT?.trim();
  if (snapshot) {
    return daytona.create({ language: "typescript", envVars, snapshot });
  }

  const image = resolveDaytonaSandboxImage();
  const resources = resolveDaytonaSandboxResources();
  return daytona.create({
    language: "typescript",
    envVars,
    image,
    ...(resources ? { resources } : {}),
  });
}

export function resolveDaytonaSandboxImage(env: NodeJS.ProcessEnv = process.env): string {
  return env.DAYTONA_SANDBOX_IMAGE?.trim() || DEFAULT_DAYTONA_SANDBOX_IMAGE;
}

export function resolveDaytonaSandboxResources(env: NodeJS.ProcessEnv = process.env): Resources {
  return {
    cpu: boundedPositiveInt(env.DAYTONA_SANDBOX_CPU, DEFAULT_DAYTONA_SANDBOX_RESOURCES.cpu),
    memory: boundedPositiveInt(env.DAYTONA_SANDBOX_MEMORY, DEFAULT_DAYTONA_SANDBOX_RESOURCES.memory),
    disk: boundedPositiveInt(env.DAYTONA_SANDBOX_DISK, DEFAULT_DAYTONA_SANDBOX_RESOURCES.disk),
  };
}

export function resolveDaytonaWorkerToolBins(env: NodeJS.ProcessEnv = process.env): { codexBin: string; codegraphBin: string } {
  if (!daytonaSkipInstall(env)) {
    return {
      codexBin: "@openai/codex",
      codegraphBin: DEFAULT_DAYTONA_CODEGRAPH_BIN,
    };
  }
  return {
    codexBin: env.CODEX_BIN?.trim() || "codex",
    codegraphBin: env.CODEGRAPH_BIN?.trim() || "codegraph",
  };
}

/** When the sandbox image/snapshot already ships the worker dependencies, skip
 *  the per-stage npm install. Off by default. */
function daytonaSkipInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DAYTONA_SKIP_INSTALL?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function daytonaSetupTimeoutSeconds(): number {
  return positiveInt(process.env.DAYTONA_SETUP_TIMEOUT_SECONDS, 300);
}

function daytonaRunTimeoutSeconds(): number {
  return positiveInt(process.env.DAYTONA_RUN_TIMEOUT_SECONDS, 3_600);
}

function daytonaResultDownloadTimeoutSeconds(): number {
  return positiveInt(process.env.DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS, 120);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInt(raw: string | undefined): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function boundedPositiveInt(raw: string | undefined, max: number): number {
  const parsed = optionalPositiveInt(raw);
  return parsed === undefined ? max : Math.min(parsed, max);
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

// Collapse to one line but keep both the head (CLI banner/model) and the tail
// (the actual error), eliding the middle — front-only truncation hid the cause
// of worker failures (issue #26 follow-up).
function truncateMiddle(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  const marker = " ...[elided]... ";
  const head = Math.max(0, Math.floor((maxLength - marker.length) * 0.3));
  const tail = Math.max(0, maxLength - marker.length - head);
  return `${oneLine.slice(0, head)}${marker}${oneLine.slice(oneLine.length - tail)}`;
}

const REDACTED = "***REDACTED***";
const DEFAULT_DAYTONA_SANDBOX_IMAGE = "node:22-bookworm";
const DEFAULT_DAYTONA_CODEGRAPH_BIN = "/home/daytona/jina-review-worker/node_modules/.bin/codegraph";
const DEFAULT_DAYTONA_SANDBOX_RESOURCES: Required<Pick<Resources, "cpu" | "memory" | "disk">> = {
  cpu: 4,
  memory: 8,
  disk: 10,
};

/** Defensively parse a Codex harness auth.json blob and return every access_token,
 *  refresh_token, and id_token value found ANYWHERE in the structure (Codex nests
 *  them under `tokens`, but we walk recursively so a schema change can't leak a
 *  token past redaction). Returns [] for a missing/invalid/non-token blob. */
export function collectCodexHarnessTokenSecrets(authBlob?: string): string[] {
  if (!authBlob) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(authBlob);
  } catch {
    return [];
  }
  const tokenKeys = new Set(["access_token", "refresh_token", "id_token"]);
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (tokenKeys.has(key) && typeof value === "string" && value) {
          found.push(value);
        } else {
          visit(value);
        }
      }
    }
  };
  visit(parsed);
  return found;
}

/** De-duplicate, drop short/empty values, and sort longest-first so overlapping
 *  secrets are replaced before their substrings. */
export function collectSecrets(values: Array<string | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value && value.length >= 8) {
      unique.add(value);
    }
  }
  return Array.from(unique).sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of each known secret value with a redaction marker. */
function redact(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function daytonaRunnerSource(): string {
  return `import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runReviewContext } from "./review/codex-review.ts";
import { runRuntimeReview } from "./runtime-review/index.ts";

async function main() {
  let resultFilePath;
  try {
    const request = JSON.parse(await readFile("./input.json", "utf8"));
    resultFilePath = request.resultFilePath;
    if (!resultFilePath) {
      throw new Error("Missing Daytona result file path");
    }

    const token = requiredEnv("GITHUB_TOKEN");
    // Prefer the GitHub App installation token for customer repo clones. A global
    // GITHUB_CLONE_TOKEN must not shadow it (issue #72).
    const cloneToken = token;
    const mainRepoDir = "/home/daytona/jina-review-worker/repo";

    let result;
    if (request.phase === "review-context") {
      result = await runReviewContext({
        ...request.input,
        token,
        cloneToken,
        repoDir: mainRepoDir,
      });
    } else if (request.phase === "runtime-review") {
      result = await runRuntimeReview({
        ...request.input,
        token,
        cloneToken,
      });
    } else {
      throw new Error(\`Unsupported Daytona worker phase: \${request.phase}\`);
    }

    await writeResultFile(resultFilePath, { ok: true, result });
    console.log("__JINA_DAYTONA_RESULT_FILE_WRITTEN__");
  } catch (error) {
    if (resultFilePath) {
      try {
        await writeResultFile(resultFilePath, {
          ok: false,
          error: error instanceof Error ? error.stack || error.message : String(error),
        });
        console.log("__JINA_DAYTONA_RESULT_FILE_WRITTEN__");
      } catch (writeError) {
        console.log("__JINA_DAYTONA_RESULT_FILE_WRITE_FAILED__");
        console.log(truncateOneLine(String(writeError instanceof Error ? writeError.message : writeError), 1000));
      }
    }
    process.exit(1);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing required environment variable \${name}\`);
  return value;
}

async function writeResultFile(filePath, envelope) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(envelope), "utf8");
}

function truncateOneLine(value, maxLength) {
  const cleaned = value.replace(/\\s+/g, " ").trim();
  return cleaned.length > maxLength ? \`\${cleaned.slice(0, maxLength - 3)}...\` : cleaned;
}

main();
`;
}
