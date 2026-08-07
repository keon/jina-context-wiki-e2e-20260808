import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createBoardAgentStageRunner,
  type BoardAgentModelUsage,
  type DaytonaBoardAgentCredential,
  type BoardAgentStageResultEnvelope,
  type BoardAgentStageRunner
} from "@jina/daytona";

const execFileAsync = promisify(execFile);
// Planning and source-challenge tasks embed every bounded research packet.
// A large repository can legitimately produce ten detailed packets, which is
// already larger than a 64k context before the publication plan and public
// pages are added. Keep the default below the runner's 256k hard ceiling while
// leaving enough room for the complete, non-truncated evidence set.
const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_COMPACT_TOKENS = 96_000;
// The Board schedules at most four automatic deliveries. An explicit,
// audited operator recovery can reopen a coordinated checkpoint build through
// multiple independent terminal branches,
// so the transport must accept those attempts without creating automatic
// retries beyond the normal budget.
const DEFAULT_MAX_ATTEMPTS = 4;
const OPERATOR_RETRY_HARD_MAX_ATTEMPTS = 32;
const MAX_DECLARED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_DECLARED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTION_PROFILE_BYTES = 64 * 1024;

type WorkerEnvironment = Readonly<Record<string, string | undefined>>;
type ContextProfileFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface BoardAgentExecutionConfiguration {
  readonly credential: DaytonaBoardAgentCredential;
  readonly model: string;
  readonly effort: string;
  readonly domains: readonly string[];
}

type BoardAgentRunnerFactory = (
  environment: WorkerEnvironment,
  protectedValues: readonly string[],
  execution?: BoardAgentExecutionConfiguration
) => BoardAgentStageRunner;

export interface PortableAgentStageInput {
  readonly id: string;
  readonly prompt: string;
  readonly schema?: unknown;
  readonly workingDirectory: string;
  readonly additionalDirectories?: readonly string[];
  readonly writableDirectories?: readonly string[];
  readonly readOnly?: boolean;
  readonly budgetSeconds: number;
  /** Exact host files expected from a writable stage. */
  readonly outputFiles?: readonly string[];
}

export interface PortableAgentStageOutput {
  readonly text: string;
  readonly parsed?: unknown;
  readonly durationMs: number;
  readonly usage: BoardAgentModelUsage;
}

export function addBoardAgentModelUsage(total: BoardAgentModelUsage, next: BoardAgentModelUsage): BoardAgentModelUsage {
  const inputTokens = safeTokenSum(total.inputTokens, next.inputTokens, "inputTokens");
  const cachedInputTokens = safeTokenSum(total.cachedInputTokens, next.cachedInputTokens, "cachedInputTokens");
  const outputTokens = safeTokenSum(total.outputTokens, next.outputTokens, "outputTokens");
  if (cachedInputTokens > inputTokens) {
    throw new Error("aggregate cachedInputTokens cannot exceed inputTokens");
  }
  return { inputTokens, cachedInputTokens, outputTokens };
}

export function boardAgentModelUsageForCompletion(input: {
  readonly outcome: "done" | "failed" | "retry";
  readonly observed: boolean;
  readonly usage: BoardAgentModelUsage;
}): BoardAgentModelUsage | undefined {
  return input.outcome === "done" || input.observed ? input.usage : undefined;
}

export interface PortableContextBoardAgentStageRunner {
  run(input: PortableAgentStageInput): Promise<PortableAgentStageOutput>;
}

export interface BoardAgentAttemptContext {
  readonly commitSha: string;
  readonly attempt: number;
  readonly tenantId?: string;
  readonly buildId?: string;
  readonly signal?: AbortSignal;
}

export interface PortableBoardAgentConfiguration {
  readonly environment?: WorkerEnvironment;
  readonly protectedValues?: readonly string[];
  /** A worker-scoped credential used only when no tenant execution profile is configured. */
  readonly defaultExecution?: BoardAgentExecutionConfiguration;
  readonly attemptContext: () => BoardAgentAttemptContext;
  /** Deterministic seams for contract tests; production uses the global fetch and runner factory. */
  readonly profileFetch?: ContextProfileFetch;
  readonly runnerFactory?: BoardAgentRunnerFactory;
}

