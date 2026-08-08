import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MemoryContextEngineStore, type MintApiTokenInput } from "@jina/context-engine";
import type { Logger, LogFields, LogSeverity, RequestTraceContext } from "@jina/observability";
import { createApiServer } from "./server.js";

const tenantId = "tenant-tokens";
const otherTenantId = "tenant-other";
const repository = "omlabs/token-fixture";
const holder = "user:holder@example.com";
const adminPrincipal = "user:admin@example.com";
const internalToken = "internal-token-test";
const contextToken = "context-token-test";
const forbiddenRepository = "omlabs/other-private-repository";

function captureLogger(entries: Record<string, unknown>[]): Logger {
  const makeLogger = (bound: LogFields = {}): Logger => {
    const logger: Logger = {
      log(severity: LogSeverity, message: string, fields: LogFields = {}): void {
        entries.push({ ...bound, ...fields, severity, message });
      },
      debug(message: string, fields?: LogFields): void {
        logger.log("DEBUG", message, fields);
      },
      info(message: string, fields?: LogFields): void {
        logger.log("INFO", message, fields);
      },
      warn(message: string, fields?: LogFields): void {
        logger.log("WARNING", message, fields);
      },
      error(message: string, fields?: LogFields): void {
        logger.log("ERROR", message, fields);
      },
      child(fields: LogFields): Logger {
        return makeLogger({ ...bound, ...fields });
      },
      withTrace(_trace: RequestTraceContext): Logger {
        return makeLogger(bound);
      }
    };
    return logger;
  };
  return makeLogger();
}

/**
 * Every server here sets `enableDevEndpoints: false`. The dev branch returns
 * before any bearer is read, so a token test against a dev-enabled server would
 * pass while executing none of the verification path.
 */
