import { createServer } from "node:http";
import {
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReviewOutput,
  prepareDiff,
  type ReviewRequest
} from "@jina/ai";
import { DaytonaCodexOntologyExecutor } from "@jina/daytona";
import {
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  analyzeSourceBlob,
  assertionsFromGeneratedOntology,
  codeCheckpoint,
  knowledgeCheckpoint,
  languageForPath,
  type BlobAnalysis,
  type OntologyAssertionBatch,
  type OntologyBuildRequest,
  type OntologyGraph,
  type OntologyIngestPlan,
  type RepositorySnapshot
} from "@jina/ontology";

const SUPPORTED_TOPICS = [
  "run-review",
  "run-research",
  "run-publish",
  "run-cleanup",
  "run-ontology",
  "run-ontology-prepare",
  "run-ontology-generate",
  "run-ontology-ingest",
  "run-ontology-assert",
  "run-ontology-project"
] as const;
type WorkerTopic = typeof SUPPORTED_TOPICS[number];

interface ClaimedWork {
  readonly message: {
    readonly id: string;
    readonly topic: WorkerTopic;
    readonly leaseId: string;
    readonly leaseExpiresAt: string;
  };
  readonly task: {
    readonly id: string;
    readonly metadata: Record<string, unknown>;
  };
}

type WorkResult =
  | {
      readonly outcome: "done";
      readonly graph?: OntologyGraph;
      readonly assertionBatch?: OntologyAssertionBatch;
      readonly result?: Record<string, unknown>;
    }
  | { readonly outcome: "failed"; readonly reason: string };

const port = Number(process.env.PORT ?? 8080);
const apiUrl = requiredEnv("JINA_API_URL").replace(/\/$/, "");
const token = requiredEnv("INTERNAL_API_TOKEN");
const topics = configuredTopics(process.env.WORKER_TOPICS);
const workerId = process.env.WORKER_ID?.trim() || `worker-${process.pid}`;
const pollIntervalMs = positiveInt(process.env.WORKER_POLL_INTERVAL_MS, 2_000);
const heartbeatIntervalMs = positiveInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 60_000);
const ontologyExecutor = topics.some((topic) => topic === "run-ontology" || topic === "run-ontology-generate" || topic === "run-ontology-assert")
  ? new DaytonaCodexOntologyExecutor()
  : undefined;
let stopping = false;
let active = false;
let lastApiSuccessAt: string | undefined;
let lastApiError: string | undefined;

const server = createServer((request, response) => {
  if (request.url === "/health" || request.url === "/healthz") {
    response.writeHead(lastApiSuccessAt ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: Boolean(lastApiSuccessAt), workerId, topics, active, lastApiSuccessAt, lastApiError }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not found"}');
});

server.listen(port, () => {
  console.log(`worker listening on ${port} for ${topics.join(", ")}`);
  void poll();
});

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const work = await claim();
      if (work) await execute(work);
    } catch (error) {
      lastApiError = errorMessage(error);
      console.error("worker poll failed", lastApiError);
    }
    if (!stopping) await delay(pollIntervalMs);
  }
}

async function claim(): Promise<ClaimedWork | undefined> {
  const response = await apiRequest("/internal/worker/claim", { workerId, topics });
  if (response.status === 204) {
    lastApiSuccessAt = new Date().toISOString();
    lastApiError = undefined;
    return undefined;
  }
  if (!response.ok) throw new Error(`claim failed with ${response.status}: ${await response.text()}`);
  lastApiSuccessAt = new Date().toISOString();
  lastApiError = undefined;
  return await response.json() as ClaimedWork;
}

async function execute(work: ClaimedWork): Promise<void> {
  active = true;
  const heartbeat = setInterval(() => {
    void renew(work).catch((error) => {
      console.error("worker lease renewal failed", errorMessage(error));
    });
  }, heartbeatIntervalMs);
  heartbeat.unref();

  let result: WorkResult;
  try {
    result = await executeTopic(work);
  } catch (error) {
    result = { outcome: "failed", reason: errorMessage(error).slice(0, 2_000) };
  } finally {
    clearInterval(heartbeat);
  }

  try {
    await complete(work, result);
  } finally {
    active = false;
  }
}

