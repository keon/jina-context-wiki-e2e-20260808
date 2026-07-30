#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `Usage: context-security-load-e2e.mjs [options]

Required (or use the matching environment variables):
  --api-url URL          Explicit loopback Context API (JINA_API_URL)
  --tenant ID            Tenant ID (JINA_TENANT_ID)
  --internal-token TOKEN Internal/admin credential (INTERNAL_API_TOKEN)
  --query-token TOKEN    Context read/query credential (CONTEXT_API_TOKEN)
  --repository OWNER/REPO
  --build BUILD_ID       Already completed Board build
  --release RELEASE_ID   Already published release produced by the build
  --principal ID         Non-admin, repository-bound query-token principal
  --report PATH          Retained machine-readable JSON report

Optional:
  --ref REF                    Default: main
  --from-release RELEASE_ID    Default: the target release
  --document DOCUMENT_ID       Default: first document in list_context
  --internal-principal ID      Default: tenant:<tenant>
  --issued-principal ID        Default: user:context-security-load@jina.internal
  --isolation-repository REPO  Default: forbidden/context-security-probe
  --concurrency N              Default: 4; accepted range: 1-32
  --request-count N            Total list/read/diff requests. Default: 30; range: 3-1000
  --timeout-ms N               Per-request timeout. Default: 10000
  --max-p95-ms N               Maximum overall and per-operation p95. Default: 2000
  --max-error-rate N           Accepted load error ratio. Default: 0; range: 0-0.1
  --max-response-bytes N       Default: 8388608

