# Data models

This document describes the active Context v2 model. Executable definitions in
`packages/board`, `apps/api/src/context-board-runtime.ts`,
`packages/db/src/context/schema.ts`, and the domain types in
`packages/context-engine/src` are authoritative.

## Runtime workflow

The durable task board records one `build-context` aggregate and its dynamic children.
The root carries the tenant/repository/ref/request identity and monotonic `refSequence`.
Dispatchable children carry only bounded orchestration metadata, content digests, and
immutable artifact references. Research, page, audit, repair, challenge, critic,
certification, publication, and PageIndex tasks are added as validated agent results
discover work.

The fresh PostgreSQL schema does not contain the legacy `pipeline_builds`,
`pipeline_stages`, `derivation_progress`, or `derivation_orchestration` tables. Their
rebuildable data has no compatibility contract. The reviewed reset must still be run
against the intended production database before rollout.

For each tenant/repository/ref:

- sequences are allocated under an advisory lock;
- only the newest admitted sequence may become current;
- every worker claim is fenced by task ID, attempt, lease ID, expiry, and an unguessable
  write-fence token;
- a delayed older checkpoint cannot publish over a newer one; and
- dependency-ready tasks are claimable concurrently.

Board rows never contain prompts, page bodies, evidence bundles, transcripts, reports,
or audit payloads. Those values are immutable GCS objects under the same build scope.
The dashboard projection removes active lease IDs and fence tokens.

## Canonical context records

### Evidence

`evidence_records` stores immutable citable bodies. An evidence anchor contains:

```text
tenant + repository + source type + source ID + content digest
```

It may also carry:

```text
commit SHA + path/URL + line range + JSON pointer + observation time
```

`evidence_checkpoints` binds a selected evidence set to an exact ref, commit,
`ref_sequence`, provider frontier, ACL fingerprint, and explicit complete/partial source
state.

`evidence_checkpoint_records` and `evidence_checkpoint_manifest` record checkpoint
membership. The manifest maps repository paths to Git blob SHAs, content digests, entry
types, and content availability.

Git objects and GitHub observations are normalized for storage and citation validation,
but they do not form a public retrieval corpus.

### Derived context

`derivation_runs` records the model, prompt/schema versions, cache identity, raw result,
status, and diagnostics.

`knowledge_documents` provides stable logical identities. Despite the historical table
name, these rows are repository context documents. `knowledge_document_revisions` stores
immutable Markdown revisions for one exact ref and commit.
`knowledge_revision_evidence` stores each revision's ordered original-evidence citations.

Every published revision has:

- a logical ID and kind;
- title, summary, and Markdown body;
- ref, commit, and grounded scope;
- generator, model, prompt, and schema identity;
- confidence and a body digest; and
- at least one citation that resolves at its checkpoint.

Generated context never cites another generated revision as evidence. Citations terminate
at blobs, commits, issues, pull requests, documents, or immutable observations.

`knowledge_revision_events` is an append-only governance log. Rejection, invalidation,
supersession, redaction, or erasure excludes a revision from later releases. Context body
editing is not supported.

### Derivation checkpoints

Board tasks and immutable artifacts are the checkpoint model. One `context-page`
aggregate owns a writer, source-aware audit, and bounded repair/audit successors. Board
rows store status, dependencies, attempts, leases, fences, bounded digests, and artifact
references. Page bodies, diagnostics, audit reports, research plans, publication plans,
critic results, and repair drafts are immutable artifacts under the build scope.

A valid page artifact is resumable but private. Replaying identical inputs and output
digest is idempotent; a repair creates a new attempt/pass artifact instead of overwriting
the previous bytes. Dependency results carry the latest-pass references forward.

Research and publication plans contain evidence-backed subjects, maintenance questions,
stable page IDs, deterministic repository-area coverage, and question-to-page mappings.
Challenge and task-evaluation artifacts contain findings, pages actually used, and
blocking gaps. The API validates every result envelope, artifact scope, and dependency
reference before completing a Board task or expanding the graph. Independent artifact
storage is intentional: plans, research, valid sibling pages, and audits survive worker
or sandbox loss even when the build never publishes.

## Immutable releases and disposable projections

