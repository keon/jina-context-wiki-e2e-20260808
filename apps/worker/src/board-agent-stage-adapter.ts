import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createBoardAgentStageRunner,
  type BoardAgentModelUsage,
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

type WorkerEnvironment = Readonly<Record<string, string | undefined>>;

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
  readonly signal?: AbortSignal;
}

export interface PortableBoardAgentConfiguration {
  readonly environment?: WorkerEnvironment;
  readonly protectedValues?: readonly string[];
  readonly attemptContext: () => BoardAgentAttemptContext;
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
  const runner = configuredBoardAgentRunner(environment, configuration.protectedValues ?? []);
  return {
    run: (input) => runPortableBoardAgentStage(runner, input, configuration.attemptContext(), environment)
  };
}

/**
 * Production workers are fail-closed: Daytona must be selected explicitly.
 * Local execution is a developer/test path and is never inferred in production.
 */
export function configuredBoardAgentRunner(
  environment: WorkerEnvironment = process.env,
  protectedValues: readonly string[] = []
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
      modelSecret: {
        environmentVariable,
        secretName: requiredDaytonaModelSecretName(environment)
      },
      allowedDomains: commaSeparated(environment.CONTEXT_DAYTONA_MODEL_DOMAINS ?? "api.openai.com"),
      model: (environment.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra").replace(/^openai\//, ""),
      effort: environment.CONTEXT_CODEX_EFFORT?.trim() || "low",
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
