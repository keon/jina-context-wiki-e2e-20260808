# Implementation plan: per-principal API tokens

How `docs/API_TOKENS.md` gets built, phase by phase, to completion. Each phase ships on its own and
leaves the system working, so the sequence can pause anywhere without half a feature in production.

| Phase | Delivers                                                         | Done when                                                        |
| ----- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1     | Token model: mint, verify, scope-check, hash at rest, revoke     | A minted token reads context for its own tenant                  |
| 2     | Usage records keyed by token, covering builds; v1 meters credits | A build and a query both appear in usage attributed to a token   |
| 3     | Dashboard issuance and per-token usage                           | A person creates a token in the dashboard and sees what it spent |
| 4     | v1 on delegated tokens; static context token retired             | `CONTEXT_API_TOKEN` is gone and nothing regressed                |

Phase 1 is planned in detail because it is next: every file, every function, every line it edits, and
the SQL and TypeScript in the form they will be pasted. Phases 2 to 4 are planned to the depth needed
to show that phase 1's shape survives them — where a later phase needs something from an earlier one,
it is called out there rather than discovered later.

# What this repository cannot confirm

Both the design doc and earlier drafts of this plan asserted facts about Jina v1. Jina v1 is a
separate deployment — `docs/SHARED_TENANCY.md` places it in `jina-463721:us-east1`, owning the
`public` schema of the shared database — and its source is not in this worktree. Nothing below can be
checked from here, so none of it may be treated as an established fact by an implementer working in
this repository. Each is listed with what would settle it.

**v1 bills through Autumn, with a metered `jina_credits` feature and monthly plan allowances, and
charges `infra_credits_per_run` for every review.** A case-insensitive search for `autumn` and
`jina_credits` across `apps`, `packages`, `docs` and `scripts` matches only this document and
`docs/API_TOKENS.md`. There is no client, key, env var, webhook handler or feature id anywhere here.
What does exist is `packages/policy/src/billing-policy.ts`, whose `infraCreditsPerRun: 100` is a pure
unenforced calculation consumed only by a simulation test and the local review CLI; `docs/BILLING.md`
states directly that "Jina does not enforce hosted billing or persist usage." The name similarity
between that dormant helper and the plan's `infra_credits_per_run` is close enough to be worth ruling
out. To confirm: v1's Autumn client module, its feature-id constants, and its review-billing call
site.

**v1's dashboard owns user sessions and tenant membership and presents Organization, Usage and
Billing.** `apps/dashboard` in this repository is not that dashboard — `README.md:181` calls it the
operator board and context workspace. It has no sessions (`apps/dashboard/src/proxy.ts` holds the
gate, on an IAP header or one shared Basic credential, and `resolveDashboardPrincipal` — which lives
in `apps/dashboard/src/server/proxy-policy.ts:76`, not in `proxy.ts`, and is called from
`apps/dashboard/src/app/api/[...path]/route.ts:41` — derives a single principal from the IAP email or
a fixed `JINA_WEB_PRINCIPAL_ID`), it serves one tenant per deployment from `JINA_TENANT_ID`, and its
routes are api, context, history and tasks. To confirm: v1's session middleware and its
Organization/Usage/Billing routes.

**v1's existing MCP access token is signed with a short lifetime.** Nothing in this repository has
that shape; the only bearer credentials here are two static shared secrets compared with `===`. The
claim appears in `docs/API_TOKENS.md` as evidence for the signed-token option, and this plan decides
against that option anyway, so nothing downstream rests on it. To confirm: v1's MCP token issuance
code.

**v1's review path already uses its own credential for MCP forwarding.** Phase 4 sequences around
this. To confirm: v1's review MCP client configuration.

**The context page is still returning 401 in production after the read-scope widening.** The
motivating 401 is real and documented: commit 7da49c4 records that "Jina v1's context page needs
exactly those reads and currently fails against production with 401s." That it _persists_ after the
widening is a production observation held outside the code — no test, doc or later commit records it.
To confirm: production logs for 401s on `GET /context/generations` carrying the context bearer.