interface ServerContext {
  baseUrl: string;
  store: MemoryContextEngineStore;
  mint: (body: Record<string, unknown>, headers?: Record<string, string>) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

function withServer(run: (context: ServerContext) => Promise<void>): Promise<void> {
  return withServerConfig({}, run);
}

async function withServerConfig(
  overrides: { tenantAdminPrincipalIds?: readonly string[]; tenantId?: string },
  run: (context: ServerContext) => Promise<void>
): Promise<void> {
  const store = new MemoryContextEngineStore();
  const server: Server = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: holder,
    contextStore: store,
    tenantAdminPrincipalIds: [adminPrincipal],
    ...overrides
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await store.replaceRepositoryAccess(tenantId, holder, [repository]);
    await run({
      baseUrl,
      store,
      request: (path, init) => fetch(`${baseUrl}${path}`, init),
      mint: (body, headers) =>
        fetch(`${baseUrl}/internal/context/tokens`, {
          method: "POST",
          headers: { authorization: `Bearer ${internalToken}`, "content-type": "application/json", ...headers },
          body: JSON.stringify(body)
        })
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function mintSecret(
  mint: (body: Record<string, unknown>) => Promise<Response>,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const response = await mint({
    principalId: holder,
    name: "test token",
    scopes: ["context:read"],
    expiresInMinutes: 60,
    ...overrides
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return (JSON.parse(body) as { secret: string }).secret;
}

const bearer = (secret: string): RequestInit => ({ headers: { authorization: `Bearer ${secret}` } });

async function mcpTool(
  baseUrl: string,
  secret: string,
  name: "search_context" | "list_context" | "read_context" | "diff_context" | "ask_context",
  args: Record<string, unknown>
) {
  const client = new Client({ name: "api-token-adversary", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } }
  });
  try {
    await client.connect(transport as unknown as Transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

function mcpRpc(baseUrl: string, secret: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "token-adversary",
      method: "tools/list",
      params: {}
    })
  });
}

test("a minted token authenticates as its own row and every failure looks identical", async () => {
  await withServer(async ({ baseUrl, store, request, mint }) => {
    const secret = await mintSecret(mint);
    assert.match(secret, /^jina_atk_[A-Za-z0-9_-]{43}$/);

    assert.notEqual((await request("/wiki/releases", bearer(secret))).status, 401);

    // Expired, revoked, unknown and malformed are one answer with one body, so
    // the response never says which tokens exist or why one stopped working.
    const unauthorized = { error: "unauthorized" };
    const listed = await store.listApiTokens(tenantId);
    await store.revokeApiToken(tenantId, listed[0]!.id, adminPrincipal, new Date().toISOString());
    const revoked = await request("/wiki/releases", bearer(secret));
    assert.equal(revoked.status, 401);
    assert.deepEqual(await revoked.json(), unauthorized);

    // Expiry is minted through the store, because mint's own bounds forbid a
    // lifetime already in the past.
    const expiredSecret = `jina_atk_${"x".repeat(43)}`;
    await store.mintApiToken({
      id: "atk_expired",
      tenantId,
      principalId: holder,
      name: "expired",
      secretHash: createHash("sha256").update(expiredSecret, "utf8").digest("hex"),
      scopes: ["context:read"],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "svc:api",
      expiresAt: "2026-01-02T00:00:00.000Z"
    });
    const expired = await request("/wiki/releases", bearer(expiredSecret));
    assert.equal(expired.status, 401);
    assert.deepEqual(await expired.json(), unauthorized);
    assert.equal((await mcpRpc(baseUrl, expiredSecret)).status, 401);

    const unknown = await request("/wiki/releases", bearer(`jina_atk_${"z".repeat(43)}`));
    assert.equal(unknown.status, 401);
    assert.deepEqual(await unknown.json(), unauthorized);

    const malformed = await request("/wiki/releases", bearer("jina_atk_short"));
    assert.equal(malformed.status, 401);
    assert.deepEqual(await malformed.json(), unauthorized);
  });
});

test("Review access is short-lived, repository-scoped, and MCP-capable", async () => {
  await withServer(async ({ store, request }) => {
    const response = await request("/internal/context/review-access", {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        reviewRunId: "review-run-123",
        repository,
        expiresInMinutes: 30
      })
    });
    const rawBody = await response.text();
    assert.equal(response.status, 201, rawBody);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = JSON.parse(rawBody) as {
      repository: string;
      mcpPath: string;
      secret: string;
      token: {
        principalId: string;
        scopes: string[];
        createdAt: string;
        expiresAt: string;
      };
    };
    assert.equal(body.repository, repository);
    assert.equal(body.mcpPath, "/mcp");
    assert.match(body.secret, /^jina_atk_[A-Za-z0-9_-]{43}$/);
    assert.match(body.token.principalId, /^user:review-[0-9a-f]{32}@runs\.jina$/);
    assert.deepEqual(body.token.scopes, ["context:query", "context:read"]);
    assert.equal(Date.parse(body.token.expiresAt) - Date.parse(body.token.createdAt), 30 * 60_000);
    assert.deepEqual(await store.repositoriesForPrincipal(tenantId, body.token.principalId), [repository]);

    const read = await request(`/wiki/releases?repository=${encodeURIComponent(repository)}`, bearer(body.secret));
    assert.equal(read.status, 200);
    const crossRepository = await request(
      `/wiki/releases?repository=${encodeURIComponent(forbiddenRepository)}`,
      bearer(body.secret)
    );
    assert.equal(crossRepository.status, 404);
    const build = await request("/wiki/build", {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ repository })
    });
    assert.equal(build.status, 403);
  });
});

test("headers stay assertions, and the asymmetry between them is deliberate", async () => {
  await withServer(async ({ request, mint }) => {
    const secret = await mintSecret(mint);
    const withHeaders = (headers: Record<string, string>): RequestInit => ({
      headers: { authorization: `Bearer ${secret}`, ...headers }
    });

    // Agreeing headers are accepted; disagreeing ones are rejected rather than
    // reinterpreted. This is the cross-tenant guard.
    assert.notEqual((await request("/wiki/releases", withHeaders({ "x-jina-tenant-id": tenantId }))).status, 401);
    assert.notEqual((await request("/wiki/releases", withHeaders({ "x-jina-principal-id": holder }))).status, 401);
    assert.equal((await request("/wiki/releases", withHeaders({ "x-jina-tenant-id": otherTenantId }))).status, 401);
    assert.equal(
      (await request("/wiki/releases", withHeaders({ "x-jina-principal-id": "user:someone@example.com" }))).status,
      401
    );
    // A principal asserting tenant administration is refused like any other
    // disagreement, so the header cannot promote a token.
    assert.equal(
      (await request("/wiki/releases", withHeaders({ "x-jina-principal-id": `tenant:${tenantId}` }))).status,
      401
    );

    // `normalizedForwardedPrincipal` lowercases the value, so the address is
    // case-insensitive...
    assert.notEqual(
      (await request("/wiki/releases", withHeaders({ "x-jina-principal-id": "user:HOLDER@EXAMPLE.COM" }))).status,
      401
    );
    // ...but only after the scheme matches, and the `user:` pattern alone carries
    // no `i` flag where `tenant:` and `svc:` do. An upper-case scheme normalizes
    // to undefined and is refused. Asserted because it is surprising enough that
    // somebody will otherwise "fix" it by accident.
    assert.equal(
      (await request("/wiki/releases", withHeaders({ "x-jina-principal-id": "USER:holder@example.com" }))).status,
      401
    );
    // ...while `contextCredentialTenantId` in fixed tenancy does not, so the
    // tenant header is not. This asserts a deliberate decision to compare tenants
    // exactly as the context credential already does, not a bug.
    assert.equal(
      (await request("/wiki/releases", withHeaders({ "x-jina-tenant-id": tenantId.toUpperCase() }))).status,
      401
    );
  });
});

