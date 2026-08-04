import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PAGEINDEX_OSS_ADAPTER_NAME,
  PAGEINDEX_OSS_SOURCE_DIGEST,
  PAGEINDEX_OSS_SOURCE_PIN,
  boardContextPublicationInputDigest,
  boardContextReleaseId,
  contextPublicSnapshotDigest,
  fingerprint,
  type CertifiedContextReleaseArtifactV1,
  type ContextArtifactRef,
  type KnowledgeEvidenceCitation
} from "@jina/context-engine";

test.skip("obsolete split publication worker fixture", async (context) => {
  const certificationArtifact = artifact("certification", "certification.json", "a");
  const releaseArtifact = artifact("context-release", "release.json", "b");
  let publicationRequest: Record<string, unknown> | undefined;
  let completion: Record<string, unknown> | undefined;
  let artifactUploadAttempted = false;
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      if (completion) {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, 200, {
        message: {
          id: "message_publication",
          topic: "run-context-publication",
          leaseId: "lease_publication",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempt: 2,
          writeFenceToken: "fence_publication"
        },
        task: {
          id: "task_publication",
          metadata: {
            tenantId: "tenant-board",
            repository: "acme/sample",
            ref: "main",
            refSequence: 7,
            commitSha: "9".repeat(40),
            contextBuildId: "task_build",
            planArtifact: artifact("publication-plan", "plan.json", "c"),
            dependencyResults: [
              {
                taskId: "task_certification",
                taskType: "certify-context-release",
                result: { version: 1, outputArtifact: certificationArtifact }
              }
            ]
          }
        }
      });
      return;
    }
    if (request.url === "/internal/context/board/publish") {
      publicationRequest = body;
      json(response, 200, {
        version: 1,
        outputArtifact: releaseArtifact,
        releaseId: "cr_0123456789abcdef0123456789abcdef"
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts") {
      artifactUploadAttempted = true;
      json(response, 500, { error: "publication must not use generic artifact upload" });
      return;
    }
    if (request.url === "/internal/worker/renew") {
      json(response, 200, { accepted: true });
      return;
    }
    if (request.url === "/internal/worker/complete") {
      completion = body;
      json(response, 200, { accepted: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const workerPort = await availablePort();
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${(mock.address() as AddressInfo).port}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_API_TIMEOUT_MS: "5000",
      CONTEXT_API_TIMEOUT_MS: "5000",
      CONTEXT_COMPLETION_TIMEOUT_MS: "5000",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });
  let output = "";
  worker.stdout?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  });
  worker.stderr?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  });

  await waitForHealth(
    workerPort,
    (value) => record(value.lastWork)?.outcome === "done",
    () => output
  );
  assert.equal(artifactUploadAttempted, false);
  assert.deepEqual(publicationRequest, {
    messageId: "message_publication",
    taskId: "task_publication",
    leaseId: "lease_publication",
    attempt: 2,
    writeFenceToken: "fence_publication",
    certificationArtifact
  });
  assert.equal(completion?.outcome, "done");
  assert.deepEqual(completion?.result, {
    version: 1,
    outputArtifact: releaseArtifact,
    releaseId: "cr_0123456789abcdef0123456789abcdef"
  });
});

