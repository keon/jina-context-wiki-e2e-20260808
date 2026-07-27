# Architecture

This document describes the deployed runtime. Persisted structures are in
[DATA_MODELS.md](DATA_MODELS.md), request flows in
[SEQUENCE_DIAGRAM.md](SEQUENCE_DIAGRAM.md), and the rationale in
[CONTEXT_ENGINE_DECISION.md](CONTEXT_ENGINE_DECISION.md).

## Topology

The release runs as five Cloud Run services against the existing shared PostgreSQL
database:

- `jina-api` verifies GitHub webhooks, serves board and context APIs, serves stateless MCP,
  and owns worker lease/completion transactions.
- `jina-task-worker` handles review, research, publication, and cleanup topics.
- `jina-context-worker` handles `ingest-evidence`, baseline `index-context`, and required
  `derive-knowledge`/enriched publication in that strict queue order.
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

The production API is deployed with 2 vCPU, 2 GiB memory, concurrency 4, and the Cloud
Run maximum 60-minute request timeout. A context worker allows 62 minutes for the
operation request and 10 additional minutes for terminal completion; its 75-minute
context-only lease exceeds those two worker deadlines combined. These longer values do
not change ordinary task deadlines or leases.

## Board and execution

The generic board is the orchestrator. A versioned planner creates tasks and dependency
edges. The reducer queues work only after required dependencies are satisfied and writes
its durable delivery with the same state change.

Opened pull requests create a review aggregate. Opened issues create manual triage work.
Signed branch pushes and `POST /context/build` create `build-context` with three children:

```text
ingest-evidence
  └─> index-context baseline (required)
        └─> derive-knowledge + enriched index publish (required)
```

`index-context` can publish a raw-evidence generation as soon as ingestion completes.
Only after that baseline completes does the coordinator queue `derive-knowledge`; a
successful derivation publishes its successor enriched generation within the derive
stage. At most the next stage is queued, so separate workers cannot race baseline
materialization against knowledge commits and their projection-input events. The
baseline is usable when ingestion and baseline indexing succeed, but it is not completion
of the root build. Invalid derivation output receives one constrained repair. If the
repair or executor still fails, the derivation stage and root build fail; the published
baseline remains available only for diagnosis and retry.

Viewed as data planes rather than board scheduling, the architecture is
`ingest-evidence` → required `derive-knowledge` → enriched `index-context`. The
pre-derivation baseline is a safety and recovery publication, not an optional derivation
path.

Build admission assigns a monotonically increasing `refSequence` under a
tenant/repository/ref advisory lock shared with checkpoint, knowledge, and generation
publication fences. That sequence is fixed when the build request is accepted and travels
through the ingest task into the evidence checkpoint; wall-clock timestamps and worker
completion order never choose the current checkpoint. If an earlier accepted push
finishes ingestion after a later accepted push, its lower sequence remains historical,
cannot advance the canonical projection-input frontier, and cannot commit knowledge or
publish a generation. Redelivery of the same request key returns the existing build and
does not allocate another sequence.

The board remains representation-neutral. It knows task state, dependency readiness,
supersession, leases, and terminal propagation, but does not import context-domain types.

## Context planes

### Evidence

`ingest-evidence` performs a full blob-filtered (non-shallow) clone, explicitly fetches
the requested branch to `refs/remotes/origin/<ref>`, resolves that authoritative remote
head to a full SHA, and checks it out detached. For webhook builds, the event SHA is an
expected-head fence: if it differs from the fetched remote head, ingestion rejects the
stale build instead of indexing a historical commit as the current ref. Manual builds
without `commitSha` use the fetched head. Ingestion stores immutable provider
observations, the exact tree, content-addressed blobs, bounded commit/parent history,
first-parent changes, deterministic parser analyses, symbols, imports, structural facts,
identities, and ACL observations. Webhook builds carry their GitHub App installation ID;
the worker mints a short-lived installation token and keeps it only for the active lease's
Git and REST work. Oversized or binary content may be omitted from stored body text, but
its manifest identity remains.

For derivation, ingestion also materializes up to 500 recent commits as citable evidence.
The checkpoint commit includes its changed paths. Bounded GitHub intake stores repository
metadata, pull requests, issues, issue comments, pull-request review comments, and commit
discussion comments. These provider records retain immutable observed bodies and
source-specific identities so the agent can connect a change to issue or incident history
without turning the inference into canonical evidence.

