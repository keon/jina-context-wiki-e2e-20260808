# Per-principal API tokens

Status: token authentication is implemented. Exact Board build-model accounting and
model-free query-rate accounting are implemented at the tenant quota boundary.
Per-principal/per-token usage reporting, dashboard self-service issuance, and retirement of
the static context credential are not implemented. This document separates those facts
from the remaining product roadmap; executable source and tests remain authoritative.

## Why the static credentials are not the end-state

Two static credentials remain for service compatibility, but they are no longer the only
authentication mechanism.

`INTERNAL_API_TOKEN` reaches everything, so it cannot be given to anyone. `CONTEXT_API_TOKEN`
is narrow, but it is bound server-side to a single tenant and principal, so it cannot serve a
second tenant. Opaque `jina_atk_…` tokens solve direct multi-tenant API/MCP authentication by
resolving their tenant, principal, token ID, scopes, expiry, and revocation state server-side.

The remaining limitations belong to the static path and the unfinished reporting surface:

- neither static credential can safely serve as a personal, multi-tenant credential;
- calls made with one static credential cannot be attributed to distinct people or tokens;
- Jina v1 still needs delegated per-tenant tokens before the static context credential can be
  retired; and
- there is no `GET /context/usage` or dashboard workflow that exposes per-token consumption.

## The model

A token carries `(tenantId, principalId, tokenId, scopes, expiresAt)` and is verified
server-side. Authorization stops depending on who holds a shared secret.

### Scopes

| Scope           | Routes                                                                                 |
| --------------- | -------------------------------------------------------------------------------------- |
| `context:query` | `POST /context/search`, `POST /mcp`                                                    |
| `context:read`  | `GET /context/releases`, `/context/list`, `/context/read`, `/context/diff`             |
| `context:build` | `POST /context/build`, `POST /context/rebuild`                                         |
| `context:admin` | `POST /context/erasure`, `POST /context/knowledge/{id}/review`, `GET /context/metrics` |
| `context:usage` | Reserved for a future self-service usage route                                         |

Scope grants route reach, not permission. `requireTenantAdmin` still applies on top, and it
covers every route under `context:build` and `context:admin` — so a token carrying either on
a principal that is not a tenant administrator reaches those routes and is refused there.

Opaque-token route authorization is a scope lookup. The static context credential retains
its deliberately narrow route predicate during migration.

### Identity comes from the token

Never from headers. Headers remain assertions that must match the token. Preserving that is
what makes multi-tenant access safe: each token names its own tenant, so nothing has to
trust a caller's claim about which tenant it is acting for.

This continues a rule the config-bound credentials follow; it is not a universal one, and
saying so matters to anyone reading the authentication function. Of the four branches that
existed before tokens, only the two whose identity comes from server-side configuration —
access synchronization and the context credential — assert headers. The dev branch asserts
nothing. The internal credential may still select a tenant for privileged service
operations, but durable token issuance and revocation attribution is bound to
`JINA_INTERNAL_PRINCIPAL_ID` (default `svc:api`) and never to a request header. The token
branch adopts the config-bound rule.

Repository filtering reuses what already exists — `permittedRepositories` for reads and
`allowedKnowledgeRevisionIds` for knowledge — so a token sees exactly what its principal's
ACL allows, and tenant administrators keep the access they have today.

### Issuance

A token is minted for a principal by a caller holding the internal credential. This is the
mechanism the dashboard and Jina v1 can use once their delegated issuance flows are
implemented. The secret is returned once and stored only as a hash, so a disclosed database
yields no working credential. Every token carries a
recognizable prefix, both so it is greppable in logs and so it can later be registered for
secret scanning.

Scopes granted may not exceed the scopes of the identity requesting them — but only after
self-service issuance is backed by an authenticated session. The current internal minter has
no such rule and cannot: its only minter holds the internal shared secret, which carries no
scopes at all, so there is nothing to compare against. What the current API enforces instead
is the principal: `tenant:` and `svc:` principals are refused outright, and a principal
configured as a tenant administrator requires an explicit `administrator: true`. That is the
real boundary, because tenant administration is derived from the principal id rather than
from any scope.

Expiry is required and bounded. Revocation takes effect immediately.

## Usage and model accounting

The Board build path captures exact Codex turn usage. Local and Daytona runners parse
`turn.completed.usage`, retain only input, cached-input, and output token counts, and do not
retain the transcript as usage evidence. A Board worker aggregates every model call
performed under one lease. Successful Board completion always carries exact usage; failed
and retry outcomes carry it whenever a runner completed. The API commits observed counts to
the tenant quota ledger idempotently per attempt and cancels reservations for failures
before a completed model turn.