An earlier draft also said the credential model had caused the same failure three times in one day.
Of the three commits landed on 2026-07-27, only 7da49c4 (#150) concerns the credential model;
c161233 (#148) concerns a database migration credential and 98a9299 (#149) a Daytona resource
ceiling. The design does not need the count. It rests on two things visible in the code:
`apps/api/src/server.ts:1415-1430` rejects a context-credential request whose `x-jina-tenant-id`
disagrees with the configured binding, and `scripts/cloud-build-deploy.sh:211-212` pins that binding
to one tenant and one principal per deployment. A caller serving many tenants cannot forward its own
tenant id and cannot omit it either, because the binding names somebody else's.

# Phase 1: the token model

Mint, verify, scope-check, hash at rest, revoke. Nothing here meters usage or issues tokens from a
dashboard.

## Decisions taken

Two questions were left open in the design doc. Both are settled here, because they are expensive to
revisit once tokens exist in the wild.

**Format: opaque, stored hashed.** Revocation is the deciding property. These credentials go to
people rather than processes, and "revoke this leaked token now" has to mean now, which a signed
token with a lifetime cannot give. The cost is a lookup per request, which is a single indexed read.
The verify path also becomes the natural place to stamp `last_used_at` and to carry the `token_id`
that phase 2 meters on, both of which a stateless token would have to invent separately.

The cost is larger than "a lookup", and the correction matters because it is most of phase 1's work.
`authenticatedPrincipal` (`apps/api/src/server.ts:1379`) is synchronous, is declared at module level
after `createApiServer` closes at line 1377 so it can reach no store, and is called twice per
request. Choosing an opaque token therefore buys immediate revocation at the price of making the
request entry point asynchronous. That is still the right trade, but it is budgeted below as a
restructure rather than as a branch.

**Narrowing: tenant-scoped only.** A token names one tenant and one principal. Restricting a token
further to specific repositories is additive later and nothing in this phase forecloses it, so it
waits for a real request rather than being guessed at now.

## Data model

One new table. It follows the context schema's conventions where they exist and departs from them in
two places that are called out rather than smuggled in.

Append to `CONTEXT_SCHEMA_SQL` in `packages/db/src/context/schema.ts`, after the `query_runs` family,
which ends with the `context_retrieval_metrics_scope` index at line 1157, and before the
`current_refs` view at line 1159 — not after line 1160, which is inside that view's body and would
split the definition into invalid SQL that fails at migration time rather than at build time. The
trigger installation block that begins at line 1219 is the other boundary:

```sql
create table if not exists jina_context.api_tokens (
  id text not null check (id ~ '^atk_'),
  tenant_id text not null,
  principal_id text not null check (principal_id ~ '^(user|tenant|svc):'),
  name text not null,
  -- sha256 hex of the presented `jina_atk_…` string, never the secret. Plain
  -- SHA-256 rather than a password hash is correct only while the body stays 256
  -- bits of randomBytes with no user-chosen entropy: stretching buys nothing
  -- against an unguessable secret and costs a KDF on every request. If this ever
  -- becomes shorter or user-chosen, the hash must change with it.
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null constraint api_tokens_scopes_known check (
    array_length(scopes,1) >= 1
    and scopes <@ array['context:query','context:read','context:build','context:admin']::text[]
  ),
  created_at timestamptz not null,
  created_by text not null,
  expires_at timestamptz not null check (expires_at > created_at),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  primary key (tenant_id,id),
  check ((revoked_at is null) = (revoked_by is null))
);
alter table jina_context.api_tokens
  drop constraint if exists api_tokens_scopes_known;
alter table jina_context.api_tokens
  add constraint api_tokens_scopes_known check (
    array_length(scopes,1) >= 1
    and scopes <@ array['context:query','context:read','context:build','context:admin']::text[]
  );
create unique index if not exists context_api_tokens_secret
  on jina_context.api_tokens (secret_hash);
create index if not exists context_api_tokens_tenant
  on jina_context.api_tokens (tenant_id,created_at desc,id desc);
```

The named constraint and the drop/add pair that immediately follow the `create table` are not
redundancy. `CONTEXT_SCHEMA_SQL` is idempotent DDL applied wholesale by `applySchema`
(`packages/db/src/apply-schema.ts:10`), so on any database where this phase has already run,
PostgreSQL skips the entire `create table if not exists` statement and editing the literal inside it
does nothing. Phase 2 adds `context:usage` to this enumeration; without the pair, that edit is a
silent no-op that passes on a freshly created CI database and raises a check violation the first time
production mints a `context:usage` token. Re-running the schema must reassert the current scope list,
which is what the drop/add does. The repository already owns this idiom — `derivation_runs` at
`packages/db/src/context/schema.ts:542-545` drops a constraint by name and adds a column the same way
— and an unnamed inline CHECK could not be dropped by name at all without first looking up the
identifier PostgreSQL generated for it. Phase 2 cannot fix this retroactively, so it is decided here.

There is deliberately no `request_key`. An earlier draft carried one, copying `createBuild`'s
`requestKey` (`packages/context-engine/src/workflow/coordinator.ts:53`, reached from
`apps/api/src/server.ts:445`) against `pipeline_builds`' `unique (tenant_id,request_key)`
(`schema.ts:46`), so that phase 4's restart storm would mint once. It cannot work here, and the reason
is worth recording because the idea is an obvious one to have again. A build is idempotent because a
replayed request can return the existing build row; a mint cannot, because the only copy of the secret
is the one in the `201` body. A replay would have to answer with the row and no secret, handing the
caller a token it cannot use and an orphan it must then revoke — strictly worse than minting a second
one, which expiry already bounds. Credential issuance is not idempotent, and pretending otherwise buys
a field that either lies or is useless.

That leaves phase 4 needing an optional field phase 1 does not define, so phase 3's freeze is scoped
to say what it actually needs to: the mint **response** body and status codes are fixed from phase 1,
and so is the meaning of every request field already shipped. Adding a further optional request field
is backward compatible by construction and is not the signal that phase 1 got the shape wrong. The
signal is a change to what a shipped field means, or to what the caller gets back.

Do **not** add `api_tokens` to the `reject_immutable_change` trigger array at
`packages/db/src/context/schema.ts:1222-1231` (entries on 1223-1230). That trigger makes a table
append-only, and the `last_used_at`, `revoked_at` and `revoked_by` updates below would raise
SQLSTATE 55000.

Two departures from convention. `primary key (tenant_id, id)` has no precedent here: of the
twenty-six tenant-prefixed primary keys in `schema.ts`, every one is `(tenant_id, repository, …)`, and
tables with no repository dimension — `pipeline_builds`, `evidence_checkpoints`, `index_generations`,
`query_runs` — use a bare `id text primary key`. A token has no repository and every read of it is
tenant-filtered, so tenant-first is deliberate. And `unique (secret_hash)` is a global index across
tenants, which no other tenant-scoped table carries; it is what makes verification one lookup. RLS is
not a uniqueness barrier, so a collision would raise a violation naming a row the inserting role
cannot see. At 256 bits that will not happen, and mint maps a unique violation on that index to a 500
with no detail rather than surfacing the constraint message.

Ids are `newId("atk")` from `packages/context-engine/src/domain/fingerprint.ts:71`, which is
`atk_<uuid>`. Note this is a departure too: every id minted inside `packages/db` uses `stableId`, and
`newId` is used only inside `packages/context-engine`. A token id must not be derivable from its
contents, so a random id is right, and the `^atk_` check enforces the prefix the way `schema.ts`
already enforces its only two id prefixes, `^cb_` (line 35) and `^cs_` (line 54).

## Row-level security and grants

Row-level security is not a property of the table definition. It is issued solely by the loop at
`packages/db/src/context/roles.ts:456-465` over the `tenantScopedTables` array at line 42. A table
added to `schema.ts` and omitted from that array ships with grants and no policy at all — which is
precisely the cross-tenant bug this phase must not introduce. Six tables sit outside it deliberately;
`api_tokens` is not one of them.

Add `"api_tokens"` to `tenantScopedTables` (`packages/db/src/context/roles.ts:42-86`, alphabetically
irrelevant — append near `"query_runs"` at line 84). That gives the standard `context_tenant_scope`
policy, which governs mint, list and revoke, all of which know their tenant.

Verification does not know its tenant. That is the whole point of putting the tenant in the row, and
it is why the standard policy alone cannot serve it. `tenantScopeSql`
(`packages/db/src/context/roles.ts:35-40`) permits a cross-tenant read only when
`current_user='jina_context_admin'` and `jina.tenant_id='*'` — a hard-coded literal role name no new
role can satisfy — and `packages/db/src/migrate.ts:29` revokes `jina_context_admin` from the runtime
login, with an inherit assertion at lines 41-58 that fails the migration if it returns. At system
scope `transactionAs` sets the setting to the literal `'*'`
(`packages/db/src/context/database.ts:75-77`), so `tenant_id = any('{*}')` is false for every real
tenant. A new capability role at system scope would read zero rows.

So the verification read gets its own permissive policy. PostgreSQL ORs permissive policies, so this
adds exactly that read and nothing else. Add a new capability role name
`"jina_context_tokens"` to `CONTEXT_ROLES` (`packages/db/src/context/roles.ts:1-17`, before
`"jina_context_tenant_admin"`), then add these grants immediately before the blanket admin grant at
`packages/db/src/context/roles.ts:280`:

```sql
grant select,insert on jina_context.api_tokens to jina_context_tokens;
grant update (last_used_at,revoked_at,revoked_by) on jina_context.api_tokens
  to jina_context_tokens;
```

and this policy in the bespoke-policy region, after the `answer_citations` policy that ends at
`packages/db/src/context/roles.ts:454`:

```sql
drop policy if exists context_api_tokens_verify on jina_context.api_tokens;
create policy context_api_tokens_verify on jina_context.api_tokens
  for select to jina_context_tokens
  using (
    current_setting('jina.tenant_id',true)='*'
    and revoked_at is null
    and expires_at > now()
  );
```

The `'*'` guard keeps this policy from also widening reads at tenant scope, where the standard policy
already governs. The liveness predicate means a revoked or expired token is not merely rejected but
invisible, so a verification bug cannot resurrect one. Containment comes from the GRANT list rather
than from RLS: apart from the blanket `jina_context_tenant_admin`/`jina_context_admin` grant at
`roles.ts:280-281` — which is still governed by the standard tenant policy and therefore reads
nothing at system scope — no capability role is granted anything on `api_tokens`, so no other role
can read it whatever the policies say. Both halves of that need asserting, and the integration test
below asserts them directly: `jina_context_query` is refused outright, and
`jina_context_tenant_admin` at `contextSystemScope` sees zero rows. The second is the property the
sentence actually depends on, because the blanket grant is real and reaching it is only a matter of
scope. That inverts the usual reasoning in this schema, which is why neither half is left implied.

The role is _granted_ privileges on the table; it does not own it. Capability roles are created
`nologin` (`roles.ts:98`) and own nothing, the migration login owns every relation
(`docs/DEPLOYMENT.md:421-422`: "The migration login therefore needs schema ownership and
`CREATEROLE`" — `cloudbuild.yaml:134` only names that login, `jina_app`, and establishes nothing
about ownership), and since no table here sets `FORCE ROW LEVEL SECURITY`, genuine ownership would
bypass every policy.

Adding the name to `CONTEXT_ROLES` is all the plumbing the role needs. That one edit creates it in
the `do $roles$` block at `roles.ts:93`, includes it in `grant usage on schema jina_context`
(`roles.ts:109`), widens the `ContextDatabaseRole` union (`roles.ts:33`), and — because
`CONTEXT_RUNTIME_ROLES` is derived at `roles.ts:19` — grants it to the runtime login at
`migrate.ts:36` with `inherit false`, includes it in the non-inheritance assertion at
`migrate.ts:41-58`, and grants it to the test runtime role at
`packages/db/src/context.integration.test.ts:1895`. Neither `migrate.ts` nor `database.ts` is edited.

The admin roles need no edit either: `grant all privileges on all tables in schema jina_context to
jina_context_tenant_admin,jina_context_admin` at `roles.ts:280-281` is evaluated when the statement
runs, and `CONTEXT_ROLES_SQL` always runs after `CONTEXT_SCHEMA_SQL` in both application paths
(`migrate.ts:21` then `:26`; `database.ts:104` then `:107`). Note that blanket privilege is not
blanket access — `jina_context_tenant_admin` is still subject to the standard policy and sees nothing
at system scope, exactly as `docs/DEPLOYMENT.md:419-421` describes.

## Token shape and hashing

```
jina_atk_<43 chars base64url>
```

The body is `randomBytes(32)` base64url-encoded, which is 43 characters. The `jina_atk_` prefix is
load-bearing in three ways: it makes a leaked token greppable in logs, it lets us register the
pattern for secret scanning later, and it lets verification reject anything not matching the shape
before it touches the database.

The stored hash is `createHash("sha256").update(token, "utf8").digest("hex")` over the **complete
`jina_atk_…` string** with `Bearer ` stripped — not the 43-character body, and not the raw
`Authorization` value. Mint and verify must agree on exactly one of those three, and a mismatch
produces a token that is silently never findable, indistinguishable from an invalid one. The
`^[0-9a-f]{64}$` check on the column makes a differently-derived or differently-cased hash fail
loudly at insert instead.

Do not reuse `fingerprint()` from `@jina/context-engine`
(`packages/context-engine/src/domain/fingerprint.ts:22`). It canonicalises JSON, so a later reader
passing it an object rather than the raw string would change every hash.

## The store port

Five optional methods on `ContextEngineStore`
(`packages/context-engine/src/ports/context-engine-store.ts:76-110`), added after `queryMetrics` at
line 105. Optional matches the existing additive idiom in that interface (`runInTenantScope?`,
`retrieveIndexed?`, `latestAuthorizedGeneration?`), needs no edit to any test fixture, and fails
closed: a store that does not implement them simply never authenticates a token.

```ts
export interface ApiTokenRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
}

export interface MintApiTokenInput {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly name: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
}

export interface VerifiedApiToken {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt?: string;
}
```

```ts
  verifyApiToken?(secretHash: string): Promise<VerifiedApiToken | undefined>;
  stampApiTokenUse?(tenantId: string, tokenId: string, usedAt: string): Promise<void>;
  mintApiToken?(token: MintApiTokenInput): Promise<ApiTokenRecord>;
  listApiTokens?(tenantId: string): Promise<ApiTokenRecord[]>;
  revokeApiToken?(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined>;
```

The Postgres implementation is a new file, `packages/db/src/context/api-token-repository.ts`,
constructed by `PostgresContextEngineStore` alongside the other four repositories
(`packages/db/src/context/store.ts:59-64`) and delegated the same way. It must be re-exported from
`packages/db/src/index.ts`, or `pnpm lint` fails: that script chains knip, which fails the build on
an exported symbol no entry point reaches. The memory implementation goes in
`packages/context-engine/src/memory/store.ts` beside `recordQueryRun` at line 595.

Expiry and revocation are decided by one SQL predicate and never by a JavaScript clock comparison:

```ts
  async verifyApiToken(secretHash: string): Promise<VerifiedApiToken | undefined> {
    const result = await this.database.queryAs<{
      id: string;
      tenant_id: string;
      principal_id: string;
      scopes: string[];
      last_used_at: Date | null;
    }>(
      "jina_context_tokens",
      contextSystemScope,
      `select id,tenant_id,principal_id,scopes,last_used_at
       from jina_context.api_tokens
       where secret_hash=$1 and revoked_at is null and expires_at > now()`,
      [secretHash]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tokenId: row.id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      scopes: row.scopes,
      ...(row.last_used_at ? { lastUsedAt: dateString(row.last_used_at) } : {})
    };
  }
```

`now()` is the transaction timestamp on the same database that evaluates the policy predicate, so the
two cannot disagree and a skewed pod clock cannot accept an expired token. The API does no date
arithmetic on verification; the only time it computes is `expires_at` at mint.

This read must run at system scope and therefore **before** `runInTenantScope` is entered.
`ContextDatabase.transactionAs` lets an ambient tenant scope override an explicitly requested system
scope (`packages/db/src/context/database.ts:68`), so the same query run inside the request's tenant
scope would silently return nothing. The call-site restructure below is what guarantees it runs once,
in the right place.

Mint, list and revoke all know their tenant and run at `contextTenantScope(tenantId)` under the same
role, and so does `stampApiTokenUse` — it takes a tenant precisely so it can run at
`contextTenantScope(token.tenantId)` rather than inheriting verification's system scope. Verification
is the single exception in this repository and it is worth keeping the exception exactly that narrow.
Mint is a plain insert with no conflict clause, for the reason given under the data model: there is
nothing to reconcile a replay against. Revoke is filtered by tenant in SQL and is a no-op on an
already-revoked row, so a second revocation returns the recorded first revoker rather than
overwriting the audit trail:

```sql
update jina_context.api_tokens
   set revoked_at=$4,revoked_by=$3
 where tenant_id=$1 and id=$2 and revoked_at is null
```

followed by a `select` of the row, so the handler can distinguish "revoked now", "already revoked"
and "no such token in this tenant".

## Verification

`authenticatedPrincipal` (`apps/api/src/server.ts:1379-1383`) becomes async and takes the verifier as
a parameter. It cannot reach `contextStore` on its own — it is declared after `createApiServer` closes
at line 1377 — so the closure is threaded in rather than the store.

The token branch goes **first in the function**, before the dev-endpoint branch at lines 1384-1390,
not merely before the two static-token comparisons at 1392-1396. The dev branch returns
unconditionally without inspecting any bearer and takes both tenant and principal from unvalidated
headers, so a token presented to a dev-enabled server would otherwise be ignored entirely and the
caller would be whoever the headers claim — including the administrator-conferring
`tenant:<tenantId>` form.

```ts
const API_TOKEN_PATTERN = /^jina_atk_[A-Za-z0-9_-]{43}$/;

async function authenticatedPrincipal(
  request: IncomingMessage,
  config: ApiServerConfig,
  pathname: string,
  verifyApiToken: (token: string) => Promise<Principal | undefined>
): Promise<Principal | undefined> {
  const authorization = firstHeader(request.headers.authorization);
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (presented && API_TOKEN_PATTERN.test(presented)) {
    // Terminal. A shape-matched token is never reinterpreted as a shared secret,
    // so an issued token cannot fall through to a static path and a revoked one
    // cannot be reinterpreted as anything.
    const principal = await verifyApiToken(presented);
    return principal && assertedIdentity(request, config, principal);
  }
  if (config.enableDevEndpoints) {
    // … unchanged, lines 1385-1389
  }
  // … the rest of the function unchanged, lines 1391-1440
}
```

`INTERNAL_API_TOKEN` and `CONTEXT_API_TOKEN` must therefore never be configured with a `jina_atk_`
prefix, or the shape check shadows them and takes the deployment offline. `createApiServer` asserts
this at construction, beside the existing `contextWorkerLeaseMs` assertion at
`apps/api/src/server.ts:153-155`.

Headers stay assertions:

```ts
function assertedIdentity(
  request: IncomingMessage,
  config: ApiServerConfig,
  principal: Principal
): Principal | undefined {
  const tenantHeader = firstHeader(request.headers["x-jina-tenant-id"]);
  const principalHeader = firstHeader(request.headers["x-jina-principal-id"]);
  if (tenantHeader !== undefined && contextCredentialTenantId(tenantHeader, config) !== principal.tenantId) {
    return undefined;
  }
  if (principalHeader !== undefined && normalizedForwardedPrincipal(principalHeader) !== principal.principalId) {
    return undefined;
  }
  return principal;
}
```

Two details that the existing branches get right and a reimplementation would get wrong, and one
consequence worth stating plainly because it is asymmetric.

The principal comparison normalizes both sides. `normalizedForwardedPrincipal`
(`apps/api/src/server.ts:1865-1871`) lowercases its input, and the stored `principal_id` is written in
that same normalized form at mint, so a differently-cased but matching principal header is accepted
rather than rejected.

With one exception, found by writing the test rather than by reading the function, and worth stating
because it is the kind of thing a later reader will "fix". Normalization lowercases the value only
_after_ a scheme pattern matches, and of the three patterns only `user:` carries no `i` flag —
`tenant:` and `svc:` do. So `x-jina-principal-id: user:HOLDER@EXAMPLE.COM` is accepted and
`USER:holder@example.com` is refused: the address is case-insensitive, the `user:` scheme is not. Both
are asserted, so the asymmetry is pinned rather than rediscovered.

The tenant comparison is not hand-rolled: it goes through `contextCredentialTenantId`
(`server.ts:1483-1487`), which is exactly the helper the access-sync and context branches use
(`server.ts:1405`, `1421`). An earlier draft wrote
`tenantHeader.trim().toLowerCase() !== principal.tenantId` by hand, which is a different comparison
from the one every other branch performs — and a token branch that validates identity differently
from the branches it sits beside is precisely the kind of divergence that produces a cross-tenant bug
nobody can find by reading one function.

The consequence: the tenant header is compared **case-sensitively** in fixed tenancy, because the
helper there is `value?.trim()` against `config.tenantId` with no lowercasing on either side. So
`x-jina-tenant-id: OMLABS` against a token whose tenant is `omlabs` is a 401. That is not a defect
introduced here — it is exactly what the context credential does today — but it does mean the header
assertions are case-insensitive for the principal and case-sensitive for the tenant, and the tests
below assert that asymmetry rather than a uniform rule that does not exist. Note that
`normalizedTenantId` is still deliberately _not_ used on this header: it is a
strict UUID check, while in fixed tenancy `config.tenantId` is a bare name — `JINA_TENANT_ID` is
wired from `JINA_FIXED_TENANT_ID` at `scripts/cloud-build-deploy.sh:198` and the value is `omlabs`
(`cloudbuild.yaml:136`) — so a UUID check would reject every legitimate assertion. Production
currently substitutes `_JINA_TENANCY_MODE: shared-db` (`cloudbuild.yaml:130`), so the fixed-mode case
is the one a self-hosted or development deployment hits rather than the deployed configuration; the
helper handles both, which is the reason to use it. The row is authoritative; the header only has to
agree with it.

It is worth being precise about what this rule continues, because the plan previously implied it was
universal. It is not. Of the four existing branches, only the two whose identity comes from
server-side config assert headers: access-sync (`server.ts:1399-1414`) and the context credential
(`server.ts:1415-1430`). The dev branch does no assertion at all, and the internal-credential
fallthrough at `server.ts:1431-1440` treats `x-jina-principal-id` as the _source_ of identity and, in
fixed mode, computes `requestedTenantId` at line 1431 and then discards it — a disagreeing tenant
header there is neither honoured nor rejected but silently ignored. The token branch adopts the
config-bound branches' rule; it does not continue a uniform one.

`Principal` (`apps/api/src/server.ts:144-148`) grows two optional fields:

```ts
interface Principal {
  readonly tenantId: string;
  readonly principalId: string;
  readonly forwarded: boolean;
  readonly scopes?: readonly ContextScope[];
  readonly tokenId?: string;
}
```

`exactOptionalPropertyTypes` is on (`tsconfig.base.json:8`), so the four existing return sites keep
working precisely because they omit the new keys rather than assigning `undefined`. Nothing may ever
write `scopes: undefined`. `forwarded: true` on the token branch is what lets a minted token pass
`requireBoundPrincipal` (`server.ts:1443`), which is applied to `/mcp` at line 381 and to every
`/context/` path at line 419.

The verifier closure lives inside `createApiServer`, beside the other dependency defaults at
`apps/api/src/server.ts:159-160`:

```ts
const API_TOKEN_USE_STAMP_MS = 60_000;

async function verifyApiToken(token: string): Promise<Principal | undefined> {
  if (!contextStore.verifyApiToken) return undefined;
  const secretHash = createHash("sha256").update(token, "utf8").digest("hex");
  let verified: VerifiedApiToken | undefined;
  try {
    verified = await contextStore.verifyApiToken(secretHash);
  } catch (error: unknown) {
    // Fail closed. A throw here is a database or role problem, not a credential
    // problem, and the only answer that cannot accidentally admit anybody is the
    // same 401 an unknown token gets. Without this the throw escapes into
    // `void routed.catch(...)` and the caller sees 500.
    logger.warn("api token verification failed", {
      event: "api.token.verify_failed",
      ...errorLogFields(error)
    });
    return undefined;
  }
  if (!verified) return undefined;
  stampApiTokenUse(verified);
  return {
    tenantId: verified.tenantId,
    principalId: verified.principalId,
    forwarded: true,
    scopes: verified.scopes.filter(isContextScope),
    tokenId: verified.tokenId
  };
}

function stampApiTokenUse(token: VerifiedApiToken): void {
  if (token.lastUsedAt && Date.now() - Date.parse(token.lastUsedAt) < API_TOKEN_USE_STAMP_MS) return;
  const stamped = contextStore.stampApiTokenUse?.(token.tenantId, token.tokenId, nowIso());
  if (!stamped) return;
  void stamped.catch((error: unknown) => {
    logger.warn("api token last-used stamp failed", {
      event: "api.token.stamp_failed",
      tokenId: token.tokenId,
      ...errorLogFields(error)
    });
  });
}
```

The stamp is coarsened to a minute and is not awaited. Without coarsening it is one `UPDATE` of a
single hot row per request — lock contention and WAL churn proportional to traffic, on a path that
must not be able to fail a request. Minute granularity is indistinguishable from exact in the list
phase 3 renders.

Every token failure — malformed prefix, unknown hash, expired, revoked, store not implementing the
methods — returns the identical `401 {"error":"unauthorized"}` with no code distinguishing them, so
the response never says which tokens exist or why one stopped working. A lookup that _throws_ is
caught by the `try` in the closure above, logged with a structured code, and returns `undefined`:
failing closed renders a database outage as a 401 for token holders, which is worse for them than a
500 but is the only answer that cannot accidentally admit anybody. That `try` is not decoration. The
verification read is the one place in the request path where a store call happens before any handler
has a try of its own, so without it the rejection propagates out of the async IIFE at
`server.ts:293-298` into `httpError` (`server.ts:2145`) and the caller gets
`500 {accepted:false, error:"internal server error"}` — which is what the Rollout section's two
migration-inversion failure modes, 42P01 and 42704, would actually produce.

The remaining timing difference — a shape-matched bearer costs a round trip where a malformed one
does not — is accepted. It distinguishes only "this string has the documented shape", which is
public, and the space behind it is 256 bits. Worth noting, and out of scope for this phase: the
static comparisons at `server.ts:1392`, `1395` and `1451` are plain `===` on the full
`Bearer <secret>` string, evaluated three times per request, which is a prefix oracle on
`INTERNAL_API_TOKEN` — and the repository already owns `timingSafeEqual` and uses it for the GitHub
webhook HMAC at `packages/github/src/webhooks.ts:98`. The hash lookup itself needs no constant-time
comparison, because it is an indexed equality on a digest.

## The call-site restructure

`authenticatedPrincipal` is called twice per request today: at `apps/api/src/server.ts:293`, inside
the synchronous `createServer` callback opened at line 268, where its result decides whether the
whole request runs inside `contextStore.runInTenantScope`; and again at `server.ts:365` inside
`route()`, which is the site that emits the 401. Both pass the same pathname (computed identically at
lines 272 and 318).

Two calls means two lookups, two `last_used_at` stamps, and — worse — two reads under _different_
database scopes, since the first has no ambient tenant scope and the second runs inside one. So the
principal is resolved exactly once and passed into `route()`.

Replace `apps/api/src/server.ts:293-297` with:

```ts
const routed = (async () => {
  const principal = await authenticatedPrincipal(request, config, pathname, verifyApiToken);
  return principal && principal.tenantId !== "*" && contextStore.runInTenantScope
    ? contextStore.runInTenantScope(principal.tenantId, () => route(request, response, principal))
    : route(request, response, principal);
})();
```

`routed` is still a Promise produced synchronously, so `void routed.catch(...)` at line 298 remains
the sole error-to-response path and now also covers a throw raised during verification. Without the
wrapping IIFE a throw at line 293 would escape as an unhandled exception on the HTTP server with no
response written at all.

`route`'s signature (`apps/api/src/server.ts:316`) becomes
`async function route(request: IncomingMessage, response: ServerResponse, principal: Principal | undefined): Promise<void>`,
and lines 365-369 collapse to the 401 check alone:

```ts
if (!principal) {
  json(response, 401, { error: "unauthorized" });
  return;
}
```

`hasInternalApiCredential` at line 370 is untouched.

## Scope enforcement

`isContextCredentialRoute(pathname, method)` (`apps/api/src/server.ts:1464-1474`) is replaced by
`requiredScope(pathname, method)`. It returns a scope or the explicit value `"internal-only"` — never
`undefined`. A lookup that returns `undefined` for a route it does not know is indistinguishable from
one returning `undefined` for a route that needs no scope, and the second reading would open
`/board`, `/overview`, `/events`, the `/internal/*` namespace and every route added after this
change. The map is exhaustive over the routes a token may reach; everything else, including the 404
fallback at line 854, is `internal-only` by construction, so a new route is closed to tokens until
somebody opens it deliberately.

```ts
type ContextScope = "context:query" | "context:read" | "context:build" | "context:admin";

const CONTEXT_SCOPES = ["context:query", "context:read", "context:build", "context:admin"] as const;

function isContextScope(value: string): value is ContextScope {
  return (CONTEXT_SCOPES as readonly string[]).includes(value);
}

function requiredScope(pathname: string, method: string): ContextScope | "internal-only" {
  if (method === "POST") {
    if (pathname === "/mcp" || pathname === "/context/query") return "context:query";
    if (pathname === "/context/build" || pathname === "/context/rebuild") return "context:build";
    if (pathname === "/context/erasure") return "context:admin";
    if (pathname.startsWith("/context/knowledge/") && pathname.endsWith("/review")) return "context:admin";
    return "internal-only";
  }
  if (method !== "GET") return "internal-only";
  if (pathname === "/context/metrics") return "context:admin";
  return pathname === "/context/structure" ||
    pathname === "/context/generations" ||
    pathname === "/context/documents" ||
    isSingleSegmentChildOf(pathname, "/context/generations") ||
    isSingleSegmentChildOf(pathname, "/context/documents")
    ? "context:read"
    : "internal-only";
}
```

Two route shapes the design doc's table flattens and this function has to reproduce exactly.
`/context/knowledge/{id}/review` is dispatched by prefix **and** suffix
(`apps/api/src/server.ts:606-610`), not as an exact path — `routeId`'s stricter id extraction happens
inside the handler at line 613. And `/mcp` is dispatched on pathname only (`server.ts:380`), with no
method check; the POST restriction lives in the old predicate and in
`apps/api/src/mcp.ts:162`, which returns 405. Keying the scope map on `(path, method)` is therefore a
_stricter_ gate than the dispatcher, which is the safe direction: a token cannot reach `GET /mcp` at
all rather than reaching it and getting a 405.

`isSingleSegmentChildOf` (`server.ts:1477-1481`) is kept as-is. It is what stops
`/context/documents/{id}/anything` and the knowledge-review path from matching `context:read`.

`CONTEXT_SCOPES` and `isContextScope` are shown here with the rest of the map because that is where
they belong on the page, but they land in commit 4, not commit 3. Their only consumer is
`verified.scopes.filter(isContextScope)` in the verifier closure, and `pnpm check` runs
`@typescript-eslint/no-unused-vars` at `error` with only an `^_` escape (`eslint.config.mjs`), so
landing them a commit early makes that commit red. Commit 3 lands `ContextScope`, `requiredScope` and
the derived `isContextCredentialRoute` — which is exactly the compatibility proof the ordering exists
for, and all of which have consumers the moment they land.

### The complete route inventory

The old predicate covered seven path/method pairs. The dispatcher serves thirty-odd. This is all of
them, so that "no scope" is a decision rather than an omission.

| Route                                   | Line | Scope           |
| --------------------------------------- | ---- | --------------- |
| `POST /context/query`                   | 457  | `context:query` |
| `/mcp` (POST only)                      | 380  | `context:query` |
| `GET /context/generations`              | 463  | `context:read`  |
| `GET /context/generations/{id}`         | 482  | `context:read`  |
| `GET /context/documents`                | 514  | `context:read`  |
| `GET /context/documents/{id}`           | 543  | `context:read`  |
| `GET /context/structure`                | 577  | `context:read`  |
| `POST /context/build`                   | 421  | `context:build` |
| `POST /context/rebuild`                 | 656  | `context:build` |
| `POST /context/erasure`                 | 667  | `context:admin` |
| `POST /context/knowledge/{id}/review`   | 606  | `context:admin` |
| `GET /context/metrics`                  | 601  | `context:admin` |
| `GET /board`                            | 698  | internal-only   |
| `GET /overview`                         | 702  | internal-only   |
| `GET /events`                           | 712  | internal-only   |
| `POST /internal/context/access/sync`    | 376  | internal-only   |
| `POST /internal/context/ingest`         | 724  | internal-only   |
| `POST /internal/context/derive/prepare` | 738  | internal-only   |
| `POST /internal/context/derive/commit`  | 757  | internal-only   |
| `POST /internal/context/index`          | 794  | internal-only   |
| `POST /internal/context/outbox/drain`   | 809  | internal-only   |
| `GET /internal/observability`           | 833  | internal-only   |
| `POST /internal/worker/claim`           | 837  | internal-only   |
| `POST /internal/worker/renew`           | 841  | internal-only   |
| `POST /internal/worker/release`         | 845  | internal-only   |
| `POST /internal/worker/complete`        | 849  | internal-only   |
| everything unmatched (404 fallback)     | 854  | internal-only   |

`/overview` and `/events` are named explicitly because "board routes" covers only `/board` by name,
and `apps/api/src/github-app.test.ts:957-959` pins the context token to 401 on `/overview`.

Six routes sit outside the scope model entirely, because they are handled before the auth gate at
line 365 and `authenticatedPrincipal` is never consulted for them: `OPTIONS *` (line 322),
`GET /health` and `GET /healthz` (326), `GET /task-types` (340), `POST /webhooks/github` (352, which
is authenticated by HMAC in `apps/api/src/routes/github-webhooks.ts` instead), and
`POST /dev/webhooks/github` (356, dev only).

### The static credential keeps exactly its reach

The union of the `context:query` and `context:read` rows is exactly the seven pairs today's predicate
admits, so the old function becomes a derived view of the new map and its behaviour is unchanged:

```ts
const CONTEXT_CREDENTIAL_SCOPES: readonly ContextScope[] = ["context:query", "context:read"];

function isContextCredentialRoute(pathname: string, method: string): boolean {
  const required = requiredScope(pathname, method);
  return required !== "internal-only" && CONTEXT_CREDENTIAL_SCOPES.includes(required);
}
```

Keeping this helper — rather than folding the static credential into the same post-auth check as
minted tokens — is what preserves its status codes. Today the route check is ANDed into the credential
match itself (`server.ts:1393-1397`), so an out-of-scope path makes `context` false, line 1398 returns
`undefined`, and `route()` emits 401. Route scope is part of _authentication_ for the static
credential: the server genuinely cannot distinguish "wrong token" from "right token, wrong route".
`apps/api/src/github-app.test.ts:970` asserts that 401 for nine method/path pairs, and it must not
change.

### Minted tokens get 403

A minted token authenticates successfully and is then refused on scope, which is a different fact
about the request and deserves a different code. 403 with a distinct code is also what lets a token
holder fix their own problem, where 401 would tell them to check a credential that is fine.

Add after the `/internal/` gate at `apps/api/src/server.ts:371-374`:

```ts
if (principal.scopes) {
  const required = requiredScope(url.pathname, request.method ?? "GET");
  if (required === "internal-only" || !principal.scopes.includes(required)) {
    throw new ApiError(403, "insufficient_scope", "token scope does not permit this route");
  }
}
```

Placing it after the `/internal/` gate is deliberate: a minted token on an `/internal/` path gets the
existing `401 internal credential required` from line 372, because it is not the internal bearer —
except `/internal/context/access/sync`, which line 371 explicitly exempts from that gate
(`… && url.pathname !== "/internal/context/access/sync"`) and which therefore falls through to the
scope check, draws `"internal-only"` from `requiredScope` and gets 403 `insufficient_scope`. That is
the only `/internal/` path where the two differ, and the difference is pinned by a test rather than
left to be rediscovered. Placing the check before the `/context/` handlers means the 404 fallback is
unreachable for a token — an unknown path is `internal-only` and yields 403, not 404. All three are
fail-closed.

Throwing rather than writing the response directly routes it through the catch at `server.ts:298`,
which renders `{ accepted: false, error, code }` like every other `ApiError`.

### Scope is not role, and both non-read rows are already administrator-only

`context:admin` grants the scope, not tenant administration. `requireTenantAdmin` still applies on
top. The correction to an earlier draft is that this is not a niche interaction affecting one row: it
covers _both_ non-read rows. `requireTenantAdmin` (`server.ts:1074`, throws 403) has exactly five
call sites — `server.ts:422` (`POST /context/build`, the first statement of the handler),
`server.ts:602` (`GET /context/metrics`), `server.ts:612` (knowledge review), `server.ts:657`
(`POST /context/rebuild`), `server.ts:668` (`POST /context/erasure`). That is the whole
`context:build` row and the whole `context:admin` row: five of the twelve mapped routes.

And `isTenantAdmin` (`server.ts:1066-1072`) is a pure string test on the principal id plus static
config. No membership table, no scope, no token. So a token whose principal is not an administrator
reaches those five routes and is refused; a token whose principal _is_ one is an administrator
everywhere it reaches, whatever its scopes say. That makes mint's principal check, not its scope
check, the privilege boundary of this phase.

## Endpoints

Three, all internal-credential only in this phase, inheriting the `/internal/` gate at
`apps/api/src/server.ts:371` for free. Insert the handlers immediately after the access-sync branch
that ends at `server.ts:379`, before the `/mcp` branch, so credential management sits with
authentication rather than among the context routes. The handler shape follows
`synchronizeRepositoryAccess` (`server.ts:928-952`) and the erasure handler (`server.ts:667-696`):
hand-written validators, `ApiError` for every refusal, `json(response, status, payload)` to reply.
There is no zod on the HTTP path — the only zod import in the repository is `apps/api/src/mcp.ts:9`,
for MCP tool schemas.

- `POST /internal/context/tokens` — mint. Body: `principalId`, `name`, `scopes`,
  `expiresInMinutes`, and optionally `administrator: true`. Responds `201`
  with the secret **once**, plus the row minus its hash, and `cache-control: no-store`. The body is
  `{ secret, token: { id, name, scopes, principalId, createdAt, expiresAt } }` — named here rather
  than left inferable from the tests, because two implementers reading "the row minus its hash" will
  not choose the same keys.
- `GET /internal/context/tokens` — list for a tenant, non-revoked and non-expired by default,
  paginated through the existing `paginateByCreatedAt` helper (`server.ts:2057`), which returns
  `{ items, nextCursor? }`; the envelope is `{ tokens, nextCursor? }`, with each entry the same
  object mint returns under `token` plus `lastUsedAt`. Never returns a secret or a hash.
- `POST /internal/context/tokens/{id}/revoke` — revoke. Idempotent: revoking an already-revoked token
  is `200` and reports the _original_ revoker. An id belonging to another tenant is `404`, not an
  idempotent `200`, which would confirm its existence.

All three take their tenant from the same two sources, described below for mint: `x-jina-tenant-id`
in shared-db mode and `config.tenantId` in fixed mode. `created_by` stores
`normalizedForwardedPrincipal(x-jina-principal-id)`, falling back to `"svc:api"` — the same value the
internal-credential branch computes at `server.ts:1440` — so an audit reads either the person v1
forwarded or the plain fact that nobody was named. `revoked_by` is the same value at revocation time.

`cache-control: no-store` needs a mechanism, because `json` (`server.ts:2102-2106`) does
`response.writeHead(statusCode, JSON_HEADERS)` and takes no headers argument. The mint handler calls
`response.setHeader("cache-control", "no-store")` before `json(response, 201, …)`; `writeHead` merges
headers already set on the response rather than discarding them, so this needs no change to `json`.

Revocation is a POST rather than `DELETE /internal/context/tokens/{id}` because no handler in this
server dispatches on DELETE, and `JSON_HEADERS` (`server.ts:2048-2055`) advertises
`access-control-allow-methods: "GET, POST, OPTIONS"`, so a DELETE would fail the browser preflight
phase 3 needs. Using POST costs nothing and changes no CORS header.

The secret is accepted only in the `Authorization` header. There is no query-parameter fallback,
ever: query strings are recorded by load balancers and by this server's own request log
(`server.ts:278-289`). No error body echoes any part of a presented or generated secret — `ApiError`
messages are exposed to the caller (`server.ts:2145`), so a mint failure names the field, never the
value.

### Where mint's tenant comes from

The earlier draft said mint takes the tenant "from the calling credential's binding, never from the
body, for the same reason the access-sync route does." That describes nothing that exists. The
internal credential has no tenant binding: `server.ts:1431-1435` takes the tenant from
`x-jina-tenant-id` in shared-db mode and from the process-wide `config.tenantId` in fixed mode, and
`ApiServerConfig` (`server.ts:80-98`) has no per-credential tenant field for `internalApiToken`. And
access-sync is not the precedent claimed: its branch (`server.ts:1399-1414`) does not consult the
internal credential for identity at all — it reads `config.contextApiTenantId` and
`config.contextApiPrincipalId`, the _context_ credential's static pair, which names one tenant and
one principal for the whole process. Copying it literally would pin mint to one tenant per
deployment, which cannot deliver phase 4.

So: mint takes the tenant from `x-jina-tenant-id`, validated by `normalizedTenantId`, in shared-db
mode, and from `config.tenantId` in fixed mode — the same two sources every other internal route
uses. That is caller-selected, and saying so plainly is better than implying a binding that is not
there. What makes it acceptable is that `INTERNAL_API_TOKEN` can already act for any tenant on every
other route, so mint grants it no new reach; the new risk is that it can now issue a _durable_
credential, and the compensating controls are the principal refusals below, `created_by` recording the
minting identity, and the `/internal/` gate ensuring a minted token can never itself mint. That last
one is asserted by a test rather than left as a property of the gate's current shape.

In phase 3, v1 supplies the tenant and principal from its session and this endpoint remains the
enforcement point. v1's discipline is not the control.

### What mint refuses

This is the privilege boundary. `isTenantAdmin` is a string test, and a minted token's principal comes
from a database row rather than from a header, so it bypasses `normalizedForwardedPrincipal` — the
only filter that stands between a caller and administrator status today. Without explicit refusals, a
minter could issue a token with `scopes: ["context:read"]` and `principal_id: "tenant:<tenantId>"`,
and that token would be a tenant administrator on every route it reaches: unfiltered
`permittedRepositories` (`server.ts:1043`), no document filter (`server.ts:524`, `550`),
`requireRepositoryAccess` returning immediately (`server.ts:1049`), an unfiltered board
(`server.ts:1034`). The rule is load-bearing in shipped code — `apps/admin/lib/jina-api.ts:124`
constructs `tenant:${tenantId}` precisely to authenticate as the tenant administrator.

```ts
function refusedTokenPrincipal(
  principalId: string,
  administrator: boolean,
  config: ApiServerConfig
): string | undefined {
  const normalized = normalizedForwardedPrincipal(principalId);
  if (!normalized) return "principal must be a recognisable user, tenant or service principal";
  if (normalized.startsWith("tenant:")) {
    return "a tenant principal confers tenant administration and cannot be issued as a token";
  }
  if (normalized.startsWith("svc:")) {
    return "a service principal names no accountable person and cannot be issued as a token";
  }
  const admins = (config.tenantAdminPrincipalIds ?? []).map((id) => id.trim().toLowerCase());
  if (admins.includes(normalized) && !administrator) {
    return "this principal is a tenant administrator; pass administrator: true to issue it deliberately";
  }
  return undefined;
}
```

All four refusals are in the function, and each one is load-bearing. Refused outright: anything that
does not survive `normalizedForwardedPrincipal` (`server.ts:1865-1871`), which is checked _first_ so
that every test after it runs on the normalized string rather than on raw body input — otherwise
`TENANT:…` or a leading space walks past a `startsWith` test; any `tenant:` principal, for any
tenant, because `tenant:<tenantId>` confers administration by construction and cannot be
de-privileged without changing the tenant; any `svc:` principal, because it names nobody and becomes
an administrator whenever `enableDevEndpoints` is true; and any principal in
`config.tenantAdminPrincipalIds` unless the body says `administrator: true`. The value written to
`principal_id` is `normalized`, never the raw body field, because `isTenantAdmin` compares by exact
string equality.

The fourth refusal is the one an earlier draft stated in prose and omitted from the code, and its
absence is a live escalation rather than a documentation gap. `isTenantAdmin` (`server.ts:1066-1072`)
returns true for `principalId === "tenant:" + tenantId`, for membership of
`config.tenantAdminPrincipalIds`, and — with dev endpoints on — for any `svc:` prefix. Production
sets `JINA_TENANT_ADMIN_PRINCIPALS=user:keon@omlabs.xyz` (`scripts/cloud-build-deploy.sh:198`), so a
mint for that principal with no `administrator: true` in the body yields a tenant-administrator token
that two prefix tests wave through.

Note also what the `tenant:` refusal is and is not guarding. `normalizedForwardedPrincipal`'s tenant
pattern is `/^tenant:[0-9a-f-]{36}$/i`, so in fixed tenancy — where `config.tenantId` is a bare name
such as `omlabs` — the string `tenant:omlabs` fails normalization and is refused by the first rule,
not the second. The `tenant:` rule bites in shared-db mode, where tenant ids are UUIDs and
`tenant:<uuid>` normalizes cleanly. Both paths refuse; they refuse for different reasons, and
checking normalization first is what makes that true rather than accidental.

A `user:` principal that appears in `config.tenantAdminPrincipalIds` is issuable, but only when the
body carries `administrator: true`, so it is never accidental. Such a token may carry `context:build`
and `context:admin`; any other principal may carry only `context:query` and `context:read`, because a
token carrying the other two would be issued dead against `requireTenantAdmin`.

The `.trim()` and `.toLowerCase()` applied to the admin list make mint's refusal deliberately wider
than the privilege it guards, and the direction is the point. `tenantAdminPrincipalIds` is raw trimmed
env with no lowercasing (`apps/api/src/dev-server.ts:67`, `147-152`), while every principal that
reaches `isTenantAdmin` has been through `normalizedForwardedPrincipal` and is lowercase. So a
mixed-case entry such as `User:Keon@Omlabs.xyz` never matches at `server.ts:1070` and confers no
administration at all — meaning mint, comparing lowercased, refuses a principal that is not in fact an
administrator. That over-refusal is the safe direction and is chosen on purpose: refusing a principal
that turns out to be ordinary costs somebody a clearer error message, while under-refusing issues an
administrator token by accident. It also means the refusal keeps working on the day somebody corrects
the env entry to lowercase and it starts conferring administration for real.

There is no "scopes may not exceed the minter's" rule in this phase. The minter is a shared secret
with no scopes at all — that is the compatibility promise — and comparing against an absent set is a
coin flip rather than a constraint. Delegation bounded by the caller's own scopes arrives in phase 3,
where the caller is a session, and it is enforced at this endpoint rather than only in v1's interface.

`expiresInMinutes` is bounded 5 to 525,600. Day granularity was the earlier draft's choice and it is
wrong for phase 4, which needs a short-lived delegated token per tenant and would otherwise be stuck
with a one-day floor — a fleet of day-long bearer tokens held in a web tier's memory, which is
materially larger exposure than "revoke this leaked token now" implies. Day-shaped choices are
phase 3's presentation; the wire field is minutes so a person-issued token and a machine delegation
are the same object with different lifetimes. Changing this later would be a change to a shipped
request body, which is exactly the signal this plan says means phase 1 got the shape wrong.

## Wiring

None of this is reachable without four small edits that are easy to leave out.

`ApiServerConfig` needs no new field: the token store rides on `contextStore`, which is already
threaded through `createApiServer` and `dev-server.ts` and already defaults to
`MemoryContextEngineStore` (`server.ts:160`). That is the reason for putting the methods on
`ContextEngineStore` rather than inventing a second injection point — every one of the roughly nine
`createApiServer` call sites in `apps/api/src/github-app.test.ts` keeps working with no edit, and
`createContextStore` (`apps/api/src/dev-server.ts:110-114`) already returns Postgres-or-memory.

What does need adding: the `jina_atk_` prefix assertion on the two static tokens in `createApiServer`;
`"/internal/context/tokens"` in `METRICS_ROUTES` (`server.ts:1873-1902`) and a fourth case in
`metricsRoute` (`server.ts:1904-1909`) using
`routeId(pathname, "/internal/context/tokens/", "/revoke")`, or the routes are labelled `(unknown)`
and their real path is suppressed from the request log at line 282 — which would leave phase 4's
"measured disuse" with nothing to measure; and mint/revoke/verify-failure counters on the existing
`MetricsRegistry`, which is the raw material for the same step.

No new dependency: hashing is `createHash` and `randomBytes` from `node:crypto`, and `server.ts`
already imports `createHash` at line 1. That keeps `pnpm audit --prod --audit-level=high`
(`scripts/cloud-build-ci.sh`) green.

## Commits

Six, each individually green under `pnpm check`. The ordering matters for one reason beyond
reviewability: commit 3 lands the scope map with no token path at all, which is the cheapest possible
proof that the compatibility promise holds — if `github-app.test.ts` needs editing there, the promise
was already broken before any token code existed.

1. **Schema, role, grants, policies.** `packages/db/src/context/schema.ts` (table DDL, indexes),
   `packages/db/src/context/roles.ts` (`CONTEXT_ROLES`, `tenantScopedTables`, grants, verify policy),
   `packages/db/src/context.integration.test.ts` (RLS assertions), `docs/DATA_MODELS.md` (the
   capability-role list at lines 204-208 enumerates all fifteen by name; this makes sixteen).
   Proven by raw-SQL assertions, not by the repository-level integration test below, which is written
   against methods commit 2 introduces and cannot exist yet. Concretely: insert two rows for two
   tenants with
   `queryAs("jina_context_tokens", contextTenantScope(tenantId), "insert into jina_context.api_tokens …")`,
   then read at `contextSystemScope` and assert that live rows for both tenants are visible while a
   revoked one and an expired one are not, plus the `jina_context_query` permission-denied assertion
   and the `jina_context_tenant_admin`-at-system-scope zero-rows assertion. The policy is the thing
   this phase must not get wrong, so it does not go a commit unasserted. Commit 2 then adds the
   repository-level assertions on top. No exports, so nothing for knip to complain about.
2. **Token repository.** New `packages/db/src/context/api-token-repository.ts`, delegation in
   `packages/db/src/context/store.ts`, re-export from `packages/db/src/index.ts`, the five optional
   methods and three interfaces in
   `packages/context-engine/src/ports/context-engine-store.ts`, the memory implementation in
   `packages/context-engine/src/memory/store.ts`. Proven by the repository-level integration test
   below plus memory-store unit assertions. knip is satisfied because the exports are consumed by
   `packages/db/src/**/*.test.ts`, which `knip.json` lists as an entry point.
3. **`requiredScope`, static mapping only.** `apps/api/src/server.ts`: replace
   `isContextCredentialRoute`'s body with the derived view, add `requiredScope` and `ContextScope`.
   No `CONTEXT_SCOPES`, no `isContextScope`, no token branch, no `Principal` change — those two
   symbols have no consumer until commit 4's verifier closure filters with them, and
   `@typescript-eslint/no-unused-vars` is `error` with only an `^_` escape (`eslint.config.mjs`), so
   landing them here makes `pnpm lint` — and therefore `pnpm check` — fail. Proven by
   `apps/api/src/github-app.test.ts` passing untouched.
4. **Verification.** `apps/api/src/server.ts`: `CONTEXT_SCOPES` and `isContextScope` alongside the
   verifier closure that consumes them, async `authenticatedPrincipal` with the token branch first,
   `assertedIdentity`, the `Principal` fields, the entry-point restructure at 293-298, the `route()`
   signature, the `insufficient_scope` check, the verifier and stamp closures, the prefix assertion.
   Proven by the new `apps/api/src/api-tokens.test.ts`.
5. **Endpoints.** `apps/api/src/server.ts`: the three handlers, `refusedTokenPrincipal` — which reads
   `config.tenantAdminPrincipalIds` and therefore genuinely consumes its `config` parameter, the same
   lint rule being the reason that matters — mint validation, `METRICS_ROUTES` and `metricsRoute`.
   Proven by the mint/list/revoke tests in the same file.
6. **Documentation.** `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `README.md`, `.env.example`,
   `docs/API_TOKENS.md`. See Rollout for the five substantive `API_TOKENS.md` corrections, which are
   not optional: the design doc currently contradicts this plan in five places.

## Tests

The failure modes here are silent by nature — a token that authorises slightly too much does not
announce itself — so the tests assert refusals as specifically as grants.

New file `apps/api/src/api-tokens.test.ts`. It must sit **directly** in `apps/api/src/`: the test
script is `node --test dist/*.test.js` (`apps/api/package.json:9`), a top-level non-recursive glob, so
a test under `apps/api/src/routes/` — a directory that already exists — compiles to
`dist/routes/…` and is silently never run, with no error and a green CI.

Every test in it constructs its own server with `enableDevEndpoints: false`, following
`github-app.test.ts:829` and `:878`. The main harness at `github-app.test.ts:33` sets
`enableDevEndpoints: true`, where the dev branch returns before any bearer is read, so a token test
written against it would pass while executing none of the verification path.

- **Verify.** `assert.equal((await get("/context/generations", withToken)).status, 200)` and the
  response's generations belong to the token's tenant; an expired token, a revoked one, an unknown
  hash and a malformed prefix each `assert.equal(response.status, 401)` with an identical body.
- **Header assertions.** A token plus a disagreeing `x-jina-tenant-id` is 401; a token plus a
  disagreeing `x-jina-principal-id` is 401; a token plus matching headers is not 401; a token plus a
  matching `x-jina-principal-id` in a different case is not 401, because
  `normalizedForwardedPrincipal` lowercases both sides; and — on a fixed-tenancy server — a token
  plus a matching `x-jina-tenant-id` in a different case **is** 401, because
  `contextCredentialTenantId` does not. That last assertion looks like it is testing a bug. It is
  pinning the deliberate decision to compare tenants exactly as the context credential already does,
  so that a later change making the token branch case-insensitive has to break a test rather than
  drift silently. This is the cross-tenant guard and deserves the most explicit treatment in the set.
- **Scope.** For each scope, one route it reaches and one it does not, asserting the code and not just
  the status: a `context:read` token on `POST /context/build` is
  `assert.equal(body.code, "insufficient_scope")` with status 403; a `context:query` token on
  `GET /context/generations` is 403; a `context:read` token on `GET /board` is 403; a `context:read`
  token on `POST /internal/context/tokens` is 401 with `error: "internal credential required"`,
  proving a minted token cannot mint; and a `context:read` token on
  `POST /internal/context/access/sync` is 403 `insufficient_scope`, not 401, because line 371 exempts
  that one path from the internal gate. Both `/internal/` bullets are here so the divergence is
  pinned rather than discovered.
- **Scope is not role.** A token carrying `context:admin` for an ordinary `user:` principal — minted
  directly through the store to bypass mint's refusal — gets 403 `forbidden` from `requireTenantAdmin`
  on `GET /context/metrics`, not `insufficient_scope`.
- **Mint refuses escalation.** `assert.equal(mint({ principalId: "tenant:" + tenantId }).status, 400)`,
  asserted directly rather than inferred from a scope test, because the escalation needs no admin
  scope to work. Same for a `svc:` principal, for a malformed principal, for an unknown scope, for
  `expiresInMinutes` of 4 and of 525,601, and for `context:admin` requested without
  `administrator: true`. And, separately named because it is the refusal an earlier draft's code
  omitted: a mint naming an entry of `config.tenantAdminPrincipalIds` without `administrator: true`
  is 400. Assert it twice, once with the configured entry lowercase and once with it mixed case — the
  second case is the deliberate over-refusal described above, where mint declines a principal that
  `isTenantAdmin` would not actually have accepted, and it is asserted so that nobody later "fixes"
  the lower-casing away.
- **Mint response.** The secret appears in the 201 body and matches `^jina_atk_[A-Za-z0-9_-]{43}$`;
  the same token id fetched through `GET /internal/context/tokens` has no `secret` and no
  `secretHash` key at all (`assert.equal("secretHash" in row, false)`). Two identical mint requests
  produce two distinct token ids and two distinct secrets, which pins the deliberate absence of
  idempotency rather than leaving it to be read as an oversight.
- **Store failure.** A request presenting `INTERNAL_API_TOKEN` and a request presenting
  `CONTEXT_API_TOKEN` both still succeed against a server whose `contextStore.verifyApiToken` rejects
  on every call; a request presenting a `jina_atk_` bearer against that same server is 401, not 500.
  This is the actual assertion behind the compatibility promise and behind the Rollout section's
  treatment of the two migration-inversion failure modes, so it is a named test rather than an
  inference from the `try` in the verifier closure.
- **Revoke.** Revoking then presenting the token is 401 on the next request; revoking twice is 200
  both times and the second response's `revokedBy` equals the first's; revoking an id minted for
  another tenant is 404.
- **Regression.** `apps/api/src/github-app.test.ts` is not edited. If it needs editing, the
  compatibility promise has been broken. Its two 401 tests assert different things and both must
  survive: the test at line 875 asserts nine out-of-scope pairs are 401 for the static credential
  (assertion at line 970) and the widened reads are not 401 (line 947); the test at line 826 asserts
  401 on six read paths, but its cause is that `protectedServer` at line 829 omits
  `contextApiTenantId`/`contextApiPrincipalId` so the credential cannot bind at all — it is not a
  scope assertion and a scope map alone would not preserve it.

In `packages/db/src/context.integration.test.ts`, appended inside the runtime-login harness rather
than in a new file. A second integration file would need its own
`drop schema if exists jina_context cascade`, and `node --test` runs files in parallel, so it would
race the existing one; the harness there already has a live `jina_context_runtime_test` NOINHERIT
login and a built schema. Placement inside that harness is exact: after the cross-tenant assertion at
line 1930 and before `runtimeStore.close()` at line 1931, which is followed by
`revoke … from jina_context_runtime_test` at 1932 and `drop role` at 1933. Assertions appended at the
end of the block instead would run against a closed store and a dropped login and fail with a
role-does-not-exist error. The handle to use is `runtimeDatabase`, constructed at line 1906, because
it is the `ContextDatabase` bound to the runtime login.

- **RLS.** Insert two tokens for two tenants through the repository. Then, as the runtime login:
  `verifyApiToken` at system scope resolves each hash to its own tenant
  (`assert.equal(verified?.tenantId, tenantId)`); `listApiTokens(tenantId)` returns only that tenant's
  row (`assert.equal(rows.length, 1)`); a raw
  `queryAs("jina_context_query", { tenantIds: [tenantId] }, "select 1 from jina_context.api_tokens")`
  rejects with `/permission denied/`; and a raw
  `queryAs("jina_context_tenant_admin", contextSystemScope, "select count(*) from jina_context.api_tokens")`
  returns zero. The two together are what the containment claim rests on: the first proves roles
  outside the blanket grant cannot read at all, the second proves the blanket grant reads nothing at
  system scope.
- **Liveness is enforced in SQL.** A row whose `expires_at` is in the past and a row with `revoked_at`
  set are both invisible to `verifyApiToken` even at system scope, so the policy and the query agree.
- **Append-only trigger absence.** `stampApiTokenUse` and `revokeApiToken` both succeed, which fails
  loudly with SQLSTATE 55000 if somebody adds the table to the trigger array.

The apps/api tests run against `MemoryContextEngineStore` and prove nothing about RLS; there is no
PostgreSQL-backed test anywhere in `apps/api`. RLS is exercised only in `packages/db`, and only when
`TEST_DATABASE_URL` is set — absent it, `{ skip: !databaseUrl }` makes the test silently skip rather
than fail. CI supplies it: `cloudbuild.ci.yaml` starts `postgres:16-alpine` and the `test` task's
`"env": ["TEST_DATABASE_URL"]` at `turbo.json:17` passes that one variable through.

## What must not break

The static tokens keep working — that is the whole compatibility strategy, and it is what lets this
ship before anything migrates onto it. Concretely: `INTERNAL_API_TOKEN` keeps full reach,
`CONTEXT_API_TOKEN` keeps query plus the read projections and its 401 on everything else, and neither
acquires a `scopes` field.

"Unchanged" is the wrong word for the code, though, and the distinction is worth naming because it is
where a regression would hide. Their _outcomes_ are unchanged; the function they run through is
rewritten. `authenticatedPrincipal` becomes async, gains a parameter, and gains a branch ahead of
every existing one; `route()` gains a parameter; the request entry point is restructured. Two things
protect the static path through all of that: the `jina_atk_` shape gate is unconditionally first and
total, so a static-token request never reaches the database; and `isContextCredentialRoute` survives
as a derived view of `requiredScope`, so its seven pairs and its 401 are computed the same way they
were. The test that a static-token request still succeeds when the token store throws on every call is
the actual assertion behind the promise; it is the **Store failure** bullet in the list above, and the
`try` in the verifier closure is what makes it pass.

The existing repository filtering is reused rather than reimplemented. `permittedRepositories`
(`server.ts:1042`) and `allowedKnowledgeRevisionIds` (`server.ts:1053`) already narrow reads by
principal, so a non-administrator token sees exactly what its principal's ACL allows with no new
authorisation logic. Two corrections to how that was previously stated. The administrator bypass is
not in both helpers: `permittedRepositories` opens with one (`server.ts:1043`), but
`allowedKnowledgeRevisionIds` contains no reference to `isTenantAdmin` at all — its two call sites do,
at `server.ts:524` and `server.ts:550` — so the administrator short-circuit for knowledge documents
lives in the document routes rather than in the helper. Either way the narrowing sentence is true only
for principals that are not administrators, and whether a principal is one is decided by the string in
the token row, which is why mint's refusals carry the weight they do. And
`allowedKnowledgeRevisionIds` has exactly two call sites, `server.ts:525`
and `:551`, both on `/context/documents`; `/context/query` and `/mcp` use `permittedRepositories` at
`server.ts:959` plus `StoreScopeAuthorizer` inside the engine, which calls `repositoriesForPrincipal`
directly with no administrator bypass at all.

That last point has a consequence for the rollout below.

## Rollout

Additive throughout: nothing in this phase changes the behaviour of a caller that does not present a
`jina_atk_` token.

1. **Schema and role**, through the existing migration path. There are no numbered migration files;
   `CONTEXT_SCHEMA_SQL` and `CONTEXT_ROLES_SQL` are idempotent DDL applied under an advisory lock in
   one transaction by `applySchema` (`packages/db/src/apply-schema.ts:10`). Production ordering is
   already safe and needs no new step: `scripts/cloud-build-deploy.sh:794-811` deploys and executes
   the `jina-context-migrate` job with `--install-roles --wait` from the _same image_ before
   `gcloud run deploy jina-api` at line 825, so schema and role always precede code.
2. **Verification and scope map**, with the static tokens still accepted (commits 3 and 4).
3. **Endpoints** (commit 5).
4. **Grant the token's principal repository access, then mint and read.** This step is bigger than it
   looks and it is the reason it is listed rather than assumed. Repository ACL rows live in
   `jina_context.repository_acl_observations`, surfaced by the `current_repository_acl` view
   (`packages/db/src/context/schema.ts:1165`), and the only writer path is
   `mergeRepositoryAccess`/`replaceRepositoryAccess`, reachable solely from
   `POST /internal/context/access/sync` (`server.ts:376` into `synchronizeRepositoryAccess` at 928),
   which derives its identity from `config.contextApiPrincipalId` and can therefore only ever grant
   access to that one principal. A token minted for a fresh `user:` principal has
   `permittedRepositories` of `[]`, so `GET /context/generations` returns `{generations: []}`,
   `/context/structure` and the by-id routes 404, and `POST /context/query` 404s at `server.ts:960`.
   So phase 1's acceptance is: mint a token for `config.contextApiPrincipalId` — the one principal
   that already has ACL rows — and confirm the context page reads with it. That proves verification,
   scope, header assertion and the tenant coming from the row. It does _not_ prove the multi-tenant
   case, which needs access-sync widened to act for a named principal. That widening is phase 4's
   first prerequisite and is called out there.

Two failure modes worth stating, because both surface as an uncaught throw rather than a clean 401 or
500, and neither is caught by a health check. Code before schema cannot happen in production but
happens locally and in CI whenever the API runs with `JINA_DB_MANAGE_SCHEMA=false` against an
unmigrated database: every `jina_atk_` verification raises 42P01. Schema before role is the realistic
one — `pnpm migrate` without `--install-roles` applies the schema unconditionally
(`migrate.ts:21`) and skips roles, leaving the table with no grants, no policy and no role, so
`set local role jina_context_tokens` fails 42704. The verifier's catch-and-return-`undefined`
converts both into a 401 for token holders while leaving static credentials working, which is the
least-bad behaviour available; the log line is how an operator finds it.

Role membership itself is safe to add live. PostgreSQL reads membership from the catalog at
`SET ROLE`, so pooled connections opened before the grant can activate the new role without draining.

Documentation to update in commit 6, three items of which are already stale today and would mislead an
implementer building the static mapping: `.env.example:7` and `README.md:146` and
`docs/ARCHITECTURE.md:346` all still describe the pre-widening reach ("only `POST /context/query` and
`POST /mcp`"), which commit 7da49c4 changed and only `docs/DEPLOYMENT.md:70-78` reflects. Beyond
fixing those: add the token shape, prefix and mint endpoint to `docs/DEPLOYMENT.md`; and add
`jina_context_tokens` to the capability-role list at `docs/DATA_MODELS.md:204-208` and the table to
that document.

`docs/API_TOKENS.md` needs more than its status line. Updating `:3-5`, which currently says nothing is
implemented beyond phase 0, is necessary but not sufficient: this plan overturns the design doc in
five substantive places, and a reader who opens it after the plan lands gets the refuted version of
all five. Each is a named sub-item of commit 6 so the commit is checkable:

1. `API_TOKENS.md:60-61` — "Scopes granted may not exceed the scopes of the identity requesting them."
   Strike it and replace with the phase-1/phase-3 split: phase 1 has no such rule because its only
   minter is a shared secret with no scopes, and the bound arrives in phase 3 where the caller is a
   session.
2. `API_TOKENS.md:43-46` — presents header-assertion as an already-universal rule. Qualify it to the
   config-bound branches: two of the four existing branches assert headers, the dev branch asserts
   nothing, and the internal-credential fallthrough treats the principal header as its source of
   identity.
3. `API_TOKENS.md:94-95` — "The worker already knows the derivation's model consumption, so build cost
   can be recorded rather than estimated." Delete it; phase 2 below refutes it end to end.
4. `API_TOKENS.md:90` — meters `build, rebuild` at one weighted rate. Split the row: rebuild runs no
   sandbox, no worker and no model.
5. `API_TOKENS.md:101-103` — puts `GET /context/usage` under "Same authorization rule as everything
   else". Give it its own `context:usage` scope in the scope table, for the reason phase 2 states.

## Out of scope

Usage records and metering, `GET /context/usage`, quota enforcement, the dashboard issuance interface,
and retiring the static context token. Phases 2 through 4.

Also deliberately excluded: caching verification lookups. It is an obvious optimisation and an easy
source of a stale-revocation bug, so it waits for evidence that a single indexed read per request is
actually a problem. And moving the static-token comparisons to `timingSafeEqual` — a real weakness,
noted above, but a separate change that should not ride in on a feature branch.

# Phase 2: usage attributed to a token

Record what each token spends, cover builds as well as queries, and let Jina v1 meter it as credits.

## What exists already

Query telemetry, and less of the rest than an earlier draft claimed. `QueryRunTelemetry`
(`packages/context-engine/src/ports/context-engine-store.ts:21-67`) records `tenantId`, `repository`,
`principalFingerprint`, `taskKind`, `routes`, `durationMs` and the citation and conflict counts for
every query, written by `recordQueryRun`. All seven reach the database
(`packages/db/src/context/query-repository.ts:537-560` into `jina_context.query_runs`,
`packages/db/src/context/schema.ts:1085-1106`).

Two things to know before building on it. The interface has eighteen top-level fields, three of them
nested arrays that `recordQueryRun` fans out into `retrieval_candidates`, `answer_citations` and
`retrieval_metrics` — anything added to that type is not a one-table change. And
`citationFailureCount` is not a count: `apps/api/src/server.ts:977` sets it by string-prefix match on
the answer text, so it is a 0/1 flag with a count's name, and the existing `sum()` in the metrics
aggregate counts affected queries rather than citations.

v1's side of this — Autumn, `jina_credits`, plan allowances, `infra_credits_per_run` — is
unverifiable from this repository. See the section at the top. The v2 half below is self-contained and
buildable regardless.

## The four gaps

1. **`principalFingerprint` is hashed.** Right for analytics, useless for billing or for showing
   someone their own usage, because it cannot be joined back to a person. A resolvable principal
   reference is needed alongside it — not instead of it. Note also that it is write-only today: it
   appears only in the DDL at `schema.ts:1089` and two INSERT column lists
   (`query-repository.ts:489`, `:538`), and nothing has ever selected it. And it is an unsalted plain
   SHA-256 over `{tenantId, principalId}` (`packages/context-engine/src/domain/fingerprint.ts:22`), so
   it is not a strong anonymisation guarantee against a known principal set.
2. **Metrics aggregate per tenant only.** `PostgresContextQueryRepository.metrics(tenantId)`
   (`packages/db/src/context/query-repository.ts:631-656`), surfaced as `queryMetrics` on the store
   port (`packages/context-engine/src/ports/context-engine-store.ts:105`), is a single aggregate with
   no `GROUP BY` and no principal predicate, and the only index on `query_runs` is
   `(tenant_id, repository, started_at desc)` (`schema.ts:1106`), so even an ad-hoc per-principal
   rollup is a scan.
3. **Builds are recorded but cannot be attributed or costed.** `pipeline_builds`
   (`packages/db/src/context/schema.ts:34-49`) persists status and timing per build and
   `pipeline_stages` persists per-stage timing, so wall-clock is already derivable. What is missing is
   any actor: the table has no requester column and `createBuild`'s input
   (`packages/context-engine/src/workflow/coordinator.ts:47-55`) does not accept one — the principal
   is in scope at `apps/api/src/server.ts:445` and discarded.
4. **There is no token dimension**, so a leaked or runaway token cannot be identified and revoked on
   its own evidence.

Phase 1 closes the fourth by putting `tokenId` on the principal. The rest is one table plus the two
contract changes below.

## Data model

```
jina_context.usage_records
  id            text        not null        -- 'use_<uuid>'
  tenant_id     text        not null
  principal_id  text        not null
  token_id      text                        -- null for the static credentials
  operation     text        not null        -- query | mcp | build | rebuild | read
  repository    text
  credits       numeric     not null        -- 0 for reads
  occurred_at   timestamptz not null
  reference_id  text                        -- trace id, build id: what to look at
  primary key (tenant_id, id)
```

Indexed on `(tenant_id, occurred_at desc)` for the tenant rollup and
`(tenant_id, token_id, occurred_at desc)` for the per-token view phase 3 renders. Registered in
`tenantScopedTables` so the standard policy applies, and given **no** bespoke cross-tenant policy:
nothing about usage needs to be read before the tenant is known, so it does not inherit `api_tokens`'
exception.

These rows carry a resolvable principal beside the existing hashed fingerprint, which is a deliberate
de-anonymisation of query telemetry — `reference_id` points at a trace id that joins to `query_runs`.
That is the point, and it is worth writing down rather than arriving at by accident.

| Operation      | Meter                     | Rationale                                            |
| -------------- | ------------------------- | ---------------------------------------------------- |
| `build`        | credits, weighted         | sandbox plus agentic derivation, the dominant cost   |
| `rebuild`      | credits, light            | inline reindex of an existing checkpoint; no sandbox |
| `query`, `mcp` | credits                   | retrieval and, when enabled, synthesis               |
| reads          | count only, `credits = 0` | cheap; for rate limiting rather than billing         |

`rebuild` is separated from `build` because they are not the same operation. `POST /context/rebuild`
(`apps/api/src/server.ts:656-665`) creates no build and no pipeline: it runs
`IndexContextService.index` inline on the latest checkpoint and returns 202. No sandbox, no worker, no
model. Metering it at a build's weight would price something that does not happen.

The `query` row needs the same honesty. `apps/api/src/server.ts:963` constructs
`new QueryContextService(contextStore)` with all defaults, which means the
`ExtractiveContextSynthesizer` (`packages/context-engine/src/query/synthesis.ts:3`, pure string
slicing) and a retriever list (`packages/context-engine/src/query/engine.ts:91-100`) that excludes the
only embedding-using retriever. A query today makes zero model calls, so its true marginal model cost
is zero. The row prices future behaviour, and the credit weight should stay nominal until the default
synthesizer changes.

## Build cost is work, not an existing capability

An earlier draft said the worker already knows the derivation's model consumption and reports it on
stage completion. Traced end to end, nothing captures it. `runDeriveKnowledge`
(`apps/worker/src/server.ts:380`) returns exactly `{effect, runId, revisionIds, generationId?}`
(lines 425-431). The `POST /internal/context/derive/commit` request body is
`{checkpointId, rawOutput, repairPresentationFields}` plus lease fields, so there is no inbound
channel either. The model runs in
`packages/daytona/src/knowledge-document-executor.ts`, which invokes `codex exec --json` but uses the
event stream only for exit-code checks and a transient-failure regex, retrieving only the last
message — token counts are produced inside the sandbox and discarded. The port forecloses it:
`KnowledgeDocumentGenerator.generate` returns `Promise<unknown>`
(`packages/context-engine/src/derive/service.ts:39`). `DerivationRun` and
`jina_context.derivation_runs` (`packages/db/src/context/schema.ts:516-541`) carry generator name,
version and model but no token or cost column. A search for `promptTokens`, `completionTokens`,
`input_tokens` and `output_tokens` across `apps/worker/src`, `packages/daytona/src` and
`packages/context-engine/src` returns nothing.

`ModelUsageRecord` (`packages/ai/src/harnesses/harness.ts:25`) is real but belongs to the PR-review
harnesses, whose only consumer is a local developer CLI that prints it — and the production review
path (`apps/worker/src/server.ts:887`) does not use those harnesses either. So model usage is captured
nowhere in production.

Recording build cost therefore means four contract changes, and phase 2 must be sized for them:
`KnowledgeDocumentGenerator.generate`'s return type; the Daytona executor, which already receives the
`--json` stream it needs and can follow `packages/ai/src/harnesses/codex-harness.ts:151`'s
`extractTokenTotals`; `runDeriveKnowledge`'s completion payload; and the derive/commit request body.
Until those land, `build` is metered on wall-clock and stage count, which the worker genuinely knows,
and the weight is a policy constant rather than a measurement.

Attribution needs a fifth change: either a requester column on `pipeline_builds` with the principal
threaded through `createBuild`, or the usage record written at the route (`server.ts:421`) where the
principal is in scope, with cost reconciled in later. The route is the cheaper of the two and is what
this phase does.

## Surface

`GET /context/usage`, filtered in SQL from the authenticated principal: `where tenant_id=$1 and
principal_id=$2` for a non-administrator, tenant-wide for an administrator. The request carries no
principal or token filter a caller can set.

It requires its own scope, `context:usage`, and is **not** mapped to `context:read`. Phase 1 states
that `CONTEXT_API_TOKEN` carries the implicit set `{context:query, context:read}` and that its reach
does not change; mapping usage under `context:read` would hand every holder of that shared secret a
new billing-grade surface the day the route ships, which is a widening nobody decided on.

"A tenant administrator sees the tenant's" rests on `isTenantAdmin`, the string test at
`server.ts:1066`, so a token whose principal is `tenant:<tenantId>` would read every principal's usage
in the tenant. Phase 1's mint refusals are what make this rule safe, and this endpoint is the reason
they are not optional. `reference_id` stays an opaque handle here — dereferencing a trace id remains
tenant-administrator only, so a usage row cannot be walked back to another person's question.

## Billing stays where it is

v1 polls this endpoint and meters credits. Polling rather than pushing, for two reasons: it avoids a
dependency from v2 onto v1, and a missed poll is recoverable where a dropped webhook silently
under-bills. What v1 gains is a reconciliation job. Whether it already has an Autumn client and a
credit feature is unverified from here; if it does not, that is v1-side work this plan cannot size.

Quota enforcement checks remaining credits before an expensive operation and rejects with a distinct
code. Cheap reads stay available at zero balance, so somebody who is blocked can still see why. The
nearest local prior art is `isBudgetExhausted` (`packages/policy/src/budget-policy.ts:20`), enforced
against in-memory workflow state at `apps/workflows/src/tasks/run-review.ts:124` — a shape to borrow,
not an existing mechanism to extend.

## What must not break

Existing query telemetry keeps its shape. `recordQueryRun` gains a usage write beside it rather than
being replaced, so the evaluation harness and the metrics endpoint carry on reading what they read
today. The seam is good: `queryContext` (`apps/api/src/server.ts:954`) is the sole production caller
of `recordQueryRun` (line 966) and serves both metered operations —
`POST /context/query` (line 460) and `POST /mcp` (line 395) — with `principal` in scope, so
`tokenId` needs no threading.

Writing usage must never fail a request that has already succeeded. This phase has to _create_ that
property rather than preserve it: `await contextStore.recordQueryRun({...})` at `server.ts:966` is
awaited outside any try, with no `.catch`, and the only handler is the route-level catch at line 298,
which returns 500 through `httpError` (line 2145). So a telemetry write failure already turns a
successful query into a 500. Both writes go inside one try that logs and continues, which is a
behaviour change for query telemetry and is listed here rather than in "what is preserved" for that
reason.

`GET /context/metrics` has three live consumers whose shapes must survive:
`apps/admin/lib/jina-api.ts:145`, `apps/dashboard/src/components/context/context-page.tsx:19` (polls
every ten seconds), and `apps/worker/src/acceptance.ts:193`, which uses it as a production acceptance
gate. The dashboard types `query` as required while admin types it optional, so any change to that
object touches both.

## Tests

- In `apps/api/src/api-tokens.test.ts` or a sibling `usage.test.ts` directly in `apps/api/src/`: a
  query, an MCP call and a build each produce exactly one usage record with the right `operation` and
  a non-zero credit weight; a read produces one with `credits = 0`.
- Records carry `token_id` for a minted token and `null` for a static credential
  (`assert.equal(record.tokenId, undefined)`), so a mixed period reconciles without double-counting.
- `GET /context/usage` returns only the caller's own records for a non-administrator principal and the
  tenant's for an administrator. This is the per-user isolation test and deserves the same weight as
  phase 1's header-assertion test.
- A usage write that throws leaves the request successful: inject a store whose usage write rejects
  and `assert.equal(response.status, 200)`.
- In `packages/db/src/context.integration.test.ts`: aggregation over a known set of rows yields the
  expected credit total, so v1's reconciliation has a fixture to trust; and a non-administrator role
  cannot read another tenant's usage rows.

## Rollout

1. `usage_records` table, `tenantScopedTables` registration, grants, and the repository — same shape
   and same ordered checklist as phase 1's commit 1 and 2.
2. The usage write beside `recordQueryRun`, with both wrapped, and the build usage write at
   `server.ts:421`.
3. `GET /context/usage` with `context:usage` added to `requiredScope`, `CONTEXT_SCOPES`, the
   `api_tokens_scopes_known` constraint on `api_tokens`, and `METRICS_ROUTES`. The constraint edit
   means both the literal inside `create table if not exists` **and** the
   `alter table … add constraint` that follows it; the second is the one that takes effect on an
   already-migrated database, which phase 1 names the constraint for.
4. The four derivation contract changes, which can land after the endpoint and only change the
   `credits` value for `build`.
5. v1's reconciliation job, outside this repository.

## Out of scope

The dashboard view, and any change to the review-side billing gate in v1. Phase 2 supplies numbers;
what to charge for them stays a pricing decision, as does the credit weighting the design doc leaves
open.

# Phase 3: dashboard issuance

Let a person create, see and revoke their own tokens, and see what each one spent.

## Where it lives

The interface belongs in the v1 dashboard, which owns user sessions and tenant membership. v2 mints;
v1 asks. That v1's dashboard presents Organization, Usage and Billing is unverified from this
repository — see the section at the top — and `apps/dashboard` here is a different application
entirely, with no sessions and one tenant per deployment.

The practical consequence is that **phase 3 touches one file in this repository — mint's
scope-bounding validation in `apps/api/src/server.ts` — and nothing else**. That one addition is
described under Decisions taken below and is the first step of the rollout; it is a pure addition to
mint's validation, not a change to the request or response shape, which is why the freeze under "What
must not break" still holds. Everything else consumes phase 1's endpoints as they already are. If
phase 3 needs any further v2 change, phase 1 got the endpoint shape wrong, and that is the signal to
fix phase 1 rather than special-case the dashboard.

## The flow

1. A person names a token, chooses scopes and sets an expiry.
2. v1 calls `POST /internal/context/tokens` with the internal credential, asserting the tenant and
   principal **from the authenticated session**, never from the request body.
3. v2 returns the secret once; v1 renders it once with a copy control and never stores it.
4. The list thereafter shows name, scopes, created, last used, expiry, usage this period and revoke.

Last used together with per-token usage is the point of the list: it is what lets somebody notice one
token behaving unlike the others and revoke exactly that one. Both come free from phases 1 and 2 —
`last_used_at` from the verify path, usage from the token dimension.

Each token also offers a ready-to-paste MCP configuration. Direct MCP access is the reason to issue
one, and pasting a config beats reading documentation. One caveat that must be in the copy: `/mcp`
returns 403 for any `Origin` header not present in `config.mcpAllowedOrigins`
(`apps/api/src/server.ts:383-386`), which defaults to the empty array, so the configuration works from
a desktop client and not from a browser unless `JINA_MCP_ALLOWED_ORIGINS` is set
(`apps/api/src/dev-server.ts:68`).

## Decisions taken

Scopes offered are bounded by the viewer's own, and that bound is enforced at the mint endpoint rather
than only in the interface. Phase 1 deliberately has no such rule because its only caller is a shared
secret with no scopes; phase 3 is where the caller becomes a session and the rule becomes meaningful.
This is the single v2 file this phase touches, named above, and it is a pure addition to mint's
validation rather than a change to the request or response shape.

Expiry stays `expiresInMinutes` on the wire. The dashboard presents day-shaped choices; the field does
not change, which is what lets phase 4's short-lived delegations use the same endpoint.

## Non-negotiables

- The secret is shown once and never retrievable, because a leaked database must not yield working
  credentials.
- A non-administrator cannot mint `context:admin` or `context:build`. Both rows are gated by
  `requireTenantAdmin` in v2, so such a token would be issued dead even if the interface offered it —
  and the interface must not, because a token that looks granted and is not is worse than a refusal.
- Issuance and revocation are recorded with their actor, which `created_by` and `revoked_by` already
  carry.
- Expiry is required, with a bounded maximum.

## What must not break

Nothing in v2 changes except the scope-bounding rule above. In particular the mint endpoint's response
body and status codes are frozen from phase 1, as is the meaning of every request field phase 1
shipped. A later phase may add a further _optional_ request field — phase 4 does — because that is
backward compatible by construction. What would signal that phase 1 got the shape wrong is a shipped
field changing meaning, or a caller getting back something different.

## Tests

- A token minted through the dashboard path belongs to the session's tenant and principal, and a
  forged body identity is ignored rather than honoured.
- The secret appears exactly once, in the creation response, and in no listing.
- A non-administrator is offered and granted no `context:admin` or `context:build` scope.
- Revoking from the list makes the token fail verification immediately.

These are tested at the API boundary, where they are enforced anyway. Dashboard component coverage is
a gap in both codebases — `apps/dashboard/package.json:9` is
`node --test src/lib/*.test.ts src/server/*.test.ts`, a `.ts`-only, directory-scoped, non-recursive
glob with no testing library in its dependencies, so a `.tsx` component test could not be picked up
even if written. Whether v1 has the same gap is unverified. Closing it means editing the test script's
glob, not only adding a dependency.

## Rollout

1. Scope bounding added to v2's mint validation, with a test that a caller's own scopes bound what it
   may issue.
2. v1's issuance page, list and revoke control.
3. v1's per-token usage column, reading phase 2's endpoint.

## Out of scope

Rate limiting per token, and repository-level narrowing in the issuance interface. Both are additive
on this shape.

# Phase 4: migrate and retire

Move v1 onto delegated per-tenant tokens and remove the static context token.

## Order matters

0. **Widen access synchronisation to name its subject.** This is a prerequisite, not a step to
   discover late. `POST /internal/context/access/sync` can only ever grant access to
   `config.contextApiPrincipalId` (`server.ts:1399-1414` into `synchronizeRepositoryAccess` at 928),
   and it is the only writer of `repository_acl_observations`. Until the internal credential can
   synchronise access for an explicitly named principal — with the same header-assertion discipline —
   a delegated token for a second tenant reads nothing, because `permittedRepositories` returns `[]`.
   Note this also matters for the `tenant:` refusal: a delegated token cannot name
   `tenant:<tenantId>` and must therefore name a real service principal whose ACL rows exist.
1. v1 requests a short-lived token per tenant instead of sending `CONTEXT_API_TOKEN`, and caches it
   until shortly before expiry. Renewal is mint-new-then-revoke-old; there is no renew endpoint and
   there does not need to be. A restart storm therefore mints a token per restart, which is the price
   of issuance not being idempotent, and it is a price rather than a bug: the tokens expire on their
   own, `GET /internal/context/tokens` defaults to non-revoked and non-expired so the list does not
   grow without bound in the interface, and v1 should revoke the token it is replacing rather than
   leaving it to lapse. If the churn turns out to matter, the fix is v1 caching its token durably
   across restarts, not an idempotency key on a credential.
2. Both paths run in parallel, and the static token's use is measured. It cannot be removed on
   assumption; usage records from phase 2 and the route metrics registered in phase 1 show whether
   anything still presents it.
3. `CONTEXT_API_TOKEN` is removed. This is six code edits, not a deployment config change, and the
   startup assertion goes first or the API will not boot: `apps/api/src/dev-server.ts:28-30` throws
   `INTERNAL_API_TOKEN and CONTEXT_API_TOKEN are required in production`;
   `apps/worker/src/acceptance.ts:413` reads it through `requiredEnv` and the `jina-acceptance` job
   mounts it (`scripts/cloud-build-deploy.sh:945`); the API service mounts it at
   `scripts/cloud-build-deploy.sh:193`; `scripts/context-question-evaluation.mjs:150` prefers it over
   the internal token; and — the one easiest to miss — `"jina-context-api-token:latest"` sits in the
   pre-deploy secret-accessibility loop at `scripts/cloud-build-deploy.sh:515`, which runs
   `require_secret` on every entry before anything is deployed. Leaving it there makes every deploy
   preflight a secret this step is deleting, so the release that removes the secret from Secret
   Manager fails before it reaches any of the other five edits. Remove it in the same change as the
   two mount sites at 193 and 945, and before the secret itself is deleted. The acceptance job must be
   migrated to a minted token first, because it is the production gate that would otherwise fail the
   very release that removes it.
4. `isContextCredentialRoute`, the `CONTEXT_CREDENTIAL_SCOPES` constant and the static context branch
   in `authenticatedPrincipal` are deleted, leaving scope lookup as the only path. This also retires
   `apps/api/src/github-app.test.ts:875-975` — the test phase 1 promised never to edit — which must be
   rewritten against minted tokens in the same change rather than deleted.

Step 2 is the one that matters. Every incident in this project's recent history came from removing
something that was still in use, so retirement waits for evidence of disuse rather than a belief in
it.

## Decisions taken

Delegated tokens are minutes-lived, refreshed continuously, and named for a service principal per
tenant rather than for `tenant:<tenantId>`. The second half is forced by phase 1's refusal of
`tenant:` principals, and it is the right outcome: a delegated read token should not also be a tenant
administrator.

## What this finally fixes

v1 stops being a privileged proxy. Each tenant's reads run under a token naming that tenant, so the
`/context` page works for every tenant rather than only the one the static credential was bound to —
the failure that motivated this whole design.

## What must not break

v1's review path uses its own credential for MCP forwarding (unverified from here) and must keep
working throughout, so the delegated token covers context reads and queries first and the MCP proxy
last, in a separate change, once reads are proven.

The internal credential keeps full reach throughout. Nothing in this phase touches it.

## Tests

- v1 reads context for two different tenants in one test and gets each tenant's own data. This is the
  assertion the whole design exists to make true, and it is impossible to pass today.
- A delegated token near expiry is renewed without a failed request reaching the user.
- With `CONTEXT_API_TOKEN` unset, `apps/api/src/dev-server.ts` still starts in production mode, and
  every v1 context path still works.
- The rewritten scope regression, asserting that a minted token is refused on the same nine
  method/path pairs the static credential was — now with 403 `insufficient_scope` rather than 401.

## Rollout

1. Access-sync widening, with its own header-assertion tests, shipped and proven before anything else.
2. v1 on delegated tokens, both paths live.
3. A full release cycle of measurement.
4. The six-consumer removal, startup assertion first, secret-access preflight in the same change,
   acceptance job already migrated.
5. Static-branch deletion and test rewrite.

## Out of scope

Removing `INTERNAL_API_TOKEN`. It stays as the only service-to-service secret, used only between our
own components, and nothing in this sequence changes that.

# Completion

Done means all of the following hold:

- A person can create a scoped token in the dashboard, use it against the API and MCP directly, see
  what it spent, and revoke it.
- Usage is attributed per token, covering builds as well as queries, and v1 meters it as credits.
- v1 serves `/context` for every tenant, not one.
- No static shared credential remains for context access; `INTERNAL_API_TOKEN` is the only
  service-to-service secret, used only between our own components.
- Retiring the static token was justified by measured disuse, not assumption.

## Deliberately left for later

Repository-level token narrowing, verification caching, rate limiting per token, and constant-time
comparison for the static credentials while they still exist. Each is additive on this shape and none
is needed to reach the above, so each waits for a real requirement rather than being built
speculatively.