async function executeTopic(work: ClaimedWork): Promise<WorkResult> {
  switch (work.message.topic) {
    case "run-ontology-ingest":
      return { outcome: "done", result: await runOntologyIngest(work) };
    case "run-ontology-assert":
      return await runOntologyAssertions(work);
    case "run-ontology-project":
      return { outcome: "done", result: { projected: true } };
    case "run-ontology-prepare": {
      const repository = requiredString(work.task.metadata.repository, "task repository");
      const ref = requiredString(work.task.metadata.ref, "task ref");
      const commit = await githubJson(`/repos/${repository}/commits/${encodeURIComponent(ref)}`);
      return { outcome: "done", result: { commitSha: requiredGitSha(commit.sha, "GitHub commit SHA") } };
    }
    case "run-ontology": {
      if (!ontologyExecutor) throw new Error("ontology executor is not configured for this worker");
      const request: OntologyBuildRequest = {
        tenantId: requiredString(work.task.metadata.tenantId, "task tenantId"),
        repository: requiredString(work.task.metadata.repository, "task repository"),
        ref: requiredString(work.task.metadata.ref, "task ref"),
        taskId: work.task.id
      };
      return { outcome: "done", graph: await ontologyExecutor.build(request) };
    }
    case "run-ontology-generate": {
      if (!ontologyExecutor) throw new Error("ontology executor is not configured for this worker");
      const request: OntologyBuildRequest = {
        tenantId: requiredString(work.task.metadata.tenantId, "task tenantId"),
        repository: requiredString(work.task.metadata.repository, "task repository"),
        ref: requiredString(work.task.metadata.ref, "task ref"),
        commitSha: requiredGitSha(work.task.metadata.commitSha, "task commitSha"),
        taskId: work.task.id
      };
      return { outcome: "done", graph: await ontologyExecutor.build(request) };
    }
    case "run-review":
      return { outcome: "done", result: await runReview(work) };
    case "run-research":
      return {
        outcome: "done",
        result: {
          question: stringValue(work.task.metadata.question),
          sources: stringArray(work.task.metadata.sourceUrls),
          note: "Context request recorded for the review worker"
        }
      };
    case "run-publish":
      return { outcome: "done", result: { published: true, target: "summary" } };
    case "run-cleanup":
      return { outcome: "done", result: { cleaned: true } };
  }
}