`index_generations` stores immutable release metadata: tenant, repository, ref, commit,
checkpoint, publication state, capability state, input fingerprints, timestamps, and
failure data.

Verified page checkpoints may appear in build progress as they arrive, but they do not
create queryable releases. Certification binds the complete unchanged public snapshot,
and one fenced publication task atomically makes that release current. Current selection
is the newest authorized completed release for a ref.

Active derived-only projections are:

| Projection                    | Purpose                                             |
| ----------------------------- | --------------------------------------------------- |
| `current_knowledge_revisions` | One eligible revision per logical context document  |
| `context_documents`           | Derived document retrieval envelopes                |
| `context_fragments`           | Chunked derived Markdown for lexical excerpt search |
| `exact_index`                 | Exact titles, logical IDs, paths, and terms         |
| `hierarchy_nodes`             | PageIndex-derived document/heading tree             |
| `ref_manifest`                | Release-local citation/path metadata                |

Dense retrieval and structural relations are disabled. The fresh schema contains only
the active derived-context projections; no public API, MCP tool, index coordinator, or
dashboard reads raw-source, provider, structural, dense, or answer-synthesis rows.

## Artifact model

Large immutable artifacts use a shared key function:

```text
context-v2/tenants/<tenant>/repositories/<repository>/builds/<build>/<kind>/<name>
```

Kinds include:

- `evidence-snapshot`;
- `derivation-checkpoint` (research, plan, page, audit, repair, challenge, critic, and
  certification objects);
- `context-release`; and
- `pageindex-tree`.

The filesystem implementation is for local development. The GCS implementation uses
create-only object generation preconditions, CRC32C transport validation, SHA-256 object
metadata, and optional generation-pinned reads.

## API tokens and ACLs

`api_tokens` stores:

```text
id
tenant_id
principal_id
name
secret_hash
scopes
created_at
created_by
expires_at
last_used_at
revoked_at
revoked_by
```

The plaintext `jina_atk_…` token is returned only once. Verification hashes the presented
token, resolves its tenant and principal from the row, rejects expired/revoked rows, and
then enforces route scope and repository ACL.

Repository access is represented by `repository_acl_observations` and disposable ACL
projections. Every release persists the repository-access fingerprint used to build it.
The fingerprint is rechecked during publication and authorization.

## Invariants

- Repository-owned keys and foreign keys include tenant scope.
- Full commit SHAs and content digests are validated.
- Evidence bodies are immutable.
- Line ranges require a repository path and valid inclusive bounds.
- JSON pointers are RFC 6901 selectors over captured provider JSON.
- A citation claim must occur in its exact selected evidence.
- A page with any invalid evidence link is withheld.
- Raw evidence is never returned by public retrieval.
- A current revision must match the target checkpoint's source identities and digests.
- Required ACL fingerprints are checked before candidate generation and hydration.
- Projection-input and repository-access fingerprints are rechecked under locks before
  publication.
- Erasure and terminal revision events invalidate affected releases.
- Exact, lexical, hierarchy, and manifest projections are rebuildable.

## Reset classes

Preserved:

- repository and tenant registrations;
- GitHub repository mappings;
- ACL observations and the source observations they reference;
- API token hashes;
- erasure filters; and
- audit events; and
- GitHub webhook delivery identity.

Deleted and rebuilt:

- persisted Board build/stage state;
- evidence snapshots and Git materialization;
- derivation progress, runs, revisions, and citations;
- releases and projections;
- outbox/checkpoint state; and
- retrieval telemetry and quota ledgers.

With database configuration present, the dry run reports the exact deletable
row count for every target without mutating it. Without database configuration,
it prints the static target list:

```sh
pnpm --filter @jina/db reset-context
```

Execution requires:

```sh
JINA_CONFIRM_CONTEXT_RESET=delete-rebuildable-context \
pnpm --filter @jina/db reset-context -- --execute
```

## Capability roles

Focused roles include coordinator, ingest, derive, manifest, current-context, lexical,
hierarchy, ACL, retention, query, token, and tenant-admin capabilities. The runtime login
is `NOINHERIT` and is not a member of the wildcard administration role.

`jina_context_tokens` is the only capability permitted to resolve a token across tenants;
that lookup is necessary because the token row itself identifies the tenant. Subsequent
operations return to strict tenant and principal scope.
