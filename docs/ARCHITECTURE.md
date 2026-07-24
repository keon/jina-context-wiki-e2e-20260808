# Architecture

This document describes the runtime in this repository. Domain-specific ContextGraph details live in [CONTEXT_GRAPH.md](CONTEXT_GRAPH.md), persisted structures in [DATA_MODELS.md](DATA_MODELS.md), and request flows in [SEQUENCE_DIAGRAM.md](SEQUENCE_DIAGRAM.md).

## Topology

The deployed backend runs as three Cloud Run services backed by the original
PostgreSQL 16 identity/control-plane database and the dedicated same-region
PostgreSQL 17 ContextGraph database:

- `jina-api` accepts tenant-scoped work from trusted callers, applies commands, reduces readiness, and owns worker lease/completion transactions. Its direct GitHub parser is retained but disabled in production.
- `jina-task-worker` handles review, research, publication, and cleanup topics.
- `jina-context-graph-worker` handles repository ingest, semantic assertion, and projection topics.

The dashboard and admin are Next.js applications deployed automatically from `main` by the Om Labs Vercel projects
`jina-dashboard` and `jina-admin`. They call the Cloud Run API only from server routes, forwarding the internal
bearer credential and shared tenant identity after app-level authentication.

```text
GitHub -> API -> PostgreSQL board/outbox <- renewable lease -> workers
Browser -> authenticated web app -> API -> PostgreSQL
Trusted context caller -> context API or MCP -> repository-scoped retrieval
```

The API performs short state transitions. Workers perform external I/O outside the mutation lock, renew their leases, and complete through the API. Expired work is reclaimable; a stale completion changes no state.

## Identity and tenancy

Production does not maintain a second user, organization, installation, or repository directory. The original Jina tables in `public` are authoritative:

- `tenants` supplies the tenant UUID and GitHub account identity;
- `installations` proves that the tenant's GitHub App installation is active;
- `repositories` binds an enabled GitHub repository to that tenant;
- `tenant_members` remains owned by the original application and supports its membership boundary.

Graph intake is branch-oriented and independent of review completion. A non-deleted branch push, or an explicit
`POST /context-graph/build` using a branch or tag, starts the current ingest/assert/project pipeline. A commit SHA is
the immutable result of resolving that ref during ingest; it is never stored as the ref itself. Retired review
completion callbacks and commit-SHA build refs are rejected at the API boundary. The authoritative identity tables
still resolve the enabled repository and active installation, and the tenant UUID partitions every pipeline and
ContextGraph row.

Workers do not connect to PostgreSQL. An unscoped worker claim asks the API to enumerate active original tenants; all later lease, completion, and graph requests carry the concrete original tenant UUID. The original application exposes its member-authenticated work overview by calling this API with the same UUID and `tenant:<uuid>` principal. Fixed mode remains available only for local development and rollback.

## Board and execution

The board is both the operational source of truth and the orchestrator. A versioned planner creates tasks and dependency edges. The reducer queues a task only after its required dependencies are satisfied and writes its outbox message with the same state change.

Task types and dispatch topics are worker-owned strings. The board remains generic: it validates commands, transitions, dependency readiness, terminal propagation, supersession, and leases without importing GitHub or context graph behavior.

Opened PRs create a `pr_review` aggregate, `review_pass`, and `publish`. A new head SHA increments the epoch and supersedes active work from the old epoch. Opened issues create manual `issue_triage` tasks. Signed branch pushes start the context graph task tree, dedupe unchanged heads, and supersede stale ref work even when a force-push returns to an earlier SHA.

Automated dependency failures are terminal: failed work remains `failed`, dispatchable descendants become `canceled`, and the aggregate becomes `failed`. The reducer does not invent recovery tasks. A workflow that supports recovery must declare the human decision and resolution command explicitly.

The board is currently stored as one JSON snapshot. Each mutation holds a cross-instance PostgreSQL transaction lock while loading and saving it, so concurrent API instances cannot derive state from the same stale snapshot.

## Worker boundaries

The task worker fetches PR data from GitHub, calls the configured review harness, and records structured findings. Research currently records requested sources without arbitrary network retrieval. Publication currently upserts an internal record.

The context graph worker runs three stages:

1. `context_graph_ingest` walks unseen commit history, records exact trees and first-parent changes, parses new blobs, and normalizes explicit repository and GitHub facts.
2. `context_graph_assert` checks out the pinned commit in Daytona and records cited semantic assertions. Valid
   model assertions become active automatically; optional human commands may later correct or retract them.
3. `context_graph_project` drains consumer-owned canonical events and rebuilds manifests, search documents, redirects, and immutable content-addressed graphs.

