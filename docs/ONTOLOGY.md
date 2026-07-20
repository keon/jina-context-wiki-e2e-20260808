# Ontology — Repository Context Architecture

## Status

This document describes the implementation in this repository as of 2026-07-20. Ontology is one workflow on Jina's generic task board. The board controls work; Ontology owns repository facts and cited retrieval. The graph shown on `/ontology` is a disposable read model, not the canonical store.

The implementation follows Repository Context Architecture v5.1 with three board-visible chunks rather than a card per internal mechanism:

| Task type | Internal responsibilities | Durable completion |
| --- | --- | --- |
| `ontology_ingest` | Immutable GitHub/Git intake, new reachable commits, first-parent deltas, content-addressed parsing, PR/issue/CODEOWNERS normalization | Observations, code-plane rows, explicit source facts, and code checkpoint are durable |
| `ontology_assert` | Daytona checkout, Codex semantic analysis, citation validation, model observation, registry validation | Model output is recorded and every supported inference is stored as `proposed` |
| `ontology_project` | Ref-scoped canonical outbox claim, redirect reconciliation, ref-manifest/search rebuild, incremental issue-trace materialization, graph rendering, retention | Projection checkpoint and immutable graph generation are durable |

`ontology_build` remains an aggregate parent. Internal stages are not board primitives and do not appear as extra cards.

## Separation of concerns

```mermaid
flowchart LR
    subgraph Board[Generic task board]
      T[Tasks]
      D[Required dependencies]
      B[Board outbox leases]
    end
    subgraph Context[Ontology / repository context]
      I[Immutable observations]
      C[Content-addressed code plane]
      K[Knowledge service]
      O[Canonical outbox]
      P[Manifest + search + issue-trace projections]
      R[Fixed cited retrieval templates]
      G[Dashboard graph]
      I --> C
      I --> K
      C --> O
      K --> O
      O --> P
      C --> R
      K --> R
      P --> R
      C --> G
      K --> G
    end
    Board -->|dispatch typed work| Context
    Context -->|checkpoints, counts, graph ID| Board
```

The board stores repository/ref inputs and checkpoint IDs. It does not store observations, symbols, assertions, redirects, search documents, or graph semantics. Ontology never treats task dependencies such as `blocks` or `publishes` as repository predicates.

## Runtime flow

### Intake and incrementality

The ontology worker resolves the requested ref, then walks the commit DAG backward. Before fetching a commit tree it asks the canonical store which SHAs already exist. A repeated build therefore reads only the head tree; a new head ingests only the previously unseen subgraph until it reaches known parents. `ONTOLOGY_HISTORY_LIMIT` is a safety fence (default 10,000 commits); exceeding it fails rather than storing a partial history.

Each commit stores parents, author external ID, commit time, message, and its tree manifest. State comes from the tree. `commit_changes` is independently computed against the first parent and records add, modify, delete, and exact-content rename. A force-push moves a ref; it does not rewrite commit facts.

Blobs are tenant-scoped and keyed by Git SHA. Parsing is keyed by `(tenant, blobSha, parserVersion)`, so unchanged content is parsed once across every commit and ref. TypeScript and JavaScript use tree-sitter through `@ast-grep/napi`; the versioned fallback supports deterministic definitions/imports for other recognized languages. Parse rows contain signature hashes and `calls | imports | references | extends` edges.

GitHub PRs and issues remain raw observations. Pure normalizers derive only explicit facts:

- `AUTHORED_BY` from the GitHub actor;
- `INCLUDES` from PR-to-commit membership;
- `MERGED_AS` from GitHub's merge commit, only after the PR is merged;
- `RESOLVES` from explicit close/fix/resolve syntax;
- `RESOLVED_BY` as the issue-centric inverse of an explicit `RESOLVES` fact;
- `REFERENCES` from explicit issue mentions;
- pattern-qualified `OWNED_BY` from CODEOWNERS.

Commit authorship is derived from commits plus accepted identities and is not duplicated as an assertion.

### Semantic assertion generation

The assertion worker checks out the immutable commit in Daytona and normally asks Codex only about added, modified, or renamed current paths. A generator/schema version change with an unchanged head intentionally performs one full semantic scan, then caches that generation. Every citation is checked against the checkout before completion. Raw model JSON is stored as a `model_output` observation before normalization.

Models never activate knowledge. All model relationships, including `INTRODUCED_BY`, enter as `proposed`. Causality requires a positive GitHub issue ID, a full commit SHA, a nonempty reason, and checked repository evidence explicitly naming the mechanism; temporal proximity or membership in a resolving PR is insufficient. An authenticated `review_assertion` command accepts, rejects, or retracts model facts and appends an audit row. `GET /ontology/assertions` exposes repository-scoped summaries for review and production verification.

### Projection

The project task uses queue-claim semantics (`FOR UPDATE SKIP LOCKED`) for canonical outbox events. It then:

