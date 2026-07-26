# Context engine evaluation report and runbook

## Latest checked-in-fixture result

- **Run:** 2026-07-26T09:27:12.330Z
- **Command:** `pnpm evaluate:context`
- **Fixture:** `packages/context-engine/evaluation/fixtures.v1.json`
- **Fixture schema:** `context-evaluation-v1`
- **Report schema:** `context-evaluation-report-v1`

| Gate                           | Full routed hybrid |     Requirement | Result |
| ------------------------------ | -----------------: | --------------: | ------ |
| Exact-query completeness       |              1.000 | 1.000 hard gate | pass   |
| Citation anchor integrity      |              1.000 | 1.000 hard gate | pass   |
| Evidence recall@20             |              1.000 |    target 0.900 | pass   |
| Unauthorized citation count    |                  0 |     0 hard gate | pass   |
| Labeled conflict failures      |                  0 |     0 hard gate | pass   |
| Required source-kind failures  |                  0 |     0 hard gate | pass   |
| Grounded knowledge citation    |               true |  true hard gate | pass   |
| Repository revocation enforced |               true |  true hard gate | pass   |

The evaluator's process exit threshold for recall is `0.90`, matching the architecture
plan's initial target. It also exits nonzero for any ACL leak, labeled conflict mismatch,
required source-kind mismatch, derived claim that is absent from its resolved excerpt, or
post-run revocation failure. All gates pass in this PostgreSQL-adapter run.

The v1 fixture now has 12 cases: exact symbol, exact path/list, structural call,
architecture overview, derived knowledge, PR/change, incident status, ownership,
long-document retrieval, a temporal window, a labeled conflict, and a negative private
ACL case. The full routed variant finds all 12 expected source IDs, reports the labeled
conflict, uses the required source kinds, and returns none of the private source IDs. The
evaluator then revokes the principal's repository access and requires the next query to
fail.

All citations returned in this run resolve back through the active evidence checkpoint
with matching source identity and content digest. Citation-selector and claim-grounding
tests separately prove that line ranges/JSON pointers resolve exact excerpts and that a
derived citation's normalized claim must occur verbatim in the selected excerpt rather
than a nearby source location. Production acceptance separately verifies HTTP and MCP
anchors at a real repository commit.

## Ablation results

| Variant                 | Enabled | Evidence recall | Exact completeness | Citation integrity | ACL leaks |
| ----------------------- | ------- | --------------: | -----------------: | -----------------: | --------: |
| lexical only            | yes     |           0.917 |              1.000 |              1.000 |         0 |
| lexical + structural    | yes     |           0.917 |              1.000 |              1.000 |         0 |
| lexical + dense control | no      |           0.917 |              1.000 |              1.000 |         0 |
| lexical + hierarchy     | yes     |           0.917 |              1.000 |              1.000 |         0 |
| lexical + knowledge     | yes     |           0.917 |              1.000 |              1.000 |         0 |
| full routed hybrid      | yes     |           1.000 |              1.000 |              1.000 |         0 |
| full without reranking  | yes     |           1.000 |              1.000 |              1.000 |         0 |
| routed long context     | yes     |           0.917 |              1.000 |              1.000 |         0 |

The fixture contains an immutable derived knowledge revision cited to original README
evidence. The knowledge route retrieves it for architecture/knowledge/long-document
questions. The full and no-reranking variants remain equivalent because the implementation
uses transparent deterministic fusion, not a separate learned reranker.

The full routed variant's temporal case uses lexical plus structured retrieval and is the
one expected-source distinction missed by the single-route controls. Exact cases use the
exact retriever, structural call uses exact plus structural, change uses structured, and
the conflict case returns both labeled sources plus one conflict group.

## Optional capability decisions

### Dense retrieval: disabled

The embedding port, PostgreSQL storage lifecycle, ACL-filtered search adapter, and dense
retriever exist. No approved embedding backend is configured for this evaluation. The
`lexical_dense` row deliberately executes the lexical control and shows no incremental
gain.

Dense must remain disabled until an evaluation:

1. configures the exact model, dimensions, contextualization, and projector version;
2. backfills a disposable generation from immutable fragments;
3. compares lexical+structural against lexical+structural+dense;
4. demonstrates a predeclared material recall or answer-quality improvement;
5. retains 100% ACL isolation and citation integrity;
6. stays within indexing cost, query latency, and data-egress budgets.

