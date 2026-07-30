import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AGENT_KNOWLEDGE_CODEX_ARGS, KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS } from "./agent-stage-contract.js";

export interface LocalAgentStageInput {
  readonly id: string;
  readonly prompt: string;
  readonly schema?: unknown;
  readonly workingDirectory: string;
  readonly additionalDirectories?: readonly string[];
  readonly writableDirectories?: readonly string[];
  readonly readOnly?: boolean;
  readonly budgetSeconds: number;
}

export interface LocalAgentStageOutput {
  readonly text: string;
  readonly parsed?: unknown;
  readonly durationMs: number;
}

export interface LocalCodexAgentStageRunnerOptions {
  readonly binary?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly verbosity?: string;
}

/**
 * Runs one bounded board work unit in a fresh Codex process.
 *
 * It deliberately disables Codex's own multi-agent surface: board tasks are the
 * production fan-out and checkpoint boundary, so an invisible nested scheduler
 * would defeat leases, retries, observability, and per-stage sandbox isolation.
 */
export class LocalCodexAgentStageRunner {
  readonly binary: string;
  readonly model: string;
  readonly effort: string;
  readonly verbosity: string;

  constructor(options: LocalCodexAgentStageRunnerOptions = {}) {
    this.binary = options.binary?.trim() || process.env.CODEX_BINARY?.trim() || "codex";
    this.model = (options.model?.trim() || process.env.CONTEXT_CODEX_MODEL?.trim() || "gpt-5.6-terra").replace(
      /^openai\//,
      ""
    );
    this.effort = options.effort?.trim() || process.env.CONTEXT_CODEX_EFFORT?.trim() || "low";
    this.verbosity = options.verbosity?.trim() || process.env.CONTEXT_CODEX_VERBOSITY?.trim() || "high";
  }

  async run(input: LocalAgentStageInput): Promise<LocalAgentStageOutput> {
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(input.id)) throw new Error("agent stage id is invalid");
    if (!input.prompt.trim()) throw new Error("agent stage prompt is required");
    if (!Number.isSafeInteger(input.budgetSeconds) || input.budgetSeconds < 30 || input.budgetSeconds > 7_200) {
      throw new Error("agent stage budget must be between 30 and 7200 seconds");
    }
    const directories = [
      input.workingDirectory,
      ...(input.additionalDirectories ?? []),
      ...(input.writableDirectories ?? [])
    ];
    if (directories.some((directory) => !isAbsolute(directory))) {
      throw new Error("agent stage directories must be absolute");
    }
    if (!input.readOnly && (input.writableDirectories?.length ?? 0) === 0) {
      throw new Error("a writable agent stage requires an explicit writable root");
    }

    const runDirectory = await mkdtemp(join(tmpdir(), "jina-context-stage-"));
    const resultPath = join(runDirectory, "result.txt");
    const schemaPath = input.schema === undefined ? undefined : join(runDirectory, "schema.json");
    const transcriptPath = join(runDirectory, "transcript.log");
    const startedAt = Date.now();
    try {
      if (schemaPath) await writeFile(schemaPath, `${JSON.stringify(input.schema, null, 2)}\n`, "utf8");
      const stageArguments = AGENT_KNOWLEDGE_CODEX_ARGS.filter(
        (argument) => argument !== "--enable multi_agent"
      ).flatMap(expandCodexArgument);
      const args = [
        "exec",
        "--json",
        ...stageArguments,
        "--disable",
        "multi_agent",
        ...(input.additionalDirectories ?? []).flatMap((directory) => ["--add-dir", directory]),
        ...(input.readOnly
          ? ["--sandbox", "read-only"]
          : [
              "--sandbox",
              "workspace-write",
              "-c",
              `sandbox_workspace_write.writable_roots=${JSON.stringify(input.writableDirectories)}`
            ]),
        "-c",
        `developer_instructions=${KNOWLEDGE_AGENT_STAGE_DEVELOPER_INSTRUCTIONS}`,
        "-C",
        input.workingDirectory,
        "-m",
        this.model,
        "-c",
        `model_context_window=${positiveInt(process.env.CONTEXT_CODEX_CONTEXT_TOKENS, 64_000)}`,
        "-c",
        `model_auto_compact_token_limit=${positiveInt(process.env.CONTEXT_CODEX_COMPACT_TOKENS, 48_000)}`,
        "-c",
        `model_reasoning_effort=${this.effort}`,
        "-c",
        `model_verbosity=${this.verbosity}`,
        ...(schemaPath ? ["--output-schema", schemaPath] : []),
        "--output-last-message",
        resultPath
      ];
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? homedir(),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...(process.env.CONTEXT_CODEX_AUTH === "api-key" && process.env.OPENAI_API_KEY
          ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
          : {})
      };
      const run = await spawnCodex({
        binary: this.binary,
        args,
        prompt: [
          input.prompt,
          `This stage has a ${input.budgetSeconds}-second hard wall clock. Finish inspection early enough to return the requested result before termination.`
        ].join("\n\n"),
        environment,
        transcriptPath,
        timeoutMs: input.budgetSeconds * 1_000
      });
      if (run.exitCode !== 0) {
        const transcript = await readFile(transcriptPath, "utf8").catch(() => "");
        throw new Error(
          run.timedOut
            ? `agent stage ${input.id} exceeded its ${input.budgetSeconds}s budget`
            : `agent stage ${input.id} exited with ${run.exitCode}: ${transcript.slice(-2_000)}`
        );
      }
      const text = (await readFile(resultPath, "utf8")).trim();
      if (!text) throw new Error(`agent stage ${input.id} returned an empty result`);
      return {
        text,
        ...(input.schema === undefined ? {} : { parsed: JSON.parse(text) as unknown }),
        durationMs: Date.now() - startedAt
      };
    } finally {
      await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function spawnCodex(input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly transcriptPath: string;
  readonly timeoutMs: number;
}): Promise<{ readonly exitCode: number; readonly timedOut: boolean }> {
  const child = spawn(input.binary, [...input.args], {
    env: input.environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let transcript = "";
  const append = (chunk: Buffer | string): void => {
    transcript = `${transcript}${String(chunk)}`.slice(-200_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.stdin.end(input.prompt);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, input.timeoutMs);
  timeout.unref();
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));
  await writeFile(input.transcriptPath, transcript, "utf8");
  return { exitCode, timedOut };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function expandCodexArgument(value: string): string[] {
  for (const prefix of ["--enable ", "--disable ", "-c "] as const) {
    if (value.startsWith(prefix)) return [prefix.trim(), value.slice(prefix.length)];
  }
  return [value];
}
