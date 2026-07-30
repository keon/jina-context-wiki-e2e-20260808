# Context engine evaluation

The context evaluator is a reproducible quality gate for retrieval, citations, ACL
isolation, conflicts, and repository-access revocation. It emits a
`context-evaluation-report-v1` JSON report; this document intentionally does not record
dated results or production release identifiers.

## Run the fixture

Run the in-memory adapter:

```sh
pnpm install --frozen-lockfile
pnpm evaluate:context
```

Run the same cases through PostgreSQL using a disposable database:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/jina_test \
  pnpm evaluate:context
```

PostgreSQL mode drops only the `jina_context` schema in the supplied database. Never
point the evaluator at production or a shared development database.

The fixture is
`packages/context-engine/evaluation/fixtures.v1.json`. The evaluator builds the context
engine and database packages, ingests the fixture, commits cited knowledge, publishes an
index generation, runs retrieval variants, resolves returned anchors, and verifies that
access revocation takes effect.

The command exits nonzero when either the full routed or indexed-runtime variant:

- has exact-query completeness or citation integrity below `1`;
- has evidence recall below `0.9`;
- returns an unauthorized source;
- misses a required source kind or labeled conflict;
- returns a derived claim that is absent from its resolved evidence excerpt; or
- remains queryable after repository access is revoked.

To retain a report without changing the repository:

```sh
pnpm evaluate:context > /tmp/context-evaluation-report.json
```

Re-run the evaluator after changing evidence selection, fragmentation, routing,
retrieval, fusion, hierarchy, citations, ACL filtering, or fixtures. Do not edit report
numbers by hand.

## CI

`scripts/cloud-build-ci.sh` runs the evaluator against an ephemeral PostgreSQL 16
database after typechecking, linting, and tests. Pull requests must not bypass this gate.

When changing the fixture:

1. version the fixture schema and report contract intentionally;
2. keep stable case IDs where their meaning is unchanged;
3. update expected source anchors and required source kinds;
4. compare reports before and after the change; and
5. change thresholds only in the evaluator and through review.

## Real-question evaluation

`pnpm evaluate:questions` sends Markdown bullet queries to a running
`POST /context/search` API. Markdown headings become report categories. The endpoint
returns citation-grounded context packs and never generates an answer.

```sh
JINA_API_URL=https://api.example.com \
JINA_CONTEXT_REPOSITORY=owner/repository \
JINA_CONTEXT_REF=main \
CONTEXT_QUESTION_FILE=/absolute/path/questions.md \
CONTEXT_API_TOKEN='<bound query token>' \
CONTEXT_QUESTION_CONCURRENCY=4 \
CONTEXT_QUESTION_MIN_RETRIEVED_RATE=0.8 \
pnpm evaluate:questions > /tmp/context-question-report.json
```

Each row records whether context was retrieved, returned logical document IDs and
citations, the deterministic lexical-tree method, the immutable release, and latency. The
command fails on request errors or when the retrieved rate is below
`CONTEXT_QUESTION_MIN_RETRIEVED_RATE`.

This is a retrieval-coverage screen, not an answer-quality grade. The calling coding or
review agent remains responsible for reasoning over the returned context. Do not commit
bearer tokens or reports containing private context.

## Optional retrieval capabilities

Dense retrieval remains disabled until an approved embedding backend demonstrates a
material improvement over the production PageIndex lexical-tree scorer while preserving
citation integrity, ACL isolation, latency, cost, and data-egress requirements.

The active hierarchy is built locally from derived Markdown by the pinned PageIndex OSS
worker. Query-time selection is deterministic and model-free; the historical Codex tree
selector is retained only as an offline research comparator and is not wired into the API
or MCP server. Any alternative adapter must beat the lexical scorer on a sufficiently
broad repository fixture while preserving exact source anchors, ACL filtering,
cancellation, and citation validation.

## Deployment acceptance

Fixture evaluation does not replace deployment acceptance. Every coordinated deployment
runs `jina-acceptance` against a real repository and requires:

- successful worker health and topic checks;
- a completed context build at one full commit SHA;
- an immutable context release and nonempty derived-context catalog;
- cited HTTP and MCP searches using the bound non-admin context identity, with no answer;
- no remaining context outbox backlog.

The release process and evidence to retain are documented in
[DEPLOYMENT.md](DEPLOYMENT.md).
