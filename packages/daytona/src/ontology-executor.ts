import { Daytona, type Resources, type Sandbox } from "@daytona/sdk";
import {
  ONTOLOGY_OUTPUT_SCHEMA,
  ONTOLOGY_SYSTEM_PROMPT,
  createOntologyGraph,
  parseGeneratedOntology,
  validateOntologyEvidence,
  type OntologyBuildRequest,
  type OntologyExecutor,
  type OntologyGraph
} from "@jina/ontology";

const DEFAULT_IMAGE = "node:22-bookworm";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.4-mini";
const WORK_DIR = "/home/daytona/ontology";
const REPO_DIR = `${WORK_DIR}/repo`;
const SCHEMA_PATH = `${WORK_DIR}/ontology-schema.json`;
const RESULT_PATH = `${WORK_DIR}/ontology-result.json`;
const PROMPT_PATH = `${WORK_DIR}/prompt.txt`;
const PROXY_PATH = `${WORK_DIR}/openrouter-proxy.mjs`;
const PROXY_PORT = 43123;

export class DaytonaCodexOntologyExecutor implements OntologyExecutor {
  async build(request: OntologyBuildRequest): Promise<OntologyGraph> {
    const daytonaApiKey = requiredEnv("DAYTONA_API_KEY");
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
    const provider = selectProvider(openaiKey, openrouterKey);
    const aiKey = provider === "openai" ? openaiKey : openrouterKey;
    if (!aiKey) throw new Error(`${provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"} is required for the Daytona Ontology worker`);
    const cloneToken = process.env.GITHUB_CLONE_TOKEN || process.env.GITHUB_TOKEN;
    const model = selectedModel(provider);
    const secrets = [daytonaApiKey, aiKey, cloneToken].filter((value): value is string => Boolean(value));

    const daytona = new Daytona({ apiKey: daytonaApiKey });
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await daytona.create(
        {
          language: "typescript",
          image: process.env.DAYTONA_SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE,
          resources: sandboxResources(),
          envVars: { NODE_ENV: "production" },
          autoDeleteInterval: 60
        },
        { timeout: positiveInt(process.env.DAYTONA_SETUP_TIMEOUT_SECONDS, 300) }
      );

      await cloneRepository(sandbox, request, cloneToken);
      if (request.commitSha) await checkoutExpectedCommit(sandbox, request.commitSha);
      await prepareCodex(sandbox);
      await writeInputFiles(sandbox, request);
      if (provider === "openrouter") await startOutputLimitingProxy(sandbox);

      const providerArguments = provider === "openrouter"
        ? [
            "-c model_provider=openrouter",
            "-c model_providers.openrouter.name=openrouter",
            `-c model_providers.openrouter.base_url=http://127.0.0.1:${PROXY_PORT}/api/v1`,
            "-c model_providers.openrouter.env_key=OPENROUTER_API_KEY"
          ]
        : [
            "-c model_provider=openai_direct",
            "-c model_providers.openai_direct.name=openai-direct",
            "-c model_providers.openai_direct.base_url=https://api.openai.com/v1",
            "-c model_providers.openai_direct.env_key=OPENAI_API_KEY",
            "-c model_providers.openai_direct.wire_api=responses"
          ];
      const providerEnvironment = provider === "openrouter"
        ? { OPENROUTER_API_KEY: aiKey }
        : { OPENAI_API_KEY: aiKey };

      const run = await sandbox.process.executeCommand(
        [
          `${WORK_DIR}/node_modules/.bin/codex`,
          "exec",
          "--json",
          "--ephemeral",
          "--sandbox workspace-write",
          `-C ${shellQuote(REPO_DIR)}`,
          `--output-schema ${shellQuote(SCHEMA_PATH)}`,
          `--output-last-message ${shellQuote(RESULT_PATH)}`,
          `-m ${shellQuote(model)}`,
          ...providerArguments,
          `-c model_context_window=${positiveInt(process.env.ONTOLOGY_CODEX_CONTEXT_TOKENS, 6_000)}`,
          `-c model_auto_compact_token_limit=${positiveInt(process.env.ONTOLOGY_CODEX_COMPACT_TOKENS, 4_500)}`,
          `-c model_reasoning_effort=${shellQuote(process.env.ONTOLOGY_CODEX_EFFORT?.trim() || "low")}`,
          "-c model_verbosity=low",
          `"$(cat ${shellQuote(PROMPT_PATH)})"`
        ].join(" "),
        REPO_DIR,
        providerEnvironment,
        positiveInt(process.env.DAYTONA_RUN_TIMEOUT_SECONDS, 1_800)
      );

      if (run.exitCode !== 0) {
        throw new Error(`Codex ontology build failed: ${redact(truncate(run.result), secrets)}`);
      }

      const [resultBuffer, shaResult] = await Promise.all([
        sandbox.fs.downloadFile(RESULT_PATH, positiveInt(process.env.DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS, 120)),
        sandbox.process.executeCommand("git rev-parse HEAD", REPO_DIR, undefined, 60)
      ]);
      if (shaResult.exitCode !== 0) {
        throw new Error(`Unable to resolve repository commit: ${truncate(shaResult.result)}`);
      }
      const commitSha = shaResult.result.trim();
      if (request.commitSha && commitSha !== request.commitSha) {
        throw new Error(`Repository ref moved before checkout: expected ${request.commitSha}, got ${commitSha}`);
      }

      const generated = parseGeneratedOntology(parseJsonResult(resultBuffer.toString("utf8")));
      await validateOntologyEvidence(generated, async (path) => {
        const contents = await sandbox!.fs.downloadFile(`${REPO_DIR}/${path}`, 120);
        return contents.toString("utf8");
      });
      return createOntologyGraph({
        request,
        commitSha,
        generatedAt: new Date().toISOString(),
        executor: "daytona",
        model,
        sandboxId: sandbox.id,
        generated
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redact(message, secrets));
    } finally {
      if (sandbox) {
        await sandbox.delete(120).catch(() => undefined);
      }
    }
  }
}