Git tree fidelity is preserved independently of searchable source text. Executable blobs
retain mode `100755`; symlinks retain mode `120000` and their link target as manifest
metadata without indexing that target as source; gitlinks retain mode `160000` and the
submodule commit without aborting unrelated-file ingestion.

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
isolated Daytona executor for knowledge documents, not nodes or relationships. The
worker also supplies the exact repository manifest and the latest eligible prior
knowledge revisions. It archives the exact checkpoint commit and extracts it into the
ephemeral sandbox, so Codex can explore the repository with read-only shell tools while
all citations still resolve through immutable host-created inputs.
`KnowledgeOutputValidator` resolves stable logical subjects and checks each citation's
tenant, repository, source identity, digest, commit, path/range, and JSON pointer before
the immutable revision is stored. A citation may select a complete evidence body, an
exact inclusive line range, or an RFC 6901-style JSON pointer, but it cannot mix line and
JSON selectors. The normalized citation claim must occur verbatim in the exact selected
excerpt; support from a nearby line or different JSON field is rejected. Invalid output
receives exactly one constrained repair before the required stage fails.

The `knowledge-documents-v4` result contains 1–50 documents plus an explicit
`retiredDocuments` list. A first initialization organizes supported architecture,
components, features, decisions, changes, issues, incidents, ownership, runbooks, and
glossary concepts. An incremental build uses prior knowledge as the catalog baseline:
every still-valid logical document must be re-emitted with current-checkpoint citations,
every affected document is revised, and every omitted prior logical ID must be explicitly
retired with a reason. Host validation rejects silent drops, unknown retirements, and an
ID that is both emitted and retired.

Every non-heading body paragraph has citation markers. The summary, facts, answered
questions, and diagnostic symptoms, likely causes, checks, and fixes carry citation
ordinals and calibrated confidence. Derived prose is allowed, but its supporting
citation claim remains a verbatim excerpt from the selected evidence. Likely
issue/change/incident relationships require multiple cited signals, explicit uncertainty,
and lower confidence.

Logical IDs are trimmed and persisted in canonical lowercase before they contribute to
revision identity. Their repository and change-commit segments must equal the checkpoint;
issue identities must resolve to cited issue evidence, and every remaining
model-controlled suffix segment must occur in the exact selected citation excerpt or the
intrinsic cited-source identity (source ID or path). Scope fields use the same rule; a
path's presence in the checkpoint manifest is necessary but not sufficient. Unrelated
text elsewhere in the evidence record cannot ground identity or scope. A syntactically
valid but hallucinated identity cannot create or collide with a durable logical subject.

The Daytona Codex invocation treats repository files, evidence, provider text, and prior
knowledge as untrusted data and ignores both user configuration and repository
instructions. Codex gets a read-only shell, a read-only checkpoint archive, and the
derivation input directory. It receives no repository credential, inherited environment,
login shell, or network. Shell snapshots, unified execution, multi-agent, apps, plugins,
remote plugins, hooks, browser use, the in-app browser, computer use, image generation,
the code-mode host, workspace dependencies, skill MCP dependency installation, and web
search remain disabled. It may inspect only the supplied paths and can return only the
schema-constrained JSON result; all grounding and identity validation remain host-side.
The default model window is 64,000 tokens, compacts at 48,000, and uses medium reasoning
effort.

Successful derivation cache reuse requires the same commit, selector/focus fingerprint,
complete checkpoint evidence fingerprint, generator/model, prompt, and schema versions.
Equivalent evidence can therefore reuse an immutable run safely; projection still
validates every reused revision's citations against the exact target checkpoint.

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
canonical evidence and immutable knowledge. Current knowledge selection is explicitly
scoped to the exact evidence checkpoint: every stored citation must find the same source
identity and `contentDigest` in that checkpoint (with matching commit/path identity where
present). This permits safe reuse of unchanged cited facts across equivalent same-commit
checkpoints, but excludes stale PR/issue-derived facts when mutable provider evidence
changes. A revision for another branch, older commit, or same commit with nonmatching
provider evidence cannot enter the generation.

