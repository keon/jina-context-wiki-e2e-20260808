import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  assertNoGitHubOperationalCredentials,
  sanitizeGitHubCommitCommentPayload,
  sanitizeGitHubIssueCommentPayload,
  sanitizeGitHubIssuePayload,
  sanitizeGitHubPullRequestPayload,
  sanitizeGitHubRepositoryPayload,
  sanitizeGitHubReviewCommentPayload
} from "./github-provider-sanitizer.js";

const execFileAsync = promisify(execFile);

test("GitHub provider sanitizers retain research facts without incidental credentials", () => {
  const common = {
    id: 7,
    number: 11,
    title: "Bound provider evidence",
    body: "Preserve this engineering discussion.",
    state: "open",
    user: { login: "octocat", token: "nested-secret" },
    labels: [{ name: "quality", color: "00ff00", description: "not retained" }],
    html_url: "https://github.com/acme/sample/issues/11",
    created_at: "2026-07-30T00:00:00Z",
    updated_at: "2026-07-30T01:00:00Z",
    clone_url: "https://response-secret@github.com/acme/sample.git",
    temp_clone_token: "response-secret",
    authorization: "response-secret"
  };
  const payloads = [
    sanitizeGitHubRepositoryPayload({
      ...common,
      full_name: "acme/sample",
      default_branch: "main",
      owner: common.user
    }),
    sanitizeGitHubIssuePayload(common),
    sanitizeGitHubPullRequestPayload({
      ...common,
      html_url: "https://github.com/acme/sample/pull/11",
      head: {
        ref: "feature",
        sha: "a".repeat(40),
        repo: { full_name: "contributor/sample", temp_clone_token: "response-secret" }
      },
      base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/sample" } }
    }),
    sanitizeGitHubIssueCommentPayload(common),
    sanitizeGitHubReviewCommentPayload({ ...common, path: "src/index.ts", diff_hunk: "@@ -1 +1 @@" }),
    sanitizeGitHubCommitCommentPayload({ ...common, commit_id: "c".repeat(40), path: "src/index.ts" })
  ];
  const serialized = JSON.stringify(payloads);
  assert.doesNotThrow(() => assertNoGitHubOperationalCredentials(payloads));
  assert.throws(
    () => assertNoGitHubOperationalCredentials({ nested: { temp_clone_token: "must-not-persist" } }),
    /forbidden operational field temp_clone_token/
  );
  assert.doesNotMatch(serialized, /response-secret|nested-secret|authorization|temp_clone_token|clone_url/);
  assert.match(serialized, /Preserve this engineering discussion/);
  assert.match(serialized, /contributor\/sample/);
});

