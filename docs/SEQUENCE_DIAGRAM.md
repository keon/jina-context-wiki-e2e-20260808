# Current Sequence Diagrams

These diagrams describe the implementation deployed by `.github/workflows/ci-deploy.yml` as of 2026-07-19. They intentionally exclude the Trigger.dev and normalized-storage target designs in [ARCHITECTURE.md](ARCHITECTURE.md).

The board reducer is the orchestrator. Workers never mutate board state directly: they claim a durable outbox lease through the API, perform external work outside the API mutation lock, renew the lease while active, and complete through the API.

## Signed GitHub intake

```mermaid
sequenceDiagram
    autonumber
    participant GitHub
    participant API as jina-api
    participant DB as Cloud SQL PostgreSQL

    GitHub->>API: POST /webhooks/github
    API->>API: Verify HMAC, event type, delivery ID
    API->>DB: Check unique delivery ID
    alt duplicate delivery
        API-->>GitHub: 200 duplicate
    else supported PR or issue event
        API->>API: Plan tasks and dependencies
        API->>API: Reduce readiness and create outbox messages
        API->>DB: Commit delivery ID + board snapshot
        API-->>GitHub: 202 accepted
    else ignored event
        API->>DB: Commit delivery ID
        API-->>GitHub: 200 acknowledged
    end
```

An opened pull request creates `pr_review`, `review_pass`, and `publish` tasks. A `synchronize` event supersedes non-terminal tasks from the old epoch and creates the next epoch. An opened issue creates one manual `issue_triage` card.

## Durable review and publication flow

```mermaid
sequenceDiagram
    autonumber
    participant Worker as jina-task-worker
    participant API as jina-api
    participant DB as Cloud SQL
    participant GitHub
    participant OpenAI as OpenAI Responses API

    loop poll
        Worker->>API: POST /internal/worker/claim topics=[run-review,...]
        API->>DB: Lease eligible tenant outbox message
        API->>DB: Transition review task to in_progress
        API-->>Worker: message, lease ID, task metadata
    end
    par external work
        Worker->>GitHub: Read PR metadata and diff
        Worker->>OpenAI: Strict review findings schema
        OpenAI-->>Worker: Summary and findings
    and lease heartbeat
        loop every 60 seconds
            Worker->>API: POST /internal/worker/renew
            API->>DB: Extend matching unexpired lease by five minutes
        end
    end
    Worker->>API: POST /internal/worker/complete
    API->>DB: Record result event, finish review, reduce board
    DB-->>API: Publish task becomes queued
    Worker->>API: Claim and complete run-publish
    API->>DB: Upsert internal publication record, finish aggregate
```

`run-publish` currently records the idempotent publication in Jina. It does not post a GitHub comment or check yet. `run-research` records its requested source context without arbitrary network retrieval, and `run-cleanup` acknowledges the cleanup task.

If a worker crashes, the leased message becomes claimable after expiration. A completion with the wrong, expired, or replaced lease returns `409` and changes no state.

## Incremental Ontology build

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant API as jina-api
    participant Worker as jina-ontology-worker
    participant GitHub
    participant Daytona
    participant Codex
    participant DB as Cloud SQL

    User->>API: POST /ontology/build repository, ref
    API->>DB: Create aggregate + ingest, assert, project children
    Worker->>API: Claim run-ontology-ingest lease
    Worker->>GitHub: Resolve ref and read recursive Git tree
    Worker->>API: Record immutable snapshot and request cache misses
    API->>DB: Upsert commit, ref, manifest, and blob identities
    DB-->>Worker: Previously unseen blob SHAs only
    Worker->>GitHub: Read and parse only missing blobs
    Worker->>API: Store versioned symbols/imports and complete ingestion
    API->>DB: Queue assertion task with commit and first-parent changed paths
    Worker->>API: Claim run-ontology-assert and check generation cache
    alt assertion input already processed
        API-->>Worker: Reuse checkpoint
    else new content needs semantic analysis
        Worker->>Daytona: Clone and checkout immutable commit SHA
        Worker->>Codex: Analyze first-parent changed paths with semantic-only cited schema
        Codex-->>Worker: Cited semantic relationships
        Worker->>Daytona: Validate every cited file and line range
        Worker->>API: Complete with model-output observation
        API->>DB: Apply registry validation and store assertions
    end
    Worker->>API: Claim run-ontology-project
    API->>DB: Join manifest, cached code facts, and active current-evidence assertions
    API->>DB: Store immutable rebuildable graph projection
    API->>DB: Complete projection and aggregate tasks
    API-->>Worker: accepted + graph ID
```

Graph identity includes the task generation, so a later projection cannot rewrite a graph referenced by an older task. Blob parsing is keyed by tenant, blob SHA, and parser version. Assertion generation is cached by repository commit and generator version, and projections carry forward assertions only while every cited path still resolves to the same blob.

## PR epoch supersession

```mermaid
sequenceDiagram
    autonumber
    participant GitHub
    participant API
    participant DB as Cloud SQL
    participant Worker

    GitHub->>API: pull_request synchronize with new head SHA
    API->>DB: Load current board snapshot
    API->>API: Increment epoch and supersede old non-terminal tasks
    API->>API: Plan new review graph and outbox
    API->>DB: Commit delivery + new snapshot
    alt old worker finishes after supersession
        Worker->>API: Complete old leased task
        API->>API: Recheck current task status and lease
        API-->>Worker: 409 stale lease
    end
```

## Dashboard authentication and reads

```mermaid
sequenceDiagram
    autonumber
    participant Browser
    participant IAP as Cloud Run IAP
    participant Dashboard as jina-dashboard
    participant API as jina-api
    participant DB as Cloud SQL

    Browser->>IAP: Open dashboard URL
    IAP->>IAP: Google sign-in and access policy
    IAP->>Dashboard: Authenticated request
    Dashboard-->>Browser: Board, task types, or Ontology page
    Browser->>Dashboard: GET /api/board, /events, /task-types, or /ontology
    Dashboard->>API: Proxy allowlisted read + internal bearer token
    API->>API: Resolve canonical omlabs tenant
    API->>DB: Tenant-scoped query
    API-->>Dashboard: Read model
    Dashboard-->>Browser: JSON
```

Each page polls only the endpoints it needs. The Ontology list request returns the latest full graph and lightweight summaries for older generations; historical node and edge collections are loaded only through graph detail.

## Local development difference

`pnpm dev` uses memory stores unless database variables are present. It enables the unsigned `/dev/webhooks/github` endpoint, can seed a demo PR, and may simulate non-Ontology task completion with an in-process timer. All three features are disabled in production; production work is handled only by the durable workers above.
