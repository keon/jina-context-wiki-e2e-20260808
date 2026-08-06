import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { contextWorkflowBoardTaskTypeDefinitions, contextWorkflowBoardTopics } from "@jina/context-engine";

const CONTEXT_BOARD_WORKER_TOPICS = Object.values(contextWorkflowBoardTopics);
const REQUIRED_RELEASE_TASK_TYPES = ["publish-context-release"] as const;
const TERMINAL_TASK_STATUSES = new Set(["done", "canceled", "failed", "superseded"]);
const CONTEXT_WORKER_TASK_TYPES = new Set(
  contextWorkflowBoardTaskTypeDefinitions
    .filter((definition) => definition.kind === "dispatchable" && definition.dispatchTopic)
    .map((definition) => definition.type)
);
const MAX_PRODUCTION_REMEDIATIONS = 4;
// Public document titles are immutable, Board-owned retrieval targets. Sampling
// the first three by logical ID keeps the gate bounded; exact-title retrieval
// must recover every owning document because lexical PageIndex scoring is
// deterministic and the title is present in both the catalog and tree.
const PRODUCTION_RETRIEVAL_SAMPLE_LIMIT = 3;
const PRODUCTION_RETRIEVAL_MIN_HIT_RATE = 1;
const WORKER_HEALTH_KEYS = new Set([
  "ok",
  "workerId",
  "claimMode",
  "workerReleaseId",
  "workerService",
  "workerRevision",
  "topics",
  "active",
  "lastApiSuccessAt",
  "lastApiErrorAt",
  "consecutiveApiFailures",
  "lastWork",
  "metrics"
]);

export interface ProductionWorkerHealthCheck {
  readonly url: string;
  readonly authorization: string;
  readonly expectedTopics: readonly string[];
  readonly expectedReleaseId?: string;
  readonly expectedRevision?: string;
}

export interface ProductionWebSurfaceChecks {
  readonly dashboardUrl: string;
  readonly adminUrl: string;
  readonly dashboardInvocationAuthorization: string;
  readonly dashboardAuthorization: string;
  readonly adminAuthorization: string;
}

export interface ProductionContextAcceptanceConfig {
  readonly apiUrl: string;
  readonly internalToken: string;
  readonly tenantId?: string;
  readonly principalId: string;
  readonly adminPrincipalId: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly githubInstallationId?: number;
  /**
   * Wall clock the gate's agent stages may use.
   *
   * A release waits on this build, so the deployment gate keeps this bounded
   * while ordinary builds may use the larger production ceiling. Reaching the
   * bound must retain private page checkpoints without partially publishing.
   */
  readonly derivationBudgetSeconds?: number;
  readonly derivationTokenBudget?: number;
  readonly requestKey?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly workerHealthChecks?: readonly ProductionWorkerHealthCheck[];
  readonly expectedWorkerReleaseId?: string;
  readonly expectedContextWorkerRevision?: string;
  readonly workerHealthTimeoutMs?: number;
  readonly webSurfaceChecks?: ProductionWebSurfaceChecks;
  readonly fetchImpl?: typeof fetch;
  readonly verifyMcp?: (input: {
    apiUrl: string;
    headers: Record<string, string>;
    repository: string;
    ref: string;
    commitSha: string;
    releaseId: string;
    documentId: string;
    fromReleaseId: string;
    fromCommitSha: string;
  }) => Promise<number>;
  readonly log?: (message: string) => void;
}

export interface ProductionContextAcceptanceSummary {
  readonly buildId: string;
  readonly repository: string;
  readonly ref: string;
  readonly releaseId: string;
  readonly commitSha: string;
  readonly releaseCount: number;
  readonly documentCount: number;
  readonly citationCount: number;
  readonly mcpCitationCount: number;
  readonly webSurfaceCount: number;
  readonly durationMs: number;
}

