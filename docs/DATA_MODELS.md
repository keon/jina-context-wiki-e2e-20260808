# Data models

This document distinguishes deployed storage from planned relational entities. Executable definitions remain authoritative: `CONTEXT_GRAPH_SCHEMA_SQL` in `packages/db/src/postgres-context-graph-store.ts` and the board types in `packages/board`.

## Implemented runtime state

The generic board currently uses two tables:

- `jina_runtime.api_state` stores the versioned JSON board snapshot, tracked pull requests, publications, and delivery sequence.
- `jina_runtime.github_deliveries` uniquely records processed GitHub delivery IDs.

The snapshot contains tasks, dependency edges, task events, and durable outbox messages. Task IDs and dedupe keys make planning idempotent. Outbox messages carry renewable lease IDs and expirations; completion requires the current lease. Every mutation is tenant-scoped and runs under a cross-instance transaction lock.

## Implemented ContextGraph schema

ContextGraph is normalized under `jina_context_graph`:

| Area               | Tables                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Source intake      | `observations`                                                                                 |
| Repository history | `commits`, `refs`, `commit_changes`                                                            |
| Parsed code        | `blobs`, `blob_analyses`, `blob_symbols`, `blob_imports`, `symbol_edges`                       |
| Knowledge          | `entities`, `identities`, `entity_redirects`, `assertions`, `assertion_relations`, `audit_log` |
| Projection control | `outbox`, `erasure_filters`, `repository_acl`, `retrieval_metrics`                             |
| Read models        | `ref_manifest`, `search_documents`, `graphs`, `graph_heads`, `nodes`, `edges`                  |

`commits` records each immutable commit's exact path/blob tree; `commit_changes` records first-parent churn. `ref_manifest` is the disposable current-ref projection. Blob analysis is keyed by tenant, content hash, and parser version.

Entities have stable natural keys. Identities and redirects reconcile provider identifiers without rewriting assertion history. Assertions retain status, confidence, typed qualifiers, checked evidence, an immutable explanation, generator/registry versions, validity, supersession, confirmation time, and audit provenance. Model facts begin as proposals; reviewed facts are projected only while their cited source paths still match canonical content.

Canonical outbox deliveries are consumer-owned so manifest, search, reconciliation, and graph consumers acknowledge their own work independently. Graphs are immutable and content-addressed; `graph_heads` selects the current generation per ref. Counterfactual retrieval changes no persisted state.

## Implemented invariants

- Every ContextGraph row is tenant-scoped, including relationship and provenance foreign keys.
- Repository reads and mutations pass repository ACL checks.
- Deliveries, observations, blobs, assertions, outbox events, and graphs use idempotent keys.
- Live assertion uniqueness and cardinality-one relationships are serialized by partial indexes and locks.
- Canonical facts remain separate from rebuildable manifest, search, and graph projections.
- Schema migration is administrative; runtime capability roles do not own or alter the schema.
- Source-like content is retained only according to lifecycle/erasure policy.

## Planned relational board model

The following groups are design targets, not current tables:

| Area      | Planned entities                                                           |
| --------- | -------------------------------------------------------------------------- |
| Tenancy   | tenants, users, memberships, GitHub identities/installations/repositories  |
| Intake    | pull requests, GitHub subjects, webhook events, review-policy snapshots    |
| Board     | tasks, task dependencies, task events, context items, outbox               |
| Execution | task runs, gates, harness versions, agents, review profiles, checkouts     |
| Review    | review runs, findings, finding threads, candidate findings                 |
| Usage     | per-call model usage, run billing, tenant billing policy                   |
| Effects   | command invocations, publications, artifacts                               |
| Dashboard | board, timeline, dependency, review, publication, and checkout read models |

The target retains these contracts:

- A pipeline is versioned code until tenant-configurable pipelines have a second real use.
- Task creation dedupes by tenant, task type, and workflow-owned key; PR task keys are epoch-scoped.
- Required dependency edges alone determine readiness and aggregate completion.
- Task events use a per-task sequence for timelines and a global cursor for the board feed.
- The transition to `queued` and its outbox row commit together.
- A task describes work; task runs describe individual attempts and preserve head-SHA/epoch fencing.
- Commands record actor, authorization, idempotency key, input, result, and rejection reason.
- External effects use stable keys such as task/head/publication target so retries update rather than duplicate.
- Findings dedupe by normalized fingerprint while threads retain cross-run history.
- Large prompts, context bundles, tool traces, and patches belong in artifact storage rather than primary rows.

Deferred `work_orders` become useful only with a second intake provider. Pipeline/stage-template tables become useful only when tenants can configure pipelines.

See [CONTEXT_GRAPH.md](CONTEXT_GRAPH.md) for ingestion and retrieval behavior, [BILLING.md](BILLING.md) for the provisional billing design, and [DEPLOYMENT.md](DEPLOYMENT.md) for migration commands and capability roles.