async function runOntologyIngest(work: ClaimedWork): Promise<Record<string, unknown>> {
  const tenantId = requiredString(work.task.metadata.tenantId, "task tenantId");
  const repository = requiredString(work.task.metadata.repository, "task repository");
  const ref = requiredString(work.task.metadata.ref, "task ref");
  const commit = await githubJson(`/repos/${repository}/commits/${encodeURIComponent(ref)}`);
  const commitSha = requiredGitSha(commit.sha, "GitHub commit SHA");
  const commitDetails = isRecord(commit.commit) ? commit.commit : {};
  const treeDetails = isRecord(commitDetails.tree) ? commitDetails.tree : {};
  const treeSha = requiredGitSha(treeDetails.sha, "GitHub tree SHA");
  const tree = await githubJson(`/repos/${repository}/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated === true) throw new Error("GitHub repository tree is truncated; refusing a partial Ontology ingestion");
  const entries = Array.isArray(tree.tree) ? tree.tree : [];
  const files = entries.flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "blob") return [];
    return [{
      path: requiredString(entry.path, "GitHub tree path"),
      blobSha: requiredGitSha(entry.sha, "GitHub blob SHA"),
      size: typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : 0
    }];
  });
  const snapshot: RepositorySnapshot = {
    tenantId,
    repository,
    ref,
    commitSha,
    treeSha,
    parents: (Array.isArray(commit.parents) ? commit.parents : []).map((parent) => {
      if (!isRecord(parent)) throw new Error("GitHub commit parent is invalid");
      return requiredGitSha(parent.sha, "GitHub parent SHA");
    }),
    recordedAt: new Date().toISOString(),
    taskId: work.task.id,
    files
  };
  const lease = { messageId: work.message.id, leaseId: work.message.leaseId };
  const plan = await internalApiJson<OntologyIngestPlan>("/internal/ontology/ingest/plan", { ...lease, snapshot });
  const analyses: BlobAnalysis[] = [];
  for (const missing of plan.missingBlobs) {
    analyses.push(await analyzeGitHubBlob(repository, missing));
    if (analyses.length >= 50) {
      await submitBlobAnalyses(work, commitSha, analyses.splice(0));
    }
  }
  if (analyses.length > 0) await submitBlobAnalyses(work, commitSha, analyses);
  return {
    observationId: plan.observationId,
    commitSha,
    fileCount: plan.fileCount,
    discoveredBlobCount: plan.discoveredBlobCount,
    reusedBlobCount: plan.reusedBlobCount,
    parsedBlobCount: plan.missingBlobs.length,
    analysisPaths: plan.changedPaths,
    parserVersion: ONTOLOGY_PARSER_VERSION,
    codeCheckpoint: codeCheckpoint(tenantId, repository, commitSha, ONTOLOGY_PARSER_VERSION)
  };
}

async function runOntologyAssertions(work: ClaimedWork): Promise<WorkResult> {
  if (!ontologyExecutor) throw new Error("ontology executor is not configured for this worker");
  const tenantId = requiredString(work.task.metadata.tenantId, "task tenantId");
  const repository = requiredString(work.task.metadata.repository, "task repository");
  const ref = requiredString(work.task.metadata.ref, "task ref");
  const commitSha = requiredGitSha(work.task.metadata.commitSha, "task commitSha");
  const focusPaths = stringArray(work.task.metadata.analysisPaths);
  const cache = await internalApiJson<{ readonly cached: Record<string, unknown> | null }>(
    "/internal/ontology/assertions/cached",
    { taskId: work.task.id, messageId: work.message.id, leaseId: work.message.leaseId, commitSha }
  );
  if (cache.cached) return { outcome: "done", result: { cached: cache.cached } };
  if (focusPaths.length === 0) {
    return {
      outcome: "done",
      result: {
        cached: {
          observationId: "none",
          assertionCount: 0,
          activeCount: 0,
          proposedCount: 0,
          knowledgeCheckpoint: knowledgeCheckpoint(tenantId, repository, commitSha, ONTOLOGY_GENERATOR_VERSION),
          cached: true
        }
      }
    };
  }
  const graph = await ontologyExecutor.buildAssertions({ tenantId, repository, ref, commitSha, focusPaths, taskId: work.task.id });
  const rawOutput = { summary: graph.summary, nodes: graph.nodes, edges: graph.edges };
  const assertions = assertionsFromGeneratedOntology(rawOutput, repository);
  return {
    outcome: "done",
    assertionBatch: {
      tenantId,
      repository,
      ref,
      commitSha,
      taskId: work.task.id,
      generatedAt: graph.generatedAt,
      generatorVersion: ONTOLOGY_GENERATOR_VERSION,
      registryVersion: "ontology-registry-v1",
      model: graph.generator.model,
      ...(graph.generator.sandboxId ? { sandboxId: graph.generator.sandboxId } : {}),
      summary: graph.summary,
      rawOutput,
      assertions
    }
  };
}

async function analyzeGitHubBlob(
  repository: string,
  input: { readonly blobSha: string; readonly path: string; readonly size: number }
): Promise<BlobAnalysis> {
  const language = languageForPath(input.path);
  if (!language || input.size > 512_000) {
    return { blobSha: input.blobSha, parserVersion: ONTOLOGY_PARSER_VERSION, symbols: [], imports: [] };
  }
  const blob = await githubJson(`/repos/${repository}/git/blobs/${input.blobSha}`);
  if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`GitHub blob ${input.blobSha} is not base64 encoded`);
  const source = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
  return analyzeSourceBlob(input.blobSha, language, source);
}

async function submitBlobAnalyses(work: ClaimedWork, commitSha: string, analyses: readonly BlobAnalysis[]): Promise<void> {
  await internalApiJson("/internal/ontology/ingest/blobs", {
    taskId: work.task.id,
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    commitSha,
    analyses
  });
}

async function internalApiJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const response = await apiRequest(path, body);
  if (!response.ok) throw new Error(`Ontology API ${path} failed with ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function runReview(work: ClaimedWork): Promise<Record<string, unknown>> {
  const repository = requiredString(work.task.metadata.repository, "task repository");
  const pullRequestNumber = requiredPositiveInteger(work.task.metadata.pullRequestNumber, "task pullRequestNumber");
  const [pullRequest, diff] = await Promise.all([
    githubJson(`/repos/${repository}/pulls/${pullRequestNumber}`),
    githubText(`/repos/${repository}/pulls/${pullRequestNumber}`, "application/vnd.github.v3.diff")
  ]);
  const reviewRequest: ReviewRequest = {
    repository,
    pullRequestNumber,
    title: typeof pullRequest.title === "string" ? pullRequest.title : `Pull request #${pullRequestNumber}`,
    diff
  };
  const prepared = prepareDiff(reviewRequest.diff);
  const model = process.env.REVIEW_MODEL?.trim() || "gpt-5.6-sol";
  const openAiApiUrl = (process.env.OPENAI_API_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${openAiApiUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: REVIEW_SYSTEM_PROMPT,
      input: buildReviewPrompt(reviewRequest, prepared),
      text: {
        format: {
          type: "json_schema",
          name: "review_findings",
          schema: REVIEW_FINDINGS_SCHEMA,
          strict: true
        }
      },
      store: false
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000)
  });
  if (!response.ok) throw new Error(`OpenAI review failed with ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
  const payload = await response.json() as Record<string, unknown>;
  const outputText = extractOutputText(payload);
  const parsed = parseReviewOutput(outputText);
  return {
    model,
    summary: parsed.summary,
    findingCount: parsed.findings.length,
    findings: parsed.findings,
    diffTruncated: prepared.truncated
  };
}

async function renew(work: ClaimedWork): Promise<void> {
  const response = await apiRequest("/internal/worker/renew", {
    messageId: work.message.id,
    leaseId: work.message.leaseId
  });
  if (!response.ok) throw new Error(`renewal failed with ${response.status}: ${await response.text()}`);
  lastApiSuccessAt = new Date().toISOString();
  lastApiError = undefined;
}

async function complete(work: ClaimedWork, result: WorkResult): Promise<void> {
  const response = await apiRequest("/internal/worker/complete", {
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    taskId: work.task.id,
    ...result
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`completion failed with ${response.status}: ${await response.text()}`);
  }
  if (response.ok) {
    lastApiSuccessAt = new Date().toISOString();
    lastApiError = undefined;
  }
}

function apiRequest(path: string, body: unknown): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
}

async function githubJson(path: string): Promise<Record<string, unknown>> {
  const response = await githubRequest(path, "application/vnd.github+json");
  return await response.json() as Record<string, unknown>;
}

async function githubText(path: string, accept: string): Promise<string> {
  const response = await githubRequest(path, accept);
  return response.text();
}

async function githubRequest(path: string, accept: string): Promise<Response> {
  const githubToken = process.env.GITHUB_CLONE_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  const githubApiUrl = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(`${githubApiUrl}${path}`, {
    headers: {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "jina-review-worker",
      ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
    },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`GitHub request failed with ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
  return response;
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string" && content.text.trim()) return content.text;
    }
  }
  throw new Error("OpenAI response did not contain output text");
}

function configuredTopics(value: string | undefined): WorkerTopic[] {
  const requested = (value ?? "run-review,run-research,run-publish,run-cleanup")
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
  const selected = requested.filter((topic): topic is WorkerTopic => SUPPORTED_TOPICS.includes(topic as WorkerTopic));
  if (selected.length === 0 || selected.length !== requested.length) {
    throw new Error(`WORKER_TOPICS must contain only: ${SUPPORTED_TOPICS.join(", ")}`);
  }
  return [...new Set(selected)];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is required`);
  return value;
}

function requiredGitSha(value: unknown, name: string): string {
  const sha = requiredString(value, name);
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`${name} must be a full Git SHA`);
  return sha;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    server.close(() => undefined);
  });
}
