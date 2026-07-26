# Sequence diagrams

These are the implemented context-engine and board flows. All context identities include
tenant and repository scope even where the diagrams abbreviate them.

## Signed push to exact-commit build

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant API as jina-api
    participant ID as Shared identity
    participant DB as PostgreSQL

    GH->>API: POST /webhooks/github (signed push, delivery ID, head SHA)
    API->>API: Verify HMAC and parse unmodified body
    API->>ID: Resolve installation/repository tenant
    ID-->>API: Original tenant UUID
    API->>DB: Lock board snapshot and dedupe delivery ID
    API->>DB: Create build-context and three stages
    Note over API,DB: Build metadata carries repository, ref, event head SHA, and installation ID
    API-->>GH: 202 accepted
```

An unchanged head deduplicates. A moved ref supersedes active older work. The worker later
verifies that the checked-out commit is exactly the requested full SHA.

## Context stage DAG

```mermaid
flowchart LR
    B["build-context"] --> I["ingest-evidence (required)"]
    I --> X["index-context baseline (required)"]
    I --> K["derive-knowledge (optional)"]
    K --> E["index-context enriched successor"]
    X --> Q["query_context available"]
    E --> Q
```

The board aggregate can serve a baseline generation without model output. Production
acceptance waits for all three stages and requires the enriched successor so it exercises
the complete release path.

## Ingest immutable evidence

```mermaid
sequenceDiagram
    participant W as jina-context-worker
    participant API as jina-api
    participant Git as Git/GitHub
    participant CE as context-engine
    participant DB as jina_context

    W->>API: POST /internal/worker/claim (run-ingest-evidence)
    API-->>W: task, lease, attempt, write-fence token
    W->>Git: Mint installation token; full blob-filtered clone and paginated provider history
    W->>Git: Resolve and checkout exact commit SHA
    W->>W: Persist bounded commit/parent history; enumerate full manifest
    W->>W: Record Git/GitHub frontiers and omitted bodies as complete or partial
    W->>API: POST /internal/context/ingest (lease + evidence input)
    API->>API: Validate topic, lease, attempt, and fence
    API->>CE: IngestEvidenceService.ingest
    CE->>CE: Hash evidence and run deterministic parser
    CE->>DB: Immutable evidence, Git objects, ACL observation, checkpoint, outbox
    DB-->>CE: Evidence checkpoint and fingerprint
    API-->>W: checkpoint ID, commit SHA, fingerprint
    W->>API: Complete board stage with checkpoint metadata
```

Partial trees and unverified commit identity fail closed. A reached Git/GitHub bound,
unavailable optional provider source, or omitted body is committed truthfully as a
`partial` checkpoint with a machine-readable frontier; query coverage then reports that
partial state. Retries converge by immutable object and input fingerprints. A stale lease
cannot commit.

## Baseline and enriched generations

```mermaid
sequenceDiagram
    participant IW as Index worker
    participant KW as Knowledge worker
    participant API as jina-api
    participant DX as Daytona executor
    participant DB as jina_context

    par Required baseline
        IW->>API: POST /internal/context/index (checkpoint + fence)
        API->>DB: Build manifest, documents/fragments, exact/lexical, structure, hierarchy, ACL
        DB->>DB: Check required projector barrier
        DB-->>API: Atomically published baseline generation
    and Optional knowledge
        KW->>API: POST /internal/context/derive/prepare
        API->>DB: Select bounded immutable evidence bundle
        API-->>KW: Prompt and evidence bundle
        KW->>DX: Run knowledge-document generator at pinned checkout
        DX-->>KW: Untrusted JSON document output
        KW->>API: POST /internal/context/derive/commit (fence + raw output)
        API->>DB: Resolve exact range/JSON excerpts and validate terminal source citations
        API->>DB: Require each normalized claim verbatim in its selected evidence excerpt
        alt valid
            DB->>DB: Append derivation run, revisions, evidence, events
            DB->>DB: Publish enriched successor generation
        else invalid
            API-->>KW: Diagnostics for one bounded repair
        end
    end
