#!/usr/bin/env node

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const EXACT_MCP_TOOLS = ["search_context", "list_context", "read_context", "diff_context"];
const HELP = `Usage: context-surface-e2e.mjs [options]

Required (or use the matching environment variables):
  --api-url URL          Loopback Context API (JINA_API_URL)
  --tenant ID            Tenant ID (JINA_TENANT_ID)
  --internal-token TOKEN Internal/admin credential (JINA_INTERNAL_TOKEN)
  --query-token TOKEN    Context query credential (JINA_CONTEXT_TOKEN; static mode only)
  --repository OWNER/REPO
  --build BUILD_ID

Optional:
  --credential-mode MODE static (default) or issued
  --internal-principal ID
                         Principal asserted with the internal credential
  --issued-principal ID  Required in issued mode; must be a non-admin user principal
  --issued-access MODE   Required in issued mode: pregranted or sync-bound
  --issued-token-name NAME
  --issued-expires-minutes MINUTES
                         Default: 15; accepted range: 5-60
  --ref REF              Default: main
  --release RELEASE_ID
  --from-release RELEASE_ID
  --query TEXT
  --dashboard-url URL
  --admin-url URL
  --timeout-ms MILLISECONDS

Issued mode mints a one-use-output jina_atk_ token with exactly context:read and
context:query, runs every HTTP and MCP assertion with it, then revokes it and proves
HTTP and MCP reject it. access-sync cannot select an arbitrary temporary principal:
use pregranted when the principal already has repository ACL, or sync-bound to merge
the repository only when that principal is the server's configured Context binding.
`;

