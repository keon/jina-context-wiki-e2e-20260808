# Per-principal API tokens

Status: phase 1 implemented. This describes a credential model that lets people query the
API and MCP directly, meters what they use, and lets them issue their own tokens from the
dashboard. The token model — mint, verify, scope-check, hash at rest, revoke — is built;
usage metering, dashboard issuance and retiring the static context token are not.
This document is the maintained design and roadmap; executable source and tests are
authoritative for the implemented phase.

## Why the current model cannot do this

Two static secrets carry all authority, and neither names who is calling.

`INTERNAL_API_TOKEN` reaches everything, so it cannot be given to anyone. `CONTEXT_API_TOKEN`
is narrow, but it is bound server-side to a single tenant and principal, so it cannot serve a
second tenant. Identity arrives with the credential rather than inside it, which is why a
multi-tenant caller has no way to act for the tenant it is serving without holding a
credential that can act for every tenant.

Three consequences follow, and they are the same defect seen from different angles:

- a person cannot be given a credential, because any credential is either omnipotent or
  belongs to one fixed identity;
- usage cannot be attributed, because every call from a given holder looks identical;
- Jina v1 cannot read on behalf of its tenants, which is how this surfaced in production.

## The model

A token carries `(tenantId, principalId, tokenId, scopes, expiresAt)` and is verified
server-side. Authorization stops depending on who holds a shared secret.

### Scopes

| Scope           | Routes                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `context:query` | `POST /context/query`, `POST /mcp`                                                                                        |
| `context:read`  | `GET /context/generations`, `GET /context/documents`, `GET /context/structure`, and a single generation or document by id |
| `context:build` | `POST /context/build`, `POST /context/rebuild`                                                                            |
| `context:admin` | `POST /context/erasure`, `POST /context/knowledge/{id}/review`, `GET /context/metrics`                                    |
| `context:usage` | `GET /context/usage` (phase 2)                                                                                            |

Scope grants route reach, not permission. `requireTenantAdmin` still applies on top, and it
covers every route under `context:build` and `context:admin` — so a token carrying either on
a principal that is not a tenant administrator reaches those routes and is refused there.

Route authorization becomes a scope lookup rather than the current
`isContextCredentialRoute` predicate.

### Identity comes from the token

Never from headers. Headers remain assertions that must match the token. Preserving that is
what makes multi-tenant access safe: each token names its own tenant, so nothing has to
trust a caller's claim about which tenant it is acting for.

This continues a rule the config-bound credentials follow; it is not a universal one, and
saying so matters to anyone reading the authentication function. Of the four branches that
existed before tokens, only the two whose identity comes from server-side configuration —
access synchronization and the context credential — assert headers. The dev branch asserts
nothing, and the internal-credential path treats `x-jina-principal-id` as the _source_ of
identity rather than a claim about it. The token branch adopts the config-bound rule.

Repository filtering reuses what already exists — `permittedRepositories` for reads and
`allowedKnowledgeRevisionIds` for knowledge — so a token sees exactly what its principal's
ACL allows, and tenant administrators keep the access they have today.

### Issuance

A token is minted for a principal by a caller holding the internal credential, which is how
the dashboard and Jina v1 both obtain them. The secret is returned once and stored only as a
hash, so a disclosed database yields no working credential. Every token carries a
recognizable prefix, both so it is greppable in logs and so it can later be registered for
secret scanning.

Scopes granted may not exceed the scopes of the identity requesting them — but only from
phase 3, where the requesting identity is an authenticated session. Phase 1 has no such
rule and cannot: its only minter holds the internal shared secret, which carries no scopes
at all, so there is nothing to compare against. What phase 1 enforces instead is the
principal: `tenant:` and `svc:` principals are refused outright, and a principal configured
as a tenant administrator requires an explicit `administrator: true`. That is the real
boundary, because tenant administration is derived from the principal id rather than from
any scope.

Expiry is required and bounded. Revocation takes effect immediately.

## Usage

Most of this already exists. `QueryRunTelemetry` records `tenantId`, `repository`,
`principalFingerprint`, `taskKind`, `routes`, `durationMs`, and citation and conflict counts
per query, and Jina v1 already meters a `jina_credits` feature with monthly plan allowances.
The work is connecting them, not building a meter.

Four gaps stand between that and per-user usage:

1. `principalFingerprint` is hashed, which suits analytics but cannot be joined back to a
   person for billing or for showing someone their own usage. A resolvable principal
   reference is needed alongside it.
2. Metrics aggregate per tenant only, with no per-principal or per-token rollup.
3. Only queries are recorded. Builds are not, and a build runs a sandbox plus an agentic
   derivation — the dominant cost by a wide margin. Metering queries while builds run free
   meters the cheap operation.
4. There is no token dimension, so a leaked or runaway token cannot be identified and revoked
   on its own.

Adding `tokenId` closes the fourth and makes the rest a matter of writing one usage record
per billable operation, keyed `(tenantId, principalId, tokenId, operation)`.

| Operation      | Meter             | Rationale                                    |
| -------------- | ----------------- | -------------------------------------------- |
| `build`        | credits, weighted | sandbox plus agentic derivation              |
| `rebuild`      | credits, lower    | inline reindex; no sandbox, no derivation    |
| `query`, `mcp` | credits           | retrieval and synthesis model calls          |
| reads          | count only        | cheap; for rate limiting rather than billing |

Build cost has to be captured before it can be metered. An earlier version of this document
said the worker already knows the derivation's model consumption and that build cost could
therefore be recorded rather than estimated. It cannot: nothing on the context derivation
path persists model token usage today. Phase 2 must extend the derivation executor result,
carry usage through stage completion, and write it with the billable build operation.

Billing stays where it is. This API exposes usage and Jina v1 polls it to meter credits.
Polling avoids a dependency from this API onto v1, and a missed poll is recoverable where a
dropped webhook silently under-bills.

`GET /context/usage`, scoped by the caller's own token, is the self-service surface: a person
sees their usage, a tenant administrator sees the tenant's. It takes its own `context:usage`
scope rather than riding on `context:read`, because `context:read` is exactly what the static
context credential holds — mapping usage onto it would silently widen a shared secret to a
billing surface.

Quota enforcement checks remaining credits before an expensive operation and rejects with a
distinct code. Cheap reads should stay available once credits are exhausted, so that someone
who is blocked can still see why.

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
2. Usage records keyed by `tokenId`, covering builds as well as queries. v1 polls and meters.
3. Dashboard issuance and per-token usage on the existing Usage page.
4. v1 moves to delegated per-tenant tokens; retire the static context token.

Metering is only trustworthy from step 1 onward. While a shared static secret is in use every
call attributes to the same principal, so usage reporting built before then describes a single
synthetic user.

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