export async function runProductionContextAcceptance(
  config: ProductionContextAcceptanceConfig
): Promise<ProductionContextAcceptanceSummary> {
  const startedAt = Date.now();
  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const repository = config.repository ?? "omxyz/jina-context-graph-e2e";
  const ref = config.ref ?? "main";
  const timeoutMs = config.timeoutMs ?? 50 * 60_000;
  const pollIntervalMs = config.pollIntervalMs ?? 10_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const log = config.log ?? console.log;
  const acceptanceRequestKey = config.requestKey ?? `acceptance-${Date.now()}`;
  const queryPrincipalId = nonAdminAcceptancePrincipal(config.principalId, config.adminPrincipalId);
  const queryIdentityHeaders = {
    "x-jina-principal-id": queryPrincipalId,
    ...(config.tenantId ? { "x-jina-tenant-id": config.tenantId } : {})
  };
  const adminIdentityHeaders = {
    "x-jina-principal-id": config.adminPrincipalId,
    ...(config.tenantId ? { "x-jina-tenant-id": config.tenantId } : {})
  };
  const accessSyncHeaders = {
    ...queryIdentityHeaders,
    authorization: `Bearer ${config.internalToken}`,
    "content-type": "application/json"
  };
  const internalHeaders = {
    ...adminIdentityHeaders,
    authorization: `Bearer ${config.internalToken}`,
    "content-type": "application/json"
  };

  for (const worker of config.workerHealthChecks ?? []) {
    await verifyWorkerHealth(fetchImpl, worker, config.workerHealthTimeoutMs ?? 120_000);
  }

  await apiJson(fetchImpl, `${apiUrl}/internal/context/access/sync`, {
    method: "POST",
    headers: accessSyncHeaders,
    body: JSON.stringify({ repositories: [repository], mode: "merge" })
  });

  const created = await apiJson(fetchImpl, `${apiUrl}/context/build`, {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify({
      repository,
      ref,
      ...(config.githubInstallationId ? { githubInstallationId: config.githubInstallationId } : {}),
      ...(config.derivationBudgetSeconds ? { derivationBudgetSeconds: config.derivationBudgetSeconds } : {}),
      ...(config.derivationTokenBudget ? { derivationTokenBudget: config.derivationTokenBudget } : {}),
      requestKey: acceptanceRequestKey
    })
  });
  const buildId = requiredString(record(created.build).id, "build.id");
  log(`Production context build ${buildId} accepted for ${repository}@${ref}`);

  const deadline = Date.now() + timeoutMs;
  let completedTasks: Record<string, unknown>[] = [];
  let remediationAttempts = 0;
  while (Date.now() < deadline) {
    let board: Record<string, unknown>;
    try {
      board = await apiJson(fetchImpl, `${apiUrl}/board`, { headers: internalHeaders });
    } catch (error) {
      if (!isTransientApiFailure(error)) throw error;
      log(`Production context build ${buildId}: transient Board read failure; retrying`);
      await delay(pollIntervalMs);
      continue;
    }
    const tasks = requiredArray(board.tasks, "board.tasks").filter(isRecord);
    const root = tasks.find((task) => task.id === buildId);
    if (!root) throw new Error(`production context build ${buildId} is missing from the board`);
    const descendants = contextBuildDescendants(tasks, buildId);
    log(renderStatus(buildId, root, descendants));
    const failed = descendants.find((task) => task.status === "failed");
    if (failed || root.status === "failed") {
      const remediationMode =
        remediationAttempts < MAX_PRODUCTION_REMEDIATIONS
          ? await requestProductionRemediation({
              fetchImpl,
              apiUrl,
              internalHeaders,
              buildId,
              requestScope: acceptanceRequestKey,
              attempt: remediationAttempts + 1
            })
          : undefined;
      if (remediationMode) {
        remediationAttempts += 1;
        const checkpoint =
          remediationMode === "page_remediation"
            ? "page"
            : remediationMode === "gate_remediation"
              ? "global gate"
              : "recoverable stage";
        log(
          `Production context build ${buildId} resumed from a retained ` +
            `${checkpoint} checkpoint (${remediationAttempts}/${MAX_PRODUCTION_REMEDIATIONS})`
        );
        await delay(pollIntervalMs);
        continue;
      }
      if (failed) {
        throw new Error(`production context task ${String(failed.type)} failed: ${failureReason(failed)}`);
      }
      throw new Error(`production context build ${buildId} failed: ${failureReason(root)}`);
    }
    if (root.status === "canceled" || root.status === "superseded") {
      throw new Error(`production context build ${buildId} ended as ${String(root.status)}`);
    }
    if (root.status === "done") {
      const incomplete = descendants.filter((task) => !TERMINAL_TASK_STATUSES.has(String(task.status)));
      if (incomplete.length > 0) {
        await delay(pollIntervalMs);
        continue;
      }
      const missingReleaseGates = REQUIRED_RELEASE_TASK_TYPES.filter(
        (type) => !descendants.some((task) => task.type === type && task.status === "done")
      );
      if (missingReleaseGates.length > 0) {
        throw new Error(
          `production context build ${buildId} completed without successful ${missingReleaseGates.join(", ")}`
        );
      }
      completedTasks = descendants;
      break;
    }
    await delay(pollIntervalMs);
  }
  if (completedTasks.length === 0) {
    try {
      const cancellation = await apiJson(
        fetchImpl,
        `${apiUrl}/internal/context/builds/${encodeURIComponent(buildId)}/cancel`,
        {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({ reason: "production acceptance timeout" })
        }
      );
      if (cancellation.buildId !== buildId || cancellation.canceled !== true) {
        throw new Error("API did not confirm the timed-out build as canceled");
      }
    } catch (error) {
      throw new Error(`production context build ${buildId} timed out and cancellation failed: ${errorMessage(error)}`, {
        cause: error
      });
    }
    throw new Error(`production context build ${buildId} timed out and was canceled`);
  }

  const blocked = blockedContextTaskIds(completedTasks, repository, ref);
  if (blocked.length) throw new Error(`production context workflow retains blocked stages: ${blocked.join(", ")}`);
  if (config.expectedWorkerReleaseId && config.expectedContextWorkerRevision) {
    const attestation = await apiJson(
      fetchImpl,
      `${apiUrl}/internal/context/builds/${encodeURIComponent(buildId)}/worker-completions`,
      { headers: internalHeaders }
    );
    if (attestation.buildId !== buildId || attestation.repository !== repository) {
      throw new Error("production worker completion attestation is not bound to the accepted build");
    }
    assertWorkerReleaseReceipts(
      completedTasks,
      requiredArray(attestation.completions, "worker completions").filter(isRecord),
      config.expectedWorkerReleaseId,
      config.expectedContextWorkerRevision
    );
  }

  const queryAcceptance = await withIssuedAcceptanceToken(
    {
      fetchImpl,
      apiUrl,
      internalHeaders,
      queryIdentityHeaders,
      principalId: queryPrincipalId,
      tenantId: config.tenantId,
      repository,
      buildId
    },
    async (contextHeaders) => {
      const releasesPayload = await apiJson(
        fetchImpl,
        `${apiUrl}/context/releases?repository=${encodeURIComponent(repository)}`,
        { headers: contextHeaders }
      );
      const releases = requiredArray(releasesPayload.releases, "releases").filter(isRecord);
      const latest = releases.find((release) => release.ref === ref);
      if (!latest) throw new Error("production context has no published release for the accepted ref");
      const releaseId = requiredString(latest.id, "release.id");
      const commitSha = requiredGitSha(latest.commitSha, "release.commitSha");
      if (latest.contextStatus !== "available") {
        throw new Error("production complete release is missing derived context");
      }
      await verifyProductionContextIsolation(fetchImpl, {
        apiUrl,
        headers: contextHeaders,
        repository,
        releaseId,
        buildId,
        timeoutMs: 30_000
      });

      const catalog = await apiJson(
        fetchImpl,
        `${apiUrl}/context/list?repository=${encodeURIComponent(repository)}&releaseId=${encodeURIComponent(releaseId)}`,
        { headers: contextHeaders }
      );
      assertRelease(catalog.release, { repository, ref, releaseId, commitSha }, "HTTP list");
      const documents = requiredArray(catalog.documents, "documents").filter(isRecord);
      if (documents.length === 0) throw new Error("production context document catalog is empty");
      assertCatalogTree(catalog.tree, documents);
      for (const document of documents) {
        assertContextCitations(
          requiredArray(document.citations, "document.citations").filter(isRecord),
          repository,
          commitSha
        );
      }
      const documentId = requiredString(documents[0]!.id, "document.id");

      const read = await apiJson(
        fetchImpl,
        `${apiUrl}/context/read?repository=${encodeURIComponent(repository)}&releaseId=${encodeURIComponent(
          releaseId
        )}&document=${encodeURIComponent(documentId)}`,
        { headers: contextHeaders }
      );
      assertRelease(read.release, { repository, ref, releaseId, commitSha }, "HTTP read");
      const readDocument = record(read.document);
      if (readDocument.id !== documentId) throw new Error("production HTTP read returned the wrong document");
      requiredString(readDocument.bodyMarkdown, "document.bodyMarkdown");
      assertContextCitations(
        requiredArray(readDocument.citations, "read document citations").filter(isRecord),
        repository,
        commitSha
      );

      const previousRelease = releases.find((release) => release.ref === ref && release.id !== releaseId) ?? latest;
      const fromReleaseId = requiredString(previousRelease.id, "previous release.id");
      const fromCommitSha = requiredGitSha(previousRelease.commitSha, "previous release.commitSha");
      const diff = await apiJson(
        fetchImpl,
        `${apiUrl}/context/diff?repository=${encodeURIComponent(repository)}&fromReleaseId=${encodeURIComponent(
          fromReleaseId
        )}&toReleaseId=${encodeURIComponent(releaseId)}`,
        { headers: contextHeaders }
      );
      assertContextDiff(diff, {
        repository,
        ref,
        fromReleaseId,
        fromCommitSha,
        toReleaseId: releaseId,
        toCommitSha: commitSha
      });

      const citations = await verifyProductionRetrievalQuality(fetchImpl, {
        apiUrl,
        headers: contextHeaders,
        repository,
        ref,
        releaseId,
        commitSha,
        documents
      });

      const mcpCitationCount = config.verifyMcp
        ? await config.verifyMcp({
            apiUrl,
            headers: contextHeaders,
            repository,
            ref,
            commitSha,
            releaseId,
            documentId,
            fromReleaseId,
            fromCommitSha
          })
        : await verifyProductionMcp({
            apiUrl,
            headers: contextHeaders,
            repository,
            ref,
            commitSha,
            releaseId,
            documentId,
            fromReleaseId,
            fromCommitSha
          });

      return {
        releaseId,
        commitSha,
        releaseCount: releases.length,
        documentCount: documents.length,
        citationCount: citations.length,
        mcpCitationCount
      };
    }
  );

  const { releaseId, commitSha, releaseCount, documentCount, citationCount, mcpCitationCount } = queryAcceptance;

  // Projection consumers drain asynchronously, so reading the depth once the
  // instant a build completes asks whether they have finished yet, not whether
  // they finish. A release failed on exactly that -- acl and retention each one
  // deep, moments from empty -- so this waits for the backlog to drain and only
  // fails if it stays.
  const backlogDeadline = Date.now() + (optionalPositiveInteger(process.env.ACCEPTANCE_BACKLOG_TIMEOUT_MS) ?? 120_000);
  for (;;) {
    const metrics = await apiJson(fetchImpl, `${apiUrl}/context/metrics?repository=${encodeURIComponent(repository)}`, {
      headers: internalHeaders
    });
    const pending = Object.entries(record(metrics.outboxDepthByConsumer)).filter(([, value]) => Number(value) > 0);
    if (pending.length === 0) break;
    if (Date.now() >= backlogDeadline) {
      throw new Error(`production context backlog is not empty: ${JSON.stringify(pending)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const webSurfaceCount = config.webSurfaceChecks
    ? await verifyProductionWebSurfaces(fetchImpl, config.webSurfaceChecks, {
        repository,
        releaseId,
        timeoutMs: config.workerHealthTimeoutMs ?? 120_000
      })
    : 0;

  return {
    buildId,
    repository,
    ref,
    releaseId,
    commitSha,
    releaseCount,
    documentCount,
    citationCount,
    mcpCitationCount,
    webSurfaceCount,
    durationMs: Date.now() - startedAt
  };
}

async function withIssuedAcceptanceToken<T>(
  input: {
    readonly fetchImpl: typeof fetch;
    readonly apiUrl: string;
    readonly internalHeaders: Record<string, string>;
    readonly queryIdentityHeaders: Record<string, string>;
    readonly principalId: string;
    readonly tenantId: string | undefined;
    readonly repository: string;
    readonly buildId: string;
  },
  operation: (headers: Record<string, string>) => Promise<T>
): Promise<T> {
  const tokenName = `production-acceptance-${input.buildId}`;
  let operationResult: T | undefined;
  let operationFailure: unknown;
  let contextHeaders: Record<string, string> | undefined;
  let tokenId: string | undefined;
  const mintStartedAt = Date.now();
  try {
    const minted = await apiJson(input.fetchImpl, `${input.apiUrl}/internal/context/tokens`, {
      method: "POST",
      headers: input.internalHeaders,
      body: JSON.stringify({
        principalId: input.principalId,
        name: tokenName,
        scopes: ["context:read", "context:query"],
        expiresInMinutes: 5
      })
    });
    const mintCompletedAt = Date.now();
    const secret = requiredString(minted.secret, "issued token secret");
    contextHeaders = {
      ...input.queryIdentityHeaders,
      authorization: `Bearer ${secret}`,
      "content-type": "application/json"
    };
    const publicToken = record(minted.token);
    const candidateTokenId = requiredString(publicToken.id, "issued token.id");
    assertAcceptanceTokenIdentity(publicToken, tokenName, input.principalId);
    tokenId = candidateTokenId;
    assertIssuedAcceptanceToken(minted, {
      principalId: input.principalId,
      tokenName,
      mintStartedAt,
      mintCompletedAt
    });
    await verifyIssuedTokenRestrictions(input, contextHeaders);
    operationResult = await operation(contextHeaders);
  } catch (error) {
    operationFailure = error;
  }

  const cleanupFailures: unknown[] = [];
  try {
    await cleanupAcceptanceTokens(input, {
      tokenName,
      tokenId
    });
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (contextHeaders) {
    try {
      await verifyRevokedTokenRejection(input, contextHeaders);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (operationFailure || cleanupFailures.length > 0) {
    const failures = [...(operationFailure ? [operationFailure] : []), ...cleanupFailures];
    const message = [
      ...(operationFailure ? [errorMessage(operationFailure)] : []),
      ...cleanupFailures.map((error) => `issued-token cleanup verification failed: ${errorMessage(error)}`)
    ].join("; ");
    throw new AggregateError(failures, message);
  }
  return operationResult as T;
}

function assertAcceptanceTokenIdentity(token: Record<string, unknown>, tokenName: string, principalId: string): void {
  if (
    requiredString(token.name, "issued token name") !== tokenName ||
    requiredString(token.principalId, "issued token principalId") !== principalId
  ) {
    throw new Error("production acceptance token identity does not match its build and principal");
  }
}

function assertIssuedAcceptanceToken(
  minted: Record<string, unknown>,
  expected: {
    readonly principalId: string;
    readonly tokenName: string;
    readonly mintStartedAt: number;
    readonly mintCompletedAt: number;
  }
): void {
  const secret = requiredString(minted.secret, "issued token secret");
  if (!/^jina_atk_[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("production acceptance did not receive a valid per-principal token");
  }
  const token = record(minted.token);
  assertAcceptanceTokenIdentity(token, expected.tokenName, expected.principalId);
  const scopes = requiredArray(token.scopes, "issued token scopes")
    .map((scope) => requiredString(scope, "issued token scope"))
    .sort();
  if (scopes.join(",") !== "context:query,context:read") {
    throw new Error("production acceptance token does not have the exact read/query scopes");
  }
  const createdAt = Date.parse(requiredString(token.createdAt, "issued token createdAt"));
  const expiresAt = Date.parse(requiredString(token.expiresAt, "issued token expiresAt"));
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt - createdAt !== 5 * 60_000) {
    throw new Error("production acceptance token does not have an exact five-minute TTL");
  }
  const clockSkewMs = 30_000;
  if (
    createdAt < expected.mintStartedAt - clockSkewMs ||
    createdAt > expected.mintCompletedAt + clockSkewMs ||
    expiresAt <= expected.mintCompletedAt - clockSkewMs
  ) {
    throw new Error("production acceptance token is not currently valid within allowed clock skew");
  }
  if ("administrator" in token || "secret" in token || "secretHash" in token) {
    throw new Error("production acceptance token metadata exceeded its public non-admin contract");
  }
}

async function cleanupAcceptanceTokens(
  input: {
    readonly fetchImpl: typeof fetch;
    readonly apiUrl: string;
    readonly internalHeaders: Record<string, string>;
    readonly principalId: string;
  },
  token: {
    readonly tokenName: string;
    readonly tokenId: string | undefined;
  }
): Promise<void> {
  let directRevocationFailure: unknown;
  if (token.tokenId) {
    try {
      await revokeAcceptanceToken(input, token.tokenId);
    } catch (error) {
      directRevocationFailure = error;
    }
  }

  let discoveryFailure: unknown;
  try {
    const matches = await matchingAcceptanceTokens(input, token.tokenName);
    const failures: unknown[] = [];
    for (const match of matches) {
      try {
        await revokeAcceptanceToken(input, requiredString(match.id, "listed acceptance token.id"));
      } catch (error) {
        failures.push(error);
      }
    }
    if (matches.length > 0) {
      try {
        const remaining = await matchingAcceptanceTokens(input, token.tokenName);
        if (remaining.length > 0) {
          throw new Error("production acceptance cleanup left an active matching token");
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, failures.map((failure) => errorMessage(failure)).join("; "));
    }
  } catch (error) {
    discoveryFailure = error;
  }

  if (directRevocationFailure || discoveryFailure) {
    const failures = [
      ...(directRevocationFailure ? [directRevocationFailure] : []),
      ...(discoveryFailure ? [discoveryFailure] : [])
    ];
    throw new AggregateError(failures, failures.map((failure) => errorMessage(failure)).join("; "));
  }
}

async function matchingAcceptanceTokens(
  input: {
    readonly fetchImpl: typeof fetch;
    readonly apiUrl: string;
    readonly internalHeaders: Record<string, string>;
    readonly principalId: string;
  },
  tokenName: string
): Promise<Record<string, unknown>[]> {
  const listed = await apiJson(input.fetchImpl, `${input.apiUrl}/internal/context/tokens`, {
    headers: input.internalHeaders
  });
  return requiredArray(listed.tokens, "active API tokens")
    .map(record)
    .filter((token) => token.name === tokenName && token.principalId === input.principalId);
}

async function revokeAcceptanceToken(
  input: {
    readonly fetchImpl: typeof fetch;
    readonly apiUrl: string;
    readonly internalHeaders: Record<string, string>;
  },
  tokenId: string
): Promise<void> {
  const revoked = await apiJson(
    input.fetchImpl,
    `${input.apiUrl}/internal/context/tokens/${encodeURIComponent(tokenId)}/revoke`,
    {
      method: "POST",
      headers: input.internalHeaders
    }
  );
  const revokedToken = record(revoked.token);
  if (revokedToken.id !== tokenId || typeof revokedToken.revokedAt !== "string") {
    throw new Error("production acceptance token revocation returned an invalid token");
  }
  if ("secret" in revokedToken || "secretHash" in revokedToken) {
    throw new Error("production acceptance token revocation exposed credential material");
  }
}

async function verifyIssuedTokenRestrictions(
  input: {
    readonly fetchImpl: typeof fetch;
    readonly apiUrl: string;
    readonly tenantId: string | undefined;
    readonly principalId: string;
    readonly repository: string;
  },
  headers: Record<string, string>
): Promise<void> {
  await expectJsonError(
    input.fetchImpl,
    `${input.apiUrl}/context/build`,
    { method: "POST", headers, body: "{}" },
    403,
    "issued token build denial",
    { code: "insufficient_scope" }
  );
  await expectJsonError(
    input.fetchImpl,
    `${input.apiUrl}/context/metrics`,
    { headers },
    403,
    "issued token admin denial",
    { code: "insufficient_scope" }
  );
  await expectJsonError(input.fetchImpl, `${input.apiUrl}/board`, { headers }, 403, "issued token Board denial", {
    code: "insufficient_scope"
  });
  await expectJsonError(
    input.fetchImpl,
    `${input.apiUrl}/context/releases?repository=${encodeURIComponent(input.repository)}`,
    {
      headers: {
        ...headers,
        "x-jina-tenant-id": otherTenantId(input.tenantId)
      }
    },
    401,
    "issued token cross-tenant denial",
    { error: "unauthorized" }
  );
  await expectJsonError(
    input.fetchImpl,
    `${input.apiUrl}/context/releases?repository=${encodeURIComponent(input.repository)}`,
    {
      headers: {
        ...headers,
        "x-jina-principal-id": otherPrincipalId(input.principalId)
      }
    },
    401,
    "issued token principal-spoofing denial",
    { error: "unauthorized" }
  );
  await expectJsonError(
    input.fetchImpl,
    `${input.apiUrl}/internal/context/tokens`,
    { method: "POST", headers, body: "{}" },
    401,
    "issued token administration denial",
    { error: "internal credential required" }
  );
}

async function verifyRevokedTokenRejection(
  input: {
    readonly fetchImpl: typeof fetch;
    readonly apiUrl: string;
    readonly repository: string;
  },
  headers: Record<string, string>
): Promise<void> {
  await expectJsonError(
    input.fetchImpl,
    `${input.apiUrl}/context/releases?repository=${encodeURIComponent(input.repository)}`,
    { headers },
    401,
    "revoked token HTTP denial",
    { error: "unauthorized" }
  );
  await expectJsonError(
    input.fetchImpl,
    `${input.apiUrl}/mcp`,
    {
      method: "POST",
      headers: {
        ...headers,
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "production-acceptance-revoked",
        method: "tools/list",
        params: {}
      })
    },
    401,
    "revoked token MCP denial",
    { error: "unauthorized" }
  );
}

async function expectJsonError(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  expectedStatus: number,
  label: string,
  expected: { readonly code?: string; readonly error?: string }
): Promise<void> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}, expected ${expectedStatus}: ${redactedDetail(value)}`);
  }
  const payload = record(value);
  if (expected.code && payload.code !== expected.code) {
    throw new Error(`${label} returned the wrong error code`);
  }
  if (expected.error && payload.error !== expected.error) {
    throw new Error(`${label} returned the wrong error`);
  }
}

export async function verifyProductionContextIsolation(
  fetchImpl: typeof fetch,
  input: {
    readonly apiUrl: string;
    readonly headers: Record<string, string>;
    readonly repository: string;
    readonly releaseId: string;
    readonly buildId: string;
    readonly timeoutMs: number;
  }
): Promise<void> {
  const apiUrl = input.apiUrl.replace(/\/$/, "");
  const owner = input.repository.split("/", 1)[0]!;
  const suffix =
    input.buildId
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-24) || "candidate";
  const forbiddenRepository = `${owner}/context-acceptance-forbidden-${suffix}`;
  const bogusReleaseId = `ig_acceptance_missing_${suffix.replace(/[^a-z0-9]+/g, "_")}`;
  if (forbiddenRepository === input.repository || bogusReleaseId === input.releaseId) {
    throw new Error("production context isolation probes collided with accepted identifiers");
  }

  await Promise.all([
    expectOpaqueContextNotFound(
      fetchImpl,
      `${apiUrl}/context/list?repository=${encodeURIComponent(forbiddenRepository)}`,
      { headers: input.headers, signal: AbortSignal.timeout(input.timeoutMs) },
      "production forbidden-repository isolation",
      "repository context not found",
      forbiddenRepository
    ),
    expectOpaqueContextNotFound(
      fetchImpl,
      `${apiUrl}/context/list?repository=${encodeURIComponent(input.repository)}&releaseId=${encodeURIComponent(
        bogusReleaseId
      )}`,
      { headers: input.headers, signal: AbortSignal.timeout(input.timeoutMs) },
      "production release-oracle isolation",
      "context not found",
      bogusReleaseId
    )
  ]);
}

