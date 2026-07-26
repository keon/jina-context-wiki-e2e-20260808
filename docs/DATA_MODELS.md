# Data models

This document summarizes deployed storage. Executable definitions are authoritative:
`CONTEXT_SCHEMA_SQL` and `CONTEXT_PGVECTOR_SCHEMA_SQL` in
`packages/db/src/context/schema.ts`, roles in `packages/db/src/context/roles.ts`, and
generic board types in `packages/board`.

## Runtime state

- `jina_runtime.api_state` stores the versioned board snapshot, tracked pull requests,
  publications, and delivery sequence.
- `jina_runtime.github_deliveries` uniquely records processed GitHub delivery IDs.

The snapshot contains tasks, dependencies, task events, and durable deliveries. Every
mutation is tenant-scoped and protected by a cross-instance transaction lock. Completion
requires the current renewable lease.

## Context schema

The context engine is normalized under `jina_context`.

| Plane                  | Tables                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow               | `repositories`, `pipeline_builds`, `pipeline_stages`                                                                                                                                                                        |
| Evidence               | `observations`, `evidence_records`, `evidence_checkpoints`, `evidence_checkpoint_records`, `evidence_checkpoint_manifest`, `refs`, `commits`, `commit_parents`, `trees`, `tree_entries`, `blobs`, `commit_changes`          |
| Deterministic analysis | `blob_analyses`, `symbols`, `imports`, `structural_facts`, `evidence_checkpoint_structural_facts`, `entities`, `identities`                                                                                                 |
| Knowledge              | `derivation_runs`, `knowledge_documents`, `knowledge_document_revisions`, `knowledge_revision_evidence`, `knowledge_revision_events`                                                                                        |
| Governance             | `repository_acl_observations`, `erasure_filters`, `audit_events`, `outbox`                                                                                                                                                  |
| Generation control     | `index_generations`, `generation_projectors`, `projection_checkpoints`                                                                                                                                                      |
| Projections            | `ref_manifest`, `current_knowledge_revisions`, `context_documents`, `context_fragments`, `exact_index`, `context_embeddings`, `hierarchy_nodes`, `structural_relations`, `identity_projection`, `repository_acl_projection` |
| Query telemetry        | `query_runs`, `retrieval_candidates`, `answer_citations`, `retrieval_metrics`                                                                                                                                               |

### Evidence records and checkpoints

Evidence records share an `EvidenceAnchor`: tenant, repository, source type and ID,
content digest, and optional commit, path/range, JSON pointer, and observation time.
Checkpoints bind one evidence selection to an exact repository/ref/commit and
fingerprint. `source_completeness` is explicitly `complete` or `partial`; the
`observation_frontier` records the bounded Git history, GitHub pagination outcome, and
omitted bodies that led to that value. Git objects and content-addressed blobs remain
reusable across checkpoints; the checkpoint membership tables preserve what was valid
for that build.

Evidence records store base immutable bodies. Citation line ranges and JSON pointers are
selectors over those bodies rather than separate record identities. Resolution validates
the source identity and digest, then extracts exactly the requested inclusive lines or
JSON value. Mixed line/JSON selectors and out-of-bounds selectors do not resolve.

### Knowledge revisions

`knowledge_documents` provides a stable logical identity such as a repository
architecture, component, decision, change, incident, ownership record, or runbook.
`knowledge_document_revisions` stores immutable generated or human-authored bodies and
metadata. `knowledge_revision_evidence` is the ordered set of original source anchors.
State changes are append-only `knowledge_revision_events`; there is no mutable current
flag on the revision. The current selection is a disposable generation projection.

### Indexable context

`context_documents` is a retrieval envelope over source code, provider evidence, or
derived knowledge. It is not authoritative. `context_fragments` preserves exact source
and character ranges. Context added to improve retrieval is separate from source text so
it cannot be cited as source material.

Exact tokens and two generated `tsvector` forms preserve path/identifier and prose
semantics. Structural relations come only from deterministic parser/provider facts.
Hierarchy leaves map back to allowed source spans. Embeddings are optional and record
model, dimensions, input fingerprint, and projector version.

### Generations

An `index_generation` is an atomic view for one tenant, repository, ref, and commit.
Required projectors must be coherent before publication; optional projectors declare
`ready`, `disabled`, `skipped`, or `failed`. A raw-evidence baseline generation can be
published without model output, and successful derivation can publish an enriched
successor.

Consumers use independent outbox deliveries and checkpoints. A slow optional consumer
cannot acknowledge required projection work. Every delivery lease is consumer-owned, and
acknowledgement requires that exact unexpired lease. Projection publication acknowledges
only deliveries matching its tenant, repository, ref, commit, checkpoint/event, and
consumer. Rebuilds and the internal drain endpoint replay pending checkpoints into new
idempotent generations and never expose partial rows through query selection.

## Database invariants

- Repository-owned identities and foreign keys include tenant and repository scope.
- Immutable evidence, revision, and citation tables deny runtime `UPDATE` and `DELETE`.
- Full Git SHAs and source-specific evidence anchors are validated.
- Line ranges require a path and valid positive bounds.
- Knowledge citations terminate at evidence, never another generated revision. Citation
  claims must occur verbatim after whitespace/case normalization in the exact selected
  evidence excerpt.
- ACL projection is generation-scoped. Principal permissions resolve to exact repository
  ACL fingerprints, and SQL filters projection rows before candidate creation.
- Erasure filters are durable and checked during ingestion and rebuild.
- Exact, lexical, hierarchy, embedding, and relation projections are disposable.
- Query telemetry stores bounded metadata and citation checks, not unrestricted source
  text.

## Capability roles

The schema defines focused NOLOGIN roles:

`jina_context_coordinator`, `jina_context_ingest`, `jina_context_derive`,
`jina_context_manifest`, `jina_context_knowledge_current`, `jina_context_lexical`,
`jina_context_dense`, `jina_context_hierarchy`, `jina_context_structural`,
`jina_context_identity`, `jina_context_acl`, `jina_context_retention`,
`jina_context_query`, and `jina_context_admin`.

Application logins must not own the schema. The migration principal owns schema changes
and installs/grants the capability roles. The runtime login is `NOINHERIT`, so role
membership supplies no ambient table access. Every adapter operation begins a transaction,
executes `SET LOCAL ROLE <capability>`, and then performs only the reads/writes granted to
that capability. Production runs migration and runtime services with separate database
credentials.
