import { Daytona, type Resources, type Sandbox } from "@daytona/sdk";
import { knowledgeGenerationJsonSchema, type KnowledgeDocumentGenerator } from "@jina/context-engine";

const DEFAULT_IMAGE = "node:22-bookworm";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.4-mini";
const WORK_DIR = "/home/daytona/context-engine";
const CODEX_LOCAL_BIN = `${WORK_DIR}/node_modules/.bin/codex`;
const SCHEMA_PATH = `${WORK_DIR}/knowledge-document-schema.json`;
const RESULT_PATH = `${WORK_DIR}/knowledge-document-result.json`;
const PROMPT_PATH = `${WORK_DIR}/prompt.txt`;
export const UNTRUSTED_KNOWLEDGE_CODEX_ARGS = [
  "--ignore-user-config",
  "--strict-config",
  "--disable shell_tool",
  "--disable shell_snapshot",
  "--disable multi_agent",
  "--disable apps",
  "--disable browser_use",
  "--disable computer_use",
  "--disable image_generation",
  "--disable unified_exec",
  "--disable plugins",
  "--disable remote_plugin",
  "--disable hooks",
  "--disable in_app_browser",
  "--disable code_mode_host",
  "--disable workspace_dependencies",
  "--disable skill_mcp_dependency_install",
  '-c web_search="disabled"'
] as const;

/**
 * Executes one bounded knowledge-document generation in an ephemeral Daytona
 * sandbox. Citation and logical-identity validation remain host-side in
 * DeriveKnowledgeService; this adapter returns untrusted JSON only.
 */
export class DaytonaCodexKnowledgeDocumentGenerator implements KnowledgeDocumentGenerator {
  readonly name = "daytona-codex";
  readonly version = "knowledge-documents-v1";
  readonly model: string;

  constructor() {
    this.model = selectedModel(configuredProvider());
  }

