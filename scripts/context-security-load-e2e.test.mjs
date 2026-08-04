import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runContextSecurityLoadAcceptance } from "./context-security-load-e2e.mjs";

const TENANT = "11111111-1111-4111-8111-111111111111";
const QUERY_TOKEN = "security-load-query";
const INTERNAL_TOKEN = "security-load-internal";
const QUERY_PRINCIPAL = "user:security-load-query@jina.internal";
const ISSUED_PRINCIPAL = "user:context-security-load@jina.internal";
const ISSUED_SECRET = `jina_atk_${"r".repeat(43)}`;
const ISSUED_TOKEN_ID = "atk_security_load";
const REPOSITORY = "acme/context";
const ISOLATION_REPOSITORY = "forbidden/context-security-probe";
const REF = "main";
const BUILD_ID = "cb_security_load";
const RELEASE_ID = "cr_security_load";
const FROM_RELEASE_ID = "cr_security_load_previous";
const COMMIT = "a".repeat(40);
const PREVIOUS_COMMIT = "b".repeat(40);

const release = {
  id: RELEASE_ID,
  repository: REPOSITORY,
  ref: REF,
  commitSha: COMMIT,
  createdAt: "2026-07-29T12:00:00.000Z",
  publishedAt: "2026-07-29T12:01:00.000Z",
  completeness: "complete",
  contextStatus: "available"
};
const previousRelease = {
  ...release,
  id: FROM_RELEASE_ID,
  commitSha: PREVIOUS_COMMIT,
  createdAt: "2026-07-28T12:00:00.000Z",
  publishedAt: "2026-07-28T12:01:00.000Z"
};
const document = {
  id: "doc-architecture",
  logicalId: "architecture",
  revisionId: "rev-architecture",
  title: "Request architecture",
  summary: "The request path and its failure boundary.",
  citations: [
    {
      claim: "The router handles incoming requests.",
      citationId: "cite-router",
      anchor: {
        sourceType: "git_blob",
        sourceId: "blob-router",
        repository: REPOSITORY,
        commitSha: COMMIT,
        pathOrUrl: "src/router.ts",
        startLine: 10,
        endLine: 24
      }
    }
  ]
};

test("security/load harness validates concurrent deterministic traffic and security boundaries", async () => {
  await withFakeContextServer({ operationDelayMs: 5 }, async ({ apiUrl, state }) => {
    const report = await runContextSecurityLoadAcceptance({
      ...baseOptions(apiUrl),
      concurrency: 3,
      requestCount: 12,
      maxP95Ms: 2_000
    });

    assert.equal(report.status, "passed");
    assert.equal(report.load.requests, 12);
    assert.equal(report.load.successes, 12);
    assert.equal(report.load.errors, 0);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(report.load.operations).map(([operation, summary]) => [operation, summary.requests])
      ),
      { list: 4, read: 4, diff: 4 }
    );
    assert.equal(report.configuration.searchRequests, 0);
    assert.equal(report.security.revokedIssuedToken.status, "passed");
    assert.equal(report.security.revokedIssuedToken.revoked, true);
    assert.equal(report.security.unauthorized.releases, 401);
    assert.equal(report.security.adminDenial.metrics, 403);
    assert.equal(report.security.adminDenial.board, 403);
    assert.equal(report.security.adminDenial.tokenAdministration, 403);
    assert.equal(report.security.tenantIsolation.status, 401);
    assert.equal(report.security.repositoryIsolation.catalogStatus, 404);
    assert.equal(report.security.repositoryIsolation.releaseOracleStatus, 404);
    assert.equal(report.publicPayloadInspection.leaks, 0);
    assert.ok(state.maxConcurrent >= 2, "load requests did not overlap");
    assert.equal(
      state.requests.some((entry) => entry.pathname === "/context/search"),
      false
    );
    assert.equal(state.issuedRevoked, true);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(QUERY_TOKEN), false);
    assert.equal(serialized.includes(INTERNAL_TOKEN), false);
    assert.equal(serialized.includes(ISSUED_SECRET), false);
  });
});