The `derivedKnowledge` capability uses that same scope. It is `available` only when at
least one exact-checkpoint citation-valid revision is eligible and every logical ID
present for that checkpoint has an eligible current revision, `partial` when only some
do, and `unavailable` when none do. Ref+commit equality or repository history alone never
upgrades the capability.

Canonical writes create one durable outbox delivery per named projection consumer.
Each consumer runs in its own capability-role transaction, claims independently with a
consumer-specific lease ID, writes only its projection, and completes its own checkpoint.
Acknowledgements require the current, unexpired delivery lease and exact scoped event.
Repository-global ACL/erasure events remain pending until every current ref has rebuilt;
pending evidence and knowledge deliveries below the newest admitted or committed
`refSequence` are terminally completed as superseded. This decision depends on admission
order, not successful successor ingestion or publication, so backlog converges even if
the newer build later fails. A ref-scoped advisory lock and newest-checkpoint barrier
prevent an older build from replacing a newer generation. The repository access
fingerprint is part of both generation identity and generation output fingerprint. ACL
mutation, ACL projection, and final publication share a repository access lock and
revalidate that fingerprint, so a revoke during indexing forces a retry instead of
publishing mixed ACL state. Query authorization also checks the current ACL observation
rather than trusting a historical generation projection.
`POST /internal/context/outbox/drain` selects only current checkpoints and actually re-runs
the same idempotent `index-context` path.

`projection_input_events` is an immutable, repository-scoped sequence over every canonical
input that can change a projection: evidence checkpoints, successful knowledge runs,
knowledge revision events, and evidence erasures. `index-context` samples a fingerprint
of the latest sequence/event before materialization and samples it again after all
projectors finish. Any change aborts the generation. Durable generation creation and
publication also acquire the projection-input advisory lock and revalidate the stored
fingerprint; publication additionally rechecks that the checkpoint has the highest
`refSequence` for its ref. Canonical writers take the same lock before appending an input
event, so no erasure or knowledge transition can commit between final validation and
publication.

Erasure appends its input event and invalidates every published generation for the
repository in the same transaction. Terminal knowledge events—`rejected`, `superseded`,
`invalidated`, `redacted`, and `expired`—append an input event and invalidate published
generations for that revision's ref. Callers see no stale generation while an idempotent
rebuild incorporates the new canonical state.

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

1. authenticate the credential and bound principal, defaulting an omitted ref to `main`;
2. resolve the principal's repository ACL fingerprints, requested ref, and one published
   generation;
3. plan exact, structured, structural, lexical, knowledge, temporal, hierarchy, and/or
   bounded long-context routes;
4. load only ACL-authorized projection rows, retrieve candidates, and fuse them
   deterministically;
5. surface conflicts and coverage gaps;
6. assemble an evidence pack from original source spans;
7. synthesize and verify every returned citation;
8. reauthorize the principal and require the same current ACL-fingerprint set immediately
   before releasing the response.

Exact and structured candidates cannot be displaced by weaker semantic matches. A
response always reports the generation/ref/commit, original-evidence citations,
conflicts, ambiguities, coverage, retrievers used, and trace ID.

`taskKind: "diagnose"` is available through both HTTP and MCP. It selects knowledge,
structured, and temporal routes so an engineering agent can retrieve cited symptoms,
likely causes, diagnostic checks, evidence-backed fixes, issue/PR state, and relevant
change history.

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

Generation and document lists use opaque cursor pagination. The dashboard scope picker
and tenant-admin listings follow cursors to exhaustion, with duplicate-cursor and page
count guards, so older scopes and documents are not silently hidden. Metrics, rebuild,
erasure, and knowledge review are tenant-administrator operations. Review also checks that the
selected revision belongs to the principal's tenant; repository read access alone cannot
append a review event. `POST /context/build` accepts optional `commitSha` and
`githubInstallationId` fields. Signed push builds supply both from the verified webhook;
trusted manual callers must supply the installation ID when private access should use the
GitHub App.

`POST /mcp` is stateless Streamable HTTP MCP. Server `jina-context` exposes exactly one
read-only tool: `query_context`. Storage primitives and retriever controls are not public
MCP tools.

The dashboard exposes `diagnose` in the query workspace. Its knowledge catalog shows
logical-document and immutable-revision counts, prior revision, generator/model/prompt
metadata, cited facts and answered questions, and symptoms/causes/checks/fixes. The admin
view shows current logical-document count, revisions by kind, and agent/model, review,
confidence, and commit metadata across the tenant.

