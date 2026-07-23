# Architecture

This document describes the runtime in this repository. Domain-specific ContextGraph details live in [CONTEXT_GRAPH.md](CONTEXT_GRAPH.md), persisted structures in [DATA_MODELS.md](DATA_MODELS.md), and request flows in [SEQUENCE_DIAGRAM.md](SEQUENCE_DIAGRAM.md).

## Topology

The deployed backend runs as three Cloud Run services backed by the shared PostgreSQL 16 database:

- `jina-api` verifies GitHub webhooks, applies commands, reduces readiness, and owns worker lease/completion transactions.
- `jina-task-worker` handles review, research, publication, and cleanup topics.
- `jina-context-graph-worker` handles repository ingest, semantic assertion, and projection topics.

The dashboard and admin are Next.js applications deployed separately. An existing Cloud Run dashboard remains during the Vercel authentication cutover; see [DEPLOYMENT.md](DEPLOYMENT.md).

```text
GitHub -> API -> PostgreSQL board/outbox <- renewable lease -> workers
Browser -> authenticated web app -> API -> PostgreSQL
Trusted graph caller -> graph API or MCP -> repository-scoped retrieval
```

The API performs short state transitions. Workers perform external I/O outside the mutation lock, renew their leases, and complete through the API. Expired work is reclaimable; a stale completion changes no state.

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
2. `context_graph_assert` checks out the pinned commit in Daytona and records cited semantic output as proposed assertions.
3. `context_graph_project` drains consumer-owned canonical events and rebuilds manifests, search documents, redirects, and immutable content-addressed graphs.

Only assertion generation uses a model. Assertions must carry checked repository evidence, a relationship explanation, and known typed identities. Reviewed assertions retain evidence, explanation, provenance, and review state when reconfirmed. Exact evidence fingerprints cache unchanged generations; generator-contract changes trigger one bounded refresh.

## Read interfaces

The dashboard is a Next.js application that reads board, history, task-type, graph, assertion, and fixed-template retrieval endpoints through its authenticated proxy. Its poll uses `GET /overview`, which serves the board and its event history from one ACL lookup and one pipeline listing, and `GET /context-graph?include=assertions`, which inlines the review queue so no dependent request follows. Polled read responses carry ETags: an unchanged poll revalidates to an empty 304, and the API itself skips reloading the board snapshot when its stored version has not moved. Historical graph lists contain summaries with counts denormalized at write time; full nodes and edges load only when requested.

`POST /mcp` implements stateless Streamable HTTP MCP with one read-only `query_graph` tool. The server chooses bounded retrieval templates and returns cited results; callers do not choose SQL, graph generations, or internal tools.

The simulation-facing graph API uses a dedicated credential and maps each simulation tenant to a bound principal. ACL synchronization replaces the complete repository set, so removed repositories are revoked on the next sync.

## Persistence and idempotency

The board snapshot lives in `jina_runtime.api_state`; GitHub delivery IDs are unique in `jina_runtime.github_deliveries`. ContextGraph uses normalized canonical, audit, outbox, ACL, lifecycle, manifest, search, graph, and retrieval-metric tables under `jina_context_graph`.

Source writes, model observations, and projections are independently idempotent. A retry may repeat a stage, but canonical keys, consumer-owned outbox delivery, exact fingerprints, and immutable graph generations make the result converge. Graph identity includes tenant, repository, ref content, projection version, and canonical graph content.

## Authentication and security

Fixed-tenancy production is scoped to `JINA_TENANT_ID`; shared-database production resolves the tenant from PostgreSQL. Health, task-type definitions, and signed webhook intake are public; board, worker, and context graph operations require the internal bearer credential.

The web application must authenticate users before forwarding a verified principal and service credential. The existing Cloud Run dashboard uses IAP; its replacement needs an equivalent identity boundary. The API applies tenant-administrator and repository ACL checks, and retrieval rechecks repository scope while assembling results.

MCP requires both the internal credential and a bound `x-jina-principal-id`; it rejects the service credential alone. Browser MCP calls also require an exact origin allowlist match. The graph API uses `GRAPH_API_TOKEN`, which grants graph/ACL access only and must not be exposed to browsers or agents.

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
