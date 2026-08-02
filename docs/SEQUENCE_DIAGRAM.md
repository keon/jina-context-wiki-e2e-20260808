# Sequence diagrams

## GitHub trigger and branch policy

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant API as Jina API
    participant B as Board

    GH->>API: Signed webhook
    API->>API: Verify signature and delivery ID
    alt Branch push with new head
        API->>B: Build branch ref at event head SHA
    else PR opened or synchronized
        API->>B: Build pull/<number>/head at PR head SHA
    else Issue opened
        API->>B: Build repository default branch
    else Comment, edit, review, label, close, or duplicate head
        API-->>GH: Accepted, no context build
    end
```

## Context build and resumable publication

```mermaid
sequenceDiagram
    participant B as Board
    participant W as Context worker
    participant API as Jina API
    participant PG as PostgreSQL
    participant C as Codex
    participant GCS as GCS
    participant PI as Local PageIndex

    B->>W: Lease snapshot-context-input
    W->>W: Clone/fetch authoritative ref
    W->>W: Verify exact expected head SHA
    W->>W: Read manifest, files, Git history, PRs, issues
    W->>API: Commit immutable input boundary
    API->>GCS: Store evidence-snapshot artifact
    API->>PG: Commit evidence checkpoint
    W->>B: Complete snapshot task

    B->>W: Lease research-plan task
    W->>C: Discover bounded repository-specific research
    C-->>W: Artifact-backed research work specifications
    W->>B: Add research tasks and publication-plan join
    par Independent research tasks
        B->>W: Lease subject research
        W->>C: Inspect checkpoint source and history
        C-->>W: Evidence-grounded report
        W->>GCS: Store immutable report
        W->>B: Complete research task with artifact digest/reference
    end

    B->>W: Lease publication-plan task
    W->>C: Synthesize engineering-documentation tree
    C-->>W: Page work specifications and maintenance-task catalog
    W->>B: Add one aggregate per page plus final gates

    par Independent page aggregates
        B->>W: Lease write-context-page
        W->>C: Write one page from bounded evidence packets
        C-->>W: Markdown page
        W->>API: Validate identity, ranges, exact anchors, and structure
        API->>GCS: Store immutable page checkpoint
        W->>B: Complete writer task
        B->>W: Lease independent audit-context-page
        W->>C: Audit exact claim spans against supplied evidence
        alt Unsupported claim
            C-->>W: Citation findings
            W->>GCS: Store audit artifact
            W->>B: Add repair and replacement-audit tasks atomically
        else Every claim supported
            W->>B: Complete page audit
        end
    end

    B->>W: Lease source challenge and context-only task evaluation
    W->>GCS: Store digest-bound findings and attempts
    B->>W: Lease certification for unchanged complete snapshot
    B->>W: Lease fenced publish-context-release
    W->>API: Submit certified bytes under task/attempt/lease/write fence
    API->>PG: Atomically publish complete immutable release
    API->>GCS: Store release bundle
    B->>W: Lease index-context-release
    W->>PI: Build hierarchy from published derived Markdown
    PI-->>W: Deterministic nodes
    W->>GCS: Store immutable PageIndex tree
    W->>API: Attach tree under task/attempt/lease/write fence
    API->>PG: Idempotently attach hierarchy to published release
    W->>B: Complete PageIndex task
    B->>B: Complete root build