Only assertion generation uses a model. Assertions must carry checked repository evidence, a relationship
explanation, and known typed identities. Reconfirmation of identical content advances `last_confirmed_at`; changed
evidence, explanation, or confidence creates a new immutable assertion version and supersedes the previous
version. Exact evidence fingerprints cache unchanged generations; generator-contract changes trigger one bounded
refresh.

## Read interfaces

The dashboard is a Next.js application that reads board, history, task-type, graph, assertion, and fixed-template retrieval endpoints through its authenticated proxy. Its board poll uses `GET /overview`, which serves the board and its event history from one ACL lookup and one pipeline listing. The graph page uses the dashboard view of `GET /context-graph`, which returns only the latest authorized graph and a bounded proposed-assertion queue; older proposals and assertion history load on demand. Polled read responses carry ETags. Context-graph revalidation derives its validator from graph heads and assertion mutation clocks before hydrating nodes, edges, summaries, or assertion entities, so an unchanged request exits with `304`. Historical graph lists remain available to other clients as summaries with counts denormalized at write time; full nodes and edges load only when requested.

`POST /mcp` implements stateless Streamable HTTP MCP with one read-only `query_graph` tool. The server chooses bounded retrieval templates and returns cited results; callers do not choose SQL, graph generations, or internal tools.

The graph build credential maps each tenant to a bound principal. ACL synchronization replaces the complete
repository set, so removed repositories are revoked on the next sync.

## Persistence and idempotency

The board snapshot lives in `jina_runtime.api_state`; GitHub delivery IDs are unique in `jina_runtime.github_deliveries`. ContextGraph uses normalized canonical, audit, outbox, ACL, lifecycle, manifest, search, graph, and retrieval-metric tables under `jina_context_graph`.

Production treats those as separate persistence planes. Identity, repository
authorization, and board/runtime state remain on the original Jina database.
The ContextGraph store and pipeline coordinator connect to a dedicated
same-region PostgreSQL instance through `GRAPH_DB_*`. This keeps ingestion
writes, graph indexes, vacuum, and connection pressure from contending with the
original dashboard database while preserving the original application as the
tenant authority.

Source writes, model observations, and projections are independently idempotent. A retry may repeat a stage, but canonical keys, consumer-owned outbox delivery, exact fingerprints, and immutable graph generations make the result converge. Graph identity includes tenant, repository, ref content, projection version, and canonical graph content.

## Authentication and security

Fixed mode uses `JINA_TENANT_ID`. Shared mode resolves the original tenant UUID from PostgreSQL for signed webhook intake and scopes authenticated requests by `x-jina-tenant-id`; a forwarded `tenant:<uuid>` principal must match that header. Health and task-type definitions are public; disabled webhook intake acknowledges without mutation. Board, worker, and context graph operations require the internal bearer credential. The cross-tenant read-only admin graph index and cursor-paginated workflow history accept only the distinct `JINA_GLOBAL_ADMIN_TOKEN`.

The web applications authenticate users with server-only Vercel environment variables before forwarding a verified principal and service credential. The dashboard forwards its configured user principal and remains fixed to its configured tenant. The admin app uses the global-admin credential only to discover graph heads and read cross-tenant operational history, then uses the service credential plus the selected graph's tenant ID for detail, retrieval, and validated build calls. The API applies tenant-administrator and repository ACL checks, validates manual build installation ownership against the shared identity database, and rechecks repository scope while assembling retrieval results.

MCP requires both the internal credential and a bound `x-jina-principal-id`; it rejects the service credential
alone. Browser MCP calls also require an exact origin allowlist match. `GRAPH_API_TOKEN` is restricted to current
branch-build intake and ACL synchronization; it does not expose a separate graph-read API and must not be exposed to
browsers or agents.

Repository credentials remain in the worker boundary. Daytona isolates repository inspection. Jina does not execute untrusted repository code, install repository dependencies, or run repository tests.

## Failure and observability contracts

- Duplicate GitHub deliveries are no-ops.
- Expired leases are reclaimable; replaced leases fence stale completion.
- Provider transport, timeout, rate-limit, and retryable server failures retry within policy. Schema and evidence validation fail closed.
- A new PR epoch or context graph ref attempt supersedes active older work.
- Public worker health exposes only stable categories; redacted detail remains in authenticated task events and Cloud Logging.
- Operational metrics cover canonical outbox depth/lag, parser backlog, projection staleness, assertion review, and retrieval latency/truncation.

## Code boundaries

- `apps/*` owns HTTP, process startup, external I/O, and runtime wiring.
- `packages/board` owns generic workflow state.
- `packages/context-graph` owns repository facts, assertions, retrieval, and store interfaces.
- `packages/db` implements durable stores, transactions, and migrations.
- Provider packages such as `github`, `daytona`, and `ai` adapt external systems.