export async function runContextSurfaceAcceptance(options, dependencies = {}) {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const config = normalizedOptions(options);
  assertLocalUrl(config.apiUrl, "API URL");
  if (config.dashboardUrl) assertLocalUrl(config.dashboardUrl, "dashboard URL");
  if (config.adminUrl) assertLocalUrl(config.adminUrl, "admin URL");

  if (config.credentialMode === "issued") {
    return runWithIssuedCredential(config, dependencies);
  }

  let requestSequence = 0;
  const request = async (path, input = {}) => {
    requestSequence += 1;
    const credential = input.credential ?? "query";
    const token = credential === "internal" ? config.internalToken : config.queryToken;
    const tenantId = input.tenantId ?? config.tenantId;
    const principalId =
      input.principalId ??
      (credential === "internal"
        ? config.internalPrincipalId
        : tenantId === config.tenantId
          ? config.principalId
          : `tenant:${tenantId}`);
    const response = await fetchImplementation(new URL(path, config.apiUrl), {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-jina-tenant-id": tenantId,
        "x-jina-principal-id": principalId,
        "x-request-id": `context-surface-${process.pid}-${requestSequence}`,
        ...(input.body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { text };
    }
    return { status: response.status, headers: response.headers, body };
  };

  const ok = async (path, input) => {
    const result = await request(path, input);
    assert.equal(result.status, 200, `${path}: HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 1_000)}`);
    return object(result.body, path);
  };

  const repositoryQuery = query({ repository: config.repository });
  const releasesResponse = await ok(`/wiki/releases?${repositoryQuery}`);
  const releases = array(releasesResponse.releases, "releases");
  const scopedReleases = releases.filter(
    (release) => object(release, "release").repository === config.repository && release.ref === config.ref
  );
  assert.ok(scopedReleases.length > 0, `no release exists for ${config.repository}@${config.ref}`);

  const buildsResponse = await ok("/wiki/builds", { credential: "internal" });
  const builds = array(buildsResponse.builds, "builds");
  const build = object(
    builds.find((candidate) => object(candidate, "build").id === config.buildId),
    `build ${config.buildId}`
  );
  assert.equal(build.repository, config.repository);
  assert.equal(build.ref, config.ref);
  assert.equal(build.status, "completed", `build ${config.buildId} is not completed`);

  const progress = await ok(`/wiki/builds/${encodeURIComponent(config.buildId)}/progress`, {
    credential: "internal"
  });
  assert.equal(progress.status, "completed");
  assert.equal(progress.repository, config.repository);
  assert.equal(progress.ref, config.ref);
  const stages = array(progress.stages, "progress.stages").map((stage) => object(stage, "stage"));
  assert.ok(stages.length > 0, "completed build has no materialized Board stages");
  assert.equal(
    stages.some((stage) => stage.status === "failed"),
    false,
    "completed build contains a failed task"
  );
  for (const type of ["publish-context-release", "index-context-release"]) {
    const stage = stages.find((candidate) => candidate.type === type);
    assert.ok(stage, `progress omitted ${type}`);
    assert.equal(stage.status, "done", `${type} did not finish`);
  }
  const checkpointPages = array(progress.pages, "progress.pages");
  assert.ok(checkpointPages.length > 0, "completed build has no retained page checkpoints");

  const targetRelease =
    scopedReleases.find((release) => release.id === config.releaseId) ??
    scopedReleases.find(
      (release) => typeof build.commitSha === "string" && object(release, "release").commitSha === build.commitSha
    ) ??
    scopedReleases[0];
  const release = object(targetRelease, "target release");
  assert.equal(release.contextStatus, "available");
  assert.equal(release.repository, config.repository);
  assert.equal(release.ref, config.ref);
  if (typeof build.commitSha === "string") assert.equal(release.commitSha, build.commitSha);

  const metricsBefore = await ok("/wiki/metrics", { credential: "internal" });
  assertMetrics(metricsBefore);
  assert.equal(object(object(metricsBefore.quotas, "metrics.quotas").active, "quotas.active").modelTasks, 0);

  // These three operations are deterministic projection reads. The model quota
  // ledger must remain byte-for-byte stable across them.
  const list = await ok(`/wiki/list?${query({ repository: config.repository, releaseId: release.id })}`);
  assert.equal(object(list.release, "list.release").id, release.id);
  const documents = array(list.documents, "list.documents").map((document) => object(document, "document"));
  assert.ok(documents.length > 0, "release contains no derived context documents");
  const tree = array(list.tree, "list.tree");
  assert.ok(tree.length > 0, "published release has no attached PageIndex hierarchy");

  const firstDocument = documents[0];
  const read = await ok(
    `/wiki/read?${query({
      repository: config.repository,
      releaseId: release.id,
      document: firstDocument.id
    })}`
  );
  assert.equal(object(read.release, "read.release").id, release.id);
  const readDocument = object(read.document, "read.document");
  assert.equal(readDocument.id, firstDocument.id);
  assert.ok(string(readDocument.bodyMarkdown, "document.bodyMarkdown").trim().length > 0);

  const previousRelease =
    scopedReleases.find((candidate) => object(candidate, "release").id === config.fromReleaseId) ??
    scopedReleases.find((candidate) => object(candidate, "release").id !== release.id) ??
    release;
  const diff = await ok(
    `/wiki/diff?${query({
      repository: config.repository,
      fromReleaseId: previousRelease.id,
      toReleaseId: release.id
    })}`
  );
  assert.equal(object(diff.from, "diff.from").id, previousRelease.id);
  assert.equal(object(diff.to, "diff.to").id, release.id);

  const citationStats = validateCitations(documents.flatMap((document) => array(document.citations, "citations")));
  const readCitationStats = validateCitations(array(readDocument.citations, "read citations"));
  citationStats.total += readCitationStats.total;
  citationStats.urls += readCitationStats.urls;
  citationStats.ranges += readCitationStats.ranges;
  assert.ok(citationStats.total > 0, "public context has no citations");
  assert.ok(citationStats.urls > 0, "public context has no provider citation URLs");
  assert.ok(citationStats.ranges > 0, "public context has no exact source line ranges");

  const metricsAfterProjectionReads = await ok("/wiki/metrics", { credential: "internal" });
  assertMetrics(metricsAfterProjectionReads);
  assert.deepEqual(
    modelQuota(metricsAfterProjectionReads),
    modelQuota(metricsBefore),
    "list/read/diff changed model request or token accounting"
  );
  assert.ok(
    number(metricsAfterProjectionReads.hierarchyNodeCount, "metrics.hierarchyNodeCount") > 0,
    "metrics report no PageIndex hierarchy nodes"
  );
  const hierarchyProjector = array(metricsAfterProjectionReads.projectors ?? [], "metrics.projectors").find(
    (projector) => object(projector, "projector").name === "hierarchy"
  );
  if (hierarchyProjector) {
    assert.equal(object(hierarchyProjector, "hierarchy projector").status, "ready");
  }

  const searchQuery = config.searchQuery ?? `${firstDocument.title ?? firstDocument.logicalId} architecture`;
  const search = await ok("/wiki/search", {
    method: "POST",
    body: {
      repository: config.repository,
      releaseId: release.id,
      query: searchQuery,
      limit: 5
    }
  });
  assert.equal("answer" in search, false, "search synthesized an answer");
  assert.equal(object(search.release, "search.release").id, release.id);
  assert.equal(search.query, searchQuery);
  const searchResults = array(search.results, "search.results").map((result) => object(result, "search result"));
  assert.ok(searchResults.length > 0, "search returned no context results");
  for (const result of searchResults) {
    assert.ok(array(result.excerpts, "result.excerpts").length > 0, "search result omitted excerpts");
    validateCitations(array(result.citations, "result.citations"));
  }

  const mcp = await verifyMcp({
    apiUrl: config.apiUrl,
    headers: queryHeaders(config),
    repository: config.repository,
    ref: config.ref,
    releaseId: release.id,
    fromReleaseId: previousRelease.id,
    documentId: firstDocument.id,
    searchQuery,
    timeoutMs: config.timeoutMs
  });

  const queryMetrics = await request("/wiki/metrics");
  assert.ok([401, 403].includes(queryMetrics.status), `query token reached admin metrics: ${queryMetrics.status}`);
  const queryBoard = await request("/board");
  assert.ok([401, 403].includes(queryBoard.status), `query token reached Board internals: ${queryBoard.status}`);
  const noToken = await fetchImplementation(new URL(`/wiki/releases?${repositoryQuery}`, config.apiUrl), {
    headers: {
      "x-jina-tenant-id": config.tenantId,
      "x-jina-principal-id": config.principalId
    },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  assert.equal(noToken.status, 401, "release catalog accepted a request without a credential");

  const wrongTenant = wrongTenantId(config.tenantId);
  const isolated = await request(`/wiki/releases?${repositoryQuery}`, {
    credential: "query",
    tenantId: wrongTenant
  });
  assert.equal(isolated.status, 401, "wrong-tenant assertion did not match an invalid credential");

  const ui = await verifyUiSurfaces(config, {
    fetchImplementation,
    releaseId: release.id,
    timeoutMs: config.timeoutMs
  });
  const report = {
    schemaVersion: "context-surface-e2e-v1",
    apiUrl: config.apiUrl,
    tenantId: config.tenantId,
    repository: config.repository,
    ref: config.ref,
    buildId: config.buildId,
    releaseId: release.id,
    fromReleaseId: previousRelease.id,
    commitSha: release.commitSha,
    board: {
      stages: stages.length,
      checkpoints: checkpointPages.length,
      publication: "done",
      pageIndex: "done"
    },
    catalog: {
      documents: documents.length,
      treeRoots: tree.length,
      hierarchyNodes: metricsAfterProjectionReads.hierarchyNodeCount,
      citations: citationStats
    },
    retrieval: {
      method: object(search.retrieval, "search.retrieval").method,
      selector: object(search.retrieval, "search.retrieval").selector,
      results: searchResults.length,
      answerGenerated: false
    },
    mcp,
    quotas: object(metricsAfterProjectionReads.quotas, "metrics.quotas"),
    negativeAuthorization: {
      queryMetrics: queryMetrics.status,
      queryBoard: queryBoard.status,
      noToken: noToken.status,
      wrongTenant,
      wrongTenantStatus: isolated.status
    },
    ui
  };
  return report;
}

async function runWithIssuedCredential(config, dependencies) {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const issuedPrincipalId = config.issuedPrincipalId;
  assert.ok(issuedPrincipalId, "issuedPrincipalId is required in issued mode");
  assert.match(issuedPrincipalId, /^user:[^\s@]+@[^\s@]+$/i, "issuedPrincipalId must be a user principal");

  if (config.issuedAccessMode === "sync-bound") {
    const synchronized = await jsonRequest(fetchImplementation, config, "/internal/context/access/sync", {
      method: "POST",
      token: config.internalToken,
      principalId: issuedPrincipalId,
      body: { repositories: [config.repository], mode: "merge" }
    });
    assert.equal(
      synchronized.status,
      200,
      `bound-principal ACL merge failed: HTTP ${synchronized.status}: ${JSON.stringify(synchronized.body).slice(0, 1_000)}. ` +
        "The access-sync contract can grant only the server's configured Context principal; use pregranted after provisioning this user through the tenant ACL owner."
    );
    assert.equal(object(synchronized.body, "access-sync response").principalId, issuedPrincipalId.toLowerCase());
    assert.equal(synchronized.body.mode, "merge");
  }

  const minted = await jsonRequest(fetchImplementation, config, "/internal/context/tokens", {
    method: "POST",
    token: config.internalToken,
    principalId: config.internalPrincipalId,
    body: {
      principalId: issuedPrincipalId,
      name: config.issuedTokenName,
      scopes: ["context:read", "context:query"],
      expiresInMinutes: config.issuedExpiresMinutes
    }
  });
  assert.equal(minted.status, 201, `token mint failed: HTTP ${minted.status}: ${safeDiagnostic(minted.body)}`);
  const mintBody = object(minted.body, "mint response");
  const secret = string(mintBody.secret, "mint response.secret");
  const token = object(mintBody.token, "mint response.token");
  const tokenId = string(token.id, "mint response.token.id");

  let report;
  let acceptanceFailure;
  let revocation;
  let revocationFailure;
  try {
    assert.equal(minted.headers.get("cache-control"), "no-store", "mint response may be cached");
    if (!/^jina_atk_[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw new Error("mint response.secret did not have the issued-token format");
    }
    assert.equal(token.principalId, issuedPrincipalId.toLowerCase());
    assert.deepEqual([...array(token.scopes, "mint response.token.scopes")].sort(), ["context:query", "context:read"]);
    assert.equal("secret" in token, false, "public token record exposed the secret");
    assert.equal("secretHash" in token, false, "public token record exposed the secret hash");
    const createdAt = Date.parse(string(token.createdAt, "mint response.token.createdAt"));
    const expiresAt = Date.parse(string(token.expiresAt, "mint response.token.expiresAt"));
    assert.ok(Number.isFinite(createdAt) && Number.isFinite(expiresAt), "mint response has invalid timestamps");
    assert.equal(
      expiresAt - createdAt,
      config.issuedExpiresMinutes * 60_000,
      "minted credential lifetime differs from the requested short lifetime"
    );

    report = await runContextSurfaceAcceptance(
      {
        ...config,
        credentialMode: "static",
        queryToken: secret,
        principalId: issuedPrincipalId,
        internalPrincipalId: config.internalPrincipalId
      },
      dependencies
    );
    const boundaries = await verifyIssuedCredentialBoundaries(fetchImplementation, config, {
      secret,
      principalId: issuedPrincipalId
    });
    report.issuedCredential = {
      tokenId,
      principalId: issuedPrincipalId.toLowerCase(),
      scopes: ["context:read", "context:query"],
      expiresAt: string(token.expiresAt, "mint response.token.expiresAt"),
      accessMode: config.issuedAccessMode,
      boundaries
    };
  } catch (error) {
    acceptanceFailure = error;
  } finally {
    try {
      revocation = await revokeAndProveIssuedCredential(fetchImplementation, config, {
        tokenId,
        secret,
        principalId: issuedPrincipalId
      });
    } catch (error) {
      revocationFailure = error;
    }
  }

  if (acceptanceFailure && revocationFailure) {
    throw new AggregateError(
      [acceptanceFailure, revocationFailure],
      "issued credential acceptance failed and cleanup could not prove revocation"
    );
  }
  if (acceptanceFailure) throw acceptanceFailure;
  if (revocationFailure) throw revocationFailure;
  assert.ok(report, "issued credential acceptance produced no report");
  report.issuedCredential.revocation = revocation;
  return report;
}

async function verifyIssuedCredentialBoundaries(fetchImplementation, config, issued) {
  const build = await jsonRequest(fetchImplementation, config, "/wiki/build", {
    method: "POST",
    token: issued.secret,
    principalId: issued.principalId,
    body: { repository: config.repository, ref: config.ref }
  });
  assert.equal(build.status, 403, `read/query token reached build: HTTP ${build.status}`);

  const admin = await jsonRequest(fetchImplementation, config, "/wiki/metrics", {
    token: issued.secret,
    principalId: issued.principalId
  });
  assert.equal(admin.status, 403, `read/query token reached admin metrics: HTTP ${admin.status}`);

  const board = await jsonRequest(fetchImplementation, config, "/board", {
    token: issued.secret,
    principalId: issued.principalId
  });
  assert.equal(board.status, 403, `read/query token reached Board: HTTP ${board.status}`);

  const tokenAdministration = await jsonRequest(fetchImplementation, config, "/internal/context/tokens", {
    token: issued.secret,
    principalId: issued.principalId
  });
  assert.equal(
    tokenAdministration.status,
    401,
    `issued token reached credential administration: HTTP ${tokenAdministration.status}`
  );

  const wrongTenant = wrongTenantId(config.tenantId);
  const crossTenant = await jsonRequest(
    fetchImplementation,
    config,
    `/wiki/releases?${query({
      repository: config.repository
    })}`,
    {
      token: issued.secret,
      tenantId: wrongTenant,
      principalId: issued.principalId
    }
  );
  assert.equal(crossTenant.status, 401, `issued token crossed tenant boundary: HTTP ${crossTenant.status}`);

  return {
    build: build.status,
    admin: admin.status,
    board: board.status,
    tokenAdministration: tokenAdministration.status,
    crossTenant: crossTenant.status
  };
}

async function revokeAndProveIssuedCredential(fetchImplementation, config, issued) {
  const revoked = await jsonRequest(
    fetchImplementation,
    config,
    `/internal/context/tokens/${encodeURIComponent(issued.tokenId)}/revoke`,
    {
      method: "POST",
      token: config.internalToken,
      principalId: config.internalPrincipalId
    }
  );
  assert.equal(
    revoked.status,
    200,
    `token revoke failed: HTTP ${revoked.status}: ${JSON.stringify(revoked.body).slice(0, 1_000)}`
  );
  assert.equal(object(object(revoked.body, "revoke response").token, "revoked token").id, issued.tokenId);

  const http = await jsonRequest(
    fetchImplementation,
    config,
    `/wiki/releases?${query({
      repository: config.repository
    })}`,
    {
      token: issued.secret,
      principalId: issued.principalId
    }
  );
  assert.equal(http.status, 401, `revoked token still reached HTTP Context: HTTP ${http.status}`);

  const mcp = await jsonRequest(fetchImplementation, config, "/mcp", {
    method: "POST",
    token: issued.secret,
    principalId: issued.principalId,
    body: {
      jsonrpc: "2.0",
      id: "post-revoke",
      method: "tools/list",
      params: {}
    }
  });
  assert.equal(mcp.status, 401, `revoked token still reached MCP: HTTP ${mcp.status}`);
  return { status: "revoked", http: http.status, mcp: mcp.status };
}

async function jsonRequest(fetchImplementation, config, path, input) {
  const response = await fetchImplementation(new URL(path, config.apiUrl), {
    method: input.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.token}`,
      "x-jina-tenant-id": input.tenantId ?? config.tenantId,
      "x-jina-principal-id": input.principalId,
      "x-request-id": `context-surface-issued-${process.pid}-${Date.now()}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { text };
  }
  return { status: response.status, headers: response.headers, body };
}

async function verifyMcp(input) {
  const client = new Client({ name: "jina-context-surface-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", input.apiUrl), {
    requestInit: {
      headers: input.headers
    },
    fetch: (url, init = {}) =>
      fetch(url, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(input.timeoutMs)])
          : AbortSignal.timeout(input.timeoutMs)
      })
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.deepEqual(names, EXACT_MCP_TOOLS);
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not declared read-only`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} is declared destructive`);
    }
    const calls = await Promise.all([
      client.callTool({
        name: "search_context",
        arguments: {
          repository: input.repository,
          releaseId: input.releaseId,
          query: input.searchQuery,
          limit: 5
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
    assert.ok(
      calls.every((call) => call.isError !== true),
      "one or more MCP context tools failed"
    );
    for (const [index, call] of calls.entries()) {
      assert.ok(call.structuredContent, `${EXACT_MCP_TOOLS[index]} omitted structured content`);
    }
    assert.equal("answer" in object(calls[0].structuredContent, "MCP search"), false);
    assert.ok(array(calls[0].structuredContent.results, "MCP search results").length > 0);
    assert.equal(object(calls[1].structuredContent, "MCP list").release.id, input.releaseId);
    assert.ok(array(calls[1].structuredContent.documents, "MCP list documents").length > 0);
    assert.equal(object(calls[2].structuredContent, "MCP read").release.id, input.releaseId);
    assert.ok(string(calls[2].structuredContent.document.bodyMarkdown, "MCP document body").length > 0);
    assert.equal(object(object(calls[3].structuredContent, "MCP diff").from, "MCP diff from").id, input.fromReleaseId);
    assert.equal(object(object(calls[3].structuredContent, "MCP diff").to, "MCP diff to").id, input.releaseId);
    return { tools: names, calls: calls.length, answerGenerated: false };
  } finally {
    await client.close();
  }
}

async function verifyUiSurfaces(config, input) {
  const prerequisite = [];
  const result = {};
  if (!config.dashboardUrl) {
    prerequisite.push(
      "Set CONTEXT_SURFACE_DASHBOARD_URL and dashboard Basic/IAP authorization to test the browser-facing proxy."
    );
  } else {
    const headers = config.dashboardAuthorization ? { authorization: config.dashboardAuthorization } : {};
    const dashboardRequest = async (path) => {
      const response = await input.fetchImplementation(new URL(path, config.dashboardUrl), {
        headers,
        signal: AbortSignal.timeout(input.timeoutMs)
      });
      const text = await response.text();
      assert.equal(response.status, 200, `dashboard ${path}: HTTP ${response.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text);
    };
    const releases = await dashboardRequest(`/api/wiki/releases?${query({ repository: config.repository })}`);
    assert.ok(array(releases.releases, "dashboard releases").some((release) => release.id === input.releaseId));
    const list = await dashboardRequest(
      `/api/wiki/list?${query({ repository: config.repository, releaseId: input.releaseId })}`
    );
    assert.ok(array(list.documents, "dashboard documents").length > 0);
    await dashboardRequest("/api/wiki/metrics");
    const progress = await dashboardRequest(`/api/wiki/builds/${encodeURIComponent(config.buildId)}/progress`);
    assert.equal(progress.status, "completed");
    result.dashboard = "passed";
  }

  if (!config.adminUrl) {
    prerequisite.push(
      "Set CONTEXT_SURFACE_ADMIN_URL and admin Basic authorization to validate the rendered admin client."
    );
  } else {
    const response = await input.fetchImplementation(
      new URL(`/?${query({ repository: config.repository })}`, config.adminUrl),
      {
        headers: config.adminAuthorization ? { authorization: config.adminAuthorization } : {},
        signal: AbortSignal.timeout(input.timeoutMs)
      }
    );
    const html = await response.text();
    assert.equal(response.status, 200, `admin root: HTTP ${response.status}: ${html.slice(0, 500)}`);
    assert.match(html, new RegExp(escapeRegExp(config.repository)));
    assert.match(html, new RegExp(escapeRegExp(input.releaseId)));
    assert.doesNotMatch(html, /Could not load repository context from the Jina API/i);
    result.admin = "passed";
  }
  return {
    ...result,
    ...(prerequisite.length ? { status: "prerequisite", prerequisite } : { status: "passed" })
  };
}

function validateCitations(citations) {
  const stats = { total: citations.length, urls: 0, ranges: 0 };
  for (const value of citations) {
    const citation = object(value, "citation");
    assert.ok(string(citation.claim, "citation.claim").trim().length > 0);
    const anchor = object(citation.anchor, "citation.anchor");
    assert.ok(string(anchor.sourceType, "citation.anchor.sourceType").trim().length > 0);
    assert.ok(string(anchor.sourceId, "citation.anchor.sourceId").trim().length > 0);
    const pathOrUrl = string(anchor.pathOrUrl, "citation.anchor.pathOrUrl");
    assert.ok(pathOrUrl.trim().length > 0);
    if (/^https?:\/\//.test(pathOrUrl)) {
      const parsed = new URL(pathOrUrl);
      assert.ok(["http:", "https:"].includes(parsed.protocol));
      stats.urls += 1;
    }
    const hasStart = anchor.startLine !== undefined;
    const hasEnd = anchor.endLine !== undefined;
    assert.equal(hasStart, hasEnd, `citation range is incomplete for ${pathOrUrl}`);
    if (hasStart) {
      const start = number(anchor.startLine, "citation.anchor.startLine");
      const end = number(anchor.endLine, "citation.anchor.endLine");
      assert.ok(Number.isSafeInteger(start) && start >= 1);
      assert.ok(Number.isSafeInteger(end) && end >= start);
      stats.ranges += 1;
    }
  }
  return stats;
}

function assertMetrics(metrics) {
  assert.ok(number(metrics.publishedGenerationCount, "metrics.publishedGenerationCount") >= 1);
  assert.ok(number(metrics.documentCount, "metrics.documentCount") >= 1);
  const quotas = object(metrics.quotas, "metrics.quotas");
  const active = object(quotas.active, "quotas.active");
  number(active.builds, "quotas.active.builds");
  number(active.modelTasks, "quotas.active.modelTasks");
  const storage = object(quotas.storage, "quotas.storage");
  number(storage.committedBytes, "quotas.storage.committedBytes");
  number(storage.reservedBytes, "quotas.storage.reservedBytes");
  number(storage.limitBytes, "quotas.storage.limitBytes");
  modelQuota(metrics);
}

function modelQuota(metrics) {
  const monthly = object(object(metrics.quotas, "metrics.quotas").monthlyModel, "quotas.monthlyModel");
  return {
    requests: number(monthly.requests, "quotas.monthlyModel.requests"),
    totalTokens: number(monthly.totalTokens, "quotas.monthlyModel.totalTokens")
  };
}

function normalizedOptions(options) {
  const credentialMode = options.credentialMode?.trim() || "static";
  assert.ok(credentialMode === "static" || credentialMode === "issued", "credentialMode must be static or issued");
  const tenantId = requiredOption(options.tenantId, "tenantId");
  const principalId = options.principalId?.trim() || `tenant:${tenantId}`;
  const issuedAccessMode = options.issuedAccessMode?.trim();
  if (credentialMode === "issued") {
    assert.ok(
      issuedAccessMode === "pregranted" || issuedAccessMode === "sync-bound",
      "issuedAccessMode is required in issued mode and must be pregranted or sync-bound"
    );
  }
  const issuedExpiresMinutes = positiveInteger(options.issuedExpiresMinutes ?? 15, "issuedExpiresMinutes");
  assert.ok(issuedExpiresMinutes >= 5 && issuedExpiresMinutes <= 60, "issuedExpiresMinutes must be between 5 and 60");
  return {
    apiUrl: requiredOption(options.apiUrl, "apiUrl").replace(/\/$/, ""),
    tenantId,
    internalToken: requiredOption(options.internalToken, "internalToken"),
    queryToken:
      credentialMode === "static" ? requiredOption(options.queryToken, "queryToken") : options.queryToken?.trim(),
    repository: requiredOption(options.repository, "repository"),
    ref: requiredOption(options.ref, "ref"),
    buildId: requiredOption(options.buildId, "buildId"),
    credentialMode,
    principalId,
    internalPrincipalId: options.internalPrincipalId?.trim() || principalId,
    issuedPrincipalId:
      credentialMode === "issued" ? requiredOption(options.issuedPrincipalId, "issuedPrincipalId") : undefined,
    issuedAccessMode,
    issuedTokenName: options.issuedTokenName?.trim() || "Context surface acceptance",
    issuedExpiresMinutes,
    releaseId: options.releaseId?.trim(),
    fromReleaseId: options.fromReleaseId?.trim(),
    searchQuery: options.searchQuery?.trim(),
    dashboardUrl: options.dashboardUrl?.trim()?.replace(/\/$/, ""),
    dashboardAuthorization: options.dashboardAuthorization?.trim(),
    adminUrl: options.adminUrl?.trim()?.replace(/\/$/, ""),
    adminAuthorization: options.adminAuthorization?.trim(),
    timeoutMs: positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs")
  };
}

function query(values) {
  return new URLSearchParams(
    Object.entries(values).flatMap(([key, value]) =>
      value === undefined || value === "" ? [] : [[key, String(value)]]
    )
  ).toString();
}

function queryHeaders(config) {
  return {
    authorization: `Bearer ${config.queryToken}`,
    "x-jina-tenant-id": config.tenantId,
    "x-jina-principal-id": config.principalId
  };
}

function wrongTenantId(tenantId) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    const last = tenantId.at(-1).toLowerCase();
    return `${tenantId.slice(0, -1)}${last === "f" ? "e" : "f"}`;
  }
  return `wrong-${tenantId}`;
}

function assertLocalUrl(value, label) {
  const parsed = new URL(value);
  assert.equal(parsed.protocol, "http:", `${label} must use local HTTP`);
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
    `${label} must be loopback; external network access is forbidden`
  );
}

function object(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function array(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function string(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  return value;
}

function number(value, label) {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0, `${label} must be a positive integer`);
  return parsed;
}

function requiredOption(value, label) {
  assert.equal(typeof value, "string", `${label} is required`);
  assert.ok(value.trim().length > 0, `${label} is required`);
  return value.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    tenantId: values.tenant ?? environment.JINA_TENANT_ID,
    internalToken: values["internal-token"] ?? environment.JINA_INTERNAL_TOKEN ?? environment.INTERNAL_API_TOKEN,
    queryToken: values["query-token"] ?? environment.JINA_CONTEXT_TOKEN ?? environment.CONTEXT_API_TOKEN,
    credentialMode: values["credential-mode"] ?? environment.CONTEXT_SURFACE_CREDENTIAL_MODE,
    repository: values.repository ?? environment.CONTEXT_SURFACE_REPOSITORY,
    ref: values.ref ?? environment.CONTEXT_SURFACE_REF ?? "main",
    buildId: values.build ?? environment.CONTEXT_SURFACE_BUILD_ID,
    principalId: values.principal ?? environment.CONTEXT_SURFACE_PRINCIPAL_ID,
    internalPrincipalId: values["internal-principal"] ?? environment.CONTEXT_SURFACE_INTERNAL_PRINCIPAL_ID,
    issuedPrincipalId: values["issued-principal"] ?? environment.CONTEXT_SURFACE_ISSUED_PRINCIPAL_ID,
    issuedAccessMode: values["issued-access"] ?? environment.CONTEXT_SURFACE_ISSUED_ACCESS_MODE,
    issuedTokenName: values["issued-token-name"] ?? environment.CONTEXT_SURFACE_ISSUED_TOKEN_NAME,
    issuedExpiresMinutes: values["issued-expires-minutes"] ?? environment.CONTEXT_SURFACE_ISSUED_EXPIRES_MINUTES,
    releaseId: values.release ?? environment.CONTEXT_SURFACE_RELEASE_ID,
    fromReleaseId: values["from-release"] ?? environment.CONTEXT_SURFACE_FROM_RELEASE_ID,
    searchQuery: values.query ?? environment.CONTEXT_SURFACE_SEARCH_QUERY,
    dashboardUrl: values["dashboard-url"] ?? environment.CONTEXT_SURFACE_DASHBOARD_URL,
    dashboardAuthorization: values["dashboard-authorization"] ?? environment.CONTEXT_SURFACE_DASHBOARD_AUTHORIZATION,
    adminUrl: values["admin-url"] ?? environment.CONTEXT_SURFACE_ADMIN_URL,
    adminAuthorization: values["admin-authorization"] ?? environment.CONTEXT_SURFACE_ADMIN_AUTHORIZATION,
    timeoutMs: values["timeout-ms"] ?? environment.CONTEXT_SURFACE_TIMEOUT_MS
  };
}

export function redactContextCredentials(value, additionalSecrets = []) {
  let redacted = String(value).replace(/jina_atk_[A-Za-z0-9_-]+/g, "[REDACTED]");
  for (const secret of additionalSecrets) {
    if (typeof secret === "string" && secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function safeDiagnostic(value) {
  return redactContextCredentials(JSON.stringify(value).slice(0, 1_000));
}

function cliCredentialValues(argv, environment) {
  const values = [
    environment.JINA_INTERNAL_TOKEN,
    environment.INTERNAL_API_TOKEN,
    environment.JINA_CONTEXT_TOKEN,
    environment.CONTEXT_API_TOKEN
  ];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === "--internal-token" || argv[index] === "--query-token") values.push(argv[index + 1]);
  }
  return values.filter((value) => typeof value === "string" && value);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const arguments_ = process.argv.slice(2);
  const credentialValues = cliCredentialValues(arguments_, process.env);
  try {
    if (arguments_.includes("--help") || arguments_.includes("-h")) {
      process.stdout.write(HELP);
      process.exit(0);
    }
    const report = await runContextSurfaceAcceptance(cliOptions(arguments_, process.env));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.ui.status === "prerequisite") {
      process.stderr.write(`UI prerequisite:\n${report.ui.prerequisite.map((item) => `- ${item}`).join("\n")}\n`);
    }
  } catch (error) {
    const diagnostic = error instanceof Error ? error.stack : error;
    process.stderr.write(
      `Context surface acceptance failed: ${redactContextCredentials(diagnostic, credentialValues)}\n`
    );
    process.exitCode = 1;
  }
}