This harness never calls search, never starts a build, and refuses non-loopback
targets. It creates and immediately revokes one short-lived local issued token
to prove revoked-token rejection.
`;

const FORBIDDEN_PUBLIC_KEYS = new Set(
  [
    "agentStages",
    "artifactKey",
    "artifactObjectKey",
    "auditInput",
    "auditResult",
    "blobContent",
    "boardTask",
    "boardTaskId",
    "checkpointArtifact",
    "checkpointKey",
    "checkpointPayload",
    "checkpointPath",
    "contentBase64",
    "dependencyResults",
    "developerPrompt",
    "evidence",
    "evidenceFingerprint",
    "evidenceSnapshot",
    "inputArtifact",
    "leaseId",
    "manifest",
    "manifestFingerprint",
    "modelOutput",
    "numberedBody",
    "observationPayload",
    "observations",
    "observationFrontier",
    "outputArtifact",
    "payload",
    "prompt",
    "providerEvidence",
    "providerDocument",
    "providerDocuments",
    "providerPayload",
    "rawEvidence",
    "repositoryManifest",
    "researchPlan",
    "researchPackets",
    "rawSource",
    "rawSourceFiles",
    "sourceBlob",
    "sourceContent",
    "sourceFiles",
    "stagePlan",
    "stack",
    "stackTrace",
    "systemPrompt",
    "transcript",
    "workerPrompt",
    "writeFenceToken",
    "writeToken",
    "taskDefinition"
  ].map(normalizedKey)
);

const FORBIDDEN_PUBLIC_STRING_PATTERNS = [
  {
    code: "gcs_uri",
    pattern: /\bgs:\/\/[^\s)"']+/i
  },
  {
    code: "artifact_object_key",
    pattern: /\bcontext-v2\/tenants\/[^/\s]+\/repositories\/[^/\s]+\/[^/\s]+\/builds\/task_[a-z0-9]+\/[^\s)"']+/i
  },
  {
    code: "stack_trace",
    pattern: /(?:^|\n)\s*(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|at\s+[^:\n]+:\d+:\d+)/m
  }
];

export async function runContextSecurityLoadAcceptance(options, dependencies = {}) {
  const config = normalizedOptions(options);
  assertLoopbackHttp(config.apiUrl);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const violations = [];
  const publicScans = [];
  let requestSequence = 0;

  const request = async (path, input = {}) => {
    requestSequence += 1;
    const started = performance.now();
    const credential = input.credential ?? "query";
    const token =
      input.token ??
      (credential === "internal" ? config.internalToken : credential === "none" ? undefined : config.queryToken);
    const tenantId = input.tenantId ?? config.tenantId;
    const principalId =
      input.principalId ??
      (credential === "internal"
        ? config.internalPrincipalId
        : tenantId === config.tenantId
          ? config.principalId
          : `tenant:${tenantId}`);
    try {
      const response = await fetchImplementation(new URL(path, config.apiUrl), {
        method: input.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "x-jina-tenant-id": tenantId,
          "x-jina-principal-id": principalId,
          "x-request-id": `context-security-load-${process.pid}-${requestSequence}`,
          ...(input.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      const responseBody = await readBoundedResponseBody(response, config.maxResponseBytes);
      if (responseBody.error) {
        return {
          status: response.status,
          latencyMs: performance.now() - started,
          bytes: responseBody.bytes,
          error: responseBody.error
        };
      }
      const { text, bytes } = responseBody;
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return {
          status: response.status,
          latencyMs: performance.now() - started,
          bytes,
          error: "invalid_json"
        };
      }
      return {
        status: response.status,
        latencyMs: performance.now() - started,
        bytes,
        body,
        headers: response.headers
      };
    } catch (error) {
      return {
        status: 0,
        latencyMs: performance.now() - started,
        bytes: 0,
        error: safeErrorCode(error)
      };
    }
  };

  const requireOk = async (path, input) => {
    const result = await request(path, input);
    if (result.status !== 200 || result.error) {
      throw new Error(`${path} did not return a bounded JSON HTTP 200 response`);
    }
    return result;
  };

  let target;
  let loadReport = emptyLoadReport(config);
  let security = {
    unauthorized: {},
    adminDenial: {},
    tenantIsolation: {},
    repositoryIsolation: {},
    revokedIssuedToken: { status: "not-run" }
  };

  try {
    const releasesResult = await requireOk(`/context/releases?${query({ repository: config.repository })}`);
    scanPublicPayload("releases", releasesResult.body, publicScans);
    const releases = requiredArray(requiredObject(releasesResult.body, "releases response").releases, "releases");
    const release = releases
      .map((value) => requiredObject(value, "release"))
      .find((value) => value.id === config.releaseId);
    if (!release) throw new Error(`required published release ${config.releaseId} was not returned`);
    requireReleaseIdentity(release, config);
    if (release.contextStatus !== "available") {
      throw new Error(`required release ${config.releaseId} is not available`);
    }

    const buildsResult = await requireOk("/context/builds", { credential: "internal" });
    const builds = requiredArray(requiredObject(buildsResult.body, "builds response").builds, "builds");
    const build = builds.map((value) => requiredObject(value, "build")).find((value) => value.id === config.buildId);
    if (!build) throw new Error(`required build ${config.buildId} was not returned`);
    if (build.status !== "completed") throw new Error(`required build ${config.buildId} is not completed`);
    if (build.repository !== config.repository || build.ref !== config.ref) {
      throw new Error(`required build ${config.buildId} does not match the requested repository/ref`);
    }
    if (typeof build.commitSha === "string" && release.commitSha !== build.commitSha) {
      throw new Error("published release commit does not match the required completed build");
    }

    const progressResult = await requireOk(`/context/builds/${encodeURIComponent(config.buildId)}/progress`, {
      credential: "internal"
    });
    const progress = requiredObject(progressResult.body, "build progress");
    if (progress.status !== "completed" || progress.repository !== config.repository || progress.ref !== config.ref) {
      throw new Error("required build progress is not completed for the requested repository/ref");
    }
    const stages = requiredArray(progress.stages, "progress.stages").map((value) =>
      requiredObject(value, "progress stage")
    );
    for (const type of ["publish-context-release", "index-context-release"]) {
      const stage = stages.find((value) => value.type === type);
      if (!stage || stage.status !== "done") throw new Error(`required completed build is missing successful ${type}`);
    }

    const listPath = `/context/list?${query({
      repository: config.repository,
      releaseId: config.releaseId
    })}`;
    const listResult = await requireOk(listPath);
    scanPublicPayload("list", listResult.body, publicScans);
    validateListResponse(listResult.body, release);
    const documents = requiredArray(requiredObject(listResult.body, "list response").documents, "list.documents").map(
      (value) => requiredObject(value, "list document")
    );
    if (documents.length === 0) throw new Error("required published release contains no Context documents");
    const documentId = config.documentId ?? requiredString(documents[0].id, "first document.id");
    if (!documents.some((document) => document.id === documentId)) {
      throw new Error(`requested document ${documentId} is not in release ${config.releaseId}`);
    }

    const readPath = `/context/read?${query({
      repository: config.repository,
      releaseId: config.releaseId,
      document: documentId
    })}`;
    const readResult = await requireOk(readPath);
    scanPublicPayload("read", readResult.body, publicScans);
    validateReadResponse(readResult.body, release, documentId);

    const diffPath = `/context/diff?${query({
      repository: config.repository,
      fromReleaseId: config.fromReleaseId,
      toReleaseId: config.releaseId
    })}`;
    const diffResult = await requireOk(diffPath);
    scanPublicPayload("diff", diffResult.body, publicScans);
    validateDiffResponse(diffResult.body, config.fromReleaseId, release);

    const baselines = {
      list: sha256Canonical(listResult.body),
      read: sha256Canonical(readResult.body),
      diff: sha256Canonical(diffResult.body)
    };
    target = {
      commitSha: release.commitSha,
      documentId,
      listPath,
      readPath,
      diffPath,
      baselines,
      release
    };

    const loadResults = await mapWithConcurrency(
      Array.from({ length: config.requestCount }, (_, index) => ["list", "read", "diff"][index % 3]),
      config.concurrency,
      async (operation) => {
        const path = target[`${operation}Path`];
        const result = await request(path);
        let contractError;
        if (result.status === 200 && !result.error) {
          try {
            if (operation === "list") validateListResponse(result.body, release);
            else if (operation === "read") validateReadResponse(result.body, release, documentId);
            else validateDiffResponse(result.body, config.fromReleaseId, release);
            if (sha256Canonical(result.body) !== baselines[operation]) contractError = "response_digest_changed";
            scanPublicPayload(`load.${operation}`, result.body, publicScans);
          } catch (error) {
            contractError = safeErrorCode(error);
          }
        }
        return {
          operation,
          status: result.status,
          latencyMs: result.latencyMs,
          bytes: result.bytes,
          error: result.error ?? contractError
        };
      }
    );
    loadReport = summarizeLoad(loadResults, config);
    if (loadReport.errorRate > config.maxErrorRate) {
      addViolation(
        violations,
        "load_error_rate",
        `load error rate ${loadReport.errorRate} exceeded ${config.maxErrorRate}`
      );
    }
    if (loadReport.latencyMs.p95 > config.maxP95Ms) {
      addViolation(
        violations,
        "load_latency",
        `overall p95 ${loadReport.latencyMs.p95}ms exceeded ${config.maxP95Ms}ms`
      );
    }
    for (const [operation, summary] of Object.entries(loadReport.operations)) {
      if (summary.latencyMs.p95 > config.maxP95Ms) {
        addViolation(
          violations,
          "operation_latency",
          `${operation} p95 ${summary.latencyMs.p95}ms exceeded ${config.maxP95Ms}ms`
        );
      }
    }

    security = await runSecurityChecks({
      config,
      request,
      publicScans,
      violations,
      release,
      documentId
    });
  } catch (error) {
    addViolation(violations, "acceptance_contract", safeErrorMessage(error));
  }

  for (const scan of publicScans) {
    addViolation(violations, scan.code, `${scan.surface}: ${scan.location}`);
  }

  const finishedAt = now().toISOString();
  return {
    schemaVersion: "context-security-load-e2e-v1",
    status: violations.length === 0 ? "passed" : "failed",
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    target: {
      apiUrl: config.apiUrl,
      tenantId: config.tenantId,
      repository: config.repository,
      ref: config.ref,
      buildId: config.buildId,
      releaseId: config.releaseId,
      fromReleaseId: config.fromReleaseId,
      ...(target?.commitSha ? { commitSha: target.commitSha } : {}),
      ...(target?.documentId ? { documentId: target.documentId } : {})
    },
    configuration: {
      concurrency: config.concurrency,
      requestCount: config.requestCount,
      timeoutMs: config.timeoutMs,
      maxP95Ms: config.maxP95Ms,
      maxErrorRate: config.maxErrorRate,
      maxResponseBytes: config.maxResponseBytes,
      searchRequests: 0
    },
    load: loadReport,
    security,
    publicPayloadInspection: {
      scannedResponses: publicScans.scannedResponses ?? 0,
      leaks: publicScans.length
    },
    violations
  };
}

async function runSecurityChecks(input) {
  const { config, request, publicScans, violations, release, documentId } = input;
  const noCredential = await request(`/context/releases?${query({ repository: config.repository })}`, {
    credential: "none"
  });
  scanPublicPayload("unauthorized", noCredential.body, publicScans);
  expectDenial(noCredential, [401], "missing credential", violations);

  const metrics = await request("/context/metrics");
  scanPublicPayload("admin.metrics", metrics.body, publicScans);
  expectDenial(metrics, [401, 403], "query token admin metrics", violations);
  const board = await request("/board");
  scanPublicPayload("admin.board", board.body, publicScans);
  expectDenial(board, [401, 403], "query token Board", violations);
  const tokenAdministration = await request("/internal/context/tokens");
  scanPublicPayload("admin.tokens", tokenAdministration.body, publicScans);
  expectDenial(tokenAdministration, [401, 403], "query token token administration", violations);

  const wrongTenant = wrongTenantId(config.tenantId);
  const tenantResult = await request(`/context/releases?${query({ repository: config.repository })}`, {
    tenantId: wrongTenant
  });
  scanPublicPayload("isolation.tenant", tenantResult.body, publicScans);
  expectDenial(tenantResult, [401, 403, 404], "cross-tenant repository catalog", violations);
  rejectOracleData(tenantResult.body, { config, release, documentId }, "cross-tenant response", violations);

  const repositoryResult = await request(`/context/releases?${query({ repository: config.isolationRepository })}`);
  scanPublicPayload("isolation.repository", repositoryResult.body, publicScans);
  expectDenial(repositoryResult, [403, 404], "unauthorized repository catalog", violations);
  rejectOracleData(repositoryResult.body, { config, release, documentId }, "repository isolation response", violations);

  const directReleaseResult = await request(
    `/context/list?${query({
      repository: config.isolationRepository,
      releaseId: config.releaseId
    })}`
  );
  scanPublicPayload("isolation.release-oracle", directReleaseResult.body, publicScans);
  expectDenial(directReleaseResult, [403, 404], "cross-repository release oracle", violations);
  rejectOracleData(directReleaseResult.body, { config, release, documentId }, "release oracle response", violations);

  const revokedIssuedToken = await mintRevokeAndProve(input);
  return {
    unauthorized: { releases: noCredential.status },
    adminDenial: {
      metrics: metrics.status,
      board: board.status,
      tokenAdministration: tokenAdministration.status
    },
    tenantIsolation: { tenantId: wrongTenant, status: tenantResult.status },
    repositoryIsolation: {
      repository: config.isolationRepository,
      catalogStatus: repositoryResult.status,
      releaseOracleStatus: directReleaseResult.status
    },
    revokedIssuedToken
  };
}

async function mintRevokeAndProve(input) {
  const { config, request, publicScans, violations } = input;
  let tokenId;
  let secret;
  let revoked = false;
  try {
    const minted = await request("/internal/context/tokens", {
      credential: "internal",
      method: "POST",
      body: {
        principalId: config.issuedPrincipalId,
        name: "Context security/load acceptance",
        scopes: ["context:read", "context:query"],
        expiresInMinutes: 5
      }
    });
    if (minted.status !== 201 || minted.error) {
      addViolation(violations, "issued_token_mint", "local issued-token mint did not return HTTP 201");
      return { status: "failed", mintStatus: minted.status };
    }
    const mintBody = requiredObject(minted.body, "mint response");
    secret = requiredString(mintBody.secret, "mint response.secret");
    const token = requiredObject(mintBody.token, "mint response.token");
    tokenId = requiredString(token.id, "mint response.token.id");
    if ("secret" in token || "secretHash" in token) {
      addViolation(violations, "issued_token_secret_exposure", "issued token metadata exposed secret material");
    }
  } catch (error) {
    addViolation(violations, "issued_token_mint", safeErrorMessage(error));
    return { status: "failed" };
  } finally {
    if (tokenId && secret) {
      const revokedResult = await request(`/internal/context/tokens/${encodeURIComponent(tokenId)}/revoke`, {
        credential: "internal",
        method: "POST"
      });
      revoked = revokedResult.status === 200;
      if (!revoked) {
        addViolation(violations, "issued_token_revoke", "temporary local issued token could not be revoked");
      }
    }
  }
  if (!revoked || !secret) return { status: "failed" };

  const revokedCatalog = await request(`/context/releases?${query({ repository: config.repository })}`, {
    token: secret,
    principalId: config.issuedPrincipalId
  });
  scanPublicPayload("revoked-token.releases", revokedCatalog.body, publicScans);
  expectDenial(revokedCatalog, [401], "revoked token release catalog", violations);
  const revokedList = await request(
    `/context/list?${query({ repository: config.repository, releaseId: config.releaseId })}`,
    {
      token: secret,
      principalId: config.issuedPrincipalId
    }
  );
  scanPublicPayload("revoked-token.list", revokedList.body, publicScans);
  expectDenial(revokedList, [401], "revoked token list", violations);
  return {
    status: revokedCatalog.status === 401 && revokedList.status === 401 ? "passed" : "failed",
    revoked: true,
    releasesStatus: revokedCatalog.status,
    listStatus: revokedList.status
  };
}

function validateListResponse(value, release) {
  const response = requiredObject(value, "list response");
  requireSameRelease(requiredObject(response.release, "list.release"), release, "list");
  requiredArray(response.documents, "list.documents");
  requiredArray(response.tree, "list.tree");
}

function validateReadResponse(value, release, documentId) {
  const response = requiredObject(value, "read response");
  requireSameRelease(requiredObject(response.release, "read.release"), release, "read");
  const document = requiredObject(response.document, "read.document");
  if (document.id !== documentId) throw new Error("read response changed document identity");
  if (typeof document.bodyMarkdown !== "string" || document.bodyMarkdown.length === 0) {
    throw new Error("read response omitted derived Context Markdown");
  }
}

function validateDiffResponse(value, fromReleaseId, release) {
  const response = requiredObject(value, "diff response");
  const from = requiredObject(response.from, "diff.from");
  const to = requiredObject(response.to, "diff.to");
  if (from.id !== fromReleaseId) throw new Error("diff response changed the requested from release");
  requireSameRelease(to, release, "diff.to");
}

function requireSameRelease(actual, expected, surface) {
  for (const key of ["id", "repository", "ref", "commitSha"]) {
    if (actual[key] !== expected[key]) throw new Error(`${surface} response changed release ${key}`);
  }
}

function requireReleaseIdentity(release, config) {
  if (
    release.id !== config.releaseId ||
    release.repository !== config.repository ||
    release.ref !== config.ref ||
    typeof release.commitSha !== "string" ||
    release.commitSha.length !== 40
  ) {
    throw new Error("required published release identity does not match the requested release");
  }
}

function scanPublicPayload(surface, value, scans) {
  if (value === undefined) return;
  scans.scannedResponses = (scans.scannedResponses ?? 0) + 1;
  const walk = (current, path) => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) {
        if (FORBIDDEN_PUBLIC_KEYS.has(normalizedKey(key))) {
          scans.push({ code: "private_field_exposure", surface, location: `${path}.${key}` });
        }
        walk(entry, `${path}.${key}`);
      }
      return;
    }
    if (typeof current !== "string") return;
    for (const forbidden of FORBIDDEN_PUBLIC_STRING_PATTERNS) {
      if (forbidden.pattern.test(current)) {
        scans.push({ code: forbidden.code, surface, location: path });
      }
    }
  };
  walk(value, "$");
}

function rejectOracleData(body, input, label, violations) {
  const text = canonicalJson(body ?? null);
  for (const [kind, value] of [
    ["target repository", input.config.repository],
    ["target release", input.release.id],
    ["target commit", input.release.commitSha],
    ["target document", input.documentId]
  ]) {
    if (typeof value === "string" && value && text.includes(value)) {
      addViolation(violations, "isolation_oracle", `${label} exposed ${kind}`);
    }
  }
}

function expectDenial(result, statuses, label, violations) {
  if (!statuses.includes(result.status)) {
    addViolation(
      violations,
      "authorization_denial",
      `${label} returned HTTP ${result.status}; expected ${statuses.join("/")}`
    );
  }
}

function summarizeLoad(results, config) {
  const errors = results.filter((result) => result.status !== 200 || result.error);
  const operations = Object.fromEntries(
    ["list", "read", "diff"].map((operation) => {
      const selected = results.filter((result) => result.operation === operation);
      return [operation, summarizeRequests(selected)];
    })
  );
  return {
    requests: results.length,
    successes: results.length - errors.length,
    errors: errors.length,
    errorRate: results.length === 0 ? 1 : errors.length / results.length,
    latencyMs: latencySummary(results.map((result) => result.latencyMs)),
    bytes: results.reduce((sum, result) => sum + result.bytes, 0),
    statusCounts: countValues(results.map((result) => String(result.status))),
    errorCounts: countValues(errors.map((result) => result.error ?? `http_${result.status}`)),
    operations,
    limits: {
      maxP95Ms: config.maxP95Ms,
      maxErrorRate: config.maxErrorRate
    }
  };
}

function summarizeRequests(results) {
  const errors = results.filter((result) => result.status !== 200 || result.error);
  return {
    requests: results.length,
    successes: results.length - errors.length,
    errors: errors.length,
    latencyMs: latencySummary(results.map((result) => result.latencyMs)),
    statusCounts: countValues(results.map((result) => String(result.status))),
    errorCounts: countValues(errors.map((result) => result.error ?? `http_${result.status}`))
  };
}

function emptyLoadReport(config) {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    errorRate: 1,
    latencyMs: latencySummary([]),
    bytes: 0,
    statusCounts: {},
    errorCounts: {},
    operations: {
      list: summarizeRequests([]),
      read: summarizeRequests([]),
      diff: summarizeRequests([])
    },
    limits: {
      maxP95Ms: config.maxP95Ms,
      maxErrorRate: config.maxErrorRate
    }
  };
}

function latencySummary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { min: 0, average: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    min: rounded(sorted[0]),
    average: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    p99: rounded(percentile(sorted, 0.99)),
    max: rounded(sorted.at(-1))
  };
}

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await worker(values[index], index);
      }
    })
  );
  return results;
}

async function readBoundedResponseBody(response, maximumBytes) {
  const advertisedBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedBytes) && advertisedBytes > maximumBytes) {
    await cancelBody(response.body);
    return { text: "", bytes: advertisedBytes, error: "response_too_large" };
  }
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        await cancelBody(reader);
        return { text: "", bytes, error: "response_too_large" };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, bytes).toString("utf8"), bytes };
}

async function cancelBody(body) {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    return;
  }
}

function countValues(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function addViolation(violations, code, message) {
  const entry = { code, message: String(message).slice(0, 500) };
  if (!violations.some((current) => current.code === entry.code && current.message === entry.message)) {
    violations.push(entry);
  }
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedOptions(options) {
  const tenantId = requiredOption(options.tenantId, "tenantId");
  const requestCount = boundedInteger(options.requestCount ?? 30, "requestCount", 3, 1_000);
  const concurrency = boundedInteger(options.concurrency ?? 4, "concurrency", 1, 32);
  const timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, "timeoutMs", 500, 120_000);
  const maxP95Ms = boundedInteger(options.maxP95Ms ?? 2_000, "maxP95Ms", 1, 120_000);
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? 8 * 1024 * 1024,
    "maxResponseBytes",
    1_024,
    64 * 1024 * 1024
  );
  const maxErrorRate = Number(options.maxErrorRate ?? 0);
  if (!Number.isFinite(maxErrorRate) || maxErrorRate < 0 || maxErrorRate > 0.1) {
    throw new Error("maxErrorRate must be between 0 and 0.1");
  }
  const repository = requiredOption(options.repository, "repository").toLowerCase();
  const isolationRepository = (options.isolationRepository?.trim() || "forbidden/context-security-probe").toLowerCase();
  const principalId = requiredOption(options.principalId, "principalId");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  if (!/^[\w.-]+\/[\w.-]+$/.test(isolationRepository)) {
    throw new Error("isolationRepository must be owner/name");
  }
  if (repository === isolationRepository) throw new Error("isolationRepository must differ from repository");
  if (principalId === `tenant:${tenantId}` || principalId.toLowerCase().startsWith("svc:")) {
    throw new Error("principalId must be a non-admin repository-bound query principal");
  }
  return {
    apiUrl: requiredOption(options.apiUrl, "apiUrl").replace(/\/$/, ""),
    tenantId,
    internalToken: requiredOption(options.internalToken, "internalToken"),
    queryToken: requiredOption(options.queryToken, "queryToken"),
    repository,
    ref: requiredOption(options.ref ?? "main", "ref"),
    buildId: requiredOption(options.buildId, "buildId"),
    releaseId: requiredOption(options.releaseId, "releaseId"),
    fromReleaseId: options.fromReleaseId?.trim() || requiredOption(options.releaseId, "releaseId"),
    documentId: options.documentId?.trim(),
    principalId,
    internalPrincipalId: options.internalPrincipalId?.trim() || `tenant:${tenantId}`,
    issuedPrincipalId: options.issuedPrincipalId?.trim() || "user:context-security-load@jina.internal",
    isolationRepository,
    concurrency,
    requestCount,
    timeoutMs,
    maxP95Ms,
    maxErrorRate,
    maxResponseBytes
  };
}

function assertLoopbackHttp(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:") throw new Error("API URL must use loopback HTTP");
  if (parsed.username || parsed.password) {
    throw new Error("API URL must not contain credentials");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("API URL must be explicitly loopback; external targets are forbidden");
  }
}

function wrongTenantId(tenantId) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    const last = tenantId.at(-1).toLowerCase();
    return `${tenantId.slice(0, -1)}${last === "f" ? "e" : "f"}`;
  }
  return `wrong-${tenantId}`;
}

function query(values) {
  return new URLSearchParams(
    Object.entries(values).flatMap(([key, value]) =>
      value === undefined || value === "" ? [] : [[key, String(value)]]
    )
  ).toString();
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function requiredOption(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizedKey(value) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function safeErrorCode(error) {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
  return "request_failed";
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function cliOptions(argv, environment) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values[name.slice(2)] = value;
    index += 1;
  }
  return {
    apiUrl: values["api-url"] ?? environment.JINA_API_URL,
    tenantId: values.tenant ?? environment.JINA_TENANT_ID ?? environment.JINA_CONTEXT_TENANT_ID,
    internalToken: values["internal-token"] ?? environment.JINA_INTERNAL_TOKEN ?? environment.INTERNAL_API_TOKEN,
    queryToken: values["query-token"] ?? environment.JINA_CONTEXT_TOKEN ?? environment.CONTEXT_API_TOKEN,
    repository: values.repository ?? environment.CONTEXT_SECURITY_LOAD_REPOSITORY,
    ref: values.ref ?? environment.CONTEXT_SECURITY_LOAD_REF ?? "main",
    buildId: values.build ?? environment.CONTEXT_SECURITY_LOAD_BUILD_ID,
    releaseId: values.release ?? environment.CONTEXT_SECURITY_LOAD_RELEASE_ID,
    fromReleaseId: values["from-release"] ?? environment.CONTEXT_SECURITY_LOAD_FROM_RELEASE_ID,
    documentId: values.document ?? environment.CONTEXT_SECURITY_LOAD_DOCUMENT,
    principalId:
      values.principal ?? environment.CONTEXT_SECURITY_LOAD_PRINCIPAL_ID ?? environment.JINA_CONTEXT_PRINCIPAL_ID,
    internalPrincipalId: values["internal-principal"] ?? environment.CONTEXT_SECURITY_LOAD_INTERNAL_PRINCIPAL_ID,
    issuedPrincipalId: values["issued-principal"] ?? environment.CONTEXT_SECURITY_LOAD_ISSUED_PRINCIPAL_ID,
    isolationRepository: values["isolation-repository"] ?? environment.CONTEXT_SECURITY_LOAD_ISOLATION_REPOSITORY,
    concurrency: values.concurrency ?? environment.CONTEXT_SECURITY_LOAD_CONCURRENCY,
    requestCount: values["request-count"] ?? environment.CONTEXT_SECURITY_LOAD_REQUEST_COUNT,
    timeoutMs: values["timeout-ms"] ?? environment.CONTEXT_SECURITY_LOAD_TIMEOUT_MS,
    maxP95Ms: values["max-p95-ms"] ?? environment.CONTEXT_SECURITY_LOAD_MAX_P95_MS,
    maxErrorRate: values["max-error-rate"] ?? environment.CONTEXT_SECURITY_LOAD_MAX_ERROR_RATE,
    maxResponseBytes: values["max-response-bytes"] ?? environment.CONTEXT_SECURITY_LOAD_MAX_RESPONSE_BYTES,
    reportPath: values.report ?? environment.CONTEXT_SECURITY_LOAD_REPORT
  };
}

async function writeReport(reportPath, report) {
  const destination = resolve(requiredOption(reportPath, "report"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(destination, 0o600);
  return destination;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  let options;
  try {
    const arguments_ = process.argv.slice(2).filter((value) => value !== "--");
    if (arguments_.includes("--help") || arguments_.includes("-h")) {
      process.stdout.write(HELP);
      process.exit(0);
    }
    options = cliOptions(arguments_, process.env);
    const report = await runContextSecurityLoadAcceptance(options);
    const destination = await writeReport(options.reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`Retained Context security/load report: ${destination}\n`);
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    const failed = {
      schemaVersion: "context-security-load-e2e-v1",
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      violations: [{ code: "harness_configuration", message: safeErrorMessage(error) }]
    };
    try {
      if (options?.reportPath) await writeReport(options.reportPath, failed);
    } catch {
      // The original bounded diagnostic is more useful than a second write failure.
    }
    process.stderr.write(`Context security/load acceptance failed: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