test("security/load harness fails closed on private payload fields", async () => {
  await withFakeContextServer({ exposePrompt: true }, async ({ apiUrl }) => {
    const report = await runContextSecurityLoadAcceptance({
      ...baseOptions(apiUrl),
      concurrency: 2,
      requestCount: 6
    });

    assert.equal(report.status, "failed");
    assert.ok(
      report.violations.some(
        (violation) => violation.code === "private_field_exposure" && violation.message.includes("$.prompt")
      )
    );
    for (const code of ["gcs_uri", "artifact_object_key", "stack_trace"]) {
      assert.ok(
        report.violations.some((violation) => violation.code === code),
        `missing ${code} violation`
      );
    }
    assert.ok(report.publicPayloadInspection.leaks > 0);
  });
});

test("security/load harness reports bounded response, request error, and latency violations", async () => {
  await withFakeContextServer(
    {
      operationDelayMs: 10,
      failFirstLoadList: true,
      oversizeFirstLoadRead: true
    },
    async ({ apiUrl }) => {
      const report = await runContextSecurityLoadAcceptance({
        ...baseOptions(apiUrl),
        concurrency: 3,
        requestCount: 9,
        maxP95Ms: 1,
        maxErrorRate: 0,
        maxResponseBytes: 1_600
      });

      assert.equal(report.status, "failed");
      assert.equal(report.load.requests, 9);
      assert.equal(report.load.errors, 2);
      assert.equal(report.load.statusCounts["500"], 1);
      assert.equal(report.load.errorCounts.response_too_large, 1);
      assert.ok(report.violations.some((violation) => violation.code === "load_error_rate"));
      assert.ok(report.violations.some((violation) => violation.code === "load_latency"));
      assert.equal(JSON.stringify(report).includes("deliberate fake-server stack"), false);
    }
  );
});

test("security/load harness rejects non-loopback endpoints before fetching", async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      runContextSecurityLoadAcceptance(
        {
          ...baseOptions("https://example.com"),
          requestCount: 3
        },
        {
          fetch: async () => {
            fetched = true;
            throw new Error("must not fetch");
          }
        }
      ),
    /loopback/
  );
  assert.equal(fetched, false);
});

test("security/load harness requires a non-admin repository-bound principal", async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      runContextSecurityLoadAcceptance(
        {
          ...baseOptions("http://127.0.0.1:3000"),
          principalId: `tenant:${TENANT}`,
          requestCount: 3
        },
        {
          fetch: async () => {
            fetched = true;
            throw new Error("must not fetch");
          }
        }
      ),
    /non-admin repository-bound/
  );
  assert.equal(fetched, false);
});

