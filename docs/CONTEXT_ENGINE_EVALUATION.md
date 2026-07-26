# Context engine evaluation report and runbook

## Latest checked-in-fixture result

- **Run:** 2026-07-26T08:37:48.676Z
- **Command:** `pnpm evaluate:context`
- **Fixture:** `packages/context-engine/evaluation/fixtures.v1.json`
- **Fixture schema:** `context-evaluation-v1`
- **Report schema:** `context-evaluation-report-v1`

| Gate                     | Full routed hybrid |     Requirement | Result |
| ------------------------ | -----------------: | --------------: | ------ |
| Exact-query completeness |              1.000 | 1.000 hard gate | pass   |
| Citation integrity       |              1.000 | 1.000 hard gate | pass   |
| Evidence recall@20       |              1.000 |    target 0.900 | pass   |

The evaluator's process exit threshold for recall is `0.90`, matching the architecture
plan's initial target. All three gates pass in this run.

The v1 fixture has eight cases: exact symbol, exact path/list, structural call,
architecture overview, PR/change, incident status, ownership, and long-document
retrieval. All eight expected source IDs are found. The ownership case retrieves the
CODEOWNERS evidence through exact/lexical indexing.

All citations returned in this run resolve back through the active evidence checkpoint
with matching source identity and content digest. This is a fixture-level integrity test;
production acceptance separately verifies HTTP and MCP anchors at a real repository
commit.

## Ablation results

| Variant                 | Enabled | Evidence recall | Exact completeness | Citation integrity |
| ----------------------- | ------- | --------------: | -----------------: | -----------------: |
| lexical only            | yes     |           1.000 |              1.000 |              1.000 |
| lexical + structural    | yes     |           1.000 |              1.000 |              1.000 |
| lexical + dense control | no      |           1.000 |              1.000 |              1.000 |
| lexical + hierarchy     | yes     |           1.000 |              1.000 |              1.000 |
| lexical + knowledge     | yes     |           1.000 |              1.000 |              1.000 |
| full routed hybrid      | yes     |           1.000 |              1.000 |              1.000 |
| full without reranking  | yes     |           1.000 |              1.000 |              1.000 |
| routed long context     | yes     |           1.000 |              1.000 |              1.000 |

The current fixture does not contain derived knowledge revisions, so the knowledge
ablation cannot demonstrate incremental quality. Likewise, the full and no-reranking
variants are equivalent because the implementation uses transparent deterministic fusion,
not a separate learned reranker. These rows establish a reproducible control, not proof
that those components add value.

The long-document case uses hierarchy, lexical, and `long_context` in the full routed
variant and finds its expected source. The architecture overview routes the same three
retrievers. Exact cases use the exact retriever, structural call uses exact plus
structural, change uses structured, and incident status uses lexical plus structured.

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
adapter behind the same port, not the canonical store or public contract.

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

The command builds `@jina/context-engine`, ingests the fixture into
`MemoryContextEngineStore`, publishes a baseline generation, runs every ablation, resolves
returned citation anchors, prints JSON to stdout, and exits nonzero if:

- full exact completeness is not `1`;
- full citation integrity is not `1`;
- full evidence recall is below the evaluator threshold.

To retain an artifact without modifying the repository:

```sh
pnpm evaluate:context > /tmp/context-evaluation-report.json
```

Do not edit reported numbers by hand. Re-run after any change to evidence selection,
fragmentation, planner routing, retrieval, fusion, hierarchy, citations, or the fixture.

## CI use

`scripts/cloud-build-ci.sh` runs `pnpm evaluate:context` after typecheck, lint, tests, and
the clean-cutover vocabulary check. A pull request must not bypass this step.

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

- add positive and negative derived-knowledge cases for every supported kind;
- add conflicts, stale sources, historical refs/time windows, revoked ACL, and erasure
  replay;
- expand long-document coverage enough to decide PageIndex;
- add a real dense ablation before enabling embeddings;
- measure structured and hybrid p95 against the plan's latency budgets;
- add groundedness and citation-precision scoring beyond anchor integrity.

These gaps do not invalidate the exact/citation hard-gate result above, but they prevent
using this small fixture as a broad product-quality claim.
