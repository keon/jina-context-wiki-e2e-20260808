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

A context build starts with only `ingest-evidence` queued; baseline `index-context` and
`derive-knowledge` are blocked. Successful ingestion queues only baseline indexing, and
successful baseline publication then queues required derivation/enriched publication.
The derivation stage permits one repair. If the repaired result or executor fails, the
root build fails even though the baseline generation remains available for diagnosis and
retry.
The store never exposes both projection-input-producing stages as simultaneously
claimable work.

`pipeline_builds.ref_sequence` is allocated monotonically under a
tenant/repository/ref advisory lock at build request time. Canonical ref-sensitive
evidence, knowledge, and generation transitions use the same lock key. The ingest stage
and resulting checkpoint retain that immutable sequence. Current-ref selection orders by
`ref_sequence`, not request timestamps, checkpoint creation time, or worker completion
time.

## Context schema

The context engine is normalized under `jina_context`.

| Plane                  | Tables                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow               | `repositories`, `pipeline_builds`, `pipeline_stages`                                                                                                                                                                        |
| Evidence               | `observations`, `evidence_records`, `evidence_checkpoints`, `evidence_checkpoint_records`, `evidence_checkpoint_manifest`, `refs`, `commits`, `commit_parents`, `trees`, `tree_entries`, `blobs`, `commit_changes`          |
| Deterministic analysis | `blob_analyses`, `symbols`, `imports`, `structural_facts`, `evidence_checkpoint_structural_facts`, `entities`, `identities`                                                                                                 |
| Knowledge              | `derivation_runs`, `knowledge_documents`, `knowledge_document_revisions`, `knowledge_revision_evidence`, `knowledge_revision_events`                                                                                        |
| Governance             | `repository_acl_observations`, `erasure_filters`, `audit_events`, `projection_input_events`, `outbox`                                                                                                                       |
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
for that build. The unique tenant/repository/ref/`ref_sequence` key preserves admission
order even when an older worker completes after a newer one.

Evidence records store base immutable bodies. Citation line ranges and JSON pointers are
selectors over those bodies rather than separate record identities. Resolution validates
the source identity and digest, then extracts exactly the requested inclusive lines or
JSON value. Mixed line/JSON selectors and out-of-bounds selectors do not resolve.

### Knowledge revisions

`knowledge_documents` provides a stable logical identity such as a repository
architecture, component, decision, change, incident, ownership record, or runbook.
`knowledge_document_revisions` stores immutable generated or human-authored bodies and
metadata. `knowledge_revision_evidence` is the ordered set of original source anchors.
Logical IDs are canonical lowercase and participate in stable revision identity only
after grounding: repository and change-commit portions come from the checkpoint, while
model-controlled subject and issue segments must be supported by resolved cited evidence.
The revision's ref/commit scope is always copied from that checkpoint.
State changes are append-only `knowledge_revision_events`; there is no mutable current
flag on the revision. The current selection is a disposable generation projection.
Selection requires every stored citation to match a record selected by the exact target
checkpoint on source type/ID and `content_digest`, plus commit/path identity when present.
Ref/commit equality alone is insufficient. Unchanged citation identities and digests may
reuse a revision across equivalent same-commit checkpoints; changed mutable provider
observations exclude stale PR/issue-derived revisions.
Terminal events (`rejected`, `superseded`, `invalidated`, `redacted`, or `expired`)
invalidate published generations for the revision's ref immediately.

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

The generation's `derivedKnowledge` capability state is computed from the exact
checkpoint's citation-valid revision set. `available` means at least one eligible
revision and complete eligible coverage of the logical IDs present for that checkpoint;
`partial` means only some checkpoint-valid logical IDs remain eligible; `unavailable`
means none do. Ref+commit-matching revisions with absent or changed citation evidence do
not affect this flag.