```

If a worker crashes, loses its lease, or reaches its time budget, its immutable
checkpoints and verified sibling page tasks remain. The expired task is reclaimed with a
new attempt and fence token. Before every expensive model call, the worker reads the
input-bound phase checkpoint; immediately after the call it records the immutable result
before parsing, deterministic validation, or a bounded correction. The new attempt
therefore resumes at the first unfinished model boundary. File-producing phases restore
the exact private Markdown snapshot from GCS. No unaudited partial release becomes
queryable.

If `main` moves after the build has invested work, admission records only the newest
follow-up on the same Board root and lets the current sequence finish. Completion
atomically publishes the old sequence, then the API promotes the queued head with that
release as its prior-context seed. Worker claim reconciliation repeats the promotion
idempotently after an API crash. PR synchronize events remain freshness-first and cancel
the stale preview immediately.

## Incremental commit, PR, and issue

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant API as Jina API
    participant B as Board
    participant W as Context worker
    participant C as Codex

    GH->>API: New commit, PR head, or opened issue
    API->>B: Admit a newer ref-sequence build
    B->>W: Snapshot exact commit and bounded provider history
    W->>API: Resolve latest eligible release for the same ref
    API-->>W: Prior derived pages and citations
    B->>W: Lease bounded research/page tasks
    W->>C: Prior context + current snapshot + changed history
    C->>C: Investigate affected and newly discovered subjects
    C-->>W: Research, page, audit, or repair artifact
    W->>B: Complete task; expand or join the graph
    B->>W: Certify, atomically publish, then index the complete successor
```

## Deterministic search without answer generation

```mermaid
sequenceDiagram
    participant A as Coding/review agent
    participant API as Context API
    participant PG as PostgreSQL

    A->>API: POST /context/search
    API->>PG: Resolve token, tenant, principal, repository ACL
    API->>PG: Load authorized immutable release and compact tree
    API->>API: Lexically score title/summary/document text
    API->>PG: Hydrate selected derived documents/fragments/citations
    API-->>A: Context excerpts + original evidence citations
    Note over API,A: No model is invoked and no answer is synthesized
```

All four retrieval tools are model-free. The calling coding or review agent performs any
reasoning over the returned cited context.

## MCP

```mermaid
sequenceDiagram
    participant A as Local agent
    participant MCP as Jina MCP
    participant API as Context handlers

    A->>MCP: initialize
    A->>MCP: tools/list
    MCP-->>A: search_context, list_context, read_context, diff_context
    A->>MCP: tools/call search_context
    MCP->>API: Authorized context search
    API-->>MCP: Structured context pack
    MCP-->>A: Text + structured content
```

The Streamable HTTP server is stateless per request. All tools are annotated read-only,
idempotent, non-destructive, and closed-world.

## Tenant-scoped token

```mermaid
sequenceDiagram
    participant O as Tenant owner
    participant API as Jina API
    participant PG as PostgreSQL
    participant A as Agent

    O->>API: Mint token with principal, scopes, expiry
    API->>PG: Store SHA-256 token hash and tenant/principal binding
    API-->>O: Return plaintext token once
    A->>API: Context request with Bearer jina_atk_...
    API->>PG: Hash and verify live token row
    PG-->>API: Tenant, principal, scopes
    API->>PG: Check repository ACL and release authorization
    API-->>A: Scoped context or uniform refusal
```

## Invalidation, erasure, and rebuild

```mermaid
sequenceDiagram
    participant O as Tenant owner
    participant API as Jina API
    participant PG as PostgreSQL

    alt Reject or invalidate a context revision
        O->>API: Append governance event
        API->>PG: Record immutable event
        API->>PG: Invalidate affected releases
    else Erase source evidence
        O->>API: Create erasure filter
        API->>PG: Record audit and projection-input event
        API->>PG: Invalidate affected releases
    else Rebuild
        O->>API: Rebuild latest checkpoint
        API->>PG: Materialize a new derived-only release
    end
```

## Production acceptance

```mermaid
sequenceDiagram
    participant CI as Deployment job
    participant API as Production API
    participant W as Context worker
    participant MCP as MCP client

    CI->>API: Merge fixture repository into reader ACL
    CI->>API: Start context build as tenant administrator
    API->>W: Execute ingest, derive, and index
    CI->>API: Wait for all required stages
    CI->>API: List releases and context documents
    CI->>API: Search with bound non-admin token
    CI->>MCP: Verify exact four tools and call search_context
    CI->>API: Require zero projection backlog
    CI-->>CI: Pass release
```