export async function verifyProductionRetrievalQuality(
  fetchImpl: typeof fetch,
  input: {
    readonly apiUrl: string;
    readonly headers: Record<string, string>;
    readonly repository: string;
    readonly ref: string;
    readonly releaseId: string;
    readonly commitSha: string;
    readonly documents: readonly Record<string, unknown>[];
  }
): Promise<Record<string, unknown>[]> {
  const sample = [...input.documents]
    .sort(
      (left, right) =>
        requiredString(left.logicalId, "retrieval target logicalId").localeCompare(
          requiredString(right.logicalId, "retrieval target logicalId")
        ) ||
        requiredString(left.id, "retrieval target document.id").localeCompare(
          requiredString(right.id, "retrieval target document.id")
        )
    )
    .slice(0, PRODUCTION_RETRIEVAL_SAMPLE_LIMIT);
  if (sample.length === 0) throw new Error("production retrieval quality has no Board-owned targets");

  const attempts = await Promise.all(
    sample.map(async (document) => {
      const documentId = requiredString(document.id, "retrieval target document.id");
      const title = requiredString(document.title, "retrieval target document.title");
      const search = await apiJson(fetchImpl, `${input.apiUrl.replace(/\/$/, "")}/context/search`, {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify({
          repository: input.repository,
          releaseId: input.releaseId,
          query: title,
          limit: 8
        })
      });
      assertRelease(
        search.release,
        {
          repository: input.repository,
          ref: input.ref,
          releaseId: input.releaseId,
          commitSha: input.commitSha
        },
        "HTTP search"
      );
      if ("answer" in search) throw new Error("production search unexpectedly generated an answer");
      const retrieval = record(search.retrieval);
      if (retrieval.method !== "lexical_tree" || retrieval.selector !== "pageindex-lexical-tree-v1") {
        throw new Error("production search did not use deterministic model-free PageIndex tree retrieval");
      }
      if ("degradedReason" in retrieval) {
        throw new Error("production deterministic retrieval unexpectedly reported degraded model selection");
      }
      const results = requiredArray(search.results, "search.results").filter(isRecord);
      const owningResults = results.filter((result) => result.documentId === documentId);
      const hit = owningResults.length > 0;
      const citations = results.flatMap((result) =>
        requiredArray(result.citations, "search result citations").filter(isRecord)
      );
      if (hit) {
        const owningCitations = owningResults.flatMap((result) =>
          requiredArray(result.citations, "owning search result citations").filter(isRecord)
        );
        assertContextCitations(owningCitations, input.repository, input.commitSha);
      }
      return { hit, citations };
    })
  );
  const hits = attempts.filter((attempt) => attempt.hit).length;
  if (hits / sample.length < PRODUCTION_RETRIEVAL_MIN_HIT_RATE) {
    throw new Error(
      `production retrieval quality missed Board-owned documents: ${hits}/${sample.length} ` +
        `(minimum hit rate ${PRODUCTION_RETRIEVAL_MIN_HIT_RATE})`
    );
  }
  return attempts.flatMap((attempt) => attempt.citations);
}