function selectProvider(openaiKey?: string, openrouterKey?: string): "openai" | "openrouter" {
  const configured = process.env.ONTOLOGY_CODEX_PROVIDER?.trim().toLowerCase();
  if (configured && configured !== "openai" && configured !== "openrouter") {
    throw new Error("ONTOLOGY_CODEX_PROVIDER must be openai or openrouter");
  }
  if (configured === "openai" || configured === "openrouter") return configured;
  if (openaiKey) return "openai";
  if (openrouterKey) return "openrouter";
  throw new Error("OPENAI_API_KEY or OPENROUTER_API_KEY is required for the Daytona Ontology worker");
}

function selectedModel(provider: "openai" | "openrouter"): string {
  const configured = process.env.ONTOLOGY_CODEX_MODEL?.trim();
  if (configured) return provider === "openai" ? configured.replace(/^openai\//, "") : configured;
  return provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_OPENROUTER_MODEL;
}

async function cloneRepository(sandbox: Sandbox, request: OntologyBuildRequest, token?: string): Promise<void> {
  const url = `https://github.com/${request.repository}.git`;
  await sandbox.git.clone(url, REPO_DIR, request.ref, undefined, token ? "x-access-token" : undefined, token);
}

async function checkoutExpectedCommit(sandbox: Sandbox, commitSha: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error("Ontology source commit must be a full Git SHA");
  const ensureCommit = await sandbox.process.executeCommand(
    `git cat-file -e ${shellQuote(`${commitSha}^{commit}`)} || git fetch --depth=1 origin ${shellQuote(commitSha)}`,
    REPO_DIR,
    undefined,
    60
  );
  if (ensureCommit.exitCode !== 0) {
    throw new Error(`Unable to fetch prepared commit ${commitSha}: ${truncate(ensureCommit.result)}`);
  }
  const checkout = await sandbox.process.executeCommand(
    `git checkout --detach ${shellQuote(commitSha)}`,
    REPO_DIR,
    undefined,
    60
  );
  if (checkout.exitCode !== 0) {
    throw new Error(`Unable to checkout prepared commit ${commitSha}: ${truncate(checkout.result)}`);
  }
}

async function prepareCodex(sandbox: Sandbox): Promise<void> {
  const mkdir = await sandbox.process.executeCommand(`mkdir -p ${shellQuote(WORK_DIR)}`, undefined, undefined, 60);
  if (mkdir.exitCode !== 0) throw new Error(`Daytona workspace setup failed: ${truncate(mkdir.result)}`);
  const install = await sandbox.process.executeCommand(
    "npm init -y >/dev/null && npm install --silent @openai/codex@0.144.0 >/dev/null",
    WORK_DIR,
    undefined,
    positiveInt(process.env.DAYTONA_SETUP_TIMEOUT_SECONDS, 600)
  );
  if (install.exitCode !== 0) throw new Error(`Codex installation failed: ${truncate(install.result)}`);
}

async function writeInputFiles(sandbox: Sandbox, request: OntologyBuildRequest): Promise<void> {
  const prompt = `${ONTOLOGY_SYSTEM_PROMPT}\n\nRepository: ${request.repository}\nRef: ${request.ref}\nTask: ${request.taskId}`;
  await Promise.all([
    sandbox.fs.uploadFile(Buffer.from(JSON.stringify(ONTOLOGY_OUTPUT_SCHEMA)), SCHEMA_PATH, 120),
    sandbox.fs.uploadFile(Buffer.from(prompt), PROMPT_PATH, 120),
    sandbox.fs.uploadFile(Buffer.from(openrouterProxySource()), PROXY_PATH, 120)
  ]);
}

async function startOutputLimitingProxy(sandbox: Sandbox): Promise<void> {
  const maxOutputTokens = positiveInt(process.env.ONTOLOGY_CODEX_MAX_OUTPUT_TOKENS, 4_000);
  const started = await sandbox.process.executeCommand(
    `nohup node ${shellQuote(PROXY_PATH)} > ${shellQuote(`${WORK_DIR}/proxy.log`)} 2>&1 &`,
    WORK_DIR,
    { ONTOLOGY_PROXY_PORT: String(PROXY_PORT), ONTOLOGY_MAX_OUTPUT_TOKENS: String(maxOutputTokens) },
    30
  );
  if (started.exitCode !== 0) throw new Error(`OpenRouter proxy failed to start: ${truncate(started.result)}`);
  const health = await sandbox.process.executeCommand(
    `node -e "fetch('http://127.0.0.1:${PROXY_PORT}/health').then(r=>{if(!r.ok)process.exit(1)})"`,
    WORK_DIR,
    undefined,
    30
  );
  if (health.exitCode !== 0) throw new Error("OpenRouter output-limiting proxy did not become healthy");
}

function openrouterProxySource(): string {
  return `import http from "node:http";
import https from "node:https";

const port = Number(process.env.ONTOLOGY_PROXY_PORT || "${PROXY_PORT}");
const maximum = Number(process.env.ONTOLOGY_MAX_OUTPUT_TOKENS || "4000");

http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    let body = Buffer.concat(chunks);
    if ((request.headers["content-type"] || "").includes("application/json") && body.length) {
      const value = JSON.parse(body.toString("utf8"));
      if (typeof value.max_output_tokens !== "number" || value.max_output_tokens > maximum) value.max_output_tokens = maximum;
      if (typeof value.max_tokens === "number" && value.max_tokens > maximum) value.max_tokens = maximum;
      body = Buffer.from(JSON.stringify(value));
    }
    const headers = { ...request.headers, host: "openrouter.ai", "content-length": String(body.length) };
    delete headers.connection;
    const upstream = https.request({
      hostname: "openrouter.ai",
      port: 443,
      method: request.method,
      path: request.url,
      headers
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    });
    upstream.end(body);
  });
}).listen(port, "127.0.0.1");`;
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
  if (!value) throw new Error(`${name} is required for the Daytona Ontology worker`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