1. materializes `ref_manifest` directly from the current ref's commit tree;
2. rebuilds repo-scoped lexical and 64-dimensional vector search documents;
3. traverses only the assertion/observation subgraph touched by claimed events and upserts the affected issue-centric `issue_traces` rows on every ref before acknowledging a repository-wide event; a missing projection triggers a one-time full backfill;
4. folds append-only entity redirects and reconciles logical assertion collisions;
5. performs reachability/recent-window code-plane GC and bounded rejected-model payload retention;
6. acknowledges claimed outbox events;
7. creates a new immutable dashboard graph generation.

An issue trace is a read model, not new canonical knowledge. It contains the Issue → resolving PR → merge/included commits → first-parent file changes path, plus reviewed `INTRODUCED_BY` commits, their associated introducing PRs, causal reason, evidence-generation commit, and checkout-validated evidence. It supports repository-scoped lookup by exact quoted text from an ingested issue title/body, issue number, PR number, or commit SHA prefix and retains the citations needed to explain every hop. Text first resolves to the canonical issue; causal traversal still follows accepted assertions rather than inferring from lexical similarity. The graph persists the same Issue → Commit edge, reason, and evidence. Rebuilding a trace never creates an assertion.

Every projected graph item carries evidence. Code and accepted model facts keep
their checkout-validated `path:line` citations. Deterministic GitHub facts that
come from PR, issue, or CODEOWNERS normalization carry their immutable
`observation:<id>` provenance into the graph; an active source assertion without
that provenance is excluded instead of relying on an empty-evidence shortcut.

Bulk history ingestion bypasses per-blob outbox fan-out; the final project rebuild is the bulk recovery path. Steady-state canonical changes emit aggregate events transactionally.

The ontology worker also drains canonical events while idle. Repository events lease only that repository and fan affected repository-wide issue facts across all of its refs before acknowledgment; tenant-global identity or redirect events fan out across current repositories. Tombstones with no remaining ref are acknowledged after their command transaction has purged the projections. A repository rebuild can never acknowledge another repository's pending event.

An unchanged ref is a no-op through the expensive path: the head tree is checked once, every blob analysis is reused, the generator checkpoint returns cached proposals without starting Daytona, and manifest/search rebuilding is skipped when no scoped canonical event is pending. The project task still writes a small immutable graph generation so its board result remains independently inspectable; its event reports `rebuilt: false` and `processedEventCount: 0`.

## Canonical storage

All tables are in PostgreSQL under `jina_ontology`, and every row is tenant-scoped.

| Plane | Tables |
| --- | --- |
| Intake | `observations`, `model_outputs` |
| Code | `commits`, `refs`, `commit_files`, `commit_changes`, `blobs`, `blob_analyses`, `blob_symbols`, `blob_imports`, `symbol_edges` |
| Knowledge | `entities`, `identities`, `entity_redirects`, `assertions`, `audit_log` |
| Infrastructure | `outbox`, `erasure_filters`, `repository_acl` |
| Rebuildable projections | `ref_manifest`, `search_documents`, `issue_traces`, `graphs`, `nodes`, `edges` |

`commit_files` is the persisted commit manifest in the current implementation. `ref_manifest` is the hot-ref projection. Graph rows include the board task generation in their ID, so reruns never overwrite a graph referenced by an older task.

### Assertions

The assertion schema and domain support object or typed literal values for registry growth; all currently registered predicates are relationships. Assertions also carry typed qualifiers, confidence for inference predicates, provenance (`sourceObservationId XOR assertedBy`), generator, registry version, validity, and five statuses:

```text
proposed | active | rejected | superseded | retracted
```

Only `status`, `validTo`, `supersededBy`, and `lastConfirmedAt` mutate after insert. Re-observation updates only `lastConfirmedAt`. Natural-key dedup includes a canonical qualifier hash. Cardinality-one supersession is scoped by `(subject, predicate, qualifiersHash)`.

### Registry

The typed registry is [registry.ts](../packages/ontology/src/registry.ts). It declares endpoint kinds, predicate class, cardinality, qualifiers, review policy, bitemporality, and authority. It is versioned in Git and stamped on assertions.

The implemented predicate set is:

```text
AUTHORED_BY  OWNED_BY  MEMBER_OF  INCLUDES  MERGED_AS
RESOLVES  RESOLVED_BY  REFERENCES  INTRODUCED_BY
LIKELY_AFFECTS  MOVED_FROM  IMPLEMENTS  DOCUMENTED_BY
```

Structural `CONTAINS`, `DECLARES`, `CALLS`, `IMPORTS`, `REFERENCES`, and `EXTENDS` edges remain in the code plane and are not assertion rows.

## Identity and repair

Repositories and commit SHAs receive accepted deterministic identities. GitHub users receive accepted GitHub identities. Git-email links remain proposed.

Entity merge/unmerge is append-only. Assertions keep the IDs originally asserted. Every read path folds the redirect ledger. A merge command checks cycles and emits `redirect_added`; projection reconciliation then:

- keeps the newest fact for cardinality-one collisions;
- keeps the earliest row for exact duplicates;
- supersedes losers with an audited `svc:reconciliation` action.

Unmerge cancels the matching redirect but does not silently restore facts superseded during reconciliation.