async function expectOpaqueContextNotFound(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
  expectedError: string,
  privateIdentifier: string
): Promise<void> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const payload = record(value);
  const keys = Object.keys(payload).sort();
  if (
    response.status !== 404 ||
    keys.join(",") !== "accepted,code,error" ||
    payload.accepted !== false ||
    payload.code !== "not_found" ||
    payload.error !== expectedError
  ) {
    throw new Error(`${label} did not return the bounded not-found contract`);
  }
  if (text.toLowerCase().includes(privateIdentifier.toLowerCase())) {
    throw new Error(`${label} leaked the requested identifier`);
  }
}

function nonAdminAcceptancePrincipal(principalId: string, adminPrincipalId: string): string {
  const normalized = principalId.trim().toLowerCase();
  if (!/^user:[^\s@]+@[^\s@]+$/.test(normalized)) {
    throw new Error("ACCEPTANCE_PRINCIPAL_ID must be a non-admin user principal");
  }
  if (normalized === adminPrincipalId.trim().toLowerCase()) {
    throw new Error("ACCEPTANCE_PRINCIPAL_ID must differ from ACCEPTANCE_ADMIN_PRINCIPAL_ID");
  }
  return normalized;
}

function otherTenantId(tenantId: string | undefined): string {
  const first = "00000000-0000-4000-8000-000000000000";
  return tenantId?.toLowerCase() === first ? "11111111-1111-4111-8111-111111111111" : first;
}

