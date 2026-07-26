# Architecture

This document describes the deployed runtime. Persisted structures are in
[DATA_MODELS.md](DATA_MODELS.md), request flows in
[SEQUENCE_DIAGRAM.md](SEQUENCE_DIAGRAM.md), and the rationale in
[CONTEXT_ENGINE_DECISION.md](CONTEXT_ENGINE_DECISION.md).

## Topology

The release runs as five Cloud Run services against one shared PostgreSQL database:

- `jina-api` verifies GitHub webhooks, serves board and context APIs, serves stateless MCP,
  and owns worker lease/completion transactions.
- `jina-task-worker` handles review, research, publication, and cleanup topics.
- `jina-context-worker` handles `ingest-evidence`, `derive-knowledge`, and
  `index-context`.
- `jina-dashboard` serves the operator board and repository context workspace.
- `jina-admin` serves tenant-wide context health and administrative views behind
  server-side authentication.

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

`ingest-evidence` resolves the requested ref to a full commit SHA, performs a full
blob-filtered (non-shallow) clone, and checks out that exact commit. It stores immutable
provider observations, the exact tree, content-addressed blobs, bounded commit/parent
history, first-parent changes, deterministic parser analyses, symbols, imports,
structural facts, identities, and ACL observations. Webhook builds carry their GitHub App
installation ID; the worker mints a short-lived installation token and keeps it only for
the active lease's Git and REST work. Oversized or binary content may be omitted from
stored body text, but its manifest identity remains.

Each checkpoint records `sourceCompleteness` as `complete` or `partial`. Its observation
frontier records the observed Git commit count and oldest commit, whether the configured
Git bound reached history root, per-source GitHub pagination status/reason, and omitted
file paths. GitHub 403/404 responses and configured history limits produce a truthful
partial checkpoint rather than an empty source represented as complete. Partial
generations remain queryable, but responses add `source-completeness:partial` to missing
coverage.

Evidence is canonical. Model output cannot alter Git/provider facts, parser output,
permissions, or audit events.

### Knowledge

`derive-knowledge` selects a bounded bundle from one evidence checkpoint and asks the
isolated Daytona executor for knowledge documents, not nodes or relationships.
`KnowledgeOutputValidator` resolves stable logical subjects and checks each citation's
tenant, repository, source identity, digest, commit, path/range, and JSON pointer before
the immutable revision is stored. A citation may select a complete evidence body, an
exact inclusive line range, or an RFC 6901-style JSON pointer, but it cannot mix line and
JSON selectors. The normalized citation claim must occur verbatim in the exact selected
excerpt; support from a nearby line or different JSON field is rejected. Invalid output
receives at most one constrained repair.

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

Canonical writes create one durable outbox delivery per named projection consumer.
Each consumer runs in its own capability-role transaction, claims independently with a
consumer-specific lease ID, writes only its projection, and completes its own checkpoint.
Acknowledgements require the current, unexpired delivery lease and exact scoped event.
Repository-global ACL/erasure events remain pending until every current ref has rebuilt;
older ref/commit deliveries are acknowledged only as proven superseded work. A ref-scoped
advisory lock and newest-checkpoint barrier prevent an older build from replacing a newer
generation. The repository access fingerprint is part of both generation identity and
generation output fingerprint. ACL mutation, ACL projection, and final publication share a
repository access lock and revalidate that fingerprint, so a revoke during indexing forces
a retry instead of publishing mixed ACL state. Query authorization also checks the current
ACL observation rather than trusting a historical generation projection.
`POST /internal/context/outbox/drain` selects only current checkpoints and actually re-runs
the same idempotent `index-context` path.

The hierarchy is owned by Jina. A deterministic adapter is the active fallback. PageIndex
is represented by an optional adapter behind the same hierarchy port, but no PageIndex
client or dependency is wired into production. It remains disabled until long-document
evaluation proves an incremental win including citation integrity, ACL isolation,
latency, cost, and data-egress review.

The dense port, PostgreSQL lifecycle adapter, and retriever exist, but no dense route is
advertised unless a generation declares the capability. Dense remains disabled until an
approved model/backend passes the ablation gate. Its dormant SQL path already applies the
same all-required-fingerprint ACL predicate as lexical/hierarchy hydration; `"*"` has no
privileged meaning.

## Query engine

`POST /context/query` and MCP `query_context` use one storage-neutral contract:

1. authenticate the credential and bound principal;
2. resolve the principal's repository ACL fingerprints, requested ref, and one published
   generation;
3. plan exact, structured, structural, lexical, knowledge, temporal, hierarchy, and/or
   bounded long-context routes;
4. load only ACL-authorized projection rows, retrieve candidates, and fuse them
   deterministically;
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

Generation and document lists use opaque cursor pagination. Metrics, rebuild, erasure,
and knowledge review are tenant-administrator operations. Review also checks that the
selected revision belongs to the principal's tenant; repository read access alone cannot
append a review event. `POST /context/build` accepts optional `commitSha` and
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
Consumers own independent outbox deliveries, leases, and checkpoints. Generation identity
includes tenant, repository, ref, exact commit, evidence fingerprint, source-completeness
frontier, and projector versions. Replaying the same input converges, while a moved ref
produces a new isolated generation.

## Authentication and security

Health, task definitions, and signed webhook intake are public. `INTERNAL_API_TOKEN`
authorizes board, worker, and administration traffic. `CONTEXT_API_TOKEN` is a narrower
server-side credential for `/context/*`, `/mcp`, and exact ACL synchronization.

Context reads also require `x-jina-principal-id`; shared tenancy additionally carries the
resolved tenant. Current ACL observations resolve that principal to exact repository ACL
fingerprints. PostgreSQL applies those fingerprints while hydrating documents, fragments,
exact terms, hierarchy nodes, manifests, and current knowledge, before retrievers can
create candidates; structural relations are retained only when all anchors belong to the
authorized document set. Citations are checked again before they leave the API. Tenant
administrators can view metrics, review knowledge, and issue rebuild/erasure commands.
Browser MCP origins must match `JINA_MCP_ALLOWED_ORIGINS`.

The schema-owning migration login is separate from the application login. The migration
installs focused NOLOGIN capability roles, marks the runtime login `NOINHERIT`, and grants
it role membership. Runtime services do not manage schema and have no ambient context
table privileges: each database operation runs in a transaction and activates its
declared capability with `SET LOCAL ROLE`.

Repository credentials stay in the worker. Daytona isolates source inspection. Jina does
not execute untrusted repository code or install its dependencies. Retrieved text and
model output are untrusted and cannot change scope, tools, ACLs, or citation policy.

## Code boundaries

- `apps/*` owns HTTP, process startup, external I/O, and runtime wiring.
- `packages/board` owns generic workflow state.
- `packages/context-engine` owns evidence, knowledge, projection, retrieval, and ports.
- `packages/db/src/context` implements durable domain-specific adapters and roles.
- `packages/github`, `packages/daytona`, and `packages/ai` adapt external systems.