## Retrieval

Models cannot compose database queries. The API exposes five deterministic templates:

| Template | Answer path |
| --- | --- |
| `issue_trace` | issue title/body phrase, issue number, PR, or commit → materialized issue → resolving and introducing PRs/commits → causal reason/evidence and changes |
| `structure` | name/moniker → typed edges inside the selected ref manifest |
| `change` | PR → included commits → first-parent changes → changed symbols → inbound affected surface |
| `intent` | file history → commits → PRs → resolved/referenced issues → raw observation text |
| `ownership` | active/source ownership by registry authority → recent commit authors via accepted identities |

Every item carries code, commit-change, assertion, entity, or observation citations plus score and explicit truncation. Expansion is limited to 200 items. Repository permission is checked before querying and again before results leave the API.

`POST /ontology/ask` is a thin classifier/composer over these five tools. It extracts issue numbers, exact quoted issue phrases, PRs, and commits and routes resolution/causality questions directly to `issue_trace`; it does not reconstruct that path with query-time assertion joins or an LLM. A quoted phrase is matched case-insensitively against ingested issue titles and bodies inside the authorized repository. The dashboard renders resolution and causality chains, reasons, evidence, and provenance citations above the graph.

## Security

- Production data routes require the server-side internal bearer credential and derive `tenantId` from server configuration, never from request payloads.
- Cloud Run IAP authenticates the browser. The dashboard proxy removes caller authorization/tenant/principal headers, forwards the verified IAP email as a `user:` principal, and adds its service credential server-side.
- Graph details, retrieval, and context assembly are tenant- and repository-scoped.
- `JINA_TENANT_ADMIN_PRINCIPALS` supplies the independent Jina tenant-admin relationship. Other users receive only repositories granted through `repository_acl` reader/writer/admin relationships. Board/event reads use the same repository scope; command authorization is rechecked in the canonical writer. Service principals can enumerate the tenant repositories required by workers.
- Blob rows are never shared across tenants.
- Workers have no database connection and mutate canonical state only through leased, authenticated API operations.
- Model output is untrusted input and cannot write active assertions or arbitrary queries.

The current modular-monolith API is the sole database client for intake, code, knowledge, and projection writer modules. Table ownership is enforced at those module boundaries; splitting them into separate database principals does not change storage or APIs.

## Lifecycle

Four operations are distinct and audited:

- **Tombstone repository** retracts live assertions, retires scoped entities, purges code-plane rows, graphs, search, manifests, issue traces, and ACLs, and persists a durable repository filter.
- **Redact observation** destroys payload content, retains digest/reason/time, masks named commit messages, retracts dependent assertions, and purges search.
- **Erase person** marks identities erased, retires the Engineer, retracts facts about it and every assertion sourced from a destroyed personal observation, removes search documents, masks matching commit authors, and redacts observations containing erased external IDs.
- **Retention/GC** keeps commits reachable from refs, PR-linked commits, and a 90-day recent window; orphan blobs and parse rows are deleted. Rejected model payloads are removed after 30 days.

Ingest and rebuild consult `erasure_filters`, so replay cannot resurrect removed data.

## Operational signals

`GET /ontology/metrics` reports:

- outbox depth by event and oldest age;
- unparsed blob backlog;
- manifest and search staleness;
- proposed assertion count;
- accept/reject rates per generator and predicate.

The design targets from v5.1 remain: ref-to-manifest p95 ≤30s, observation-to-search p95 ≤60s, redirect-to-reconciliation p95 ≤5m, warm template p95 ≤400ms, and personal erasure ≤24h. The metrics expose the required timestamps/counters; production alert thresholds belong in Cloud Monitoring.

## APIs

```text
POST /ontology/build
GET  /ontology
GET  /ontology/graphs/:id
GET  /ontology/metrics
POST /ontology/retrieve
POST /ontology/ask
POST /ontology/commands
```

Internal worker routes are lease-fenced:

```text
POST /internal/ontology/ingest/known
POST /internal/ontology/ingest/plan
POST /internal/ontology/ingest/blobs
POST /internal/ontology/ingest/github
POST /internal/ontology/assertions/cached
POST /internal/ontology/outbox/drain
```

## Verification contract

The test suite proves:

- tree-sitter parsing, signature hashes, and typed edges;
- first-parent add/modify/delete/rename deltas;
- registry endpoint/qualifier validation;
- provenance XOR, review transitions, cardinality, redirects, reconciliation, and acceptance labels;
- GitHub work-item and CODEOWNERS normalization;
- explicit resolution/merge assertions and review-gated issue causality;
- fixed-template orchestration and citations;
- real PostgreSQL intake → knowledge → incremental issue projection → retrieval → graph flow;
- repository ACL denial, redaction, and personal erasure;
- board/API/worker lease behavior and dashboard rendering.

Run the database contract with PostgreSQL 17:

```sh
TEST_DATABASE_URL=postgresql://... pnpm --filter @jina/db test
```

CI provides PostgreSQL and runs this integration suite on every pull request.
