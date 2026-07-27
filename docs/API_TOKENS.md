# Per-principal API tokens

Status: proposed. This describes a credential model that lets people query the API and MCP
directly, meters what they use, and lets them issue their own tokens from the dashboard.
Nothing here is implemented beyond the read-scope widening described under Phase 0.

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

Route authorization becomes a scope lookup rather than the current
`isContextCredentialRoute` predicate.

### Identity comes from the token

Never from headers. Headers remain assertions that must match the token, which is the rule
established when caller-selected tenant and principal headers were removed from access
synchronization. Preserving it is what makes multi-tenant access safe: each token names its
own tenant, so nothing has to trust a caller's claim about which tenant it is acting for.

Repository filtering reuses what already exists — `permittedRepositories` for reads and
`allowedKnowledgeRevisionIds` for knowledge — so a token sees exactly what its principal's
ACL allows, and tenant administrators keep the access they have today.

### Issuance

A token is minted for a principal by a caller holding the internal credential, which is how
the dashboard and Jina v1 both obtain them. The secret is returned once and stored only as a
hash, so a disclosed database yields no working credential. Every token carries a
recognizable prefix, both so it is greppable in logs and so it can later be registered for
secret scanning.

Scopes granted may not exceed the scopes of the identity requesting them. A non-administrator
cannot mint `context:admin`; without that rule, self-service issuance is privilege escalation
with extra steps.

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

| Operation          | Meter             | Rationale                                    |
| ------------------ | ----------------- | -------------------------------------------- |
| `build`, `rebuild` | credits, weighted | sandbox plus agentic derivation              |
| `query`, `mcp`     | credits           | retrieval and synthesis model calls          |
| reads              | count only        | cheap; for rate limiting rather than billing |

The worker already knows the derivation's model consumption, so build cost can be recorded
rather than estimated.

Billing stays where it is. This API exposes usage and Jina v1 polls it to meter credits.
Polling avoids a dependency from this API onto v1, and a missed poll is recoverable where a
dropped webhook silently under-bills.

`GET /context/usage`, scoped by the caller's own token, is the self-service surface: a person
sees their usage, a tenant administrator sees the tenant's. Same authorization rule as
everything else.

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

0. Widen the context credential to the read-only projections. Unblocks the v1 context page
   and is a strict subset of `context:read`.
1. Token model here: mint, verify, scope-check, hash at rest, revoke. Both static tokens keep
   working, so nothing breaks.
2. Usage records keyed by `tokenId`, covering builds as well as queries. v1 polls and meters.
3. Dashboard issuance and per-token usage on the existing Usage page.
4. v1 moves to delegated per-tenant tokens; retire the static context token.

Metering is only trustworthy from step 1 onward. While a shared static secret is in use every
call attributes to the same principal, so usage reporting built before then describes a single
synthetic user.

## Open decisions

**Token format.** Opaque and stored hashed gives immediate revocation at the cost of a lookup
per request. Signed with a short lifetime verifies statelessly but can only be revoked by
waiting for expiry; v1's existing MCP access token already uses that shape. Revocation
latency is the deciding question, and it is hard to change after tokens are issued.

**Token narrowing.** Whether a token may be restricted to specific repositories in addition to
its tenant.

**Credit weighting.** How many queries a build is worth. Cost data exists; the ratio is a
pricing decision.

**Exhausted credits.** Whether to block builds while continuing to serve queries and reads, or
to stop everything.

**Retention** for per-request usage rows, which would be the highest-volume table added.
