# ContextGraph Build Performance — Implementation Plan

Status: proposed 2026-07-21. Grounded in production measurements taken the same
day (Cloud Logging request traces 16:30–18:40 UTC) and a local benchmark harness
running the real `PostgresContextGraphStore` code against PostgreSQL.

## Measured baseline

Production, per internal API call (Cloud Run request logs):

| Call                                                              | Typical  | Worst observed          | Local benchmark (same code, unix socket) |
| ----------------------------------------------------------------- | -------- | ----------------------- | ---------------------------------------- |
| `/internal/context-graph/ingest/blobs` (50 analyses)              | ~12 s    | 495 s, one 504 at 300 s | 0.85 s                                   |
| `/internal/context-graph/ingest/plan` (one commit)                | 4–29 s   | 67 s (930 KB response)  | 45 ms (2k tree) / 159 ms (10k tree)      |
| `/internal/context-graph/ingest/github` (one repo's PR/issue set) | 10–70 s  | 131.7 s                 | 1.4 s / 100 observations                 |
| `/internal/worker/complete`                                       | 1–27 s   | 250 s                   | —                                        |
| `/internal/worker/claim` (empty poll)                             | 0.6–13 s | 70 s                    | —                                        |
| `/internal/context-graph/outbox/drain`                            | 3–16 s   | 572 s                   | 3.0 s with events / 4 ms empty           |

Whole tasks, production:

- `omxyz/jina` snapshot ingest 3 m 55 s; history ingest 4 m 30 s; a rebuild with
  a 205 s blob batch lost its lease (renew starved behind the write) and
  discarded work through a 409 loop.
- `omxyz/jina-simulation` snapshot ingest 2 m 31 s, of which one
  `/ingest/github` call was 131.7 s (87%).
- Assert stages (Daytona/Codex): 18+ minutes, dominated by sandbox create +
  full clone + `npm install` of Codex before any model token.
- The e2e acceptance build (tiny fixture repo) has been taking 20–40+ minutes,
  repeatedly outliving the deploy that launched it.

Root causes, ranked (each verified by both code reading and the numbers above):

1. Row-at-a-time SQL: a 50-blob batch issues ~4,100 sequential queries
   (`postgres-context-graph-store.ts` — per-symbol/import/edge INSERT loops,
   plus one `commit_manifest()` tree-unnest per blob). Cloud SQL round-trip
   latency turns 0.85 s of SQL into 231–495 s.
2. Full-tree-per-commit protocol: every `/ingest/plan` ships and stores the
   entire tree (10k-element arrays on each commit row); incremental and no-op
   costs scale with tree size, not delta size.
3. Serial GitHub REST reads: ~3 calls per commit plus one call per blob,
   sequential, no retry/backoff/ETag; ~13,500 calls for a 1k-commit/10k-blob
   build (35–70 min of wall clock and a guaranteed rate-limit collision).
4. Heavy work inside HTTP requests: assert/project completion runs multi-minute
   durable writes inside one request against a 30 s worker client timeout —
   source of the 409-stale-lease loops and the #55–#59 timeout escalations.
5. Coordination tax: single worker instance (concurrency 1, all topics), drains
   on every 2 s idle tick that rebuild whole search projections, empty claims
   paying a full `api_state` JSON snapshot parse, lease renewals blocked behind
   write fences and aborted on a single 429.
6. Daytona cold start: sandbox create + full clone + Codex npm install on every
   assert run (2–5 min before the model runs).

## Design principle: delta updates ≠ batch initialization

Two workloads, two shapes. Much of today's cost is the delta path running
through backfill-shaped code and vice versa.

- **Batch initialization** (first build; up to `CONTEXT_GRAPH_HISTORY_LIMIT`
  commits): optimize for throughput. One clone, local history walk, bulk
  set-based loads, no per-event projection during the load, one terminal
  rebuild, one bounded semantic generation.
- **Delta update** (push moves head by 1–N commits): optimize for latency.
  Fetch only new objects, ship only the delta, event-scoped projection upserts,
  assert only when the evidence fingerprint moved.

Invariants: the delta path never touches O(tree) data for an O(delta) change;
the backfill path never emits per-commit projection work.

## Targets (acceptance gates)

| Scenario                                       | Baseline   | Target                |
| ---------------------------------------------- | ---------- | --------------------- |
| Delta push, cached assert (no semantic change) | 8–10 min   | ≤ 30 s                |
| Delta push with semantic assert                | 20–40+ min | ≤ 4 min (model-bound) |
| Batch init, 1k commits / 10k blobs / 200 PRs   | hours      | ≤ 15 min              |
| e2e acceptance build (deploy gate)             | 20–40+ min | ≤ 5 min               |
| Empty claim poll                               | 0.6–70 s   | ≤ 100 ms              |

These align with the SLOs already declared in CONTEXT_GRAPH.md (ref-to-manifest p95
≤ 30 s, observation-to-search p95 ≤ 60 s), currently missed by an order of
magnitude.

## PR train

Each PR is independently shippable, keeps the acceptance gate green, and
carries before/after numbers from the benchmark harness plus the next deploy's
acceptance duration.

### PR 1 — Batch canonical writes (packages/db) — expected: largest single win

- `applyBlobAnalyses`: replace per-row INSERT loops with one multi-row
  `insert … select from unnest($1::…[], …)` per table (`blob_analyses`,
  `blob_symbols`, `blob_imports`, `symbol_edges`). Replace the per-blob
  `commit_manifest()` probe with one set-based membership check per batch.
- `planIngestion`: `commit_changes` as one unnest insert.
- `applyGitHubObservations`: batch the observation inserts and outbox rows;
  load all live assertions for the batch's natural keys in one query, keep the
  per-key advisory-lock semantics for supersession.
- `saveAssertionBatch`: bulk entity upsert, batched assertion insert, one
  multi-row outbox insert.
- `insertOutbox`: one multi-row insert per event covering all consumers.
- Search documents: multi-row insert; exclude `source_snapshot` payload bodies
  from search text (they are 1 MB tree dumps that poison both write volume and
  relevance).
- Semantics unchanged; the existing PG integration suite must pass as-is.
- Expected: blob batch 231–495 s → < 5 s; `/ingest/github` 131 s → < 5 s;
  completion writes shrink proportionally.

### PR 2 — Delta/backfill ingest protocol + content-addressed trees (db + api + worker)

- Schema (additive first): new `trees` table keyed `(tenant_id, tree_sha)`
  holding the path/blob arrays once; `commits` gains `tree_ref`; migration
  backfills `trees` from existing commit rows; `commit_manifest()` becomes a
  join. Column drop of `tree_paths`/`tree_blob_shas` ships as a separate
  follow-up migration after a soak period (rollback = keep reading old columns).
- API: `/internal/context-graph/ingest/plan` accepts
  `{mode:"delta", parentSha, changes:[…]}` or `{mode:"tree", treeSha, files}`;
  tree mode only when the tree is unseen (root commits, unknown parents).
- Worker: sends deltas computed from git for chain commits; the full tree only
  when required. Unchanged-head check becomes constant-time.
- Expected: plan calls 4–67 s → sub-second for deltas; 930 KB payloads → KBs;
  commit-row TOAST churn eliminated.

### PR 3 — Clone-based read side (worker)

- Ingest clones once per build (`git clone --filter=blob:none`, full clone under
  a size threshold) using the existing clone credential; commit walk, trees,
  blob contents, and exact-rename detection come from local git. Add git to the
  worker image; enforce a disk-budget guard with REST fallback.
- Keep REST for PRs/issues/CODEOWNERS-adjacent data; wrap `githubRequest` with
  rate-limit-aware retry (`Retry-After`, `x-ratelimit-remaining`), exponential
  backoff, and bounded concurrency (reuse `mapWithConcurrency`, default 10).
- Feature flag `CONTEXT_GRAPH_INGEST_TRANSPORT=git|rest` for rollback.
- Expected: the 2–3 minute serial-read gap at the start of every ingest → tens
  of seconds; backfills stop consuming the REST rate budget for code data.

### PR 4 — Projection policy split (db + worker)

- Backfill: while a repo has an active ingest lease, drain skips that repo's
  search/manifest consumers; the terminal project task performs the single
  rebuild (the bulk-recovery path that already exists becomes the only path).
- Delta: event-scoped upserts — update only the documents/manifest rows named
  by the event instead of delete-and-rebuild per repo.
- Worker loop: drain after completions and on a 60 s safety interval, not every
  2 s idle tick.
- Expected: eliminates the 461–572 s drains observed mid-build and the
  redundant rebuild between assert and project.

### PR 5 — Thin completions, safe leases, concurrency (api + db + worker)

- `complete` flips task status only; projection/assertion-save work is enqueued
  as its own board task on the relational coordinator. Removes multi-minute
  writes from completion requests and the 30 s/900 s timeout mismatch.
- Lease renewal: compare-and-set on the lease row, never waiting on the write
  fence's `FOR UPDATE`; the durable-write fencing check validates `lease_id`
  inside the write transaction instead of holding a row lock for its duration.
- Worker: renew failures retry with backoff; the lease is treated as lost only
  on an explicit 409. Internal `/internal/*` routes are exempt from the API
  rate limiter (renew/claim 429s observed in production are self-inflicted).
- Exempt internal contextGraph routes from the `api_state` `synchronize()` reload;
  add retention (age + count caps) for board events in both stores.
- Scale out: worker `max-instances` 2–4 with topic sharding; split the per-repo
  advisory lock per plane (code / knowledge / projection) so batched writers
  pipeline. `FOR UPDATE SKIP LOCKED` claiming already supports this.
- Expected: empty claims 0.6–70 s → ~10 ms; 409 loops and 30-minute
  lease-expiry stalls eliminated; repos build concurrently.

### PR 6 — Warm assert path (daytona)

- Prebaked Daytona snapshot/image with Codex preinstalled; shallow clone
  (`--depth 1`) at the pinned commit; keep full clone as fallback when history
  is needed for citation checks.
- Optional follow-up: submit-and-poll assert execution so the worker loop is
  not held hostage for the model's duration.
- Expected: 2–5 min cold start → ~30 s; assert becomes model-bound.

### PR 7 — Hygiene and observability

- One structured log line per stage transition with duration and repo — this
  entire investigation becomes a five-minute log query.
- Drop pretty-printed API JSON; ETag/304 on dashboard polls; cap the unbounded
  `/events` and `listSummaries` reads; cache the folded redirect/entity map per
  request.
- Grant `roles/logging.viewer` to `github-deployer@jina-v2` so the CI
  acceptance log dump stops failing with PERMISSION_DENIED (infra change,
  documented here because it blocked diagnosis).

## Verification

- Per PR: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the
  `@jina/db` PG integration suite unchanged (PR 2 adds delta-protocol cases:
  delta chain equals tree-mode result; unknown-parent forces tree mode;
  no-op head is constant-time).
- Benchmark harness (the scripts used to produce the baseline numbers) runs the
  write path at 2k/10k-file scale before/after; numbers go in each PR
  description.
- The deploy acceptance job is the production gate; its duration is the
  headline metric, target trending 40 min → < 5 min across the train.
- PR 5's lease semantics get a dedicated integration test: renewal succeeds
  while a multi-second durable write holds the fence; a superseded lease still
  cannot commit.

## Sequencing and risk

```
PR1 (db batching)          — no deps, ship first
PR2 (delta protocol)       — after PR1 (shares touched files)
PR3 (clone transport)      — independent of PR1/2, flag-gated
PR4 (projection policy)    — after PR1; interacts with PR2 event scoping
PR5 (coordination)         — independent; biggest blast radius, own soak
PR6 (daytona)              — independent
PR7 (hygiene)              — anytime
```

Risks and mitigations:

- Commits-table migration (PR 2): additive first, dual-read, drop columns in a
  later migration after soak; `commit_manifest()` keeps its signature.
- Clone on Cloud Run (PR 3): in-memory filesystem — enforce a size guard and
  REST fallback flag; measure worker memory ceiling before raising limits.
- PR 5 changes failure semantics: land the lease CAS and the thin-complete
  separately if soak surfaces anything; each is independently revertible.
- Model-call floor: after this train, semantic asserts bound build time; the
  next lever is assert batching/parallelism, out of scope here.

## Operations

One-time IAM grant (owner-run, not CI): the deploy acceptance step dumps
worker/API logs on failure, and the `github-deployer` service account currently
gets `PERMISSION_DENIED` from Cloud Logging, so the dump step fails. A project
owner must run once:

```
gcloud projects add-iam-policy-binding jina-v2 \
  --member=serviceAccount:github-deployer@jina-v2.iam.gserviceaccount.com \
  --role=roles/logging.viewer
```

We deliberately do not grant IAM from the workflow itself — the deployer should
not hold `resourcemanager.projects.setIamPolicy`.