test.skip("obsolete split PageIndex worker fixture", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "jina-pageindex-worker-http-"));
  const fakePageIndex = join(root, "fake-pageindex.cjs");
  await writeFile(fakePageIndex, fakePageIndexProgram());
  const release = pageIndexRelease();
  const releaseContent = Buffer.from(JSON.stringify(release), "utf8");
  const releaseArtifact = {
    ...scopedArtifact("context-release", `${release.release.releaseId}.json`, "d"),
    bytes: releaseContent.byteLength,
    sha256: createHash("sha256").update(releaseContent).digest("hex")
  };
  let completion: Record<string, unknown> | undefined;
  let attachmentRequest: Record<string, unknown> | undefined;
  let uploadedTree: ContextArtifactRef | undefined;
  const order: string[] = [];
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      if (completion) {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, 200, {
        message: {
          id: "message_pageindex",
          topic: "run-context-pageindex",
          leaseId: "lease_pageindex",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempt: 1,
          writeFenceToken: "fence_pageindex"
        },
        task: {
          id: "task_pageindex",
          metadata: {
            tenantId: "tenant-board",
            repository: "acme/sample",
            ref: "main",
            refSequence: 7,
            commitSha: "9".repeat(40),
            contextBuildId: "task_build",
            planArtifact: scopedArtifact("publication-plan", "plan.json", "e"),
            dependencyResults: [
              {
                taskId: "task_publication",
                taskType: "publish-context-release",
                result: { version: 1, outputArtifact: releaseArtifact }
              }
            ]
          }
        }
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts/read") {
      json(response, 200, {
        artifact: releaseArtifact,
        contentBase64: releaseContent.toString("base64")
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts") {
      const content = Buffer.from(String(body.contentBase64), "base64");
      uploadedTree = {
        uri: "gs://context-artifacts/pageindex-tree.json",
        key: `context/tenants/tenant-board/repositories/acme/sample/builds/task_build/pageindex-tree/task_pageindex-attempt-1-${String(body.name)}`,
        contentType: "application/json",
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        objectGeneration: "101"
      };
      order.push("upload");
      json(response, 201, { artifact: uploadedTree });
      return;
    }
    if (request.url === "/internal/context/board/pageindex/attach") {
      attachmentRequest = body;
      order.push("attach");
      json(response, 200, {
        version: 1,
        outputArtifact: uploadedTree,
        releaseId: release.release.releaseId,
        generationId: release.release.releaseId
      });
      return;
    }
    if (request.url === "/internal/worker/renew") {
      json(response, 200, { accepted: true });
      return;
    }
    if (request.url === "/internal/worker/complete") {
      completion = body;
      order.push("complete");
      json(response, 200, { accepted: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const workerPort = await availablePort();
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${(mock.address() as AddressInfo).port}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-pageindex",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_API_TIMEOUT_MS: "5000",
      CONTEXT_API_TIMEOUT_MS: "5000",
      CONTEXT_COMPLETION_TIMEOUT_MS: "5000",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      CONTEXT_PAGEINDEX_PYTHON: process.execPath,
      CONTEXT_PAGEINDEX_WORKER: fakePageIndex
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
    output = `${output}${String(chunk)}`.slice(-8_000);
  });
  worker.stderr?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  });

  await waitForHealth(
    workerPort,
    (value) => record(value.lastWork)?.outcome === "done",
    () => output
  );
  assert.deepEqual(order, ["upload", "attach", "complete"]);
  assert.ok(uploadedTree);
  assert.deepEqual(attachmentRequest, {
    messageId: "message_pageindex",
    taskId: "task_pageindex",
    leaseId: "lease_pageindex",
    attempt: 1,
    writeFenceToken: "fence_pageindex",
    releaseId: release.release.releaseId,
    treeArtifact: uploadedTree
  });
  assert.equal(completion?.outcome, "done");
  assert.deepEqual(completion?.result, {
    version: 1,
    outputArtifact: uploadedTree,
    releaseId: release.release.releaseId
  });
});

function artifact(kind: string, name: string, digestCharacter: string) {
  return {
    uri: `file:///context/${name}`,
    key: `context/tenants/tenant-board/repositories/acme%2Fsample/builds/task_build/${kind}/${name}`,
    contentType: "application/json",
    bytes: 128,
    sha256: digestCharacter.repeat(64)
  };
}