Public `POST /context/query` and `POST /mcp` bodies are limited to 128 KiB. Each raw
target category (`paths`, `symbols`, `pullRequests`, or `issues`) accepts at most 100
array entries. Entries are trimmed, empty strings are discarded, accepted values are
deduplicated, and every non-empty entry is limited to 1,000 characters. The raw-entry
limit is applied before deduplication, so duplicate flooding cannot bypass amplification
protection.

## Persistence and idempotency

The board snapshot lives in `jina_runtime.api_state`; GitHub delivery IDs are unique in
`jina_runtime.github_deliveries`. The context engine owns `jina_context`.

Canonical objects and knowledge revisions use stable fingerprints over immutable input.
Consumers own independent outbox deliveries, leases, and checkpoints. Generation identity
includes tenant, repository, ref, exact commit, checkpoint identity (which includes the
monotonic `refSequence`), evidence fingerprint, source-completeness frontier, immutable
projection-input frontier, and projector versions. Replaying the same input converges,
while a moved ref produces a new isolated generation.

## Authentication and security

Health, task definitions, and signed webhook intake are public. `INTERNAL_API_TOKEN`
authorizes board, worker, administration, and
`POST /internal/context/access/sync`. `CONTEXT_API_TOKEN` is a narrower server-side
credential accepted only by `POST /context/query` and `POST /mcp`.

In production the context credential is usable only when
`JINA_CONTEXT_TENANT_ID` and `JINA_CONTEXT_PRINCIPAL_ID` server-side bind it to one
identity.
Tenant/principal headers may repeat that identity but cannot override it; a mismatch is
unauthorized. Repository-access synchronization uses that same server-side tenant and
principal binding even though it requires the internal credential; caller-selected
identity headers are rejected. Other internal callers must carry a normalized, forwarded
principal and, in shared tenancy, a tenant. Current ACL observations resolve that principal to exact
repository ACL fingerprints. PostgreSQL applies those fingerprints while hydrating
documents, fragments, exact terms, hierarchy nodes, manifests, and current knowledge,
before retrievers can create candidates; structural relations are retained only when all
anchors belong to the authorized document set. The principal and exact fingerprint set
are re-read after hydration/synthesis, and citations are checked again before they leave
the API. Tenant administrators can view metrics, review knowledge, and issue
rebuild/erasure commands. Browser MCP origins must match `JINA_MCP_ALLOWED_ORIGINS`.

Repository access synchronization is also serialized at the store boundary. Both
`replace` and `merge` acquire one tenant/principal advisory lock; `merge` reads the
current grants and applies their union with the request in that transaction. API-level
read/modify/write races cannot discard one of two concurrent merges; a serialized
replacement still has its documented complete-set semantics.

The schema-owning migration login is separate from the application login. The migration
installs focused NOLOGIN capability roles, marks the runtime login `NOINHERIT`, and grants
it role membership except for the wildcard `jina_context_admin` role. Tenant-scoped
administration activates `jina_context_tenant_admin`, whose RLS policies never accept the
wildcard system scope. Runtime services do not manage schema and have no ambient context
table privileges: each database operation runs in a transaction and activates its
declared capability with `SET LOCAL ROLE`.

The Cloud Run migration job also has a dedicated Google identity,
`jina-migration@jina-v2.iam.gserviceaccount.com`. Only that identity may access the
migration-owner database secret. Network-facing API, workers, dashboard, admin, and
acceptance run as `jina-runtime`, which must not have access to the owner secret; the
migration identity is never assigned to those services.

Repository credentials stay in the worker. Daytona isolates source inspection. Jina does
not execute untrusted repository code or install its dependencies. Retrieved text and
model output are untrusted and cannot change scope, tools, ACLs, or citation policy.

## Code boundaries

- `apps/*` owns HTTP, process startup, external I/O, and runtime wiring.
- `packages/board` owns generic workflow state.
- `packages/context-engine` owns evidence, knowledge, projection, retrieval, and ports.
- `packages/db/src/context` implements durable domain-specific adapters and roles.
- `packages/github`, `packages/daytona`, and `packages/ai` adapt external systems.
