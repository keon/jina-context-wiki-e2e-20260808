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

`pnpm evaluate:questions` sends Markdown bullet questions to a running
`POST /context/query` API. Markdown headings become report categories.

```sh
JINA_API_URL=https://api.example.com \
JINA_CONTEXT_REPOSITORY=owner/repository \
JINA_CONTEXT_REF=main \
CONTEXT_QUESTION_FILE=/absolute/path/questions.md \
CONTEXT_API_TOKEN='<bound query token>' \
CONTEXT_QUESTION_CONCURRENCY=4 \
CONTEXT_QUESTION_MIN_ANSWERED_RATE=0.8 \
pnpm evaluate:questions > /tmp/context-question-report.json
```

Each row records answer status, citations, coverage gaps, retrievers, trace ID, and
latency. The command fails on request errors or when the answered-or-partial rate is below
`CONTEXT_QUESTION_MIN_ANSWERED_RATE`.

This is a coverage screen, not a semantic correctness grade. Causal, counterfactual, and
fix-quality questions still require human or rubric grading. Do not commit bearer tokens
or reports containing private answer text.

## Optional retrieval capabilities

Dense retrieval remains disabled until an approved embedding backend demonstrates a
material improvement over lexical and structural retrieval while preserving citation
integrity, ACL isolation, latency, cost, and data-egress requirements.

The active hierarchy is the deterministic Jina adapter. Any alternative hierarchy
adapter must beat it on a sufficiently broad long-document fixture while preserving exact
source spans, ACL filtering, cancellation, and citation validation.

## Deployment acceptance

Fixture evaluation does not replace deployment acceptance. Every coordinated deployment
runs `jina-acceptance` against a real repository and requires:

- successful worker health and topic checks;
- a completed context build at one full commit SHA;
- a published enriched generation and nonempty knowledge catalog;
- cited HTTP and MCP queries using the bound non-admin context identity; and
- no remaining context outbox backlog.

The release process and evidence to retain are documented in
[DEPLOYMENT.md](DEPLOYMENT.md).