function otherPrincipalId(principalId: string): string {
  const first = "user:acceptance-spoof@jina.invalid";
  return principalId === first ? "user:acceptance-spoof-2@jina.invalid" : first;
}

export function assertWorkerReleaseReceipts(
  tasks: readonly Record<string, unknown>[],
  completions: readonly Record<string, unknown>[],
  expectedReleaseId: string,
  expectedContextWorkerRevision: string
): void {
  for (const task of tasks.filter(
    (candidate) =>
      candidate.status === "done" && typeof candidate.type === "string" && CONTEXT_WORKER_TASK_TYPES.has(candidate.type)
  )) {
    const taskId = requiredString(task.id, "completed task id");
    const taskType = requiredString(task.type, "completed task type");
    const taskAttempt = requiredPositiveInteger(task.attempt, "completed task attempt");
    const receipt = completions.find(
      (completion) =>
        completion.taskId === taskId &&
        completion.taskType === taskType &&
        completion.attempt === taskAttempt &&
        completion.outcome === "done"
    );
    if (!receipt) throw new Error(`completed task ${taskId} has no worker release receipt`);
    if (
      receipt.workerReleaseId !== expectedReleaseId ||
      receipt.workerService !== "jina-context-worker" ||
      receipt.workerRevision !== expectedContextWorkerRevision
    ) {
      throw new Error(`completed task ${taskId} was not produced by the exact candidate worker revision`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function blockedContextTaskIds(tasks: readonly unknown[], repository: string, ref: string): string[] {
  return tasks
    .filter(isRecord)
    .filter(
      (task) =>
        recordOrEmpty(task.metadata).repository === repository &&
        recordOrEmpty(task.metadata).ref === ref &&
        !TERMINAL_TASK_STATUSES.has(String(task.status))
    )
    .map((task) => String(task.id));
}

export function productionAcceptanceExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/worker health|worker topics|worker payload/.test(message)) return 19;
  if (/task .* failed|build .* (failed|ended|completed without)|timed out|blocked stages/.test(message)) return 20;
  if (/published release|certified release|release.*commit|commitSha/.test(message)) return 21;
  if (/context document catalog|derived context/.test(message)) return 22;
  if (/citation|retrieval|search|returned no context|unexpectedly generated an answer|MCP/.test(message)) return 23;
  if (message.includes("backlog")) return 24;
  return 25;
}

async function verifyWorkerHealth(
  fetchImpl: typeof fetch,
  check: ProductionWorkerHealthCheck,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: string | undefined;
  do {
    try {
      const response = await fetchImpl(`${check.url.replace(/\/$/, "")}/health`, {
        headers: { authorization: check.authorization }
      });
      const value = record(JSON.parse(await response.text()));
      const unexpectedKeys = Object.keys(value).filter((key) => !WORKER_HEALTH_KEYS.has(key));
      if (unexpectedKeys.length > 0) {
        throw new Error(`worker payload exposed unexpected fields: ${unexpectedKeys.sort().join(", ")}`);
      }
      if (!response.ok || value.ok !== true) {
        throw new Error(`worker health returned ${response.status} with ok=${String(value.ok)}`);
      }
      if (check.expectedReleaseId) {
        if (
          value.claimMode !== "enabled" ||
          value.workerReleaseId !== check.expectedReleaseId ||
          value.workerRevision !== check.expectedRevision
        ) {
          throw new Error("worker health did not attest the exact candidate release revision");
        }
      }
      const topics = requiredArray(value.topics, "worker topics").map((topic) => requiredString(topic, "worker topic"));
      if (
        topics.length !== check.expectedTopics.length ||
        topics.some((topic, index) => topic !== check.expectedTopics[index])
      ) {
        throw new Error(
          `worker topics were ${JSON.stringify(topics)}, expected ${JSON.stringify(check.expectedTopics)}`
        );
      }
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(2_000);
  } while (Date.now() < deadline);
  throw new Error(`worker health verification failed: ${lastFailure ?? "no response"}`);
}

export type ProductionRemediationMode = "page_remediation" | "gate_remediation" | "checkpoint_retry";

export async function requestProductionRemediation(input: {
  readonly fetchImpl: typeof fetch;
  readonly apiUrl: string;
  readonly internalHeaders: Record<string, string>;
  readonly buildId: string;
  readonly requestScope: string;
  readonly attempt: number;
}): Promise<ProductionRemediationMode | undefined> {
  const progress = await apiJson(
    input.fetchImpl,
    `${input.apiUrl}/context/builds/${encodeURIComponent(input.buildId)}/progress`,
    { headers: input.internalHeaders }
  );
  const eligibility = recordOrEmpty(progress.retryEligibility);
  const mode = eligibility.mode;
  if (eligibility.eligible !== true) return undefined;
  const taskIds = requiredArray(eligibility.recoverableTaskIds, "retryEligibility.recoverableTaskIds").map((taskId) =>
    requiredString(taskId, "retryEligibility task id")
  );
  if (taskIds.length !== 1) {
    throw new Error("production remediation must identify exactly one recovery target");
  }
  const remediationMode: ProductionRemediationMode =
    mode === "page_remediation" || mode === "gate_remediation" ? mode : "checkpoint_retry";
  const requestMode =
    remediationMode === "page_remediation"
      ? "page-remediation"
      : remediationMode === "gate_remediation"
        ? "gate-remediation"
        : "checkpoint-retry";
  await apiJson(input.fetchImpl, `${input.apiUrl}/context/builds/${encodeURIComponent(input.buildId)}/retry`, {
    method: "POST",
    headers: input.internalHeaders,
    body: JSON.stringify({
      taskIds,
      requestKey:
        `production-acceptance:${input.requestScope}:${input.buildId}:` +
        `${requestMode}:${input.attempt}:${taskIds[0]}`,
      reason:
        remediationMode === "page_remediation"
          ? "Production acceptance resumed one bounded citation-quality page from its retained checkpoint; preserve supported bindings and repair only current findings."
          : remediationMode === "gate_remediation"
            ? "Production acceptance resumed one bounded global quality-gate pass from its retained draft and gate checkpoints; repair only current findings."
            : "Production acceptance resumed one recoverable stage from retained upstream checkpoints; use its Board failure observations and preserve completed work."
    })
  });
  return remediationMode;
}

export async function verifyProductionMcp(input: {
  apiUrl: string;
  headers: Record<string, string>;
  repository: string;
  ref: string;
  commitSha: string;
  releaseId: string;
  documentId: string;
  fromReleaseId: string;
  fromCommitSha: string;
}): Promise<number> {
  const client = new Client({ name: "jina-production-acceptance", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${input.apiUrl}/mcp`), {
    requestInit: { headers: input.headers }
  });
  try {
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    const expectedTools = ["search_context", "list_context", "read_context", "diff_context"];
    if (tools.tools.map((tool) => tool.name).join(",") !== expectedTools.join(",")) {
      throw new Error(`production MCP exposed unexpected tools: ${tools.tools.map((tool) => tool.name).join(",")}`);
    }
    for (const tool of tools.tools) {
      if (tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint !== false) {
        throw new Error(`production MCP tool ${tool.name} is not declared read-only`);
      }
    }
    const calls = await Promise.all([
      client.callTool({
        name: "search_context",
        arguments: {
          repository: input.repository,
          releaseId: input.releaseId,
          query: "Where is the primary implementation and what evidence supports it?"
        }
      }),
      client.callTool({
        name: "list_context",
        arguments: { repository: input.repository, releaseId: input.releaseId }
      }),
      client.callTool({
        name: "read_context",
        arguments: {
          repository: input.repository,
          releaseId: input.releaseId,
          document: input.documentId
        }
      }),
      client.callTool({
        name: "diff_context",
        arguments: {
          repository: input.repository,
          fromReleaseId: input.fromReleaseId,
          toReleaseId: input.releaseId
        }
      })
    ]);
    for (const [index, call] of calls.entries()) {
      if (call.isError) throw new Error(`production MCP ${expectedTools[index]} returned an error`);
      if (!call.structuredContent) {
        throw new Error(`production MCP ${expectedTools[index]} omitted structured content`);
      }
    }

    const search = record(calls[0].structuredContent);
    if ("answer" in search) throw new Error("production MCP unexpectedly generated an answer");
    const retrieval = record(search.retrieval);
    if (retrieval.method !== "lexical_tree" || retrieval.selector !== "pageindex-lexical-tree-v1") {
      throw new Error("production MCP search_context was not deterministic and model-free");
    }
    assertRelease(
      search.release,
      {
        repository: input.repository,
        ref: input.ref,
        releaseId: input.releaseId,
        commitSha: input.commitSha
      },
      "MCP search"
    );
    const searchResults = requiredArray(search.results, "MCP search results").filter(isRecord);
    if (searchResults.length === 0) throw new Error("production MCP search_context returned no context");
    const searchCitations = searchResults
      .filter(isRecord)
      .flatMap((entry) => requiredArray(entry.citations, "MCP result citations").filter(isRecord));
    assertContextCitations(searchCitations, input.repository, input.commitSha);

    const list = record(calls[1].structuredContent);
    assertRelease(
      list.release,
      {
        repository: input.repository,
        ref: input.ref,
        releaseId: input.releaseId,
        commitSha: input.commitSha
      },
      "MCP list"
    );
    const documents = requiredArray(list.documents, "MCP list documents").filter(isRecord);
    if (documents.length === 0) throw new Error("production MCP list_context returned no documents");
    assertCatalogTree(list.tree, documents);
    const listCitations = documents.flatMap((document) =>
      requiredArray(document.citations, "MCP list document citations").filter(isRecord)
    );
    assertContextCitations(listCitations, input.repository, input.commitSha);

    const read = record(calls[2].structuredContent);
    assertRelease(
      read.release,
      {
        repository: input.repository,
        ref: input.ref,
        releaseId: input.releaseId,
        commitSha: input.commitSha
      },
      "MCP read"
    );
    const readDocument = record(read.document);
    if (readDocument.id !== input.documentId)
      throw new Error("production MCP read_context returned the wrong document");
    requiredString(readDocument.bodyMarkdown, "MCP document.bodyMarkdown");
    const readCitations = requiredArray(readDocument.citations, "MCP read document citations").filter(isRecord);
    assertContextCitations(readCitations, input.repository, input.commitSha);

    const diff = record(calls[3].structuredContent);
    const diffCitationCount = assertContextDiff(diff, {
      repository: input.repository,
      ref: input.ref,
      fromReleaseId: input.fromReleaseId,
      fromCommitSha: input.fromCommitSha,
      toReleaseId: input.releaseId,
      toCommitSha: input.commitSha
    });
    return searchCitations.length + listCitations.length + readCitations.length + diffCitationCount;
  } finally {
    await client.close();
  }
}

export async function verifyProductionWebSurfaces(
  fetchImpl: typeof fetch,
  checks: ProductionWebSurfaceChecks,
  expected: { repository: string; releaseId: string; timeoutMs: number }
): Promise<number> {
  const dashboardUrl = checks.dashboardUrl.replace(/\/$/, "");
  const adminUrl = checks.adminUrl.replace(/\/$/, "");
  const dashboard = await fetchImpl(
    `${dashboardUrl}/api/context/releases?repository=${encodeURIComponent(expected.repository)}`,
    {
      headers: {
        accept: "application/json",
        authorization: checks.dashboardInvocationAuthorization,
        "x-jina-web-authorization": checks.dashboardAuthorization
      },
      signal: AbortSignal.timeout(expected.timeoutMs)
    }
  );
  const dashboardText = await dashboard.text();
  let dashboardPayload: unknown;
  try {
    dashboardPayload = JSON.parse(dashboardText);
  } catch {
    throw new Error(
      `production dashboard API proxy returned ${dashboard.status} ${
        dashboard.headers.get("content-type") ?? "without content-type"
      } instead of JSON`
    );
  }
  if (!dashboard.ok) {
    throw new Error(`production dashboard API proxy failed with ${dashboard.status}`);
  }
  const releases = requiredArray(record(dashboardPayload).releases, "dashboard releases").filter(isRecord);
  if (!releases.some((release) => release.id === expected.releaseId && release.repository === expected.repository)) {
    throw new Error("production dashboard API proxy did not expose the certified release");
  }

  const dashboardPage = await fetchImpl(
    `${dashboardUrl}/context?repository=${encodeURIComponent(expected.repository)}`,
    {
      headers: {
        accept: "text/html",
        authorization: checks.dashboardInvocationAuthorization,
        "x-jina-web-authorization": checks.dashboardAuthorization
      },
      signal: AbortSignal.timeout(expected.timeoutMs)
    }
  );
  const dashboardPageText = await dashboardPage.text();
  if (!dashboardPage.ok || !dashboardPage.headers.get("content-type")?.toLowerCase().includes("text/html")) {
    throw new Error(`production dashboard Context page failed with ${dashboardPage.status}`);
  }
  if (!dashboardPageText.includes('id="context-page"') || !dashboardPageText.includes("Evidence-backed workspace")) {
    throw new Error("production dashboard Context page did not render the application marker");
  }

  const admin = await fetchImpl(`${adminUrl}/?repository=${encodeURIComponent(expected.repository)}`, {
    headers: {
      accept: "text/html",
      authorization: checks.adminAuthorization
    },
    signal: AbortSignal.timeout(expected.timeoutMs)
  });
  const adminText = await admin.text();
  if (!admin.ok || !admin.headers.get("content-type")?.toLowerCase().includes("text/html")) {
    throw new Error(`production admin surface failed with ${admin.status}`);
  }
  if (
    !adminText.includes(expected.releaseId) ||
    !adminText.includes(expected.repository) ||
    adminText.includes("Could not load repository context from the Jina API.")
  ) {
    throw new Error("production admin surface did not render the certified release");
  }
  return 3;
}

function assertRelease(
  value: unknown,
  expected: {
    repository: string;
    ref: string;
    releaseId: string;
    commitSha: string;
  },
  label: string
): void {
  const release = record(value);
  if (
    release.id !== expected.releaseId ||
    release.repository !== expected.repository ||
    release.ref !== expected.ref ||
    release.commitSha !== expected.commitSha
  ) {
    throw new Error(`${label} did not use the expected immutable release`);
  }
}

function assertCatalogTree(value: unknown, documents: readonly Record<string, unknown>[]): void {
  const roots = requiredArray(value, "context tree");
  if (roots.length === 0) throw new Error("production Context catalog has no PageIndex hierarchy");
  const documentIds = new Set(documents.map((document) => requiredString(document.id, "document.id")));
  const representedDocuments = new Set<string>();
  const nodeIds = new Set<string>();
  const visit = (candidate: unknown): void => {
    const node = record(candidate);
    const nodeId = requiredString(node.id, "context tree node.id");
    if (nodeIds.has(nodeId)) throw new Error("production Context catalog has a duplicate hierarchy node");
    nodeIds.add(nodeId);
    const documentId = requiredString(node.documentId, "context tree node.documentId");
    if (!documentIds.has(documentId)) {
      throw new Error("production Context hierarchy points outside the derived document catalog");
    }
    representedDocuments.add(documentId);
    for (const child of requiredArray(node.children, "context tree node.children")) visit(child);
  };
  for (const root of roots) visit(root);
  if (representedDocuments.size !== documentIds.size) {
    throw new Error("production Context hierarchy does not represent every derived document");
  }
}

function assertContextDiff(
  value: unknown,
  expected: {
    repository: string;
    ref: string;
    fromReleaseId: string;
    fromCommitSha: string;
    toReleaseId: string;
    toCommitSha: string;
  }
): number {
  const diff = record(value);
  assertRelease(
    diff.from,
    {
      repository: expected.repository,
      ref: expected.ref,
      releaseId: expected.fromReleaseId,
      commitSha: expected.fromCommitSha
    },
    "Context diff source"
  );
  assertRelease(
    diff.to,
    {
      repository: expected.repository,
      ref: expected.ref,
      releaseId: expected.toReleaseId,
      commitSha: expected.toCommitSha
    },
    "Context diff target"
  );
  const added = requiredArray(diff.added, "context diff.added").filter(isRecord);
  const removed = requiredArray(diff.removed, "context diff.removed").filter(isRecord);
  const changed = requiredArray(diff.changed, "context diff.changed").filter(isRecord);
  requiredArray(diff.unchanged, "context diff.unchanged").forEach((id) => requiredString(id, "unchanged document id"));

  let citationCount = 0;
  const validateDocuments = (entries: readonly Record<string, unknown>[], commitSha: string, label: string): void => {
    for (const entry of entries) {
      const citations = requiredArray(entry.citations, `${label} citations`).filter(isRecord);
      assertContextCitations(citations, expected.repository, commitSha);
      citationCount += citations.length;
    }
  };
  validateDocuments(added, expected.toCommitSha, "added document");
  validateDocuments(removed, expected.fromCommitSha, "removed document");
  for (const entry of changed) {
    validateDocuments([record(entry.before)], expected.fromCommitSha, "changed before document");
    validateDocuments([record(entry.after)], expected.toCommitSha, "changed after document");
  }
  return citationCount;
}

function assertContextCitations(
  citations: readonly Record<string, unknown>[],
  repository: string,
  commitSha: string
): void {
  if (citations.length === 0) throw new Error("production context returned no citations");
  const anchors = citations.map((citation) => record(citation.anchor));
  if (
    !anchors.every(
      (anchor) =>
        anchor.repository === repository &&
        (anchor.commitSha === commitSha || anchor.sourceType === "observation") &&
        typeof anchor.contentDigest === "string"
    )
  ) {
    throw new Error("production context citations do not match the accepted repository and commit");
  }
}

async function apiJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) {
      throw new Error(`${new URL(url).pathname} failed with ${response.status}: non-JSON response`);
    }
    throw new Error(`${new URL(url).pathname} returned invalid JSON`);
  }
  if (!response.ok) {
    throw new Error(`${new URL(url).pathname} failed with ${response.status}: ${redactedDetail(value)}`);
  }
  return record(value);
}

function isTransientApiFailure(error: unknown): boolean {
  return error instanceof Error && / failed with (?:429|5\d\d):/.test(error.message);
}

function renderStatus(
  buildId: string,
  root: Record<string, unknown>,
  descendants: readonly Record<string, unknown>[]
): string {
  const counts = new Map<string, number>();
  for (const task of descendants) {
    const status = String(task.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const values = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  return `Production context build ${buildId}: root=${String(root.status)}, descendants=${descendants.length}${
    values ? ` (${values})` : ""
  }`;
}

function contextBuildDescendants(
  tasks: readonly Record<string, unknown>[],
  buildId: string
): Record<string, unknown>[] {
  const descendants: Record<string, unknown>[] = [];
  const discovered = new Set<string>([buildId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      const id = String(task.id);
      if (discovered.has(id) || !discovered.has(String(task.parentTaskId))) continue;
      discovered.add(id);
      descendants.push(task);
      changed = true;
    }
  }
  return descendants;
}

function failureReason(task: Record<string, unknown>): string {
  if (typeof task.failureReason === "string") {
    const code = typeof task.failureCode === "string" ? `${task.failureCode}: ` : "";
    return `${code}${task.failureReason}`.slice(0, 500);
  }
  const metadata = recordOrEmpty(task.metadata);
  return typeof metadata.error === "string" ? metadata.error.slice(0, 500) : "no public reason";
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object response");
  return value;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredGitSha(value: unknown, name: string): string {
  const result = requiredString(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${name} must be a full Git SHA`);
  return result;
}

function redactedDetail(value: unknown): string {
  return JSON.stringify(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 1_000);
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const githubInstallationId = optionalPositiveInteger(process.env.ACCEPTANCE_GITHUB_INSTALLATION_ID);
  const derivationBudgetSeconds = optionalPositiveInteger(process.env.ACCEPTANCE_DERIVATION_BUDGET_SECONDS);
  const derivationTokenBudget = optionalPositiveInteger(process.env.ACCEPTANCE_DERIVATION_TOKEN_BUDGET);
  const workerHealthChecks = await configuredWorkerHealthChecks();
  const webSurfaceChecks = await configuredWebSurfaceChecks();
  const summary = await runProductionContextAcceptance({
    apiUrl: requiredEnv("JINA_API_URL"),
    internalToken: requiredEnv("INTERNAL_API_TOKEN"),
    ...(process.env.ACCEPTANCE_TENANT_ID ? { tenantId: process.env.ACCEPTANCE_TENANT_ID } : {}),
    principalId: requiredEnv("ACCEPTANCE_PRINCIPAL_ID"),
    adminPrincipalId: requiredEnv("ACCEPTANCE_ADMIN_PRINCIPAL_ID"),
    ...(process.env.ACCEPTANCE_REPOSITORY ? { repository: process.env.ACCEPTANCE_REPOSITORY } : {}),
    ...(process.env.ACCEPTANCE_REF ? { ref: process.env.ACCEPTANCE_REF } : {}),
    ...(githubInstallationId ? { githubInstallationId } : {}),
    ...(derivationBudgetSeconds ? { derivationBudgetSeconds } : {}),
    ...(derivationTokenBudget ? { derivationTokenBudget } : {}),
    ...(process.env.ACCEPTANCE_REQUEST_KEY ? { requestKey: process.env.ACCEPTANCE_REQUEST_KEY } : {}),
    ...(process.env.ACCEPTANCE_TIMEOUT_MS ? { timeoutMs: Number(process.env.ACCEPTANCE_TIMEOUT_MS) } : {}),
    workerHealthChecks,
    ...(process.env.ACCEPTANCE_WORKER_RELEASE_ID
      ? {
          expectedWorkerReleaseId: process.env.ACCEPTANCE_WORKER_RELEASE_ID,
          expectedContextWorkerRevision: requiredEnv("ACCEPTANCE_CONTEXT_WORKER_REVISION")
        }
      : {}),
    webSurfaceChecks
  });
  console.log(JSON.stringify({ event: "production.context.acceptance_succeeded", ...summary }));
}

async function configuredWorkerHealthChecks(): Promise<ProductionWorkerHealthCheck[]> {
  const contextWorkerUrl = requiredEnv("ACCEPTANCE_CONTEXT_WORKER_URL");
  const contextWorkerAudience = requiredEnv("ACCEPTANCE_CONTEXT_WORKER_AUDIENCE");
  const taskWorkerUrl = requiredEnv("ACCEPTANCE_TASK_WORKER_URL");
  const taskWorkerAudience = requiredEnv("ACCEPTANCE_TASK_WORKER_AUDIENCE");
  const releaseId = requiredEnv("ACCEPTANCE_WORKER_RELEASE_ID");
  return Promise.all([
    authenticatedWorkerHealthCheck(
      contextWorkerUrl,
      contextWorkerAudience,
      CONTEXT_BOARD_WORKER_TOPICS,
      releaseId,
      requiredEnv("ACCEPTANCE_CONTEXT_WORKER_REVISION")
    ),
    authenticatedWorkerHealthCheck(
      taskWorkerUrl,
      taskWorkerAudience,
      ["run-review"],
      releaseId,
      requiredEnv("ACCEPTANCE_TASK_WORKER_REVISION")
    )
  ]);
}

async function authenticatedWorkerHealthCheck(
  url: string,
  audience: string,
  expectedTopics: readonly string[],
  expectedReleaseId?: string,
  expectedRevision?: string
): Promise<ProductionWorkerHealthCheck> {
  const target = cloudRunCandidateIdentityTarget(url, audience);
  return {
    url: target.url,
    authorization: `Bearer ${await identityTokenForAudience(target.audience)}`,
    expectedTopics,
    ...(expectedReleaseId ? { expectedReleaseId } : {}),
    ...(expectedRevision ? { expectedRevision } : {})
  };
}

async function configuredWebSurfaceChecks(): Promise<ProductionWebSurfaceChecks> {
  const dashboardTarget = cloudRunCandidateIdentityTarget(
    requiredEnv("ACCEPTANCE_DASHBOARD_URL"),
    requiredEnv("ACCEPTANCE_DASHBOARD_AUDIENCE")
  );
  const adminUrl = requiredEnv("ACCEPTANCE_ADMIN_URL").replace(/\/$/, "");
  const username = requiredEnv("ACCEPTANCE_WEB_AUTH_USERNAME");
  const password = requiredEnv("ACCEPTANCE_WEB_AUTH_PASSWORD");
  return {
    dashboardUrl: dashboardTarget.url,
    adminUrl,
    dashboardInvocationAuthorization: `Bearer ${await identityTokenForAudience(dashboardTarget.audience)}`,
    dashboardAuthorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    adminAuthorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  };
}

export function cloudRunCandidateIdentityTarget(
  requestUrl: string,
  stableAudience: string
): { readonly url: string; readonly audience: string } {
  const normalize = (value: string, name: string): string => {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${name} must be an HTTPS Cloud Run service URL`);
    }
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      throw new Error(`${name} must not contain a path`);
    }
    return parsed.origin;
  };
  const url = normalize(requestUrl, "candidate request URL");
  const audience = normalize(stableAudience, "stable identity audience");
  if (url === audience) {
    throw new Error("candidate request URL must be release-tagged and distinct from the stable identity audience");
  }
  return { url, audience };
}

async function identityTokenForAudience(audience: string): Promise<string> {
  const metadataUrl = new URL(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
  );
  metadataUrl.searchParams.set("audience", audience);
  metadataUrl.searchParams.set("format", "full");
  const response = await fetch(metadataUrl, { headers: { "Metadata-Flavor": "Google" } });
  const token = (await response.text()).trim();
  if (!response.ok || token.split(".").length !== 3) {
    throw new Error(`Cloud Run identity token request failed with ${response.status}`);
  }
  return token;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("ACCEPTANCE_GITHUB_INSTALLATION_ID must be a positive integer");
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(
      JSON.stringify({
        event: "production.context.acceptance_failed",
        error: error instanceof Error ? error.message : String(error)
      })
    );
    process.exitCode = productionAcceptanceExitCode(error);
  });
}