```

The baseline contains raw evidence as indexable context documents. Derived knowledge is
also projected as indexable documents, but its answer citations expand through immutable
revision evidence to original blobs, observations, commits, pull requests, or issues.

Each projector claims its own durable outbox delivery and lease. Publication acknowledges
only deliveries for that consumer and exact tenant/repository/ref/commit checkpoint.
`POST /internal/context/outbox/drain` finds pending checkpoints and replays this idempotent
index path; it is not a metrics-only no-op.

## HTTP query

```mermaid
sequenceDiagram
    participant C as Trusted client
    participant API as jina-api
    participant DB as jina_context
    participant QE as Query engine

    C->>API: POST /context/query (context token, bound principal, repository/ref/question)
    API->>DB: Resolve principal repository access and ACL fingerprints
    DB-->>API: Authorized repository and exact fingerprint set
    API->>DB: SQL-filter one published generation by those fingerprints
    API->>QE: Plan task-specific routes
    par deterministic routes
        QE->>DB: Exact/structured/structural retrieval
    and text routes
        QE->>DB: Lexical/knowledge/temporal retrieval
    and long-form routes
        QE->>DB: Hierarchy and bounded long-context retrieval
    end
    DB-->>QE: Only authorized rows; candidates with original evidence anchors
    QE->>QE: Deduplicate, fuse, detect conflicts, assess coverage
    QE->>QE: Assemble evidence pack, synthesize, verify citations
    QE->>DB: Persist bounded query telemetry
    API-->>C: Answer, generation/ref/commit, citations, conflicts, coverage, trace ID
```

SQL filtering occurs while hydrating documents, fragments, exact entries, hierarchy,
manifest, and current knowledge, before candidate creation. Structural relations survive
only when every anchor belongs to the authorized document set. Dense retrieval joins only
when a generation advertises an evaluated/available embedding capability; it is disabled
in the current release.

## Stateless MCP query

```mermaid
sequenceDiagram
    participant MC as MCP client
    participant API as jina-context MCP server
    participant QE as Query engine

    MC->>API: POST /mcp initialize (context token + bound principal)
    API-->>MC: Stateless Streamable HTTP response
    MC->>API: tools/list
    API-->>MC: query_context only
    MC->>API: tools/call query_context
    API->>QE: Same QueryContextRequest as HTTP
    QE-->>API: Storage-neutral cited response
    API-->>MC: Text plus structuredContent
```

MCP callers cannot select SQL, retrievers, generation internals, or mutation tools.

## Knowledge review

```mermaid
sequenceDiagram
    participant O as Tenant administrator
    participant API as jina-api
    participant DB as jina_context

    O->>API: POST /context/knowledge/:revisionId/review
    API->>API: Require tenant-administrator identity
    API->>DB: Verify revision tenant and repository scope
    API->>DB: Append reviewed/rejected/invalidated event
    API->>DB: Rebuild from latest matching evidence checkpoint
    DB-->>API: Successor generation ID when applicable
    API-->>O: Immutable event and generation
```

The revision body and citations never change. Current selection is recomputed from the
append-only event history. A repository reader who is not a tenant administrator cannot
append review state.

## Erasure and rebuild

```mermaid
sequenceDiagram
    participant A as Tenant administrator
    participant API as jina-api
    participant DB as jina_context

    A->>API: POST /context/erasure (repository, source type/ID, reason)
    API->>DB: Append erasure filter and audit event
    DB->>DB: Remove affected query projections and invalidate generations
    API->>DB: Reindex latest checkpoint with filter applied
    DB-->>API: New generation or awaiting-reingestion
    API-->>A: Erased generation count and status
```

Reingestion checks the durable filter, so a rebuild cannot resurrect erased evidence,
knowledge citations, or query-visible documents.

## Deployment acceptance

```mermaid
sequenceDiagram
    participant CB as Cloud Build
    participant M as Migration owner job
    participant CR as Cloud Run
    participant A as Acceptance job

    CB->>M: Deploy/execute jina-context-migrate using audited image SHA
    M->>M: Install roles; make runtime login NOINHERIT and grant memberships
    M-->>CB: jina_context ready
    CB->>CR: Deploy API and verify /health
    CB->>CR: Deploy context worker and verify exact topics
    CB->>CR: Deploy task worker and verify exact topics
    CB->>CR: Deploy dashboard and admin from the same release build
    CB->>A: Execute production fixture build
    A->>CR: ACL sync, build, generation/doc/query checks
    A->>CR: Real MCP SDK tools/list and query_context
    A->>CR: Verify citations, commit, backlog, and removed route
    A-->>CB: Pass/fail summary
```

The operator creates and records the restorable Cloud SQL backup before this sequence.
Every context database transaction in the runtime explicitly activates its declared
capability with `SET LOCAL ROLE`.
