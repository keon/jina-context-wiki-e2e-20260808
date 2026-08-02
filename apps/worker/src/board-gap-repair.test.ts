import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { boardPageAuditInventory, boardPublicPageDigest } from "@jina/daytona";

const execFileAsync = promisify(execFile);

test("board gap repair reuses its prior global audit and emits a structurally grounded newest draft", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "jina-board-gap-repair-test-"));
  const working = join(root, "working");
  const remoteParent = join(root, "remotes", "acme");
  const remote = join(remoteParent, "sample.git");
  const fakeCodex = join(root, "fake-codex.cjs");
  const auditCountPath = join(root, "audit-count");
  const auditBatchSizesPath = join(root, "audit-batch-sizes");
  await mkdir(join(working, "src"), { recursive: true });
  await mkdir(remoteParent, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main", working]);
  await execFileAsync("git", ["config", "user.name", "Context Test"], { cwd: working });
  await execFileAsync("git", ["config", "user.email", "context-test@example.com"], { cwd: working });
  const runtimeSource = [
    "export interface Request { method: string; path: string }",
    "export interface Result { status: number; route: string }",
    "export function normalizeRequest(request: Request): Request {",
    "  return { method: request.method.toUpperCase(), path: request.path || '/' };",
    "}",
    "export function selectRoute(request: Request): string {",
    "  return request.path.startsWith('/health') ? 'health' : 'application';",
    "}",
    "export function executeRoute(route: string): Result {",
    "  return route === 'health' ? { status: 200, route } : { status: 202, route };",
    "}",
    "export function createRequest(request: Request): Result {",
    "  const normalized = normalizeRequest(request);",
    "  const route = selectRoute(normalized);",
    "  return executeRoute(route);",
    "}",
    "export function shouldRetry(result: Result): boolean {",
    "  return result.status >= 500;",
    "}",
    "export const runtimeDefaults = { method: 'GET', path: '/' };"
  ].join("\n");
  await writeFile(join(working, "src", "runtime.ts"), `${runtimeSource}\n`, "utf8");
  await execFileAsync("git", ["add", "src/runtime.ts"], { cwd: working });
  await execFileAsync("git", ["commit", "-m", "Add request runtime"], { cwd: working });
  const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: working });
  const { stdout: blobOutput } = await execFileAsync("git", ["rev-parse", "HEAD:src/runtime.ts"], {
    cwd: working
  });
  const commitSha = commitOutput.trim();
  const blobSha = blobOutput.trim();
  await execFileAsync("git", ["clone", "--bare", working, remote]);

  const repairedMarkdown = [
    "# Architecture",
    "",
    "[Requests enter through `createRequest`, which normalizes the request, selects a route, and executes it](src/runtime.ts#L12-L16).",
    "",
    "## Request normalization",
    "",
    "[Normalization uppercases the method and substitutes `/` when the path is empty](src/runtime.ts#L3-L5).",
    "",
    "## Route selection and execution",
    "",
    "[Health-prefixed paths select the health route while every other path selects the application route](src/runtime.ts#L6-L8).",
    "",
    "[The health route returns status 200 and the application route returns status 202](src/runtime.ts#L9-L11).",
    "",
    "## Failure and retry behavior",
    "",
    "[The runtime classifies only results with a status of at least 500 as retryable](src/runtime.ts#L17-L19).",
    "",
    "## Defaults and verification",
    "",
    "[The exported defaults use `GET` and `/`, matching the normalization fallback](src/runtime.ts#L3-L5).",
    "",
    "[A maintainer can trace the complete request path through `createRequest`, `normalizeRequest`, `selectRoute`, and `executeRoute`](src/runtime.ts#L3-L16).",
    ""
  ].join("\n");
  await writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const outputIndex = args.indexOf('--output-last-message');",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (outputIndex < 0) process.exit(4);",
      "  if (prompt.includes('independent source-aware citation auditor')) {",
      "    const worker = /auditor ([a-z0-9-]+)\\./.exec(prompt);",
      "    const inputDigest = /Copy inputDigest ([a-f0-9]{64})/.exec(prompt);",
      "    const publicDigest = /publicSnapshotDigest ([a-f0-9]{64})/.exec(prompt);",
      "    const refs = /Citation references with exact source excerpts:\\n([\\s\\S]*?)\\n\\nRepository source is read-only/.exec(prompt);",
      "    if (!worker || !inputDigest || !publicDigest || !refs) process.exit(6);",
      "    const references = JSON.parse(refs[1]);",
      `    const auditCountPath = ${JSON.stringify(auditCountPath)};`,
      `    const auditBatchSizesPath = ${JSON.stringify(auditBatchSizesPath)};`,
      "    const auditCount = fs.existsSync(auditCountPath) ? Number(fs.readFileSync(auditCountPath, 'utf8')) : 0;",
      "    fs.writeFileSync(auditCountPath, String(auditCount + 1));",
      "    fs.appendFileSync(auditBatchSizesPath, String(references.length) + '\\n');",
      "    const result = {",
      "      version: 1,",
      "      inputDigest: inputDigest[1],",
      "      publicSnapshotDigest: publicDigest[1],",
      "      worker: { id: worker[1], summary: auditCount < 2 ? 'One fixture citation needs repair.' : 'Every fixture citation is supported.' },",
      "      results: references.map((ref, index) => index === 0 && auditCount < 2",
      "        ? { citationId: ref.citationId, verdict: 'unsupported', rationale: 'Exercise the bounded targeted repair loop.', correction: null }",
      "        : { citationId: ref.citationId, verdict: 'supported', rationale: 'The exact fixture excerpt supports the claim.', correction: null }),",
      "      summary: auditCount < 2 ? 'One fixture citation is unsupported.' : 'All fixture citations are supported.'",
      "    };",
      "    fs.writeFileSync(args[outputIndex + 1], JSON.stringify(result));",
      "    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 80, cached_input_tokens: 40, output_tokens: 20 } }) + '\\n');",
      "    return;",
      "  }",
      "  if (prompt.includes('bounded source-aware citation repair stage')) {",
      "    fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ completed: true }));",
      "    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 15, output_tokens: 5 } }) + '\\n');",
      "    return;",
      "  }",
      "  const match = prompt.match(/under (.+?)\\. The current pages/);",
      "  if (!match || !prompt.includes('Source challenge result')) process.exit(5);",
      "  const target = path.join(match[1], 'architecture.md');",
      "  fs.mkdirSync(path.dirname(target), { recursive: true });",
      `  fs.writeFileSync(target, ${JSON.stringify(repairedMarkdown)});`,
      "  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ completed: true }));",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } }) + '\\n');",
      "});"
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeCodex, 0o755);

  const buildId = "task_build";
  const artifacts = new Map<string, { ref: ArtifactRef; content: Buffer }>();
  const addArtifact = (name: string, value: unknown): ArtifactRef => {
    const content = Buffer.from(JSON.stringify(value), "utf8");
    const key = `context-v2/tenants/tenant-board/repositories/acme/sample/builds/${buildId}/${name}.json`;
    const ref = {
      uri: `file:///${key}`,
      key,
      contentType: "application/json",
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex")
    };
    artifacts.set(key, { ref, content });
    return ref;
  };
  const snapshot = {
    tenantId: "tenant-board",
    repository: "acme/sample",
    ref: "main",
    refSequence: 1,
    commitSha,
    files: [
      {
        path: "src/runtime.ts",
        blobSha,
        body: `${runtimeSource}\n`,
        executable: false,
        contentOmitted: false,
        entryType: "file" as const
      }
    ],
    observations: [],
    aclFingerprint: "e".repeat(64),
    observationFrontier: "{}",
    sourceComplete: true,
    createdAt: new Date().toISOString()
  };
  const snapshotArtifact = addArtifact("evidence-snapshot/snapshot", snapshot);
  const researchPlanArtifact = addArtifact("research-plan/plan", { version: 1 });
  const publicationPlanArtifact = addArtifact("publication-plan/plan", {
    version: 1,
    plan: {
      version: 1,
      hierarchyRationale: "One repository-wide runtime page.",
      pages: [
        {
          id: "architecture",
          path: "architecture.md",
          title: "Architecture",
          purpose: "Explain the request runtime.",
          sourceAssignmentIds: ["runtime"],
          maintenanceQuestions: ["How does a request move through the runtime?"],
          coverageAreas: ["src"],
          requiredTopics: ["request flow", "retry behavior"],
          diagram: "none",
          dependencies: []
        }
      ],
      writers: [
        {
          id: "writer-runtime",
          objective: "Document the request runtime.",
          pageIds: ["architecture"]
        }
      ],
      excludedAreas: []
    },
    researchPlanArtifact,
    researchReportArtifacts: [],
    snapshotArtifact
  });
  const initialBodyMarkdown = [
    "# Architecture",
    "",
    "[Requests enter the runtime](src/runtime.ts#L12-L16).",
    "",
    "## Request normalization",
    "",
    "[Normalization uppercases the method and substitutes `/` when the path is empty](src/runtime.ts#L3-L5).",
    "",
    "The initial draft does not explain route selection or retries."
  ].join("\n");
  const initialPageArtifact = addArtifact("context-page/architecture-pass-0", {
    version: 1,
    documentPath: "architecture.md",
    title: "Architecture",
    bodyMarkdown: initialBodyMarkdown,
    publicationPlanArtifact,
    snapshotArtifact
  });
  const initialInventory = boardPageAuditInventory({
    documentPath: "architecture.md",
    bodyMarkdown: initialBodyMarkdown,
    snapshot
  });
  const publicDigest = createHash("sha256")
    .update(`<!-- context-page:architecture.md -->\n${initialBodyMarkdown.trim()}\n`)
    .digest("hex");
  const priorInputDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        checkpoint: {
          repository: snapshot.repository,
          ref: snapshot.ref,
          commitSha: snapshot.commitSha
        },
        publicSnapshotDigest: publicDigest,
        references: initialInventory.references
      })
    )
    .digest("hex");
  const priorPublicDigest = boardPublicPageDigest("architecture.md", initialBodyMarkdown);
  const priorAudit = {
    version: 1,
    inputDigest: priorInputDigest,
    publicSnapshotDigest: publicDigest,
    worker: { id: "citation-audit-gap-1", summary: "Initial global draft citations are supported." },
    results: initialInventory.references.map((reference) => ({
      citationId: reference.citationId,
      verdict: "supported",
      rationale: "The exact fixture excerpt supports the claim.",
      correction: null
    })),
    summary: "Initial global draft citations are supported."
  };
  const initialAuditArtifact = addArtifact("citation-audit/architecture-pass-0", {
    version: 1,
    pageArtifact: initialPageArtifact,
    snapshotArtifact,
    publicSnapshotDigest: priorPublicDigest,
    inputDigest: priorInputDigest,
    references: initialInventory.references,
    structuralProblems: [],
    audit: {
      version: 1,
      inputDigest: priorInputDigest,
      publicSnapshotDigest: priorPublicDigest,
      worker: { id: "citation-audit-architecture", summary: "Initial page citations are supported." },
      results: initialInventory.references.map((reference) => ({
        citationId: reference.citationId,
        verdict: "supported",
        rationale: "The exact fixture excerpt supports the claim.",
        correction: null
      })),
      summary: "Initial page citations are supported."
    }
  });
  const priorDraftArtifact = addArtifact("context-draft/context-draft-1", {
    version: 1,
    pages: [
      {
        documentPath: "architecture.md",
        title: "Architecture",
        bodyMarkdown: initialBodyMarkdown,
        publicationPlanArtifact,
        snapshotArtifact
      }
    ],
    publicationPlanArtifact,
    snapshotArtifact,
    citationAuditInput: {
      inputDigest: priorInputDigest,
      publicSnapshotDigest: publicDigest,
      references: initialInventory.references
    },
    citationAudit: priorAudit,
    citationAuditDigest: createHash("sha256").update(JSON.stringify(priorAudit)).digest("hex")
  });
  const challengeArtifact = addArtifact("gate-evaluation/source-challenge-0", {
    version: 1,
    gate: "source-challenge",
    verdict: "repair_required",
    publicSnapshotDigest: publicDigest,
    blockingGapCount: 1,
    publicationPlanArtifact,
    pageArtifacts: [priorDraftArtifact],
    result: {
      version: 1,
      addedTasks: [
        {
          id: "challenge-runtime-retries",
          material: true,
          question: "How does retry classification work?",
          requiredAnswerParts: ["entrypoints", "control_flow", "failure_triage", "verification"]
        }
      ],
      omittedSubjects: []
    }
  });
  const evaluationArtifact = addArtifact("gate-evaluation/task-evaluation-0", {
    version: 1,
    gate: "task-evaluation",
    verdict: "repair_required",
    publicSnapshotDigest: publicDigest,
    blockingGapCount: 1,
    publicationPlanArtifact,
    pageArtifacts: [priorDraftArtifact],
    result: {
      review: {
        results: [
          {
            questionId: "task-runtime",
            verdict: "partial",
            gapIds: ["gap-runtime-retry"],
            summary: "Retry behavior is missing."
          }
        ]
      },
      gaps: [
        {
          id: "gap-runtime-retry",
          severity: "blocking",
          description: "Explain retry behavior.",
          status: "open"
        }
      ]
    }
  });

  let completion: Record<string, unknown> | undefined;
  let uploadedDraft: Record<string, unknown> | undefined;
  let uploadedLease: Record<string, unknown> | undefined;
  let uploadedArtifact: ArtifactRef | undefined;
  let claimedTopics: unknown;
  let claimAttempt = 0;
  const completionAttempts: Record<string, unknown>[] = [];
  const phaseCheckpoints = new Map<
    string,
    {
      readonly phase: string;
      readonly checkpointKey: string;
      readonly attempt: number;
      readonly artifact: ArtifactRef;
      readonly recordedAt: string;
    }
  >();
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      claimedTopics = body.topics;
      if (completion) {
        response.writeHead(204);
        response.end();
        return;
      }
      claimAttempt += 1;
      json(response, 200, {
        message: {
          id: `message_gap_repair_${claimAttempt}`,
          topic: "run-context-gap-repair",
          leaseId: `lease_gap_repair_${claimAttempt}`,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempt: claimAttempt,
          writeFenceToken: `fence_gap_repair_${claimAttempt}`
        },
        task: {
          id: "task_gap_repair",
          metadata: {
            tenantId: "tenant-board",
            repository: "acme/sample",
            ref: "main",
            refSequence: 1,
            contextBuildId: buildId,
            dependencyResults: [
              {
                taskId: "task_page_write",
                taskType: "write-context-page",
                pass: 0,
                result: { version: 1, outputArtifact: initialPageArtifact }
              },
              {
                taskId: "task_page_audit",
                taskType: "audit-context-page",
                pass: 0,
                result: { version: 1, outputArtifact: initialAuditArtifact }
              },
              {
                taskId: "task_prior_gap_repair",
                taskType: "repair-context-gaps",
                pass: 1,
                result: { version: 1, outputArtifact: priorDraftArtifact }
              },
              {
                taskId: "task_source_challenge",
                taskType: "challenge-context-sources",
                pass: 1,
                result: { version: 1, outputArtifact: challengeArtifact }
              },
              {
                taskId: "task_task_evaluation",
                taskType: "evaluate-context-tasks",
                pass: 1,
                result: { version: 1, outputArtifact: evaluationArtifact }
              }
            ],
            commitSha,
            planArtifact: publicationPlanArtifact,
            pass: 2
          }
        }
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts/read") {
      const requested = record(body.artifact);
      const stored = artifacts.get(String(requested.key));
      if (!stored) {
        json(response, 404, { error: "artifact not found" });
        return;
      }
      json(response, 200, {
        artifact: stored.ref,
        contentBase64: stored.content.toString("base64")
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts") {
      uploadedLease = body;
      const content = Buffer.from(String(body.contentBase64), "base64");
      uploadedDraft = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
      const key = `context-v2/tenants/tenant-board/repositories/acme/sample/builds/${buildId}/context-draft/task_gap_repair-attempt-${String(body.attempt)}-${String(body.name)}`;
      const ref: ArtifactRef = {
        uri: `file:///${key}`,
        key,
        contentType: "application/json",
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex")
      };
      uploadedArtifact = ref;
      artifacts.set(key, { ref, content });
      json(response, 201, { artifact: ref });
      return;
    }
    if (request.url === "/internal/context/board/phase-checkpoints/read") {
      json(response, 200, {
        checkpoint: phaseCheckpoints.get(`${String(body.phase)}:${String(body.checkpointKey)}`) ?? null
      });
      return;
    }
    if (request.url === "/internal/context/board/phase-checkpoints") {
      const key = `${String(body.phase)}:${String(body.checkpointKey)}`;
      const existing = phaseCheckpoints.get(key);
      if (existing) {
        json(response, 200, { checkpoint: existing, created: false });
        return;
      }
      const checkpoint = {
        phase: String(body.phase),
        checkpointKey: String(body.checkpointKey),
        attempt: Number(body.attempt),
        artifact: body.artifact as ArtifactRef,
        recordedAt: new Date().toISOString()
      };
      phaseCheckpoints.set(key, checkpoint);
      json(response, 201, { checkpoint, created: true });
      return;
    }
    if (request.url === "/internal/worker/renew") {
      json(response, 200, { renewed: true });
      return;
    }
    if (request.url === "/internal/worker/release") {
      json(response, 200, { released: true });
      return;
    }
    if (request.url === "/internal/worker/complete") {
      completionAttempts.push(body);
      if (completionAttempts.length === 1) {
        json(response, 503, { error: "simulated response loss after phase checkpoints" });
        return;
      }
      completion = body;
      json(response, 200, { accepted: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const rewriteRoot = `file://${join(root, "remotes")}/`;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-gap-repair",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_API_TIMEOUT_MS: "5000",
      CONTEXT_API_TIMEOUT_MS: "5000",
      CONTEXT_COMPLETION_TIMEOUT_MS: "5000",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      CONTEXT_GAP_REPAIR_SECONDS: "30",
      CODEX_BINARY: fakeCodex,
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${rewriteRoot}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  let output = "";
  worker.stdout?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-12_000);
  });
  worker.stderr?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-12_000);
  });

  await waitForHealth(
    workerPort,
    (value) => record(value.lastWork).outcome === "done",
    () => output
  );
  assert.deepEqual(claimedTopics, ["run-context-gap-repair"]);
  assert.equal(uploadedLease?.kind, "context-draft");
  assert.equal(uploadedLease?.taskId, "task_gap_repair");
  assert.equal(uploadedLease?.leaseId, "lease_gap_repair_2");
  assert.equal(uploadedLease?.writeFenceToken, "fence_gap_repair_2");
  assert.equal(uploadedDraft?.version, 1);
  const pages = uploadedDraft?.pages as readonly Record<string, unknown>[];
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.documentPath, "architecture.md");
  assert.equal(pages[0]?.bodyMarkdown, repairedMarkdown);
  assert.deepEqual(uploadedDraft?.sourceChallengeArtifact, challengeArtifact);
  assert.deepEqual(uploadedDraft?.taskEvaluationArtifact, evaluationArtifact);
  assert.equal(completion?.outcome, "done", output);
  assert.equal(completionAttempts.length, 2);
  assert.deepEqual(completionAttempts[0]?.modelUsage, {
    inputTokens: 400,
    cachedInputTokens: 200,
    outputTokens: 80
  });
  assert.deepEqual(completion?.modelUsage, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  assert.ok(phaseCheckpoints.size >= 5);
  const finalAudit = record(uploadedDraft?.citationAudit);
  assert.match(String(record(finalAudit.worker).summary), /Reused \d+ exact digest-bound supported citation verdicts/);
  const finalReferences = record(uploadedDraft?.citationAuditInput).references as readonly unknown[];
  const auditBatchSizes = (await readFile(auditBatchSizesPath, "utf8")).trim().split("\n").map(Number);
  assert.deepEqual(auditBatchSizes, [finalReferences.length - 1, 1, 1]);
  const result = record(completion?.result);
  assert.equal(result.version, 1);
  assert.match(String(result.publicSnapshotDigest), /^[a-f0-9]{64}$/);
  assert.deepEqual(result.outputArtifact, uploadedArtifact);
});

interface ArtifactRef {
  readonly uri: string;
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
}

async function waitForHealth(
  port: number,
  predicate: (value: Record<string, unknown>) => boolean,
  output: () => string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      last = (await response.json()) as Record<string, unknown>;
      if (predicate(last)) return last;
    } catch {
      // The worker may not have bound its port yet.
    }
    await delay(20);
  }
  throw new Error(`gap repair worker did not complete: ${JSON.stringify(last)}\n${output()}`);
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  request.setEncoding("utf8");
  let raw = "";
  for await (const chunk of request as AsyncIterable<string>) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
