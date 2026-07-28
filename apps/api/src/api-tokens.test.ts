import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { test } from "node:test";
import { MemoryContextEngineStore, MemoryContextPipelineCoordinator } from "@jina/context-engine";
import { createApiServer } from "./server.js";

const tenantId = "tenant-tokens";
const otherTenantId = "tenant-other";
const repository = "omlabs/token-fixture";
const holder = "user:holder@example.com";
const adminPrincipal = "user:admin@example.com";
const internalToken = "internal-token-test";
const contextToken = "context-token-test";

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
  overrides: { tenantAdminPrincipalIds?: readonly string[] },
  run: (context: ServerContext) => Promise<void>
): Promise<void> {
  const coordinator = new MemoryContextPipelineCoordinator();
  const store = new MemoryContextEngineStore(coordinator);
  const server: Server = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    seedDemo: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: holder,
    contextCoordinator: coordinator,
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

test("a minted token authenticates as its own row and every failure looks identical", async () => {
  await withServer(async ({ store, request, mint }) => {
    const secret = await mintSecret(mint);
    assert.match(secret, /^jina_atk_[A-Za-z0-9_-]{43}$/);

    assert.notEqual((await request("/context/generations", bearer(secret))).status, 401);

    // Expired, revoked, unknown and malformed are one answer with one body, so
    // the response never says which tokens exist or why one stopped working.
    const unauthorized = { error: "unauthorized" };
    const listed = await store.listApiTokens(tenantId);
    await store.revokeApiToken(tenantId, listed[0]!.id, adminPrincipal, new Date().toISOString());
    const revoked = await request("/context/generations", bearer(secret));
    assert.equal(revoked.status, 401);
    assert.deepEqual(await revoked.json(), unauthorized);

    // Expiry is minted through the store, because mint's own bounds forbid a
    // lifetime already in the past.
    const { createHash } = await import("node:crypto");
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
    const expired = await request("/context/generations", bearer(expiredSecret));
    assert.equal(expired.status, 401);
    assert.deepEqual(await expired.json(), unauthorized);

    const unknown = await request("/context/generations", bearer(`jina_atk_${"z".repeat(43)}`));
    assert.equal(unknown.status, 401);
    assert.deepEqual(await unknown.json(), unauthorized);

    const malformed = await request("/context/generations", bearer("jina_atk_short"));
    assert.equal(malformed.status, 401);
    assert.deepEqual(await malformed.json(), unauthorized);
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
    assert.notEqual((await request("/context/generations", withHeaders({ "x-jina-tenant-id": tenantId }))).status, 401);
    assert.notEqual(
      (await request("/context/generations", withHeaders({ "x-jina-principal-id": holder }))).status,
      401
    );
    assert.equal(
      (await request("/context/generations", withHeaders({ "x-jina-tenant-id": otherTenantId }))).status,
      401
    );
    assert.equal(
      (await request("/context/generations", withHeaders({ "x-jina-principal-id": "user:someone@example.com" })))
        .status,
      401
    );
    // A principal asserting tenant administration is refused like any other
    // disagreement, so the header cannot promote a token.
    assert.equal(
      (await request("/context/generations", withHeaders({ "x-jina-principal-id": `tenant:${tenantId}` }))).status,
      401
    );

    // `normalizedForwardedPrincipal` lowercases the value, so the address is
    // case-insensitive...
    assert.notEqual(
      (await request("/context/generations", withHeaders({ "x-jina-principal-id": "user:HOLDER@EXAMPLE.COM" }))).status,
      401
    );
    // ...but only after the scheme matches, and the `user:` pattern alone carries
    // no `i` flag where `tenant:` and `svc:` do. An upper-case scheme normalizes
    // to undefined and is refused. Asserted because it is surprising enough that
    // somebody will otherwise "fix" it by accident.
    assert.equal(
      (await request("/context/generations", withHeaders({ "x-jina-principal-id": "USER:holder@example.com" }))).status,
      401
    );
    // ...while `contextCredentialTenantId` in fixed tenancy does not, so the
    // tenant header is not. This asserts a deliberate decision to compare tenants
    // exactly as the context credential already does, not a bug.
    assert.equal(
      (await request("/context/generations", withHeaders({ "x-jina-tenant-id": tenantId.toUpperCase() }))).status,
      401
    );
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

    assert.notEqual((await request("/context/generations", bearer(readSecret))).status, 401);
    await insufficient(await request("/context/generations", bearer(querySecret)));
    assert.notEqual((await request("/context/structure?repository=" + repository, bearer(readSecret))).status, 403);

    const base = (await request("/health")).url.replace("/health", "");
    await insufficient(await post(`${base}/context/build`, readSecret));
    await insufficient(await post(`${base}/context/rebuild`, readSecret));
    await insufficient(await post(`${base}/context/erasure`, readSecret));

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

test("scope is not role: an admin-scoped token on an ordinary principal is still refused", async () => {
  await withServer(async ({ store, request }) => {
    // Minted through the store directly, because mint itself refuses this pairing.
    const secret = `jina_atk_${"y".repeat(43)}`;
    const { createHash } = await import("node:crypto");
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
    const response = await request("/context/metrics", bearer(secret));
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
    await refused(
      { principalId: `tenant:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}` },
      /tenant principal confers tenant administration/
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

test("revocation is immediate, idempotent, and blind to other tenants", async () => {
  await withServer(async ({ request, mint }) => {
    const secret = await mintSecret(mint);
    const listed = await request("/internal/context/tokens", {
      headers: { authorization: `Bearer ${internalToken}` }
    });
    const tokenId = ((await listed.json()) as { tokens: { id: string }[] }).tokens[0]!.id;

    assert.notEqual((await request("/context/generations", bearer(secret))).status, 401);
    const revoke = (id: string): Promise<Response> =>
      request(`/internal/context/tokens/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${internalToken}`, "x-jina-principal-id": adminPrincipal }
      });

    const revoked = await revoke(tokenId);
    assert.equal(revoked.status, 200);
    assert.equal((await request("/context/generations", bearer(secret))).status, 401);

    // Revoking twice is a 200 that reports the original revocation rather than
    // overwriting the audit trail.
    const twice = await revoke(tokenId);
    assert.equal(twice.status, 200);
    assert.equal(
      ((await twice.json()) as { token: { revokedAt: string } }).token.revokedAt,
      ((await revoked.json()) as { token: { revokedAt: string } }).token.revokedAt
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

test("a failing token store leaves the static credentials working and never returns 500", async () => {
  const coordinator = new MemoryContextPipelineCoordinator();
  const store = new MemoryContextEngineStore(coordinator);
  // The verification read is the one store call on the request path with no
  // handler try of its own, so without the closure's catch this is a 500.
  store.verifyApiToken = () => Promise.reject(new Error("relation does not exist"));
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    seedDemo: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: holder,
    contextCoordinator: coordinator,
    contextStore: store
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await store.replaceRepositoryAccess(tenantId, holder, [repository]);
    const token = await fetch(`${baseUrl}/context/generations`, {
      headers: { authorization: `Bearer jina_atk_${"q".repeat(43)}` }
    });
    assert.equal(token.status, 401);
    assert.deepEqual(await token.json(), { error: "unauthorized" });

    assert.notEqual(
      (await fetch(`${baseUrl}/context/generations`, { headers: { authorization: `Bearer ${contextToken}` } })).status,
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

test("a static credential shaped like an issued token is refused at construction", () => {
  assert.throws(
    () => createApiServer({ tenantId, enableDevEndpoints: false, internalApiToken: `jina_atk_${"a".repeat(43)}` }),
    /jina_atk_/
  );
  assert.throws(
    () => createApiServer({ tenantId, enableDevEndpoints: false, contextApiToken: `jina_atk_${"a".repeat(43)}` }),
    /jina_atk_/
  );
});