test("issued and static MCP credentials reject spoofed tenant and principal headers", async () => {
  await withServer(async ({ baseUrl, mint }) => {
    const issued = await mintSecret(mint);
    for (const secret of [issued, contextToken]) {
      assert.equal((await mcpRpc(baseUrl, secret, { "x-jina-tenant-id": otherTenantId })).status, 401);
      assert.equal(
        (
          await mcpRpc(baseUrl, secret, {
            "x-jina-principal-id": "user:attacker@example.com"
          })
        ).status,
        401
      );
    }

    assert.equal(
      (
        await mcpRpc(baseUrl, issued, {
          "x-jina-tenant-id": tenantId,
          "x-jina-principal-id": holder
        })
      ).status,
      200
    );
    assert.equal((await mcpRpc(baseUrl, contextToken)).status, 200);
  });
});

test("scope grants route reach and nothing more", async () => {
  await withServer(async ({ request, mint }) => {
    const readSecret = await mintSecret(mint);
    const querySecret = await mintSecret(mint, { scopes: ["context:query"] });
    const post = (path: string, secret: string): Promise<Response> =>
      fetch(`${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ repository })
      });

    const insufficient = async (response: Response): Promise<void> => {
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { code?: string }).code, "insufficient_scope");
    };

    assert.notEqual((await request("/wiki/releases", bearer(readSecret))).status, 401);
    await insufficient(await request("/wiki/releases", bearer(querySecret)));
    assert.notEqual((await request("/wiki/list?repository=" + repository, bearer(readSecret))).status, 403);

    const base = (await request("/health")).url.replace("/health", "");
    await insufficient(await post(`${base}/wiki/build`, readSecret));

    // Board traffic maps to no scope at all, so a token is refused there even
    // though the routes are not internal.
    await insufficient(await request("/board", bearer(readSecret)));
    await insufficient(await request("/overview", bearer(readSecret)));
    await insufficient(await request("/events", bearer(readSecret)));

    // An unknown path is `internal-only` by construction, so the 404 fallback is
    // unreachable for a token.
    await insufficient(await request("/nothing-here", bearer(readSecret)));

    // A minted token cannot mint: the `/internal/` gate answers first...
    const mintAttempt = await post(`${base}/internal/context/tokens`, readSecret);
    assert.equal(mintAttempt.status, 401);
    assert.equal(((await mintAttempt.json()) as { error: string }).error, "internal credential required");
    // ...except access-sync, which that gate exempts and which therefore falls
    // through to the scope check. Both are fail-closed; the codes differ, and
    // pinning it here stops the difference being rediscovered.
    await insufficient(await post(`${base}/internal/context/access/sync`, readSecret));
  });
});

test("HTTP and MCP independently enforce read, query, build, and admin scopes", async () => {
  await withServer(async ({ baseUrl, request, mint }) => {
    const readSecret = await mintSecret(mint, { scopes: ["context:read"] });
    const querySecret = await mintSecret(mint, { scopes: ["context:query"] });
    const mintAdministrator = async (scope: "context:build" | "context:admin"): Promise<string> => {
      const response = await mint({
        principalId: adminPrincipal,
        name: `${scope} token`,
        scopes: [scope],
        expiresInMinutes: 60,
        administrator: true
      });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      return (JSON.parse(text) as { secret: string }).secret;
    };
    const buildSecret = await mintAdministrator("context:build");
    const adminSecret = await mintAdministrator("context:admin");
    const post = (path: string, secret: string, body: Record<string, unknown>): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
    const insufficient = async (response: Response): Promise<void> => {
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { code?: string }).code, "insufficient_scope");
    };

    assert.equal((await request("/wiki/releases", bearer(readSecret))).status, 200);
    await insufficient(await request("/wiki/releases", bearer(querySecret)));
    await insufficient(await post("/wiki/search", readSecret, { repository, query: "architecture" }));
    assert.notEqual((await post("/wiki/search", querySecret, { repository, query: "architecture" })).status, 403);

    const build = await post("/wiki/build", buildSecret, {
      repository,
      ref: "main",
      requestKey: "token-scope-build"
    });
    assert.equal(build.status, 202, await build.text());
    await insufficient(await request("/wiki/metrics", bearer(buildSecret)));
    await insufficient(await request("/wiki/releases", bearer(buildSecret)));

    assert.equal((await request("/wiki/metrics", bearer(adminSecret))).status, 200);
    await insufficient(
      await post("/wiki/build", adminSecret, {
        repository,
        ref: "main",
        requestKey: "admin-cannot-build"
      })
    );
    await insufficient(await request("/wiki/releases", bearer(adminSecret)));

    const querySearch = await mcpTool(baseUrl, querySecret, "search_context", {
      repository,
      query: "architecture"
    });
    assert.equal(querySearch.isError, true);
    assert.match(JSON.stringify(querySearch), /context not found/i);
    assert.doesNotMatch(JSON.stringify(querySearch), /scope does not permit/i);

    const queryList = await mcpTool(baseUrl, querySecret, "list_context", { repository });
    assert.equal(queryList.isError, true);
    assert.match(JSON.stringify(queryList), /scope does not permit/i);

    const readList = await mcpTool(baseUrl, readSecret, "list_context", { repository });
    assert.equal(readList.isError, true);
    assert.match(JSON.stringify(readList), /context not found/i);
    assert.doesNotMatch(JSON.stringify(readList), /scope does not permit/i);

    const readSearch = await mcpTool(baseUrl, readSecret, "search_context", {
      repository,
      query: "architecture"
    });
    assert.equal(readSearch.isError, true);
    assert.match(JSON.stringify(readSearch), /scope does not permit/i);

    for (const [name, args] of [
      ["read_context", { repository, document: "architecture" }],
      [
        "diff_context",
        {
          repository,
          fromReleaseId: "release-before",
          toReleaseId: "release-after"
        }
      ]
    ] as const) {
      const queryDenied = await mcpTool(baseUrl, querySecret, name, args);
      assert.equal(queryDenied.isError, true);
      assert.match(JSON.stringify(queryDenied), /scope does not permit/i);

      const readAdmitted = await mcpTool(baseUrl, readSecret, name, args);
      assert.equal(readAdmitted.isError, true);
      assert.match(JSON.stringify(readAdmitted), /context not found/i);
      assert.doesNotMatch(JSON.stringify(readAdmitted), /scope does not permit/i);
    }

    for (const path of [
      `/wiki/read?repository=${encodeURIComponent(repository)}&document=architecture`,
      `/wiki/diff?repository=${encodeURIComponent(repository)}&fromReleaseId=release-before&toReleaseId=release-after`
    ]) {
      await insufficient(await request(path, bearer(querySecret)));
      assert.notEqual((await request(path, bearer(readSecret))).status, 403);
    }

    assert.equal((await mcpRpc(baseUrl, buildSecret)).status, 403);
    assert.equal((await mcpRpc(baseUrl, adminSecret)).status, 403);
  });
});

test("HTTP and MCP expose the same repository ACL denial without cross-tenant oracles", async () => {
  await withServer(async ({ baseUrl, request, mint }) => {
    const readSecret = await mintSecret(mint, { scopes: ["context:read"] });
    const querySecret = await mintSecret(mint, { scopes: ["context:query"] });
    const nonexistentRepository = "omlabs/repository-that-does-not-exist";

    const httpRead = await request(
      `/wiki/list?repository=${encodeURIComponent(forbiddenRepository)}`,
      bearer(readSecret)
    );
    assert.equal(httpRead.status, 404);
    const httpReadBody: unknown = await httpRead.json();
    assert.deepEqual(httpReadBody, {
      accepted: false,
      code: "not_found",
      error: "repository context not found"
    });
    const httpNonexistent = await request(
      `/wiki/list?repository=${encodeURIComponent(nonexistentRepository)}`,
      bearer(readSecret)
    );
    assert.equal(httpNonexistent.status, httpRead.status);
    assert.deepEqual(await httpNonexistent.json(), httpReadBody);

    const mcpRead = await mcpTool(baseUrl, readSecret, "list_context", {
      repository: forbiddenRepository
    });
    assert.equal(mcpRead.isError, true);
    assert.match(JSON.stringify(mcpRead), /repository context not found/i);
    const mcpNonexistent = await mcpTool(baseUrl, readSecret, "list_context", {
      repository: nonexistentRepository
    });
    assert.deepEqual(mcpNonexistent, mcpRead);

    const httpQuery = await fetch(`${baseUrl}/wiki/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${querySecret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ repository: forbiddenRepository, query: "secret project" })
    });
    assert.equal(httpQuery.status, 404);
    assert.equal(((await httpQuery.json()) as { error: string }).error, "repository context not found");
    const mcpQuery = await mcpTool(baseUrl, querySecret, "search_context", {
      repository: forbiddenRepository,
      query: "secret project"
    });
    assert.equal(mcpQuery.isError, true);
    assert.match(JSON.stringify(mcpQuery), /repository context not found/i);

    for (const secret of [readSecret, querySecret]) {
      const wrongTenantMcp = await mcpRpc(baseUrl, secret, {
        "x-jina-tenant-id": otherTenantId
      });
      const unknownMcp = await mcpRpc(baseUrl, `jina_atk_${"u".repeat(43)}`);
      assert.equal(wrongTenantMcp.status, 401);
      assert.equal(unknownMcp.status, wrongTenantMcp.status);
      assert.deepEqual(await unknownMcp.json(), await wrongTenantMcp.json());
    }

    const wrongTenantHttp = await request("/wiki/releases", {
      headers: {
        authorization: `Bearer ${readSecret}`,
        "x-jina-tenant-id": otherTenantId
      }
    });
    const unknownHttp = await request("/wiki/releases", bearer(`jina_atk_${"u".repeat(43)}`));
    assert.equal(wrongTenantHttp.status, 401);
    assert.equal(unknownHttp.status, wrongTenantHttp.status);
    assert.deepEqual(await unknownHttp.json(), await wrongTenantHttp.json());
  });
});