/**
 * Creates the worker adapter over the transport-neutral runner. The attempt
 * context is read for every invocation so a reused worker cannot leak a prior
 * task's commit, retry number, or cancellation signal into the next lease.
 */
export function configuredPortableContextBoardAgentStageRunner(
  configuration: PortableBoardAgentConfiguration
): PortableContextBoardAgentStageRunner {
  const environment = configuration.environment ?? process.env;
  const protectedValues = configuration.protectedValues ?? [];
  const runnerFactory = configuration.runnerFactory ?? configuredBoardAgentRunner;
  const managedRunner = configuration.defaultExecution ? undefined : runnerFactory(environment, protectedValues);
  return {
    async run(input) {
      const attempt = configuration.attemptContext();
      const profile = await resolveContextExecutionProfile(environment, attempt, configuration.profileFetch);
      if (!profile) {
        // Raw API-key and Codex credentials are intentionally single-use in the
        // Daytona runner. Construct a fresh runner for every stage instead of
        // retaining a consumed credential on the long-lived worker process.
        const defaultRunner = configuration.defaultExecution
          ? runnerFactory(environment, protectedValues, configuration.defaultExecution)
          : managedRunner!;
        return runPortableBoardAgentStage(defaultRunner, input, attempt, environment);
      }
      const profileManagedRunner = (selectedModel?: string) =>
        configuredManagedProfileRunner(environment, protectedValues, profile.effort, runnerFactory, selectedModel);
      if (profile.credential.kind === "managed") {
        return runPortableBoardAgentStage(profileManagedRunner(profile.model), input, attempt, environment);
      }
      if (profile.credential.kind === "unavailable") {
        if (profile.fallback_policy === "managed") {
          return runPortableBoardAgentStage(profileManagedRunner(), input, attempt, environment);
        }
        throw new Error(`context_provider_configuration: ${profile.credential.reason}`);
      }
      const credential: DaytonaBoardAgentCredential =
        profile.credential.kind === "codex"
          ? { kind: "codex", authJson: profile.credential.value }
          : {
              kind: "api-key",
              environmentVariable: profile.credential.kind === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY",
              value: profile.credential.value
            };
      const selectedRunner = runnerFactory(environment, protectedValues, {
        credential,
        model: profile.credential.kind === "openrouter" ? profile.model : profile.model.replace(/^openai\//, ""),
        effort: profile.effort,
        domains:
          profile.credential.kind === "openrouter"
            ? ["openrouter.ai"]
            : profile.credential.kind === "codex"
              ? ["chatgpt.com"]
              : ["api.openai.com"]
      });
      try {
        return await runPortableBoardAgentStage(selectedRunner, input, attempt, environment);
      } catch (error) {
        if (profile.fallback_policy !== "managed" || !providerExecutionFailure(error)) throw error;
        console.warn("context_provider_fallback_started", {
          tenant_id: attempt.tenantId,
          build_id: attempt.buildId,
          provider: profile.provider,
          credential_kind: profile.credential.kind,
          consumes_organization_credits: true
        });
        return runPortableBoardAgentStage(profileManagedRunner(), input, attempt, environment);
      }
    }
  };
}

function configuredManagedProfileRunner(
  environment: WorkerEnvironment,
  protectedValues: readonly string[],
  effort: ContextExecutionProfile["effort"],
  runnerFactory: BoardAgentRunnerFactory,
  selectedModel?: string
): BoardAgentStageRunner {
  const environmentVariable = environment.CONTEXT_DAYTONA_MODEL_SECRET_ENV?.trim() || "OPENAI_API_KEY";
  if (environmentVariable !== "OPENAI_API_KEY" && environmentVariable !== "OPENROUTER_API_KEY") {
    throw new Error("CONTEXT_DAYTONA_MODEL_SECRET_ENV must be OPENAI_API_KEY or OPENROUTER_API_KEY");
  }
  const configuredModel = selectedModel ?? environment.CONTEXT_CODEX_MODEL?.trim() ?? "gpt-5.6-terra";
  if (
    environmentVariable === "OPENAI_API_KEY" &&
    configuredModel.includes("/") &&
    !configuredModel.startsWith("openai/")
  ) {
    throw new Error("the managed OpenAI credential cannot serve the selected Context model");
  }
  const managedModel =
    environmentVariable === "OPENROUTER_API_KEY"
      ? configuredModel.includes("/")
        ? configuredModel
        : `openai/${configuredModel}`
      : configuredModel.replace(/^openai\//, "");
  return runnerFactory(environment, protectedValues, {
    credential: {
      kind: "secret",
      secret: { environmentVariable, secretName: requiredDaytonaModelSecretName(environment) }
    },
    model: managedModel,
    effort,
    domains: commaSeparated(
      environment.CONTEXT_DAYTONA_MODEL_DOMAINS ??
        (environmentVariable === "OPENROUTER_API_KEY" ? "openrouter.ai" : "api.openai.com")
    )
  });
}

export interface ContextExecutionProfile {
  readonly provider: "codex" | "byok" | "managed";
  readonly model: string;
  readonly effort: "low" | "medium" | "high";
  readonly fallback_policy: "fail_notify" | "managed";
  readonly settings_revision: string;
  readonly credential:
    | { readonly kind: "managed" }
    | { readonly kind: "unavailable"; readonly reason: string }
    | { readonly kind: "openai" | "openrouter" | "codex"; readonly value: string; readonly revision: string };
}

export async function resolveContextExecutionProfile(
  environment: WorkerEnvironment,
  attempt: BoardAgentAttemptContext,
  profileFetch: ContextProfileFetch = fetch
): Promise<ContextExecutionProfile | undefined> {
  const apiUrl = (environment.JINA_PRODUCT_API_URL ?? environment.JINA_API_URL)?.trim()?.replace(/\/+$/, "");
  const token = environment.JINA_PRODUCT_INTERNAL_API_TOKEN?.trim();
  if (!token) return undefined;
  if (!apiUrl) {
    throw new Error(
      "JINA_PRODUCT_API_URL or JINA_API_URL is required when JINA_PRODUCT_INTERNAL_API_TOKEN is configured"
    );
  }
  if (!attempt.tenantId || !attempt.buildId) throw new Error("Context execution profile requires tenantId and buildId");
  let endpoint: URL;
  try {
    endpoint = new URL(`${apiUrl}/internal/context/execution-profile`);
  } catch {
    throw new Error("the product API URL must be absolute");
  }
  if (endpoint.protocol !== "https:") throw new Error("the product API URL must use HTTPS");
  const timeout = AbortSignal.timeout(15_000);
  const response = await profileFetch(endpoint.href, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: attempt.tenantId, build_id: attempt.buildId }),
    signal: attempt.signal ? AbortSignal.any([attempt.signal, timeout]) : timeout
  });
  if (!response.ok) {
    throw new Error(`Context API execution-profile request failed with ${response.status}`);
  }
  return parseContextExecutionProfile(await boundedResponseJson(response, MAX_EXECUTION_PROFILE_BYTES));
}