`search_context` and `POST /context/search` do not reserve a model attempt or consume model
quota. They perform bounded deterministic lexical scoring over the published PageIndex tree.
Caller-controlled `x-request-id` remains the query-rate idempotency key, so retries consume
one query-rate operation. Public search results contain only derived Context and
citations—never accounting metadata or a generated answer.

This is production quota accounting, not yet per-person billing:

- the ledger is tenant scoped rather than keyed by API token;
- token records track `lastUsedAt`, not consumption by operation;
- query telemetry records a non-resolvable principal fingerprint rather than a token ID;
- build-model invocations that never emit valid completed usage cannot be recorded as exact
  token usage and therefore cancel their reservation; and
- there is no self-service usage API.

The remaining reporting design is one usage record per billable operation, keyed by
`(tenantId, principalId, tokenId, operation)`, with an idempotency identity for replay.

| Operation                 | Current accounting                                                     | Remaining product work                            |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Board model task          | Exact tenant input/cached-input/output tokens and request count        | Attribute to initiating principal/token and price |
| Build admission/artifacts | Tenant rate, concurrency, active-task, and artifact-storage quota      | Present a user-facing cost rollup                 |
| `search_context` / MCP    | Tenant query-rate controls; deterministic search uses no model         | Attribute query count to principal/token          |
| list/read/diff            | Read authorization and request controls; no derivation model is needed | Count only if product analytics require it        |

Billing stays in Jina v1. The planned API exposes usage for v1 to poll rather than adding a
dependency from this API onto v1; a missed poll is recoverable where a dropped webhook would
silently under-bill.

The planned `GET /context/usage`, scoped by the caller's own token, is the self-service surface: a person
sees their usage, a tenant administrator sees the tenant's. It takes its own `context:usage`
scope rather than riding on `context:read`, because `context:read` is exactly what the static
context credential holds — mapping usage onto it would silently widen a shared secret to a
billing surface.

Current quota enforcement checks tenant build/query rates, concurrency, active builds and
model tasks, artifact bytes, monthly model requests, and monthly model tokens before
expensive work. Pricing credits and the exhausted-credit product policy remain separate
decisions. Cheap reads should stay available once credits are exhausted, so that someone who
is blocked can still inspect state.

## Dashboard issuance

The issuing interface belongs in the Jina v1 dashboard, which owns user sessions and tenant
membership, and which already presents Organization, Usage, and Billing. This API mints.

A person names a token, chooses scopes, and sets an expiry. The v1 API calls the mint
endpoint with the internal credential and asserts the tenant and principal **from the
authenticated session**, never from the request body. The secret is shown once, with a copy
control, and cannot be retrieved afterwards.

The list shows name, scopes, creation, last use, expiry, usage for the current period, and a
revoke control. Last use together with per-token usage is what lets someone notice one token
behaving unlike the others and revoke exactly that one.

Each token should also offer a ready-to-paste MCP configuration, since direct MCP access is
the point of issuing it.

Issuance and revocation are recorded with their actor.

## Sequencing

0. **Done.** Widen the context credential to the read-only projections. Unblocks the v1
   context page and is a strict subset of `context:read`.
1. **Done.** Token model here: mint, verify, scope-check, hash at rest, revoke. Both static
   tokens keep working, so nothing breaks — the pre-existing static-token scope test passes
   untouched, which is how that promise is checked.
2. **Done at the tenant quota boundary.** Exact Board build-model usage and model-free
   query-rate usage are persisted idempotently and exposed in administrator quota metrics.
3. Add usage records keyed by `tokenId`, covering builds, deterministic search, and MCP.
   Expose `GET /context/usage`; v1 polls and meters.
4. Add dashboard issuance and per-token usage on the existing Usage page.
5. Move v1 to delegated per-tenant tokens and retire the static context token.

Tenant model accounting is trustworthy for Board build-model attempts whenever Codex emits
valid `turn.completed.usage`; public Context searches never contribute model usage.
Per-principal reporting is not trustworthy until step 3, and a shared static secret will
continue to describe a single synthetic caller.

## Decisions taken

**Token format: opaque, stored hashed.** Revocation decided it. These credentials go to
people, and "revoke this leaked token now" has to mean now, which a signed token with a
lifetime cannot give. The cost is a lookup per request — and, as implementation showed, an
asynchronous request entry point, which was most of phase 1's work.

**Token narrowing: tenant-scoped only.** A token names one tenant and one principal.
Restricting it further to specific repositories is additive later and nothing forecloses it.

## Open decisions

**Credit weighting.** How many queries a build is worth. Cost data exists; the ratio is a
pricing decision.

**Exhausted credits.** Whether to block builds while continuing to serve queries and reads, or
to stop everything.

**Retention** for per-request usage rows, which would be the highest-volume table added.