test("CLI retains a mode-0600 JSON failure report and exits nonzero", async () => {
  await withFakeContextServer({ exposePrompt: true }, async ({ apiUrl }) => {
    const directory = await mkdtemp(join(tmpdir(), "jina-context-security-load-"));
    const reportPath = join(directory, "security-load.json");
    try {
      await writeFile(reportPath, "stale report\n", { mode: 0o644 });
      await chmod(reportPath, 0o644);
      const result = await runProcess(process.execPath, [
        "scripts/context-security-load-e2e.mjs",
        "--",
        "--api-url",
        apiUrl,
        "--tenant",
        TENANT,
        "--internal-token",
        INTERNAL_TOKEN,
        "--query-token",
        QUERY_TOKEN,
        "--principal",
        QUERY_PRINCIPAL,
        "--repository",
        REPOSITORY,
        "--isolation-repository",
        ISOLATION_REPOSITORY,
        "--ref",
        REF,
        "--build",
        BUILD_ID,
        "--release",
        RELEASE_ID,
        "--from-release",
        FROM_RELEASE_ID,
        "--request-count",
        "3",
        "--report",
        reportPath
      ]);
      assert.equal(result.code, 1, result.stderr);
      const reportText = await readFile(reportPath, "utf8");
      const report = JSON.parse(reportText);
      assert.equal(report.status, "failed");
      assert.ok(report.violations.some((violation) => violation.code === "private_field_exposure"));
      assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
      assert.equal(reportText.includes(QUERY_TOKEN), false);
      assert.equal(reportText.includes(INTERNAL_TOKEN), false);
      assert.equal(reportText.includes(ISSUED_SECRET), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function baseOptions(apiUrl) {
  return {
    apiUrl,
    tenantId: TENANT,
    internalToken: INTERNAL_TOKEN,
    queryToken: QUERY_TOKEN,
    repository: REPOSITORY,
    isolationRepository: ISOLATION_REPOSITORY,
    principalId: QUERY_PRINCIPAL,
    ref: REF,
    buildId: BUILD_ID,
    releaseId: RELEASE_ID,
    fromReleaseId: FROM_RELEASE_ID,
    issuedPrincipalId: ISSUED_PRINCIPAL,
    timeoutMs: 5_000
  };
}

async function withFakeContextServer(configuration, run) {
  const state = {
    active: 0,
    maxConcurrent: 0,
    loadListCalls: 0,
    loadReadCalls: 0,
    issuedSecret: undefined,
    issuedRevoked: false,
    requests: []
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const authorization = request.headers.authorization;
    const tenant = request.headers["x-jina-tenant-id"];
    const principal = request.headers["x-jina-principal-id"];
    state.requests.push({
      method: request.method,
      pathname: url.pathname,
      authorization,
      tenant,
      principal
    });

    if (!authorization) return json(response, 401, { error: "unauthorized" });
    const internal = authorization === `Bearer ${INTERNAL_TOKEN}`;
    const query = authorization === `Bearer ${QUERY_TOKEN}`;
    const issued = state.issuedSecret && authorization === `Bearer ${state.issuedSecret}` && !state.issuedRevoked;
    if (state.issuedSecret && authorization === `Bearer ${state.issuedSecret}` && state.issuedRevoked) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (!internal && !query && !issued) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (query && principal !== QUERY_PRINCIPAL) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (tenant !== TENANT) return json(response, issued ? 401 : 404, { error: "not found" });
    if (issued && principal !== ISSUED_PRINCIPAL) {
      return json(response, 401, { error: "unauthorized" });
    }

    if (url.pathname === "/internal/context/tokens" && request.method === "POST") {
      if (!internal) return json(response, 403, { code: "insufficient_scope" });
      const body = await readJson(request);
      if (
        body.principalId !== ISSUED_PRINCIPAL ||
        body.expiresInMinutes !== 5 ||
        JSON.stringify(body.scopes) !== JSON.stringify(["context:read", "context:query"])
      ) {
        return json(response, 400, { error: "invalid token contract" });
      }
      state.issuedSecret = ISSUED_SECRET;
      response.setHeader("cache-control", "no-store");
      return json(response, 201, {
        secret: ISSUED_SECRET,
        token: {
          id: ISSUED_TOKEN_ID,
          name: body.name,
          principalId: body.principalId,
          scopes: body.scopes,
          createdAt: "2026-07-29T12:02:00.000Z",
          expiresAt: "2026-07-29T12:07:00.000Z"
        }
      });
    }
    if (url.pathname === `/internal/context/tokens/${ISSUED_TOKEN_ID}/revoke` && request.method === "POST") {
      if (!internal) return json(response, 403, { code: "insufficient_scope" });
      state.issuedRevoked = true;
      return json(response, 200, {
        token: {
          id: ISSUED_TOKEN_ID,
          principalId: ISSUED_PRINCIPAL,
          scopes: ["context:read", "context:query"],
          revokedAt: "2026-07-29T12:03:00.000Z"
        }
      });
    }
    if (url.pathname === "/internal/context/tokens") {
      return internal ? json(response, 200, { tokens: [] }) : json(response, 403, { code: "insufficient_scope" });
    }
    if (url.pathname.startsWith("/internal/")) {
      return json(response, internal ? 404 : 403, {
        code: internal ? "not_found" : "insufficient_scope"
      });
    }
    if (url.pathname === "/context/metrics") {
      return internal ? json(response, 200, { status: "ready" }) : json(response, 403, { code: "insufficient_scope" });
    }
    if (url.pathname === "/board") {
      return internal ? json(response, 200, { tasks: [] }) : json(response, 403, { code: "insufficient_scope" });
    }
    if (url.pathname === "/context/builds") {
      if (!internal) return json(response, 403, { code: "insufficient_scope" });
      return json(response, 200, {
        builds: [
          {
            id: BUILD_ID,
            repository: REPOSITORY,
            ref: REF,
            commitSha: COMMIT,
            status: "completed",
            createdAt: release.createdAt
          }
        ]
      });
    }
    if (url.pathname === `/context/builds/${BUILD_ID}/progress`) {
      if (!internal) return json(response, 403, { code: "insufficient_scope" });
      return json(response, 200, {
        buildId: BUILD_ID,
        repository: REPOSITORY,
        ref: REF,
        status: "completed",
        stages: [
          {
            id: "publication",
            type: "publish-context-release",
            status: "done"
          },
          {
            id: "index",
            type: "index-context-release",
            status: "done"
          }
        ]
      });
    }

    const requestedRepository = url.searchParams.get("repository");
    if (requestedRepository !== REPOSITORY) {
      return json(response, 404, { error: "not found" });
    }
    if (url.pathname === "/context/releases") {
      return json(response, 200, { releases: [release, previousRelease] });
    }

    const result = await serveOperation(url, configuration, state);
    if (result) return json(response, result.status, result.body);
    return json(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run({ apiUrl: `http://127.0.0.1:${address.port}`, state });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function serveOperation(url, configuration, state) {
  if (!["/context/list", "/context/read", "/context/diff"].includes(url.pathname)) {
    return undefined;
  }
  state.active += 1;
  state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
  try {
    if (configuration.operationDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, configuration.operationDelayMs));
    }
    if (url.pathname === "/context/list") {
      state.loadListCalls += 1;
      if (configuration.failFirstLoadList && state.loadListCalls === 2) {
        return {
          status: 500,
          body: {
            error: "deliberate failure",
            detail: "bounded public error"
          }
        };
      }
      return {
        status: 200,
        body: {
          release,
          documents: [document],
          tree: [
            {
              id: "node-root",
              documentId: document.id,
              title: document.title,
              summary: document.summary,
              depth: 1,
              children: []
            }
          ],
          ...(configuration.exposePrompt
            ? {
                prompt: "private worker instructions",
                artifactUri: "gs://private-context-bucket/checkpoints/task.json",
                artifactPath: "context/tenants/t1/repositories/acme/context/builds/task_abc/output.json",
                diagnostic: "Error: private failure\n    at worker (/srv/private-worker.js:1:2)",
                rawEvidence: { providerPayload: "private provider body" }
              }
            : {})
        }
      };
    }
    if (url.pathname === "/context/read") {
      state.loadReadCalls += 1;
      if (url.searchParams.get("document") !== document.id) {
        return { status: 404, body: { error: "not found" } };
      }
      return {
        status: 200,
        body: {
          release,
          document: {
            ...document,
            bodyMarkdown:
              configuration.oversizeFirstLoadRead && state.loadReadCalls === 2
                ? `# Request architecture\n\n${"x".repeat(3_000)}`
                : "# Request architecture\n\nGrounded Context documentation."
          }
        }
      };
    }
    return {
      status: 200,
      body: {
        from: previousRelease,
        to: release,
        added: [],
        removed: [],
        changed: [],
        unchanged: [document.logicalId]
      }
    };
  } finally {
    state.active -= 1;
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function runProcess(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