test("scope is not role: an admin-scoped token on an ordinary principal is still refused", async () => {
  await withServer(async ({ store, request }) => {
    // Minted through the store directly, because mint itself refuses this pairing.
    const secret = `jina_atk_${"y".repeat(43)}`;
    await store.mintApiToken({
      id: "atk_admin_scope",
      tenantId,
      principalId: holder,
      name: "admin scope on an ordinary principal",
      secretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
      scopes: ["context:admin"],
      createdAt: new Date().toISOString(),
      createdBy: "svc:api",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    const response = await request("/wiki/metrics", bearer(secret));
    assert.equal(response.status, 403);
    // Refused by requireTenantAdmin, not by the scope check: the scope was enough
    // to reach the route.
    assert.equal(((await response.json()) as { code?: string }).code, "forbidden");
  });
});

test("mint refuses every principal that would confer tenant administration", async () => {
  await withServer(async ({ mint }) => {
    // Asserting the reason, not just the status: several of these would otherwise
    // pass through the normalization branch and never reach the rule they name.
    const refused = async (body: Record<string, unknown>, because: RegExp): Promise<void> => {
      const response = await mint({ name: "t", scopes: ["context:read"], expiresInMinutes: 60, ...body });
      const text = await response.text();
      assert.equal(response.status, 400, text);
      assert.match((JSON.parse(text) as { error: string }).error, because, JSON.stringify(body));
    };
    const notNormalized = /recognisable user, tenant or service principal/;
    const isAdministrator = /pass administrator: true/;

    // The escalation needs no admin scope to work, so this is asserted directly
    // rather than inferred from a scope test.
    // A tenant principal is opt-in, not forbidden — but without the opt-in it is
    // refused, and even with it, only for the token's own tenant.
    await refused(
      { principalId: `tenant:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}` },
      /pass administrator: true/
    );
    await refused(
      {
        principalId: `tenant:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`,
        administrator: true
      },
      /must name the tenant the token is issued for/
    );
    // In fixed tenancy `tenant:<name>` fails normalization rather than the
    // tenant rule, because the tenant pattern only admits a UUID. Both refuse;
    // they refuse for different reasons, and the reasons are asserted so the
    // ordering of the checks stays deliberate.
    await refused({ principalId: `tenant:${tenantId}` }, notNormalized);
    await refused({ principalId: "svc:worker" }, /service principal names no accountable person/);
    await refused({ principalId: "not-a-principal" }, notNormalized);
    await refused({ principalId: " USER:holder@example.com " }, notNormalized);

    // A configured administrator needs the deliberate opt-in.
    await refused({ principalId: adminPrincipal }, isAdministrator);
    // An upper-case scheme does NOT reach the admin-list rule — it fails
    // normalization first. Asserted so the next case is not mistaken for
    // covering the lowercasing branch.
    await refused({ principalId: adminPrincipal.toUpperCase() }, notNormalized);
    const deliberate = await mint({
      principalId: adminPrincipal,
      name: "deliberate admin",
      scopes: ["context:admin"],
      expiresInMinutes: 60,
      administrator: true
    });
    assert.equal(deliberate.status, 201);

    // Scopes only an administrator could use are refused on anyone else, rather
    // than issued dead — and the body cannot assert its way past that, because the
    // guard reads the configured list rather than the flag.
    const adminScopes = /require an administrator principal/;
    await refused({ principalId: holder, scopes: ["context:build"] }, adminScopes);
    await refused({ principalId: holder, scopes: ["context:admin"] }, adminScopes);
    await refused({ principalId: holder, scopes: ["context:build"], administrator: true }, adminScopes);
    await refused({ principalId: holder, scopes: ["context:admin"], administrator: true }, adminScopes);
    await refused({ principalId: holder, scopes: ["context:write"] }, /unsupported scope/);
    await refused({ principalId: holder, scopes: [] }, /non-empty array/);
    await refused({ principalId: holder, expiresInMinutes: 4 }, /expiresInMinutes must be between/);
    await refused({ principalId: holder, expiresInMinutes: 525_601 }, /expiresInMinutes must be between/);
  });
});

test("the admin list is matched case-insensitively, so a mixed-case entry still refuses", async () => {
  // The configured entry is mixed case, which `isTenantAdmin` would never match
  // — so mint deliberately refuses a principal that is not in fact an
  // administrator. Over-refusing is the safe direction, and it keeps working on
  // the day somebody corrects the entry to lowercase. This is the branch the
  // upper-cased-principal case above cannot reach.
  await withServerConfig({ tenantAdminPrincipalIds: ["  User:Admin@Example.COM  "] }, async ({ mint }) => {
    const response = await mint({
      principalId: "user:admin@example.com",
      name: "t",
      scopes: ["context:read"],
      expiresInMinutes: 60
    });
    const text = await response.text();
    assert.equal(response.status, 400, text);
    assert.match((JSON.parse(text) as { error: string }).error, /pass administrator: true/);
  });
});

test("the secret exists exactly once, and issuance is deliberately not idempotent", async () => {
  await withServer(async ({ request, mint }) => {
    const created = await mint({
      principalId: holder,
      name: "once",
      scopes: ["context:read"],
      expiresInMinutes: 60
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    const body = (await created.json()) as { secret: string; token: Record<string, unknown> };
    assert.match(body.secret, /^jina_atk_/);
    assert.equal("secretHash" in body.token, false);
    assert.equal("secret" in body.token, false);

    const listed = await request("/internal/context/tokens", {
      headers: { authorization: `Bearer ${internalToken}` }
    });
    assert.equal(listed.status, 200);
    const tokens = ((await listed.json()) as { tokens: Record<string, unknown>[] }).tokens;
    assert.ok(tokens.length >= 1);
    for (const token of tokens) {
      assert.equal("secret" in token, false);
      assert.equal("secretHash" in token, false);
    }

    // Two identical requests produce two tokens. Credential issuance cannot be
    // idempotent — the only copy of the secret is the one in the response — and
    // pinning that stops it being read as an oversight.
    const again = await mint({
      principalId: holder,
      name: "once",
      scopes: ["context:read"],
      expiresInMinutes: 60
    });
    const secondBody = (await again.json()) as { secret: string; token: { id: string } };
    assert.notEqual(secondBody.secret, body.secret);
    assert.notEqual(secondBody.token.id, (body.token as { id: string }).id);
  });
});

test("the internal credential owns token audit attribution", async () => {
  await withServer(async ({ store, request, mint }) => {
    const created = await mint(
      {
        principalId: holder,
        name: "bound audit actor",
        scopes: ["context:read"],
        expiresInMinutes: 60
      },
      { "x-jina-principal-id": "user:forged-auditor@example.com" }
    );
    const text = await created.text();
    assert.equal(created.status, 201, text);
    const tokenId = (JSON.parse(text) as { token: { id: string } }).token.id;
    const stored = (await store.listApiTokens(tenantId)).find((token) => token.id === tokenId);
    assert.equal(stored?.createdBy, "svc:api");

    const revoked = await request(`/internal/context/tokens/${encodeURIComponent(tokenId)}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "x-jina-principal-id": "user:another-forged-auditor@example.com"
      }
    });
    assert.equal(revoked.status, 200);
    const after = (await store.listApiTokens(tenantId)).find((token) => token.id === tokenId);
    assert.equal(after?.revokedBy, "svc:api");
  });
});

test("revocation is immediate, idempotent, and blind to other tenants", async () => {
  await withServer(async ({ baseUrl, request, mint }) => {
    const secret = await mintSecret(mint, {
      scopes: ["context:read", "context:query"]
    });
    const listed = await request("/internal/context/tokens", {
      headers: { authorization: `Bearer ${internalToken}` }
    });
    const tokenId = ((await listed.json()) as { tokens: { id: string }[] }).tokens[0]!.id;

    assert.notEqual((await request("/wiki/releases", bearer(secret))).status, 401);
    assert.equal((await mcpRpc(baseUrl, secret)).status, 200);
    const revoke = (id: string): Promise<Response> =>
      request(`/internal/context/tokens/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${internalToken}`, "x-jina-principal-id": adminPrincipal }
      });

    const revoked = await revoke(tokenId);
    assert.equal(revoked.status, 200);
    const revokedBody = (await revoked.json()) as { token: Record<string, unknown> & { revokedAt: string } };
    assert.equal("secret" in revokedBody.token, false);
    assert.equal("secretHash" in revokedBody.token, false);
    assert.equal((await request("/wiki/releases", bearer(secret))).status, 401);
    assert.equal((await mcpRpc(baseUrl, secret)).status, 401);

    // Revoking twice is a 200 that reports the original revocation rather than
    // overwriting the audit trail.
    const twice = await revoke(tokenId);
    assert.equal(twice.status, 200);
    assert.equal(
      ((await twice.json()) as { token: { revokedAt: string } }).token.revokedAt,
      revokedBody.token.revokedAt
    );

    // An unknown id is a 404 rather than an idempotent 200, which would confirm
    // that it exists.
    assert.equal((await revoke("atk_not_here")).status, 404);

    // A revoked token is gone from the list.
    const after = await request("/internal/context/tokens", {
      headers: { authorization: `Bearer ${internalToken}` }
    });
    assert.deepEqual(((await after.json()) as { tokens: unknown[] }).tokens, []);
  });
});

test("an issued token revoked while retrieval is in flight cannot emit its result", async () => {
  await withServer(async ({ store, request, mint }) => {
    const secret = await mintSecret(mint, { scopes: ["context:read"] });
    const listed = await request("/internal/context/tokens", {
      headers: { authorization: `Bearer ${internalToken}` }
    });
    const tokenId = ((await listed.json()) as { tokens: { id: string }[] }).tokens[0]!.id;

    let retrievalStarted!: () => void;
    let allowRetrieval!: () => void;
    const started = new Promise<void>((resolve) => {
      retrievalStarted = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      allowRetrieval = resolve;
    });
    const originalListGenerations = store.listGenerations.bind(store);
    store.listGenerations = async (...args) => {
      retrievalStarted();
      await allowed;
      return originalListGenerations(...args);
    };

    const inFlight = request(`/wiki/releases?repository=${encodeURIComponent(repository)}`, bearer(secret));
    await started;
    const revoked = await request(`/internal/context/tokens/${encodeURIComponent(tokenId)}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${internalToken}` }
    });
    assert.equal(revoked.status, 200);
    allowRetrieval();

    const response = await inFlight;
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { code: string }).code, "unauthorized");
  });
});

test("a failing token store leaves the static credentials working and never returns 500", async () => {
  const store = new MemoryContextEngineStore();
  // The verification read is the one store call on the request path with no
  // handler try of its own, so without the closure's catch this is a 500.
  store.verifyApiToken = () => Promise.reject(new Error("relation does not exist"));
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: holder,
    contextStore: store
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await store.replaceRepositoryAccess(tenantId, holder, [repository]);
    const token = await fetch(`${baseUrl}/wiki/releases`, {
      headers: { authorization: `Bearer jina_atk_${"q".repeat(43)}` }
    });
    assert.equal(token.status, 401);
    assert.deepEqual(await token.json(), { error: "unauthorized" });

    assert.notEqual(
      (await fetch(`${baseUrl}/wiki/releases`, { headers: { authorization: `Bearer ${contextToken}` } })).status,
      401
    );
    assert.notEqual(
      (await fetch(`${baseUrl}/board`, { headers: { authorization: `Bearer ${internalToken}` } })).status,
      401
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("token store failures cannot put bearer secrets or hashes in responses or logs", async () => {
  const store = new MemoryContextEngineStore();
  const entries: Record<string, unknown>[] = [];
  const bearerSecret = `jina_atk_${"q".repeat(43)}`;
  const bearerHash = createHash("sha256").update(bearerSecret, "utf8").digest("hex");
  let mintedHash: string | undefined;
  store.verifyApiToken = (secretHash: string) => {
    assert.equal(secretHash, bearerHash);
    return Promise.reject(new Error(`driver leaked bearer=${bearerSecret} bind=${secretHash}`));
  };
  store.mintApiToken = (input: MintApiTokenInput) => {
    mintedHash = input.secretHash;
    return Promise.reject(new Error(`driver leaked insert bind=${input.secretHash}`));
  };
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: holder,
    contextStore: store,
    logger: captureLogger(entries)
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const verify = await fetch(`${baseUrl}/wiki/releases`, bearer(bearerSecret));
    assert.equal(verify.status, 401);
    assert.deepEqual(await verify.json(), { error: "unauthorized" });

    const mint = await fetch(`${baseUrl}/internal/context/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        principalId: holder,
        name: "must not leak",
        scopes: ["context:read"],
        expiresInMinutes: 60
      })
    });
    assert.equal(mint.status, 500);
    const mintResponse = await mint.text();
    assert.doesNotMatch(mintResponse, /jina_atk_|secretHash|bearer|bind=/);
    assert.ok(mintedHash);

    const logs = JSON.stringify(entries);
    assert.doesNotMatch(logs, new RegExp(bearerSecret));
    assert.doesNotMatch(logs, new RegExp(bearerHash));
    assert.doesNotMatch(logs, new RegExp(mintedHash));
    assert.doesNotMatch(logs, /authorization|secretHash|bind=/i);
    assert.match(logs, /api\.token\.verify_failed/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a static credential shaped like an issued token is refused at construction", () => {
  assert.throws(
    () => createApiServer({ tenantId, enableDevEndpoints: false, internalApiToken: `jina_atk_${"a".repeat(43)}` }),
    /jina_atk_/
  );
  assert.throws(
    () => createApiServer({ tenantId, enableDevEndpoints: false, contextApiToken: `jina_atk_${"a".repeat(43)}` }),
    /jina_atk_/
  );
  assert.throws(
    () =>
      createApiServer({
        tenantId,
        enableDevEndpoints: false,
        internalApiToken: "shared-secret",
        contextApiToken: "shared-secret"
      }),
    /must be distinct/
  );
  assert.throws(
    () =>
      createApiServer({
        tenantId,
        enableDevEndpoints: false,
        internalApiToken: internalToken,
        internalApiPrincipalId: "forged"
      }),
    /internalApiPrincipalId/
  );
});

test("a tenant principal is issuable for its own tenant, and is a tenant administrator", async () => {
  // The shape production actually uses: shared-db tenancy, so tenant ids are
  // UUIDs and `tenant:<uuid>` normalizes. This is the delegated token v1 holds
  // to read a tenant's context on that tenant's behalf.
  const uuidTenant = "11111111-1111-4111-8111-111111111111";
  await withServerConfig({ tenantId: uuidTenant, tenantAdminPrincipalIds: [] }, async ({ request, mint, store }) => {
    await store.replaceRepositoryAccess(uuidTenant, holder, [repository]);
    const created = await mint({
      principalId: `tenant:${uuidTenant}`,
      name: "v1 delegated reader",
      // `context:admin` is accepted here only because the principal really is an
      // administrator — the same guard that refuses it on an ordinary principal.
      scopes: ["context:read", "context:query", "context:admin"],
      expiresInMinutes: 15,
      administrator: true
    });
    const body = await created.text();
    assert.equal(created.status, 201, body);
    const secret = (JSON.parse(body) as { secret: string }).secret;

    // It reads, and it is a tenant administrator — so it sees the tenant's
    // repositories without needing ACL rows of its own, which is the whole reason
    // v1 needs this principal rather than a `user:` one.
    assert.equal((await request("/wiki/releases", bearer(secret))).status, 200);
    // requireTenantAdmin admits it where an ordinary principal is refused, so the
    // scope reaches the route and the role permits it.
    assert.equal((await request("/wiki/metrics", bearer(secret))).status, 200);

    // A minted tenant principal still cannot exceed its scopes.
    const refusedRoute = await request("/board", bearer(secret));
    assert.equal(refusedRoute.status, 403);
    assert.equal(((await refusedRoute.json()) as { code?: string }).code, "insufficient_scope");

    // And the headers v1 sends today must agree with the row rather than being
    // ignored: this is the exact pair that 401s against the static credential.
    const withHeaders = await request("/wiki/releases", {
      headers: {
        authorization: `Bearer ${secret}`,
        "x-jina-tenant-id": uuidTenant,
        "x-jina-principal-id": `tenant:${uuidTenant}`
      }
    });
    assert.equal(withHeaders.status, 200);
  });
});