async function boundedResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Context execution profile response exceeds its byte bound");
  }
  if (!response.body) throw new Error("Context execution profile response is empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new Error("Context execution profile response exceeds its byte bound");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (received < 1) throw new Error("Context execution profile response is empty");
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Context execution profile response is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Context execution profile response is not valid JSON");
  }
}

function parseContextExecutionProfile(value: unknown): ContextExecutionProfile {
  const profile = exactRecord(
    value,
    ["provider", "model", "effort", "fallback_policy", "credential", "settings_revision"],
    "profile"
  );
  const provider = enumValue(profile.provider, ["codex", "byok", "managed"] as const, "provider");
  const model = boundedString(profile.model, "model", 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) {
    throw new Error("Context execution profile model is invalid");
  }
  const effort = enumValue(profile.effort, ["low", "medium", "high"] as const, "effort");
  const fallbackPolicy = enumValue(profile.fallback_policy, ["fail_notify", "managed"] as const, "fallback_policy");
  const settingsRevision = boundedString(profile.settings_revision, "settings_revision", 240);
  const credentialRecord = exactCredentialRecord(profile.credential);
  const kind = enumValue(
    credentialRecord.kind,
    ["managed", "unavailable", "openai", "openrouter", "codex"] as const,
    "credential.kind"
  );
  let credential: ContextExecutionProfile["credential"];
  if (kind === "managed") {
    credential = { kind };
  } else if (kind === "unavailable") {
    credential = { kind, reason: boundedString(credentialRecord.reason, "credential.reason", 1_000) };
  } else {
    const maximumCredentialBytes = kind === "codex" ? 32_768 : 8_192;
    const credentialValue = boundedString(credentialRecord.value, "credential.value", maximumCredentialBytes);
    if (kind === "codex") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(credentialValue) as unknown;
      } catch {
        throw new Error("Context execution profile Codex credential is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Context execution profile Codex credential must be a JSON object");
      }
    }
    credential = {
      kind,
      value: credentialValue,
      revision: boundedString(credentialRecord.revision, "credential.revision", 240)
    };
  }
  if (
    (provider === "managed" && credential.kind !== "managed") ||
    (provider === "codex" && credential.kind !== "codex" && credential.kind !== "unavailable") ||
    (provider === "byok" &&
      credential.kind !== "openai" &&
      credential.kind !== "openrouter" &&
      credential.kind !== "unavailable")
  ) {
    throw new Error("Context execution profile provider and credential are inconsistent");
  }
  if ((credential.kind === "openai" || credential.kind === "codex") && !model.startsWith("openai/")) {
    throw new Error("Context execution profile credential cannot serve the selected model");
  }
  return {
    provider,
    model,
    effort,
    fallback_policy: fallbackPolicy,
    credential,
    settings_revision: settingsRevision
  };
}

function exactCredentialRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Context execution profile credential must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "managed") return exactRecord(record, ["kind"], "credential");
  if (record.kind === "unavailable") return exactRecord(record, ["kind", "reason"], "credential");
  return exactRecord(record, ["kind", "value", "revision"], "credential");
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Context execution ${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Context execution ${name} has unexpected fields`);
  }
  return record;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Context execution profile ${name} is invalid`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`Context execution profile ${name} is invalid`);
  }
  return value;
}

function providerExecutionFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const diagnostic = message.slice(0, 12_000);
  return (
    /\b(?:quota|rate.?limit|too many requests|insufficient[_ -]quota|out of credits|credits? (?:balance|exhausted)|usage limit)\b/i.test(
      diagnostic
    ) ||
    /\b(?:unauthorized|invalid[_ -](?:api[_ -]?)?key|authentication|invalid_grant|token_expired|refresh token|logged out)\b/i.test(
      diagnostic
    ) ||
    /\b(?:unknown model|invalid model|model .{0,120}(?:not found|unavailable|unsupported))\b/i.test(diagnostic) ||
    /\b(?:upstream|service unavailable|bad gateway|gateway timeout|connection (?:reset|refused)|network unreachable|dns lookup|http (?:502|503|504))\b/i.test(
      diagnostic
    )
  );
}

/**
 * Production workers are fail-closed: Daytona must be selected explicitly.
 * Local execution is a developer/test path and is never inferred in production.
 */