### PageIndex: fallback only

The active hierarchy is Jina's deterministic heading/section-tree adapter. It preserves
source spans and gives long documents a hierarchy route. PageIndex is a replaceable
adapter behind the same port, not the canonical store or public contract. No PageIndex
client or dependency is configured in the current runtime.

PageIndex must remain disabled until an expanded long-document slice compares:

- lexical only;
- lexical plus deterministic hierarchy;
- lexical plus PageIndex;
- routed long-context with each hierarchy.

The go/no-go decision must include recall, citation integrity, ACL isolation, node/span
validation, indexing and query latency, cost, private-data egress, cancellation/timeout,
and licensing. The current eight-case fixture is too small to make that decision.

## Reproduce locally

```sh
pnpm install --frozen-lockfile
pnpm evaluate:context
```

Without `TEST_DATABASE_URL`, the command builds the packages, ingests the fixture into
`MemoryContextEngineStore`, commits a cited derived knowledge revision, publishes a
generation, runs every ablation, resolves returned anchors, checks revocation, and prints
JSON to stdout.

For the merge gate, use a disposable PostgreSQL database:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/jina_test \
  pnpm evaluate:context
```

That mode drops only the `jina_context` schema in the named disposable database, then
repeats the same fixture and gates through `PostgresContextEngineStore`. It exercises
actual SQL ACL filtering, generation hydration, knowledge projection, and query
telemetry/storage paths. Never point this evaluator at production or a shared development
database.

The evaluator exits nonzero if:

- full exact completeness is not `1`;
- full citation integrity is not `1`;
- full evidence recall is below the evaluator threshold;
- an unauthorized source is cited;
- a labeled conflict count differs;
- a required source kind is missing; or
- the persisted knowledge claim is absent from its exact resolved evidence excerpt; or
- the principal can still query after repository access is revoked.

To retain an artifact without modifying the repository:

```sh
pnpm evaluate:context > /tmp/context-evaluation-report.json
```

Do not edit reported numbers by hand. Re-run after any change to evidence selection,
fragmentation, planner routing, retrieval, fusion, hierarchy, citations, or the fixture.

## CI use

`scripts/cloud-build-ci.sh` runs `pnpm evaluate:context` with its ephemeral PostgreSQL 16
`TEST_DATABASE_URL` after typecheck, lint, tests, and the clean-cutover vocabulary check.
A pull request must not bypass this step.

When changing the fixture schema:

1. version the schema and fixture together;
2. keep stable case IDs;
3. document added/removed cases and expected source anchors;
4. compare old/new reports rather than overwriting the baseline silently;
5. update thresholds only through a reviewed architecture/evaluation decision.

## Production-shaped acceptance

The fixture evaluator is necessary but insufficient. Each deployment also executes the
`jina-acceptance` Cloud Run job against a real repository. It must:

- synchronize an exact repository ACL for the bound principal;
- run `build-context` through `ingest-evidence`, `derive-knowledge`, and `index-context`;
- select a published enriched generation at one exact full commit SHA;
- return a nonempty knowledge-document catalog;
- query the HTTP API and verify original evidence anchors;
- connect with the MCP SDK, confirm `query_context` is the only tool, call it, and verify
  the same commit and original anchors;
- report no pending context outbox work;
- confirm the retired public path is not served.

Release evidence must record the build ID, stage IDs, repository/ref/commit, generation ID,
document count, HTTP citation count, MCP citation count, duration, and outbox depth. It
must also record the pre-cutover database backup ID and immutable image/source SHA.

## Follow-up evaluation work

Before calling the target evaluation set complete:

- add positive and negative derived-knowledge cases for every remaining supported kind;
- expand stale-source, multi-ref history, and erasure replay coverage beyond the current
  temporal, conflict, private-ACL, and revocation cases;
- expand long-document coverage enough to decide PageIndex;
- add a real dense ablation before enabling embeddings;
- measure structured and hybrid p95 against the plan's latency budgets;
- add graded groundedness and citation-precision scoring beyond the enforced exact
  citation-claim excerpt check.

These gaps do not invalidate the exact/citation/ACL/conflict hard-gate result above, but
they prevent using this small fixture as a broad product-quality claim.