  async generate(input: { readonly prompt: string; readonly repairErrors: readonly string[] }): Promise<unknown> {
    const daytonaApiKey = requiredEnv("DAYTONA_API_KEY");
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
    const provider = configuredProvider(openaiKey, openrouterKey);
    const aiKey = provider === "openai" ? openaiKey : openrouterKey;
    if (!aiKey) throw new Error(`${providerKeyName(provider)} is required for knowledge derivation`);
    const secrets = [daytonaApiKey, aiKey].filter((value): value is string => Boolean(value));
    const daytona = new Daytona({ apiKey: daytonaApiKey });
    let sandbox: Sandbox | undefined;
    try {
      const snapshot = process.env.DAYTONA_SNAPSHOT?.trim();
      const createOptions = { timeout: positiveInt(process.env.DAYTONA_SETUP_TIMEOUT_SECONDS, 300) };
      sandbox = snapshot
        ? await daytona.create(
            {
              language: "typescript",
              snapshot,
              envVars: { NODE_ENV: "production" },
              autoDeleteInterval: 60
            },
            createOptions
          )
        : await daytona.create(
            {
              language: "typescript",
              image: process.env.DAYTONA_SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE,
              resources: sandboxResources(),
              envVars: { NODE_ENV: "production" },
              autoDeleteInterval: 60
            },
            createOptions
          );

      const codexBinary = await prepareCodex(sandbox, Boolean(snapshot));
      await Promise.all([
        sandbox.fs.uploadFile(Buffer.from(JSON.stringify(knowledgeGenerationJsonSchema)), SCHEMA_PATH, 120),
        sandbox.fs.uploadFile(Buffer.from(input.prompt), PROMPT_PATH, 120)
      ]);
      const providerArguments =
        provider === "openrouter"
          ? [
              "-c model_provider=openrouter",
              "-c model_providers.openrouter.name=openrouter",
              "-c model_providers.openrouter.base_url=https://openrouter.ai/api/v1",
              "-c model_providers.openrouter.env_key=OPENROUTER_API_KEY"
            ]
          : [
              "-c model_provider=openai_direct",
              "-c model_providers.openai_direct.name=openai-direct",
              "-c model_providers.openai_direct.base_url=https://api.openai.com/v1",
              "-c model_providers.openai_direct.env_key=OPENAI_API_KEY",
              "-c model_providers.openai_direct.wire_api=responses"
            ];
      const environment = provider === "openrouter" ? { OPENROUTER_API_KEY: aiKey } : { OPENAI_API_KEY: aiKey };
      const command = [
        shellQuote(codexBinary),
        "exec",
        "--json",
        "--ephemeral",
        ...UNTRUSTED_KNOWLEDGE_CODEX_ARGS,
        "--sandbox workspace-write",
        `-C ${shellQuote(WORK_DIR)}`,
        `--output-schema ${shellQuote(SCHEMA_PATH)}`,
        `--output-last-message ${shellQuote(RESULT_PATH)}`,
        `-m ${shellQuote(this.model)}`,
        ...providerArguments,
        `-c model_context_window=${positiveInt(process.env.CONTEXT_CODEX_CONTEXT_TOKENS, 16_000)}`,
        `-c model_auto_compact_token_limit=${positiveInt(process.env.CONTEXT_CODEX_COMPACT_TOKENS, 12_000)}`,
        `-c model_reasoning_effort=${shellQuote(process.env.CONTEXT_CODEX_EFFORT?.trim() || "low")}`,
        "-c model_verbosity=low",
        `"$(cat ${shellQuote(PROMPT_PATH)})"`
      ].join(" ");

      const attempts = positiveInt(process.env.CONTEXT_CODEX_EXECUTION_ATTEMPTS, 2);
      let run: Awaited<ReturnType<Sandbox["process"]["executeCommand"]>> | undefined;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        run = await sandbox.process.executeCommand(
          command,
          WORK_DIR,
          environment,
          positiveInt(process.env.DAYTONA_RUN_TIMEOUT_SECONDS, 1_800)
        );
        if (run.exitCode === 0 || !isTransientKnowledgeGenerationFailure(run.result)) break;
        if (attempt + 1 < attempts) {
          const delay = positiveInt(process.env.CONTEXT_CODEX_RETRY_DELAY_SECONDS, 10);
          await sandbox.process.executeCommand(`sleep ${delay}`, WORK_DIR, undefined, delay + 5);
        }
      }
      if (!run || run.exitCode !== 0) {
        throw new Error(`Codex knowledge generation failed: ${redact(truncate(run?.result ?? ""), secrets)}`);
      }
      const result = await sandbox.fs.downloadFile(
        RESULT_PATH,
        positiveInt(process.env.DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS, 120)
      );
      return parseJsonResult(result.toString("utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redact(message, secrets), { cause: error });
    } finally {
      if (sandbox) await sandbox.delete(120).catch(() => undefined);
    }
  }
}

export function isTransientKnowledgeGenerationFailure(output: string): boolean {
  return /(?:reconnecting|stream disconnected|internal server error|connection (?:reset|closed)|timed? out|http (?:429|500|502|503|504)|rate limit|(?:daytona|sandbox).*(?:unavailable|failed|connection|timeout|timed out|gateway)|failed to .*sandbox)/i.test(
    output
  );
}

function configuredProvider(
  openaiKey = process.env.OPENAI_API_KEY?.trim(),
  openrouterKey = process.env.OPENROUTER_API_KEY?.trim()
): "openai" | "openrouter" {
  const configured = process.env.CONTEXT_CODEX_PROVIDER?.trim().toLowerCase();
  if (configured && configured !== "openai" && configured !== "openrouter") {
    throw new Error("CONTEXT_CODEX_PROVIDER must be openai or openrouter");
  }
  if (configured === "openai" || configured === "openrouter") return configured;
  if (openaiKey) return "openai";
  if (openrouterKey) return "openrouter";
  return "openai";
}

function selectedModel(provider: "openai" | "openrouter"): string {
  const configured = process.env.CONTEXT_CODEX_MODEL?.trim();
  if (configured) return provider === "openai" ? configured.replace(/^openai\//, "") : configured;
  return provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_OPENROUTER_MODEL;
}

function providerKeyName(provider: "openai" | "openrouter"): string {
  return provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY";
}

async function prepareCodex(sandbox: Sandbox, preferExisting: boolean): Promise<string> {
  const mkdir = await sandbox.process.executeCommand(`mkdir -p ${shellQuote(WORK_DIR)}`, undefined, undefined, 60);
  if (mkdir.exitCode !== 0) throw new Error(`Daytona workspace setup failed: ${truncate(mkdir.result)}`);
  if (preferExisting) {
    const existing = await findExistingCodex(sandbox);
    if (existing) return existing;
  }
  const install = await sandbox.process.executeCommand(
    "npm init -y >/dev/null && npm install --silent @openai/codex@0.144.0 >/dev/null",
    WORK_DIR,
    undefined,
    positiveInt(process.env.DAYTONA_SETUP_TIMEOUT_SECONDS, 600)
  );
  if (install.exitCode !== 0) throw new Error(`Codex installation failed: ${truncate(install.result)}`);
  return CODEX_LOCAL_BIN;
}

export async function findExistingCodex(sandbox: {
  readonly process: Pick<Sandbox["process"], "executeCommand">;
}): Promise<string | undefined> {
  const probe = await sandbox.process.executeCommand(
    `if ${shellQuote(CODEX_LOCAL_BIN)} --version >/dev/null 2>&1; then echo ${shellQuote(CODEX_LOCAL_BIN)}; elif command -v codex >/dev/null 2>&1 && codex --version >/dev/null 2>&1; then command -v codex; fi`,
    WORK_DIR,
    undefined,
    60
  );
  if (probe.exitCode !== 0) return undefined;
  const found = probe.result.trim().split("\n").pop()?.trim();
  return found?.startsWith("/") ? found : undefined;
}

function sandboxResources(): Resources {
  return {
    cpu: boundedPositiveInt(process.env.DAYTONA_SANDBOX_CPU, 4),
    memory: boundedPositiveInt(process.env.DAYTONA_SANDBOX_MEMORY, 8),
    disk: boundedPositiveInt(process.env.DAYTONA_SANDBOX_DISK, 10)
  };
}

function parseJsonResult(value: string): unknown {
  const trimmed = value.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  return JSON.parse(withoutFence);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the knowledge-document worker`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInt(value: string | undefined, maximum: number): number {
  return Math.min(positiveInt(value, maximum), maximum);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(value: string, maximum = 2_000): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}…`;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "***REDACTED***"), value);
}
