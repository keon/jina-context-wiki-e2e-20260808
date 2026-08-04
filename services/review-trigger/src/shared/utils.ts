import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";

const moduleRequire = createRequire(import.meta.url);

export type CommandResult = {
  stdout: string;
  stderr: string;
};

const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const CLEANUP_MAX_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 200;
export const WORKER_WARNING_PREFIX = "__JINA_WORKER_WARNING__";

export type CleanupWarning = {
  event: "temp_workspace_cleanup_failed_nonfatal";
  label: string;
  path: string;
  code?: string;
  message: string;
  maxRetries: number;
  retryDelay: number;
};

type CleanupRemoveOptions = {
  recursive: true;
  force: true;
  maxRetries: number;
  retryDelay: number;
};

export type CleanupDeps = {
  remove?: (targetPath: string, options: CleanupRemoveOptions) => Promise<void>;
  warn?: (warning: CleanupWarning) => void | Promise<void>;
};

/**
 * Spawn a child process, capturing stdout/stderr (bounded by `maxBufferBytes`).
 * Resolves with the captured output on exit code 0, otherwise rejects. Also
 * rejects on spawn error or if the process exceeds `timeoutMs`.
 */
export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
    maxBufferBytes?: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= maxBufferBytes) {
        stdout.push(chunk);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maxBufferBytes) {
        stderr.push(chunk);
      }
    });

    // A short-lived command can close its input before Node finishes flushing
    // the pipe. EPIPE is not the command result: the close event below still
    // carries the authoritative exit code and captured diagnostics.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
        return;
      }
      clearTimeout(timeout);
      reject(error);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };

      if (code === 0) {
        resolve(result);
        return;
      }

      reject(new Error(`${command} exited with ${code}: ${result.stderr || result.stdout}`));
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Normalize an unknown thrown value into a human-readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort cleanup for transient review workspaces. Once a phase result has
 * been produced, cleanup failures should be observable but must not convert the
 * review into a failure.
 */
export async function cleanupTransientPath(
  targetPath: string,
  label: string,
  deps: CleanupDeps = {},
): Promise<CleanupWarning | undefined> {
  const remove = deps.remove ?? ((pathToRemove: string, options: CleanupRemoveOptions) => rm(pathToRemove, options));
  const warn = deps.warn ?? defaultCleanupWarningSink;

  try {
    await remove(targetPath, {
      recursive: true,
      force: true,
      maxRetries: CLEANUP_MAX_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS,
    });
    return undefined;
  } catch (error) {
    const warning: CleanupWarning = {
      event: "temp_workspace_cleanup_failed_nonfatal",
      label,
      path: targetPath,
      code: errorCode(error),
      message: errorMessage(error),
      maxRetries: CLEANUP_MAX_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS,
    };
    await warn(warning);
    return warning;
  }
}

function defaultCleanupWarningSink(warning: CleanupWarning): void {
  console.log(`${WORKER_WARNING_PREFIX}${JSON.stringify(warning)}`);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function envSetting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

// Codex model settings for active review stages. Defaults are OpenRouter slugs
// now that OpenRouter is the model gateway; per-tenant overrides flow through the
// same env vars from the stage payload.
export function reviewCodexModel(env: NodeJS.ProcessEnv = process.env): string {
  return envSetting(env, "REVIEW_CODEX_MODEL") || "openai/gpt-5.6-luna";
}

export function runtimePlannerModel(env: NodeJS.ProcessEnv = process.env): string {
  return envSetting(env, "RUNTIME_PLANNER_MODEL") || "openai/gpt-5.6-sol";
}

export function runtimeAgentModel(env: NodeJS.ProcessEnv = process.env): string {
  return envSetting(env, "RUNTIME_AGENT_MODEL") || "openai/gpt-5.6-luna";
}

export function runtimeMentalTraceModel(env: NodeJS.ProcessEnv = process.env): string {
  return envSetting(env, "RUNTIME_MENTAL_TRACE_MODEL") || "openai/gpt-5.6-luna";
}

/** Git env that authenticates HTTPS GitHub access with an installation token. */
export function githubGitEnv(token: string): NodeJS.ProcessEnv {
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");

  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Resolve the packaged Codex CLI entrypoint. */
export function codexCliPath(): string {
  return moduleRequire.resolve("@openai/codex/bin/codex.js");
}

/** Whether a CODEX_BIN value refers to the packaged Codex CLI rather than a custom binary. */
export function usesPackagedCodex(value: string): boolean {
  return value === "@openai/codex" || value === "node-package";
}
