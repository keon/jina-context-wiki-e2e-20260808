# Data models

This document summarizes deployed storage. Executable definitions remain authoritative: `CONTEXT_GRAPH_SCHEMA_SQL` in `packages/db/src/context-graph-schema.ts` and the board types in `packages/board`.

## Implemented runtime state

The generic board currently uses two tables:

- `jina_runtime.api_state` stores the versioned JSON board snapshot, tracked pull requests, publications, and delivery sequence.
- `jina_runtime.github_deliveries` uniquely records processed GitHub delivery IDs.

The snapshot contains tasks, dependency edges, task events, and durable outbox messages. Task IDs and dedupe keys make planning idempotent. Outbox messages carry renewable lease IDs and expirations; completion requires the current lease. Every mutation is tenant-scoped and runs under a cross-instance transaction lock.

## Shared identity boundary

Production also reads four tables owned by the original Jina application in `public`: `tenants`, `tenant_members`, `installations`, and `repositories`. They are not v2 read models and are never migrated into a v2 schema. The `jina_v2_app` login has narrow `SELECT` grants on those tables, no original-application writes, and no access to session, OAuth, or integration-secret tables.

The original tenant UUID is stored as `tenantId` throughout the board and as the tenant key throughout `jina_context_graph`. Work metadata retains the external identity needed by operators and downstream projections:

- `workspaceLabel`, `githubAccountId`, and `githubAccountType` identify the original tenant's GitHub account;
- `authorGithubUserId`, `authorLogin`, and `authorAccountType` identify the PR or issue author;
- `senderGithubUserId`, `senderLogin`, and `senderAccountType` identify the webhook actor;
- `githubRepositoryId` and `githubInstallationId` preserve the resolved GitHub binding.

These values are provenance attached to tenant-scoped work; they do not create a parallel user or organization database. Dashboard search and task details use the workspace and author labels, while context graph observations normalize the same external identities into repository knowledge.

## Implemented context graph schema

The context graph is normalized under `jina_context_graph`:

| Area               | Tables                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Execution control  | `execution_settings`                                                                           |
| Source intake      | `observations`                                                                                 |
| Repository history | `commits`, `trees`, `refs`, `commit_changes`                                                   |
| Parsed code        | `blobs`, `blob_analyses`, `blob_symbols`, `blob_imports`, `symbol_edges`                       |
| Knowledge          | `entities`, `identities`, `entity_redirects`, `assertions`, `assertion_relations`, `audit_log` |
| Projection control | `outbox`, `erasure_filters`, `repository_acl`, `retrieval_metrics`                             |
| Read models        | `ref_manifest`, `search_documents`, `graphs`, `graph_heads`, `nodes`, `edges`                  |

`commits` records each immutable commit; `trees` stores the exact path/blob tree content-addressed by tree SHA; `commit_changes` records first-parent churn. `ref_manifest` is the disposable current-ref projection. Blob analysis is keyed by tenant, content hash, and parser version.

Entities have stable natural keys. Identities and redirects reconcile provider identifiers without rewriting assertion history. Assertions retain status, confidence, typed qualifiers, checked evidence, an immutable explanation, generator/registry versions, validity, supersession, confirmation time, and audit provenance. Model facts begin as proposals; reviewed facts are projected only while their cited source paths still match canonical content.

`execution_settings` stores one tenant-scoped assertion provider, model, optimistic revision, and optional encrypted
OpenRouter, OpenAI, and Codex auth envelopes. Public APIs expose only connection booleans. Ciphertext is bound to the
tenant and integration with AES-256-GCM associated data. General graph readers, projection roles, and query roles
cannot select this table; only the knowledge-capability writer can read or update it. A model-output observation
records the actual model provider and credential class after fallback, never the credential.

Canonical outbox deliveries are consumer-owned so manifest, search, reconciliation, and graph consumers acknowledge their own work independently. Graphs are immutable and content-addressed; `graph_heads` selects the current generation per ref. Counterfactual retrieval changes no persisted state.

## Implemented invariants

- Every context graph row is tenant-scoped, including relationship and provenance foreign keys.
- Repository reads and mutations pass repository ACL checks.
- Deliveries, observations, blobs, assertions, outbox events, and graphs use idempotent keys.
- Live assertion uniqueness and cardinality-one relationships are serialized by partial indexes and locks.
- Canonical facts remain separate from rebuildable manifest, search, and graph projections.
- Schema migration is administrative; runtime capability roles do not own or alter the schema.
- Source-like content is retained only according to lifecycle/erasure policy.

See [CONTEXT_GRAPH.md](CONTEXT_GRAPH.md) for ingestion and retrieval behavior and [DEPLOYMENT.md](DEPLOYMENT.md) for migration commands and capability roles.