`projection_input_events` is the immutable repository-wide frontier for materialization
inputs. It assigns a monotonic sequence to evidence checkpoint commits, successful
knowledge runs, knowledge revision events, and erasures. `index_generations` persists the
fingerprint of the latest sequence/event sampled before materialization. The indexer
re-samples after materialization, and generation creation/publication lock and revalidate
the same fingerprint plus the latest per-ref checkpoint before a generation can become
visible.

Consumers use independent outbox deliveries and checkpoints. A slow optional consumer
cannot acknowledge required projection work. Every delivery lease is consumer-owned, and
each projector transaction activates only that consumer's capability role. Acknowledgement
requires the exact unexpired lease. Scoped deliveries match tenant, repository, ref,
commit, checkpoint/event, and consumer. Repository-global ACL/retention events use an
all-current-refs barrier. Pending evidence and knowledge deliveries whose source
checkpoint is below the newest admitted or committed sequence for that ref are marked
processed with a terminal superseded reason, without waiting for a newer checkpoint or
generation to publish. Rebuilds and the internal drain endpoint replay only current
checkpoints into new idempotent generations and never expose partial rows.

## Database invariants

- Repository-owned identities and foreign keys include tenant and repository scope.
- A build/checkpoint with a lower `ref_sequence` cannot become current or publish over a
  higher admitted sequence, regardless of completion timestamps. Such a checkpoint does
  not advance the projection-input frontier, and knowledge commit rechecks the maximum
  admitted/checkpoint sequence under the ref lock.
- Pending evidence/knowledge outbox rows below that maximum sequence terminally
  supersede. A failed newer ingest cannot leave obsolete older work counted forever in
  backlog or selected for drain.
- Projection input events are immutable and uniquely sequenced per repository. A
  generation cannot publish when evidence, knowledge state, or erasure state changed
  after its initial frontier sample.
- Immutable evidence, revision, and citation tables deny runtime `UPDATE` and `DELETE`.
- Full Git SHAs and source-specific evidence anchors are validated.
- Line ranges require a path and valid positive bounds.
- Line ranges and JSON pointers are selectors over the immutable base evidence body, not
  alternate evidence-row identities; PostgreSQL validates the selector before storing it.
- Knowledge citations terminate at evidence, never another generated revision. Citation
  claims must occur verbatim after whitespace/case normalization in the exact selected
  evidence excerpt. Identity and scope grounding can use only that excerpt and intrinsic
  source identity; unrelated record text and manifest membership alone cannot support it.
- Knowledge projection requires every citation's source identity and digest to be a
  member of the exact generation checkpoint. Equivalent-evidence cache reuse is safe
  because this membership is rechecked at indexing; mutable provider changes remove stale
  derived facts.
- ACL projection is generation-scoped. Principal permissions resolve to exact repository
  ACL fingerprints, and SQL filters projection rows before candidate creation. The
  repository access snapshot fingerprint is persisted with the generation, included in
  generation identity/output fingerprints, and rechecked under the repository access lock
  at ACL projection and publication. Query authorization consults current ACL state so a
  revoked principal cannot use an older published ACL projection. Authorized hydration
  reads the principal's current fingerprint set before and after loading, and query
  response emission performs a final authorization/fingerprint equality check.
- Every ACL transition has a monotonic observation version. Revoke/regrant cycles therefore
  produce new immutable events and new generation identities rather than reusing old IDs.
- Repository ACL replacement and merge synchronize under the same tenant/principal
  advisory lock. Merge reads the current ACL and applies the union in one store
  transaction, so concurrent merges cannot lose either grant set. Replacement remains an
  intentional complete-set operation and applies in the lock's serial order.
- Documents derived from multiple sources require every source ACL fingerprint in lexical,
  hierarchy, and optional dense retrieval; wildcard fingerprints never bypass that rule.
- Erasure filters are durable and checked during ingestion and rebuild.
- Erasure invalidates every published repository generation in the same transaction as
  its projection-input event. Terminal knowledge events do the same for their ref.
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