function pageIndexRelease(): CertifiedContextReleaseArtifactV1 {
  const tenantId = "tenant-board";
  const repository = "acme/sample";
  const commitSha = "9".repeat(40);
  const bodyMarkdown = "# Architecture\n\nA board task owns the published Context release.\n";
  const revisionId = "kr_pageindex_http";
  const citation: KnowledgeEvidenceCitation = {
    id: "kc_pageindex_http",
    revisionId,
    ordinal: 0,
    claim: "A board task owns the published Context release.",
    citationId: "cite_00000000000000000000",
    claimSpan: "A board task owns the published Context release.",
    anchor: {
      tenantId,
      repository,
      sourceType: "blob",
      sourceId: "8".repeat(40),
      contentDigest: fingerprint("export const board = true;\n"),
      commitSha,
      pathOrUrl: "src/board.ts",
      startLine: 1,
      endLine: 1
    }
  };
  const pages = [
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown,
      bodySha256: fingerprint(bodyMarkdown),
      revisionId,
      citations: [citation]
    }
  ];
  const scope = {
    tenantId,
    repository,
    ref: "main",
    refSequence: 7,
    commitSha,
    buildId: "task_build"
  };
  const certificationArtifact = scopedArtifact("certification", "certification.json", "a");
  const publicationPlanArtifact = scopedArtifact("publication-plan", "plan.json", "b");
  const publicSnapshotDigest = contextPublicSnapshotDigest(pages);
  const publicationInputDigest = boardContextPublicationInputDigest({
    scope,
    certificationArtifact,
    publicationPlanArtifact,
    checkpointId: "ec_pageindex_http",
    publicSnapshotDigest,
    pages: pages.map((page) => ({
      documentPath: page.documentPath,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citationIds: page.citations.map((candidate) => candidate.id)
    }))
  });
  return {
    version: 1,
    release: {
      releaseId: boardContextReleaseId(publicationInputDigest),
      ...scope,
      checkpointId: "ec_pageindex_http",
      publishedAt: "2026-07-29T20:00:00.000Z"
    },
    certificationArtifact,
    publicationPlanArtifact,
    publicSnapshotDigest,
    publicationInputDigest,
    pages
  };
}

function scopedArtifact(kind: string, name: string, digestCharacter: string): ContextArtifactRef {
  const key = [
    "context",
    "tenants",
    "tenant-board",
    "repositories",
    "acme",
    "sample",
    "builds",
    "task_build",
    kind,
    name
  ].join("/");
  return {
    uri: `gs://context-artifacts/${key}`,
    key,
    contentType: "application/json",
    bytes: 128,
    sha256: digestCharacter.repeat(64),
    objectGeneration: "42"
  };
}

function fakePageIndexProgram(): string {
  return [
    `const name = ${JSON.stringify(PAGEINDEX_OSS_ADAPTER_NAME)};`,
    `const pin = ${JSON.stringify(PAGEINDEX_OSS_SOURCE_PIN)};`,
    `const digest = ${JSON.stringify(PAGEINDEX_OSS_SOURCE_DIGEST)};`,
    "if (process.argv.includes('--probe')) {",
    "  process.stdout.write(JSON.stringify({ available: true, adapterName: name, version: pin, sourcePin: pin, sourceDigest: digest }));",
    "  process.exit(0);",
    "}",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(input);",
    "  const nodes = request.input.documents.map(document => ({",
    "    externalId: `root-${document.id}`, documentId: document.id,",
    "    title: document.title, summary: `Root for ${document.title}`,",
    "    depth: 1, preorderStart: 1, preorderEnd: 1, anchors: document.anchors",
    "  }));",
    "  process.stdout.write(JSON.stringify({",
    "    adapterName: name, adapterVersion: pin, sourcePin: pin, sourceDigest: digest, nodes, diagnostics: []",
    "  }));",
    "});"
  ].join("\n");
}

async function waitForHealth(
  port: number,
  predicate: (value: Record<string, unknown>) => boolean,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const value = (await response.json()) as Record<string, unknown>;
      if (predicate(value)) return;
    } catch {
      // Worker may not have bound its health port yet.
    }
    await delay(20);
  }
  throw new Error(`publication worker did not complete\n${output()}`);
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