test("board snapshot worker captures evidence, uploads it, and completes with only its artifact reference", async (context) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "jina-board-snapshot-test-"));
  const working = join(repositoryRoot, "working");
  const remoteParent = join(repositoryRoot, "remotes", "acme");
  const remote = join(remoteParent, "sample.git");
  await mkdir(remoteParent, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main", working]);
  await execFileAsync("git", ["config", "user.name", "Context Test"], { cwd: working });
  await execFileAsync("git", ["config", "user.email", "context-test@example.com"], { cwd: working });
  await writeFile(join(working, "README.md"), "# Sample\n\nRepository snapshot evidence.\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: working });
  await execFileAsync("git", ["commit", "-m", "Initialize sample repository"], { cwd: working });
  const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: working });
  const commitSha = commitOutput.trim();
  await execFileAsync("git", ["clone", "--bare", working, remote]);

  let completion: Record<string, unknown> | undefined;
  let uploadedSnapshot: Record<string, unknown> | undefined;
  let uploadLease: Record<string, unknown> | undefined;
  let claimedTopics: unknown;
  const outputArtifact = {
    uri: "file:///context/snapshot.json",
    key: "context/tenants/tenant-board/repositories/acme/sample/builds/task_build/evidence-snapshot/task_snapshot-attempt-1-snapshot.json",
    contentType: "application/json",
    bytes: 0,
    sha256: "a".repeat(64)
  };
  const mock = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/repos/acme/sample")) {
      if (request.url === "/repos/acme/sample") {
        json(response, 200, {
          full_name: "acme/sample",
          html_url: "https://github.com/acme/sample",
          clone_url: "https://transient-clone-secret@github.com/acme/sample.git",
          temp_clone_token: "transient-clone-secret",
          owner: { login: "acme", token: "nested-secret" }
        });
      } else {
        json(response, 200, []);
      }
      return;
    }
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      claimedTopics = body.topics;
      if (completion) {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, 200, {
        message: {
          id: "message_snapshot",
          topic: "run-context-input-snapshot",
          leaseId: "lease_snapshot",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempt: 1,
          writeFenceToken: "fence_snapshot"
        },
        task: {
          id: "task_snapshot",
          metadata: {
            tenantId: "tenant-board",
            repository: "acme/sample",
            ref: "main",
            refSequence: 1,
            contextBuildId: "task_build",
            dependencyResults: [],
            commitSha
          }
        }
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts") {
      uploadLease = body;
      const encoded = String(body.contentBase64);
      const bytes = Buffer.from(encoded, "base64");
      uploadedSnapshot = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      outputArtifact.bytes = bytes.byteLength;
      outputArtifact.sha256 = createHash("sha256").update(bytes).digest("hex");
      json(response, 201, { artifact: outputArtifact });
      return;
    }
    if (request.url === "/internal/worker/renew") {
      json(response, 200, { renewed: true });
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
  const mockPort = (mock.address() as AddressInfo).port;
  const rewriteRoot = `file://${join(repositoryRoot, "remotes")}/`;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      GITHUB_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-input-snapshot",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_API_TIMEOUT_MS: "5000",
      CONTEXT_API_TIMEOUT_MS: "5000",
      CONTEXT_COMPLETION_TIMEOUT_MS: "5000",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      CONTEXT_GIT_HISTORY_LIMIT: "10",
      CONTEXT_GITHUB_HISTORY_LIMIT: "10",
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
    await rm(repositoryRoot, { recursive: true, force: true });
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
    (value) => recordOrUndefined(value.lastWork)?.outcome === "done",
    () => output
  );
  assert.deepEqual(claimedTopics, ["run-context-input-snapshot"]);
  assert.equal(uploadLease?.kind, "evidence-snapshot");
  assert.equal(uploadLease?.taskId, "task_snapshot");
  assert.equal(uploadLease?.leaseId, "lease_snapshot");
  assert.equal(uploadLease?.writeFenceToken, "fence_snapshot");
  assert.equal(uploadedSnapshot?.repository, "acme/sample");
  assert.equal(uploadedSnapshot?.commitSha, commitSha);
  assert.equal(uploadedSnapshot?.sourceComplete, true);
  const files = uploadedSnapshot?.files as readonly Record<string, unknown>[];
  assert.equal(files[0]?.path, "README.md");
  assert.match(String(files[0]?.body), /Repository snapshot evidence/);
  const observations = uploadedSnapshot?.observations as readonly Record<string, unknown>[];
  assert.equal(observations[0]?.sourceId, `github:repository:acme/sample:${commitSha}`);
  const serializedSnapshot = JSON.stringify(uploadedSnapshot);
  assert.doesNotMatch(serializedSnapshot, /transient-clone-secret|nested-secret/);
  assert.doesNotMatch(serializedSnapshot, /temp_clone_token|clone_url/);
  assert.equal(completion?.outcome, "done");
  assert.deepEqual(completion?.result, {
    contract: "page-oriented",
    schemaRevision: 1,
    outputArtifact,
    commitSha
  });
});

async function waitForHealth(
  port: number,
  predicate: (value: Record<string, unknown>) => boolean,
  output: () => string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
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
  throw new Error(`snapshot worker did not complete: ${JSON.stringify(last)}\n${output()}`);
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

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