export function configuredBoardAgentRunner(
  environment: WorkerEnvironment = process.env,
  protectedValues: readonly string[] = [],
  execution?: BoardAgentExecutionConfiguration
): BoardAgentStageRunner {
  const mode = environment.CONTEXT_BOARD_EXECUTOR?.trim();
  if (environment.NODE_ENV === "production" && mode !== "daytona") {
    throw new Error("CONTEXT_BOARD_EXECUTOR=daytona is required for production board agent workers");
  }
  if (!mode || mode === "local") {
    return createBoardAgentStageRunner({
      mode: "local",
      options: {
        model: (environment.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra").replace(/^openai\//, ""),
        effort: environment.CONTEXT_CODEX_EFFORT?.trim() || "low",
        verbosity: environment.CONTEXT_CODEX_VERBOSITY?.trim() || "high",
        ...(environment.CODEX_BINARY?.trim() ? { binary: environment.CODEX_BINARY.trim() } : {}),
        ...(environment.CODEX_HOME?.trim() ? { codexHome: environment.CODEX_HOME.trim() } : {}),
        protectedValues
      }
    });
  }
  if (mode !== "daytona") {
    throw new Error("CONTEXT_BOARD_EXECUTOR must be local or daytona");
  }
  const snapshot = environment.CONTEXT_DAYTONA_SNAPSHOT?.trim();
  const image = environment.CONTEXT_DAYTONA_IMAGE?.trim();
  if (Boolean(snapshot) === Boolean(image)) {
    throw new Error("Daytona board agents require exactly one CONTEXT_DAYTONA_SNAPSHOT or CONTEXT_DAYTONA_IMAGE");
  }
  if (snapshot && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshot)) {
    throw new Error("CONTEXT_DAYTONA_SNAPSHOT must name one immutable Daytona snapshot");
  }
  if (image && !/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("CONTEXT_DAYTONA_IMAGE must be pinned by sha256 digest");
  }
  const environmentVariable = environment.CONTEXT_DAYTONA_MODEL_SECRET_ENV?.trim() || "OPENAI_API_KEY";
  if (environmentVariable !== "OPENAI_API_KEY" && environmentVariable !== "OPENROUTER_API_KEY") {
    throw new Error("CONTEXT_DAYTONA_MODEL_SECRET_ENV must be OPENAI_API_KEY or OPENROUTER_API_KEY");
  }
  return createBoardAgentStageRunner({
    mode: "daytona",
    options: {
      daytonaApiKey: requiredEnvironment(environment, "DAYTONA_API_KEY"),
      ...(snapshot ? { snapshot } : { image: image! }),
      ...(execution
        ? { credential: execution.credential }
        : {
            modelSecret: {
              environmentVariable,
              secretName: requiredDaytonaModelSecretName(environment)
            }
          }),
      allowedDomains:
        execution?.domains ?? commaSeparated(environment.CONTEXT_DAYTONA_MODEL_DOMAINS ?? "api.openai.com"),
      model: execution?.model ?? (environment.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra").replace(/^openai\//, ""),
      effort: execution?.effort ?? (environment.CONTEXT_CODEX_EFFORT?.trim() || "low"),
      verbosity: environment.CONTEXT_CODEX_VERBOSITY?.trim() || "high",
      ...(environment.CODEX_BINARY?.trim() ? { binary: environment.CODEX_BINARY.trim() } : {}),
      protectedValues
    }
  });
}

export async function runPortableBoardAgentStage(
  runner: BoardAgentStageRunner,
  input: PortableAgentStageInput,
  attemptContext: BoardAgentAttemptContext,
  environment: WorkerEnvironment = process.env
): Promise<PortableAgentStageOutput> {
  const startedAt = Date.now();
  const commitSha = requiredGitSha(attemptContext.commitSha, "board agent commitSha");
  const attempt = attemptContext.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > OPERATOR_RETRY_HARD_MAX_ATTEMPTS) {
    throw new Error("board agent task attempt exceeds its bounded retry contract");
  }
  const prepared = await portableAgentWorkspace(input);
  try {
    const schema =
      input.schema ??
      (input.outputFiles?.length
        ? {
            type: "object",
            additionalProperties: false,
            required: ["completed"],
            properties: { completed: { type: "boolean", const: true } }
          }
        : {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: { text: { type: "string", minLength: 1 } }
          });
    const prompt = [
      prepared.prompt,
      input.schema === undefined && input.outputFiles?.length
        ? 'Complete the declared file work, then return exactly {"completed":true}.'
        : input.schema === undefined
          ? 'Return the requested report as the "text" field of the JSON result.'
          : ""
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await runner.run({
      id: input.id,
      prompt,
      schema,
      repository: {
        commitSha,
        archive: prepared.archive,
        sha256: createHash("sha256").update(prepared.archive).digest("hex")
      },
      artifacts: [],
      limits: {
        timeoutSeconds: input.budgetSeconds,
        contextTokens: positiveInt(environment.CONTEXT_CODEX_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS),
        compactTokens: positiveInt(environment.CONTEXT_CODEX_COMPACT_TOKENS, DEFAULT_COMPACT_TOKENS),
        attempt,
        maxAttempts: Math.max(DEFAULT_MAX_ATTEMPTS, attempt)
      },
      ...(prepared.declared.length ? { outputFiles: prepared.declared } : {}),
      ...(prepared.initial.length ? { initialOutputFiles: prepared.initial } : {}),
      ...(attemptContext.signal ? { signal: attemptContext.signal } : {})
    });
    const parsed = JSON.parse(Buffer.from(result.bytes).toString("utf8")) as Record<string, unknown>;
    assertExactReturnedFiles(result, prepared.hostOutputByPortablePath);
    await Promise.all(
      result.files.map(async (file) => {
        const hostPath = prepared.hostOutputByPortablePath.get(file.path)!;
        await mkdir(dirname(hostPath), { recursive: true });
        await writeFile(hostPath, file.bytes);
      })
    );
    return {
      text:
        input.schema === undefined && !input.outputFiles?.length
          ? requiredString(parsed.text, "board agent text")
          : Buffer.from(result.bytes).toString("utf8"),
      ...(input.schema === undefined ? {} : { parsed }),
      durationMs: Date.now() - startedAt,
      usage: result.usage
    };
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
}

interface PortableWorkspace {
  readonly root: string;
  readonly prompt: string;
  readonly archive: Uint8Array;
  readonly declared: readonly { path: string; contentType: string; maxBytes: number }[];
  readonly initial: readonly {
    name: string;
    contentType: string;
    bytes: Uint8Array;
    sha256: string;
  }[];
  readonly hostOutputByPortablePath: ReadonlyMap<string, string>;
}

async function portableAgentWorkspace(input: PortableAgentStageInput): Promise<PortableWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "jina-board-agent-input-"));
  try {
    const snapshotRoot = join(root, "snapshot");
    await mkdir(snapshotRoot, { recursive: true });
    const mappings: { host: string; portable: string }[] = [];
    await copyPortableDirectory(input.workingDirectory, join(snapshotRoot, "work"));
    mappings.push({ host: resolve(input.workingDirectory), portable: "repository/work" });
    for (const [index, directory] of (input.additionalDirectories ?? []).entries()) {
      const portable = `repository/additional/${index}`;
      await copyPortableDirectory(directory, join(snapshotRoot, "additional", String(index)));
      mappings.push({ host: resolve(directory), portable });
    }
    const writableRoots = (input.writableDirectories ?? []).map((directory) => resolve(directory));
    writableRoots.forEach((directory, index) => {
      mappings.push({ host: directory, portable: `output/writable/${index}` });
    });
    const hostOutputByPortablePath = new Map<string, string>();
    const maximumFileBytes = input.outputFiles?.length
      ? Math.min(MAX_DECLARED_FILE_BYTES, Math.floor(MAX_TOTAL_DECLARED_FILE_BYTES / input.outputFiles.length))
      : MAX_DECLARED_FILE_BYTES;
    const declared = (input.outputFiles ?? []).map((file) => {
      const hostPath = resolve(file);
      const rootIndex = writableRoots.findIndex((candidate) => insideDirectory(candidate, hostPath));
      if (rootIndex < 0) {
        throw new Error(`board agent output is outside its writable roots: ${hostPath}`);
      }
      const child = relative(writableRoots[rootIndex]!, hostPath).split("\\").join("/");
      if (!child || child.startsWith("../")) {
        throw new Error("board agent output path is invalid");
      }
      const path = `writable/${rootIndex}/${child}`;
      if (hostOutputByPortablePath.has(path)) {
        throw new Error(`duplicate board agent host output ${hostPath}`);
      }
      hostOutputByPortablePath.set(path, hostPath);
      return {
        path,
        contentType: "text/markdown",
        maxBytes: maximumFileBytes
      };
    });
    const initial = (
      await Promise.all(
        declared.map(async (file) => {
          const hostPath = hostOutputByPortablePath.get(file.path)!;
          const bytes = await readFile(hostPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          return bytes
            ? {
                name: file.path,
                contentType: file.contentType,
                bytes,
                sha256: createHash("sha256").update(bytes).digest("hex")
              }
            : undefined;
        })
      )
    ).filter((file): file is NonNullable<typeof file> => file !== undefined);
    const archivePath = join(root, "repository.tar.gz");
    await writeFile(join(snapshotRoot, "WORKSPACE"), "isolated board agent snapshot\n", "utf8");
    const entries = await readdir(snapshotRoot);
    await execFileAsync("tar", ["--format", "ustar", "-czf", archivePath, "-C", snapshotRoot, ...entries.sort()], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      maxBuffer: 10 * 1024 * 1024
    });
    const prompt = rewritePromptPaths(input.prompt, mappings);
    return {
      root,
      prompt,
      archive: await readFile(archivePath),
      declared,
      initial,
      hostOutputByPortablePath
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function assertExactReturnedFiles(
  result: BoardAgentStageResultEnvelope,
  hostOutputByPortablePath: ReadonlyMap<string, string>
): void {
  const returned = new Set<string>();
  for (const file of result.files) {
    if (!hostOutputByPortablePath.has(file.path)) {
      throw new Error(`board agent returned undeclared host output ${file.path}`);
    }
    if (returned.has(file.path)) {
      throw new Error(`board agent returned duplicate host output ${file.path}`);
    }
    returned.add(file.path);
  }
  for (const expected of hostOutputByPortablePath.keys()) {
    if (!returned.has(expected)) {
      throw new Error(`board agent omitted declared host output ${expected}`);
    }
  }
}

async function copyPortableDirectory(source: string, target: string): Promise<void> {
  const sourceRoot = resolve(source);
  await cp(sourceRoot, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (candidate) => {
      const child = relative(sourceRoot, resolve(candidate));
      return child !== ".git" && !child.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`);
    }
  });
}

function rewritePromptPaths(prompt: string, mappings: readonly { host: string; portable: string }[]): string {
  return [...mappings]
    .sort((left, right) => right.host.length - left.host.length)
    .reduce(
      (value, mapping) =>
        value.replace(
          new RegExp(`${escapeRegExp(mapping.host)}(?=$|[\\\\/\\s"'\\x60),.;:}\\]])`, "g"),
          mapping.portable
        ),
      prompt
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function insideDirectory(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function requiredEnvironment(environment: WorkerEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredDaytonaModelSecretName(environment: WorkerEnvironment): string {
  const name = requiredEnvironment(environment, "CONTEXT_DAYTONA_MODEL_SECRET");
  if (/^sk[-_]/i.test(name)) {
    throw new Error("CONTEXT_DAYTONA_MODEL_SECRET must be a Secret name, not a credential value");
  }
  return name;
}

function requiredGitSha(value: unknown, name: string): string {
  const sha = requiredString(value, name).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${name} must be a full Git SHA`);
  return sha;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeTokenSum(left: number, right: number, name: string): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    !Number.isSafeInteger(left + right)
  ) {
    throw new Error(`aggregate board agent ${name} is outside the safe integer range`);
  }
  return left + right;
}
