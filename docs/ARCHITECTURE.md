# Architecture

This document describes the deployed runtime. Persisted structures are in
[DATA_MODELS.md](DATA_MODELS.md), request flows in
[SEQUENCE_DIAGRAM.md](SEQUENCE_DIAGRAM.md), and the rationale in
[CONTEXT_ENGINE_DECISION.md](CONTEXT_ENGINE_DECISION.md).

## Topology

The backend runs as three Cloud Run services against one shared PostgreSQL database:

- `jina-api` verifies GitHub webhooks, serves board and context APIs, serves stateless MCP,
  and owns worker lease/completion transactions.
- `jina-task-worker` handles review, research, publication, and cleanup topics.
- `jina-context-worker` handles `ingest-evidence`, `derive-knowledge`, and
  `index-context`.

The dashboard and admin are Next.js applications deployed separately through Vercel.

```text
GitHub -> API -> PostgreSQL board/outbox <- renewable lease -> workers
Browser -> authenticated web app -> API -> PostgreSQL
Trusted context client -> HTTP API or MCP -> ACL-filtered retrieval
```

The API performs short state transitions. Workers perform external I/O outside the
mutation lock, renew their leases, and complete through the API. Every internal context
worker-stage mutation carries task, lease, attempt, and write-fence identity. An expired
or replaced lease cannot commit.

## Board and execution

The generic board is the orchestrator. A versioned planner creates tasks and dependency
edges. The reducer queues work only after required dependencies are satisfied and writes
its durable delivery with the same state change.

Opened pull requests create a review aggregate. Opened issues create manual triage work.
Signed branch pushes and `POST /context/build` create `build-context` with three children:

```text
ingest-evidence
  ├─> index-context       required baseline
  └─> derive-knowledge   optional enrichment
```

`index-context` can publish a raw-evidence generation as soon as ingestion completes.
Successful derivation publishes a successor enriched generation. The aggregate succeeds
when ingestion and baseline indexing succeed; derivation failure degrades rather than
invalidates the usable baseline.

The board remains representation-neutral. It knows task state, dependency readiness,
supersession, leases, and terminal propagation, but does not import context-domain types.

## Context planes

### Evidence

`ingest-evidence` resolves the requested ref to a full commit SHA, clones and checks out
that exact commit, then stores immutable provider observations, commits and parents, exact
trees, content-addressed blobs, first-parent changes, deterministic parser analyses,
symbols, imports, structural facts, identities, and ACL observations. Webhook builds carry
their GitHub App installation ID; the worker mints a short-lived installation token and
keeps it only for the active lease's Git and REST work. Oversized or binary content may be
omitted from stored body text, but its manifest identity remains.

Evidence is canonical. Model output cannot alter Git/provider facts, parser output,
permissions, or audit events.

### Knowledge

`derive-knowledge` selects a bounded bundle from one evidence checkpoint and asks the
isolated Daytona executor for knowledge documents, not nodes or relationships.
`KnowledgeOutputValidator` resolves stable logical subjects and checks each citation's
tenant, repository, source identity, digest, commit, path/range, and JSON pointer before
the immutable revision is stored. Invalid output receives at most one constrained repair.

Review, rejection, invalidation, supersession, and redaction are append-only events.
Derived interpretation never becomes terminal evidence; answer citations expand to the
original source anchors.

### Projection

`index-context` builds disposable, generation-scoped read models:

- exact ref manifest;
- current eligible knowledge revisions;
- indexable context documents and anchor-preserving fragments;
- exact-token and PostgreSQL lexical indexes;
- deterministic structural relations and identity/ACL projections;
- deterministic heading/section hierarchy;
- optional embeddings.

A generation is published only as one coherent tenant/repository/ref/commit view. Queries
never combine refs, ACL states, or partially built projectors. Indexes rebuild from
canonical evidence and immutable knowledge.

The hierarchy is owned by Jina. A deterministic adapter is the active fallback. PageIndex
is represented by an optional adapter behind the same hierarchy port, but no PageIndex
client or dependency is wired into production. It remains disabled until long-document
evaluation proves an incremental win including citation integrity, ACL isolation,
latency, cost, and data-egress review.

The dense port, PostgreSQL lifecycle adapter, and retriever exist, but no dense route is
advertised unless a generation declares the capability. Dense remains disabled until an
approved model/backend passes the ablation gate.

## Query engine

`POST /context/query` and MCP `query_context` use one storage-neutral contract:

1. authenticate the credential and bound principal;
2. resolve repository ACL, requested ref, and one published generation;
3. plan exact, structured, structural, lexical, knowledge, temporal, hierarchy, and/or
   bounded long-context routes;
4. retrieve ACL-filtered candidates and fuse them deterministically;
5. surface conflicts and coverage gaps;
6. assemble an evidence pack from original source spans;
7. synthesize and verify every returned citation.

Exact and structured candidates cannot be displaced by weaker semantic matches. A
response always reports the generation/ref/commit, original-evidence citations,
conflicts, ambiguities, coverage, retrievers used, and trace ID.

## Public surfaces

The implemented context HTTP surface is:

```text
POST /context/build
POST /context/query
GET  /context/generations
GET  /context/generations/:id
GET  /context/documents
GET  /context/documents/:revisionId
GET  /context/structure
GET  /context/metrics
POST /context/knowledge/:revisionId/review
POST /context/rebuild
POST /context/erasure
```

Generation and document lists use opaque cursor pagination. Metrics, rebuild, and erasure
are tenant-administrator operations; review additionally requires access to the
revision's repository. `POST /context/build` accepts optional `commitSha` and
`githubInstallationId` fields. Signed push builds supply both from the verified webhook;
trusted manual callers must supply the installation ID when private access should use the
GitHub App.

`POST /mcp` is stateless Streamable HTTP MCP. Server `jina-context` exposes exactly one
read-only tool: `query_context`. Storage primitives and retriever controls are not public
MCP tools.

## Persistence and idempotency

The board snapshot lives in `jina_runtime.api_state`; GitHub delivery IDs are unique in
`jina_runtime.github_deliveries`. The context engine owns `jina_context`.

Canonical objects and knowledge revisions use stable fingerprints over immutable input.
Consumers own their outbox delivery and checkpoint. Generation identity includes tenant,
repository, ref, exact commit, evidence fingerprint, and projector versions. Replaying
the same input converges, while a moved ref produces a new isolated generation.

## Authentication and security

Health, task definitions, and signed webhook intake are public. `INTERNAL_API_TOKEN`
authorizes board, worker, and administration traffic. `CONTEXT_API_TOKEN` is a narrower
server-side credential for `/context/*`, `/mcp`, and exact ACL synchronization.

Context reads also require `x-jina-principal-id`; shared tenancy additionally carries the
resolved tenant. Repository permissions are applied before candidate creation and checked
again before citations leave the API. Tenant administrators can view metrics and issue
rebuild/erasure commands. Browser MCP origins must match `JINA_MCP_ALLOWED_ORIGINS`.

Repository credentials stay in the worker. Daytona isolates source inspection. Jina does
not execute untrusted repository code or install its dependencies. Retrieved text and
model output are untrusted and cannot change scope, tools, ACLs, or citation policy.

## Code boundaries

- `apps/*` owns HTTP, process startup, external I/O, and runtime wiring.
- `packages/board` owns generic workflow state.
- `packages/context-engine` owns evidence, knowledge, projection, retrieval, and ports.
- `packages/db/src/context` implements durable domain-specific adapters and roles.
- `packages/github`, `packages/daytona`, and `packages/ai` adapt external systems.
